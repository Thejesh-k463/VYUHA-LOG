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
    const funded = p.mtfFundedAmount ?? 0;
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
