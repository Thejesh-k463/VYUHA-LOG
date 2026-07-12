import "server-only";
import { db } from "@/lib/db";
import { trades } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { loadRatesMap } from "@/lib/engine/rates-db";
import { findRates } from "@/lib/engine/rates";
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
export function accrueMtfInterest(today = new Date().toISOString().slice(0, 10)): {
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
    // Broker-financed principal — reuse what was locked in at entry (or a prior
    // accrual run); only fall back to the margin-based estimate for trades that
    // predate the mtf_funded_amount_paise column. NEVER the full position value:
    // that assumes 100% broker financing and overstates interest (the bug fixed
    // here — see also closePosition/commitManualTrade in lib/import/commit.ts).
    // Own-margin % is looked up per THIS trade's broker — real leverage varies.
    const ownMarginPct = marginRates.get(marginKey(t.broker, "eq_mtf")) ?? DEFAULT_MTF_OWN_MARGIN_PCT;
    const funded = t.mtfFundedAmount && t.mtfFundedAmount > 0 ? t.mtfFundedAmount : defaultMtfFundedAmount(t.buyValue, ownMarginPct);
    // T+1 settlement start through the day before sale proceeds settle = exactly
    // (today − buyDate) calendar days for a still-open position — confirmed
    // against Dhan's MTF docs. No extra "-1": that undercounted by one day.
    const days = Math.max(0, Math.floor((new Date(today + "T00:00:00").getTime() - new Date(t.buyDate + "T00:00:00").getTime()) / 86400000));
    const r = findRates(rates, t.broker as Broker, "eq_mtf", t.exchange as Exchange);
    const rate = mtfRateFor(funded, r);
    const interest = r2((funded * rate * days) / 365);
    const fundedChanged = t.mtfFundedAmount == null || t.mtfFundedAmount <= 0;
    if (interest === t.mtfInterest && !fundedChanged) continue;

    const newCharges = r2(t.chargesTotal - t.mtfInterest + interest);
    const newNet = r2(t.grossPnl - newCharges);
    db.update(trades)
      .set({ mtfInterest: interest, mtfFundedAmount: funded, chargesTotal: newCharges, netPnl: newNet })
      .where(eq(trades.id, t.id))
      .run();
    updated++;
    totalAccrued += interest;
  }
  return { updated, totalAccrued: r2(totalAccrued) };
}
