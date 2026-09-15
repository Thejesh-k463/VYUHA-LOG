import { todayIstIso } from "@/lib/domain/trading-day";
import "server-only";
import { db } from "@/lib/db";
import { trades } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { loadRatesMap } from "@/lib/engine/rates-db";
import { epochSpans } from "@/lib/engine/rates";
import { mtfRateFor } from "@/lib/engine/charges";
import type { Broker, Exchange } from "@/lib/domain/constants";
import { getMarginRates } from "@/lib/queries/margin";
import { defaultMtfFundedAmount, marginKey, DEFAULT_MTF_OWN_MARGIN_PCT } from "@/lib/risk/margin";

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Daily MTF interest accrual. Recomputes accrued interest for every OPEN eq_mtf
 * position from T+1 (buy date) to `today`, updating charges_total and net_pnl.
 * Idempotent — safe to run on every app open (it recomputes, not increments).
 */
export function accrueMtfInterest(today = todayIstIso()): {
  updated: number;
  totalAccrued: number;
} {
  const open = db
    .select()
    .from(trades)
    .where(and(eq(trades.segment, "eq_mtf"), eq(trades.isOpen, true)))
    .all();
  if (open.length === 0) return { updated: 0, totalAccrued: 0 };

  const rates = loadRatesMap();
  const marginRates = getMarginRates(); // one query; per-broker eq_mtf own-margin %
  let updated = 0;
  let totalAccrued = 0;

  for (const t of open) {
    if (!t.buyDate) continue;
    // Broker-financed principal — reuse what a writer locked in (entry, editor,
    // close); only fall back to the margin-based estimate for a row nobody has
    // priced. NEVER the full position value:
    // that assumes 100% broker financing and overstates interest (the bug fixed
    // here — see also closePosition/commitManualTrade in lib/import/commit.ts).
    // Own-margin % is looked up per THIS trade's broker — real leverage varies.
    // X2 (4.3.0) — a stored 0 is STATED (the whole position from own capital),
    // not "never set": it is kept and accrues nothing. Only null is estimated —
    // the rule closePosition/updateManualTrade use (V3), so a close keeps what
    // this job leaves.
    // M1 (4.3.0 wave 2L) — that estimate is used HERE and never written back.
    // This job used to persist it (`fundedChanged = t.mtfFundedAmount == null`
    // forced the UPDATE), and /equity runs on every render, so the first visit
    // to the Equity Tracker turned a position the journal never priced into a
    // STATED funded amount at the margin default — after which mtfDrift's
    // `mtfFundedAmount == null` exclusion and `unpricedMtfPositions` could never
    // fire for it, and the drift card compared the requirement against a margin
    // nobody recorded (invariant 6: never state a fabricated figure as the
    // journal's). Interest stays an estimate the UI labels; the funded column
    // stays NULL until a writer the user drove (the editor, a close, an import)
    // states one.
    const ownMarginPct = marginRates.get(marginKey(t.broker, "eq_mtf")) ?? DEFAULT_MTF_OWN_MARGIN_PCT;
    const funded = t.mtfFundedAmount ?? defaultMtfFundedAmount(t.buyValue, ownMarginPct);
    // T+1 settlement start through the day before sale proceeds settle = exactly
    // (today − buyDate) calendar days for a still-open position — confirmed
    // against Dhan's MTF docs. No extra "-1": that undercounted by one day.
    /**
     * Interest accrues PER EPOCH, not at today's rate for the whole period.
     *
     * Pricing the full holding period at today's rate would retroactively
     * restate interest the user already accrued under the old one — and this
     * job writes `chargesTotal` and `netPnl` back, so that is a stored P&L
     * changing with no prompt and no audit entry. DECISIONS 2026-08-30
     * decision 6 forbids exactly that.
     *
     * `epochSpans` days always sum to (today − buyDate), so a broker with one
     * open-ended epoch — every broker today — accrues precisely as before.
     */
    let interest: number;
    try {
      const spans = epochSpans(rates, t.broker as Broker, "eq_mtf", t.exchange as Exchange, t.buyDate, today);
      let acc = 0;
      for (const s of spans) acc += (funded * mtfRateFor(funded, s.rates) * s.days) / 365;
      interest = r2(acc);
    } catch {
      // No rate epoch covers part of this holding period. Accruing at a
      // neighbouring rate would invent a number; leaving it alone is honest.
      continue;
    }
    if (interest === t.mtfInterest) continue;

    const newCharges = r2(t.chargesTotal - t.mtfInterest + interest);
    const newNet = r2(t.grossPnl - newCharges);
    db.update(trades)
      .set({ mtfInterest: interest, chargesTotal: newCharges, netPnl: newNet })
      .where(eq(trades.id, t.id))
      .run();
    updated++;
    totalAccrued += interest;
  }
  return { updated, totalAccrued: r2(totalAccrued) };
}
