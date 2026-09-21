import { todayIstIso, normalizeDate } from "@/lib/domain/trading-day";
import "server-only";
import { db } from "@/lib/db";
import { trades } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { loadRatesMap } from "@/lib/engine/rates-db";
import { mtfInterestOver } from "@/lib/engine/rates";
import { rebuildStagedTrade, legCountOf } from "@/lib/queries/staged";
import { planAccountsById } from "@/lib/queries/broker-plan";

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Daily MTF interest accrual. Recomputes accrued interest for every OPEN eq_mtf
 * position from T+1 (buy date) to `today`, updating charges_total and net_pnl.
 * Idempotent — safe to run on every app open (it recomputes, not increments).
 *
 * `skipped` (D2, wave 2P) counts the staged rows this run left exactly as they
 * were: a ladder the domain refused, a ladder that could not be priced (no rate
 * epoch covers `today` for its broker), and a staged-flagged row with no legs
 * (D5). The job surfaced no skip before, so a whole book silently stopping was
 * observable to nobody.
 */
export function accrueMtfInterest(today = todayIstIso()): {
  updated: number;
  totalAccrued: number;
  skipped: number;
} {
  const open = db
    .select()
    .from(trades)
    .where(and(eq(trades.segment, "eq_mtf"), eq(trades.isOpen, true)))
    .all();
  if (open.length === 0) return { updated: 0, totalAccrued: 0, skipped: 0 };

  const rates = loadRatesMap();
  // The plan each row's own ACCOUNT is on, read once for the whole run (wave U).
  const planAccounts = planAccountsById();
  // No margin_config read: nothing here estimates a funded amount any more (Q-A).
  let updated = 0;
  let totalAccrued = 0;
  let skipped = 0;

  for (const t of open) {
    // D6 (OWNER RULING 2O row 1 / mtf#0, a silent wrong number) — A STAGED ROW'S
    // CHARGES HAVE ONE WRITER: THE LADDER. This job patches the PARENT row only,
    // so on a staged position it wrote a figure the ladder's own legs disagreed
    // with — probed on a legacy ladder: the release took 147.20 out of the parent
    // (71.38) and left the legs at 218.58, which is invariant 5 broken by the fix
    // for mtf#0. And because both doors wrote, the row's stored interest
    // alternated between the ladder's answer and this job's on every leg edit and
    // every /equity render.
    //
    // So a staged row is skipped in BOTH branches and re-priced through
    // `rebuildStagedTrade`, which writes the legs and the parent in ONE
    // transaction: the release of a pre-4.3.0 estimate on an OPEN staged row and
    // the daily accrual of a STATED principal are then the same idempotent call,
    // and parent = Σ legs holds at every step. The ladder reads `asOf` from us, so
    // one run states one day for every row.
    //
    // A CLOSED staged row is not selected here at all (`isOpen` above), which is
    // exactly what the owner ruled: one priced before 4.3.0 keeps its earlier
    // estimate, and the release notes say so.
    if (t.staged) {
      // D5 (wave 2P) — ONE leg-count question before any rebuild (`legCountOf`,
      // the predicate the editor-side doors share). `validateLegs([])` returns no
      // problem, so a staged-flagged row with ZERO legs was rewritten from an
      // EMPTY ladder on every /equity render (buyQty / buyValue / chargesTotal /
      // netPnl → 0). Such a row is left EXACTLY as it is — not accrued flat
      // either: it claims a ladder it does not have, and a flat figure on it
      // would be the second writer D6 removed.
      if (legCountOf(t.id) === 0) {
        skipped++;
        continue;
      }
      // D2 (wave 2P) — the same guard the flat path's `epochSpans` block has:
      // `findRates` THROWS when no eq_mtf epoch covers `today` for this row's
      // broker (an expired epoch with no successor; sahi, which seeds none), and
      // the throw used to escape this job — /equity swallowed it, and NO row
      // after the failing one accrued, flat rows with a STATED principal
      // included, with nothing on screen. Accruing at a neighbouring rate would
      // invent a number (invariant 6); the row is left alone and the loop goes
      // on. The throw happens inside `priceLegs`, before the rebuild's
      // transaction opens, so nothing is written for this row.
      let res: ReturnType<typeof rebuildStagedTrade>;
      try {
        res = rebuildStagedTrade(t.id, undefined, today);
      } catch {
        skipped++;
        continue;
      }
      // A ladder the domain refuses (an unreadable leg date, an over-sold fill)
      // is left exactly as it is — `rebuildStagedTrade` writes nothing then.
      if (!res.ok) {
        skipped++;
        continue;
      }
      const after = db.select().from(trades).where(eq(trades.id, t.id)).get();
      const interest = after?.mtfInterest ?? t.mtfInterest;
      if (interest !== t.mtfInterest) {
        updated++;
        totalAccrued += interest;
      }
      continue;
    }
    if (!t.buyDate) continue;
    // D3 (v4.3.0 wave 2N, ipo#1) — the THIRD reader of a stored buy date, and the
    // only one that writes on every render. `epochSpans` does not throw on a value
    // it cannot read: measured, '9999-99-99' spans 0 days, so this job SET the
    // row's interest to 0 and moved its stored charges and net with it — a stored
    // P&L changing with no prompt and no audit row (DECISIONS 2026-08-30 decision
    // 6) — and '2026-02-31' rolled forward to 3 March and billed 199 days /
    // ₹636.80 from a day the row does not state. A date that states no day is
    // skipped: nothing accrues until the editor corrects it (invariant 6).
    const buyIso = normalizeDate(t.buyDate);
    if (!buyIso) continue;
    // Broker-financed principal — what a writer locked in (entry, editor,
    // close). NEVER the full position value: that assumes 100% broker financing
    // and overstates interest (the bug fixed here — see also
    // closePosition/commitManualTrade in lib/import/commit.ts).
    // X2 (4.3.0) — a stored 0 is STATED (the whole position from own capital),
    // not "never set": it is kept and accrues nothing.
    //
    // Q-A (OWNER RULING, v4.3.0 wave 2N — mtf-accrual#0/#1): A ROW WITH NO
    // RECORDED FUNDED AMOUNT ACCRUES NOTHING. The job used to estimate it from
    // `defaultMtfFundedAmount(buyValue, margin_config)` on every render (M1
    // stopped it PERSISTING that estimate, not using it), so editing a broker's
    // eq_mtf own-margin % retroactively restated the stored charges_total and
    // net_pnl of every unpriced holding — a stored P&L moving with no prompt
    // and no audit row, which is exactly what this job's per-epoch design
    // exists to prevent (DECISIONS 2026-08-30 decision 6). Nothing accrues
    // until a writer the user drove states the amount; an estimate ALREADY
    // stored is released once, below.
    const funded = t.mtfFundedAmount;
    if (funded == null) {
      if (t.mtfInterest !== 0) {
        // The estimate left money in the row's stored columns. Take it back out
        // ONCE — after this the row reads 0 interest and stays there.
        const releasedCharges = r2(t.chargesTotal - t.mtfInterest);
        db.update(trades)
          .set({ mtfInterest: 0, chargesTotal: releasedCharges, netPnl: r2(t.grossPnl - releasedCharges) })
          .where(eq(trades.id, t.id))
          .run();
        updated++;
      }
      continue;
    }
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
      // …and PER PLAN epoch too (wave U): the row's account may have moved to
      // a paid plan part-way through the holding period, and the days before
      // that date keep the rate they accrued at. See `mtfInterestOver`.
      interest = mtfInterestOver(rates, t, funded, planAccounts.get(t.accountId) ?? null, buyIso, today);
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
  return { updated, totalAccrued: r2(totalAccrued), skipped };
}
