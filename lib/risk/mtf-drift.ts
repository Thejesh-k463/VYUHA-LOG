/**
 * MTF drift (PURE) — the startup check behind "recompute my open MTF
 * positions against the latest margins".
 *
 * A position opened when a stock needed 25% own margin doesn't retroactively
 * change, but the CURRENT requirement drifting to 40% is something the trader
 * should see: their broker may demand a top-up, and new adds price
 * differently. This reports the gap; it never rewrites the stored trade —
 * the journal records what happened, not what today's rates wish had
 * happened.
 */

import type { MtfMarginResolution } from "@/lib/risk/mtf-margins";

export interface OpenMtfPosition {
  id: number;
  symbol: string;
  broker: string;
  buyValue: number; // invested value (₹)
  mtfFundedAmount: number | null; // stored broker-funded ₹ at entry
}

export interface MtfDriftRow {
  id: number;
  symbol: string;
  broker: string;
  storedOwnPct: number; // what the position was entered at
  currentPct: number; // what the latest list says
  deltaPct: number; // current − stored (positive = requirement rose)
  /** ₹ the trader would need to add if the broker re-margined at current. */
  topUpAtCurrent: number;
  source: MtfMarginResolution["source"];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function mtfDrift(
  positions: OpenMtfPosition[],
  resolve: (broker: string, symbol: string) => MtfMarginResolution,
  thresholdPct = 2, // ignore sub-2-point noise from rounding
): MtfDriftRow[] {
  const out: MtfDriftRow[] = [];
  for (const p of positions) {
    if (!(p.buyValue > 0)) continue;
    // A ROW THE JOURNAL NEVER PRICED HAS NO ENTRY MARGIN (v4.3.0 wave 2L,
    // L2[1]). `?? 0` read a null funded amount as "the broker funded nothing",
    // so a position whose funding was never resolved was STATED at 100% own
    // margin: `storedOwnPct` 100, a large NEGATIVE delta, and a card telling
    // the trader the requirement had FALLEN and no top-up was owed. The Trades
    // table's own cell already refuses a percentage for exactly this row
    // ("MTF · funding not yet resolved", `investedSummary`), so the two
    // surfaces disagreed about the same trade. It is EXCLUDED and counted
    // instead (invariant 6) — `unpricedMtfPositions` below names it on the
    // card. A STATED 0 really is 100% own capital and keeps its row, the same
    // null-vs-0 rule every other reader follows.
    if (p.mtfFundedAmount == null) continue;
    const funded = p.mtfFundedAmount;
    const own = p.buyValue - funded;
    if (own <= 0) continue; // malformed row — nothing honest to compare
    const storedOwnPct = r2((own / p.buyValue) * 100);
    const cur = resolve(p.broker, p.symbol);
    const deltaPct = r2(cur.pct - storedOwnPct);
    if (Math.abs(deltaPct) < thresholdPct) continue;
    out.push({
      id: p.id,
      symbol: p.symbol,
      broker: p.broker,
      storedOwnPct,
      currentPct: cur.pct,
      deltaPct,
      topUpAtCurrent: deltaPct > 0 ? r2((deltaPct / 100) * p.buyValue) : 0,
      source: cur.source,
    });
  }
  return out.sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));
}

/**
 * The open MTF rows the drift check had to leave out: the journal never
 * resolved what the broker funded, so there is no entry margin to compare
 * today's requirement against. Counted rather than priced, so the card can say
 * what it is not showing instead of printing a number for it (invariant 6).
 */
export function unpricedMtfPositions(positions: OpenMtfPosition[]): OpenMtfPosition[] {
  return positions.filter((p) => p.buyValue > 0 && p.mtfFundedAmount == null);
}
