/**
 * KPI DRILL-DOWNS THAT REPRODUCE THEIR OWN NUMBER (v4.4.0 D6).
 *
 * Pure — no DB, no React (invariant 2). The dashboard's Profit-factor popup
 * used to sum winners and losers in a local loop over EVERY closed trade while
 * `computeKpis` divides only the PRICED ones (`edgeMeasurable`), so one
 * acquisition-flagged winner put "₹1,20,000 ÷ ₹60,000" above a printed PF of
 * 1.62. The rows now read `Kpis.winnersNet` / `losersNet` — the exact two sums
 * the headline divides — so r2(winners ÷ |losers|) = `k.profitFactor` by
 * construction.
 *
 * Both sums are NET P&L: after charges. The labels say so; "gross" was wrong.
 */

import type { GroupStat, Kpis } from "@/lib/analytics/metrics";
import { DEPTH_SEGMENTS } from "@/lib/analytics/segment-depth";
import type { Segment } from "@/lib/domain/constants";
import { inr } from "@/lib/format";

/** Structurally the KpiCard `KpiDetailRow` — declared here so this module
 *  never imports a client component. */
export interface KpiDetailLine {
  label: string;
  value: string;
  tone?: "profit" | "loss" | "neutral";
  hint?: string;
}

export const PROFIT_FACTOR_TITLE = "Profit factor — winners ÷ losers, after charges";

/** The three rows of the Profit-factor popup. */
export function profitFactorRows(k: Pick<Kpis, "winnersNet" | "losersNet" | "profitFactor">): KpiDetailLine[] {
  return [
    { label: "Total from winners (after charges)", value: inr(k.winnersNet, { decimals: 0 }), tone: "profit" },
    { label: "Total from losers (after charges)", value: `−${inr(Math.abs(k.losersNet), { decimals: 0 })}`, tone: "loss" },
    {
      label: "Profit factor",
      value: k.profitFactor === Infinity ? "∞" : k.profitFactor.toFixed(2),
      tone: k.profitFactor >= 1 ? "profit" : "loss",
    },
  ];
}

/** One row of the dashboard's per-segment edge table. */
export interface SegmentEdgeRow {
  segment: Segment;
  label: string;
  /** Priced closed trades — the denominator of every ratio in the row. */
  pricedCount: number;
  /** Closed trades held out for want of a cost basis (counted, not bucketed). */
  unpricedCount: number;
  winRate: number | null;
  /** null = no losing trade yet (or nothing priced). */
  profitFactor: number | null;
  payoff: number | null;
  /** ₹ per priced closed trade; null when nothing is priced. */
  expectancy: number | null;
  /** True when the segment has priced trades but no loser — the PF cell says so. */
  noLoserYet: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The per-segment table beside the dashboard's segment bars: win rate · PF ·
 * payoff · expectancy for `DEPTH_SEGMENTS` only (the five businesses —
 * DECISIONS "segment depth"), in their order, from `groupBy`'s own figures.
 * FREE (v4.4.0 OQ3): the dashboard's segment filter already shows each
 * segment's PF unlicensed, and the dashboard is never gated (invariant 7).
 * Segments with no closed trade are omitted rather than printed as zeroes.
 */
export function segmentEdgeRows(stats: GroupStat[]): SegmentEdgeRow[] {
  const byKey = new Map(stats.map((g) => [g.key, g]));
  const out: SegmentEdgeRow[] = [];
  for (const d of DEPTH_SEGMENTS) {
    const g = byKey.get(d.segment);
    if (!g) continue;
    out.push({
      segment: d.segment,
      label: d.label,
      pricedCount: g.pricedCount,
      unpricedCount: g.count - g.pricedCount,
      winRate: g.winRate,
      profitFactor: g.profitFactor,
      payoff: g.payoff,
      expectancy: g.pricedCount ? r2(g.pricedNet / g.pricedCount) : null,
      noLoserYet: g.pricedCount > 0 && g.losersNet === 0,
    });
  }
  return out;
}
