// M2 — Winners-vs-losers analytics (PURE, no DB/React). The payoff/win-rate
// trade-off against the breakeven curve, the R-multiple distribution split by
// where the R came from, and the loss-tail report.
//
// INPUT CONTRACT: callers pass CLOSED, PRICED trades — i.e. they have already
// applied `edgeMeasurable` (lib/analytics/metrics.ts) and dropped open rows.
// Both filters are re-applied defensively (via computeKpis and local checks),
// but coverage counts ("N of M") are computed over what arrives here, so a
// caller that forgets the filter gets defensible numbers with the wrong
// denominators on display. Filter first.
//
// Honesty rules this module encodes:
// - Payoff ratio is NULL when there are no losses or no wins — never Infinity
//   in the wire shape (a book with no losses yet has an unmeasurable payoff,
//   not an infinitely good one).
// - The R histogram is SPLIT by provenance: a row carries plan-derived R only
//   when its R DENOMINATOR verifiably derives from a recorded stop —
//   riskAmount within PLAN_R_RISK_TOLERANCE of |avgEntryPrice − stop| × qty
//   (see hasPlanR). Merely RECORDING a stop is not enough: the Stop-losses
//   tab's own suggested workflow records a stop on a trade whose riskAmount
//   stays the import default (edit-trade-dialog's riskTouched blocks the
//   SL-derived recompute), and rMultiple = netPnl / riskAmount, so that row's
//   R is still measured in cap units. Everything unverifiable carries
//   default-cap R — netPnl over the per-trade cap (₹9,500 default, see
//   lib/import/commit.ts) — which measures P&L in cap units, NOT plan
//   adherence, and must never be presented unlabelled.
// - Tail economics use the expectancy-GAP framing of behavior.ts
//   mistakeReport: deep losses cost ₹X per trade versus the clean-loss
//   average — never a counterfactual "you would have saved ₹X".

import {
  computeKpis,
  type AnalyticsTrade,
  type Kpis,
} from "@/lib/analytics/metrics";
import { wilsonInterval, type Interval } from "@/lib/analytics/inference";

export interface WinLossTrade extends AnalyticsTrade {
  /** Planned stop-loss LEVEL (per-unit rupees, REAL) — a candidate stop for hasPlanR. */
  slPlanned: number | null;
  /** Trailing stop LEVEL (per-unit rupees, REAL) — a candidate stop for hasPlanR. */
  trailingSl: number | null;
  /** Weighted-average buy price (per-unit rupees, REAL). Null/0 when unknown. */
  avgBuyPrice: number | null;
  /** Weighted-average sell price (per-unit rupees, REAL). Null/0 when unknown. */
  avgSellPrice: number | null;
  /** Traded quantity — max(buyQty, sellQty) on the flat row. Null/0 when unknown. */
  qty: number | null;
  /** The R denominator actually stored on the row (₹, runtime rupees). */
  riskAmount: number | null;
}

/** Closed priced trades needed before a verdict stops being mostly noise. */
export const MIN_SAMPLE = 20;

/**
 * Distance from the breakeven curve (in win-rate points) inside which the
 * quadrant label is a coin flip and we say so instead.
 */
export const NEAR_BREAKEVEN_MARGIN = 0.05;

export type WinLossVerdict =
  | "wins-big-loses-small"
  | "wins-big-loses-big"
  | "wins-small-loses-small"
  | "wins-small-loses-big"
  | "near-breakeven";

export interface WinLossReport {
  /** Full KPI block — win rate, avgWin/avgLoss, profit factor, expectancy. */
  kpis: Kpis;
  /** Closed trades whose edge is measurable — the denominator for every ratio here. */
  n: number;
  /** avgWin / |avgLoss|. Null when no wins or no losses — never Infinity. */
  payoff: number | null;
  /** Wilson 95% interval on the win rate over the n priced closed trades. */
  winRate: Interval;
  /** Breakeven payoff at the observed win rate: (1-w)/w. Null when w is 0 or n is 0. */
  payoffNeeded: number | null;
  /** Breakeven win rate at the observed payoff: 1/(1+payoff). Null when payoff is null. */
  winRateNeeded: number | null;
  /** Null below MIN_SAMPLE, or when payoff is unmeasurable (no wins or no losses). */
  verdict: WinLossVerdict | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * The four quadrants sit around the point where the breakeven curve
 * w = 1/(1+payoff) crosses payoff = 1 (i.e. w = 0.5):
 *
 * - "wins-big" / "wins-small" is the MAGNITUDE axis — payoff >= 1 means the
 *   average win is at least the average loss.
 * - "loses-small" / "loses-big" is the FREQUENCY axis — winRate >= 0.5 means
 *   losses are the minority of trades.
 *
 * The mixed quadrants (trend-follower: big wins, frequent losses; scalper:
 * small wins, rare losses) can sit on either side of the curve, which is why
 * the near-breakeven check runs FIRST: within NEAR_BREAKEVEN_MARGIN win-rate
 * points of the curve, any quadrant label would be a coin flip.
 */
function classify(n: number, winRate: number, payoff: number | null): WinLossVerdict | null {
  if (n < MIN_SAMPLE || payoff == null) return null;
  const wNeeded = 1 / (1 + payoff);
  // r4 keeps the boundary deterministic: 0.55 - 0.5 is 0.050000000000000044
  // in binary floats, which would flip an exactly-on-margin book to a quadrant.
  if (r4(Math.abs(winRate - wNeeded)) <= NEAR_BREAKEVEN_MARGIN) return "near-breakeven";
  const winsBig = payoff >= 1;
  const losesSmall = winRate >= 0.5;
  if (winsBig) return losesSmall ? "wins-big-loses-small" : "wins-big-loses-big";
  return losesSmall ? "wins-small-loses-small" : "wins-small-loses-big";
}

export function winLossReport(trades: WinLossTrade[]): WinLossReport {
  const kpis = computeKpis(trades);
  const n = kpis.closedCount - kpis.unpricedCount;
  const payoff =
    kpis.wins > 0 && kpis.losses > 0 ? r4(kpis.avgWin / Math.abs(kpis.avgLoss)) : null;
  const winRate = wilsonInterval(kpis.wins, n);
  const payoffNeeded =
    n > 0 && kpis.winRate > 0 ? r4((1 - kpis.winRate) / kpis.winRate) : null;
  const winRateNeeded = payoff != null ? r4(1 / (1 + payoff)) : null;
  return {
    kpis,
    n,
    payoff,
    winRate,
    payoffNeeded,
    winRateNeeded,
    verdict: classify(n, kpis.winRate, payoff),
  };
}

// ---------------------------------------------------------------------------
// R distribution — split by where the R came from
// ---------------------------------------------------------------------------

/** Interior bucket edges; the first and last buckets are open tails. */
export const R_BUCKET_EDGES = [-3, -2, -1, -0.5, 0, 0.5, 1, 2, 3, 5] as const;

export interface RBucket {
  /** Lower edge, null for the open left tail. Buckets are [lo, hi). */
  lo: number | null;
  /** Upper edge, null for the open right tail. */
  hi: number | null;
  label: string;
  /** Trades whose R denominator verifiably derives from a recorded stop (hasPlanR). */
  plan: number;
  /** Trades whose R is netPnl over the per-trade cap — NOT plan adherence. */
  defaultCap: number;
}

export interface RDistribution {
  edges: number[];
  buckets: RBucket[];
  /** Closed priced trades with an R in the plan-derived series. */
  planCount: number;
  /** Closed priced trades with an R in the default-cap series. */
  defaultCapCount: number;
  /** Closed priced trades carrying no rMultiple at all — in neither series. */
  noRCount: number;
}

/**
 * Relative tolerance for tying riskAmount back to a recorded stop:
 * |riskAmount − |avgPrice − stop| × qty| / (|avgPrice − stop| × qty) ≤ 2%.
 * Wide enough to absorb rupee-rounding of riskAmount and weighted-average
 * price truncation; narrow enough that the ₹9,500 import default cannot
 * coincidentally pass except by an actual match.
 */
export const PLAN_R_RISK_TOLERANCE = 0.02;

/**
 * True when the row's R DENOMINATOR verifiably derives from a recorded stop —
 * not merely when a stop exists. rMultiple = netPnl / riskAmount, and a trade
 * can record a stop while riskAmount remains the import default (the
 * Stop-losses tab's suggested workflow produces exactly this: edit-trade-dialog
 * sets riskTouched, which blocks the SL-derived risk recompute). Presence-only
 * classification put cap-unit R in the plan series; here the tie is proven:
 * some recorded stop (slPlanned or trailingSl) must reproduce riskAmount as
 * |avgPrice − stop| × qty within PLAN_R_RISK_TOLERANCE.
 *
 * The match is accepted against EITHER avgBuyPrice or avgSellPrice: direction
 * (long/short) is not derivable from a flat row, so we cannot know which side
 * was the entry — but matching either side proves the denominator was computed
 * from the stop and an actual traded price, which is the provenance claim the
 * plan series makes. When any verification input is absent, the row is
 * default-cap: never overclaim provenance.
 */
export function hasPlanR(t: WinLossTrade): boolean {
  const risk = t.riskAmount;
  const qty = t.qty;
  if (risk == null || risk <= 0 || qty == null || qty <= 0) return false;
  const stops = [t.slPlanned, t.trailingSl].filter((s): s is number => s != null);
  if (stops.length === 0) return false;
  const prices = [t.avgBuyPrice, t.avgSellPrice].filter((p): p is number => p != null && p > 0);
  for (const stop of stops) {
    for (const price of prices) {
      const implied = Math.abs(price - stop) * qty;
      if (implied > 0 && Math.abs(risk - implied) / implied <= PLAN_R_RISK_TOLERANCE) return true;
    }
  }
  return false;
}

const fmtR = (x: number) => `${x}R`;

function bucketLabel(lo: number | null, hi: number | null): string {
  if (lo == null) return `< ${fmtR(hi!)}`;
  if (hi == null) return `≥ ${fmtR(lo)}`;
  return `${fmtR(lo)} to ${fmtR(hi)}`;
}

/**
 * Histogram of rMultiple over closed priced trades, one series per R
 * provenance. Renders at any n — the per-series counts ARE the caveat, so
 * surfaces must show them.
 */
export function rDistribution(trades: WinLossTrade[]): RDistribution {
  const edges = [...R_BUCKET_EDGES];
  const buckets: RBucket[] = [];
  buckets.push({ lo: null, hi: edges[0], label: bucketLabel(null, edges[0]), plan: 0, defaultCap: 0 });
  for (let i = 0; i < edges.length - 1; i++) {
    buckets.push({ lo: edges[i], hi: edges[i + 1], label: bucketLabel(edges[i], edges[i + 1]), plan: 0, defaultCap: 0 });
  }
  buckets.push({ lo: edges[edges.length - 1], hi: null, label: bucketLabel(edges[edges.length - 1], null), plan: 0, defaultCap: 0 });

  let planCount = 0, defaultCapCount = 0, noRCount = 0;
  for (const t of trades) {
    if (t.isOpen) continue;
    if (t.rMultiple == null) {
      noRCount++;
      continue;
    }
    const r = t.rMultiple;
    // [lo, hi) everywhere; the last bucket catches r >= top edge.
    let idx = buckets.length - 1;
    for (let i = 0; i < buckets.length - 1; i++) {
      if (r < edges[i]) { idx = i; break; }
    }
    if (hasPlanR(t)) { buckets[idx].plan++; planCount++; }
    else { buckets[idx].defaultCap++; defaultCapCount++; }
  }
  return { edges, buckets, planCount, defaultCapCount, noRCount };
}

// ---------------------------------------------------------------------------
// Tail report — how concentrated the losses are, and what the deep ones cost
// ---------------------------------------------------------------------------

/** Plan-derived R at or below this marks a loss as "deep" — past the planned stop by 2×. */
export const DEEP_LOSS_R = -2;

export interface TailReport {
  /** Closed losing trades (netPnl < 0). */
  lossCount: number;
  /** Σ|loss| in rupees, >= 0. */
  grossLoss: number;
  /** |worst single loss|. Null when there are no losses. */
  worstLoss: number | null;
  /** worstLoss / grossLoss, 0..1. Null when there are no losses. */
  worstLossShare: number | null;
  /** How many trades the "worst 5%" is: ceil(5% of closed trades), min 1. */
  worst5PctCount: number;
  /** Share of gross losses carried by the worst5PctCount worst trades. Null when no losses. */
  worst5PctShare: number | null;
  /**
   * Coverage for the deep-loss economics: how many of the losses carry a
   * plan-derived R (hasPlanR — the R denominator verifiably ties to a recorded
   * stop). Say "recorded of total" wherever the gap is shown — default-cap R
   * cannot say whether a stop was overrun, so those rows are excluded, not
   * assumed clean.
   */
  planLossCoverage: { recorded: number; total: number };
  /** Plan-derived losses with R <= DEEP_LOSS_R. */
  deepLossCount: number;
  /** Plan-derived losses with DEEP_LOSS_R < R < 0 — the "clean" losses. */
  cleanLossCount: number;
  /** Mean net P&L of deep losses (₹, negative). Null when none. */
  deepLossAvg: number | null;
  /** Mean net P&L of clean losses (₹, negative). Null when none. */
  cleanLossAvg: number | null;
  /**
   * Expectancy gap per deep loss: cleanLossAvg − deepLossAvg (₹/trade given up
   * versus the clean-loss average). Null unless BOTH sides have a sample.
   */
  deepLossGapPerTrade: number | null;
  /** deepLossGapPerTrade × deepLossCount — the headline "cost ₹X" figure. */
  deepLossGapTotal: number | null;
}

/**
 * Loss concentration and deep-loss economics. Framed as an expectancy GAP
 * (deep losses vs the clean-loss average) per behavior.ts mistakeReport —
 * never as counterfactual P&L, because "what the stop would have saved" is
 * not observable.
 */
export function tailReport(trades: WinLossTrade[]): TailReport {
  const closed = trades.filter((t) => !t.isOpen);
  const losses = closed.filter((t) => t.netPnl < 0);
  const lossCount = losses.length;
  const grossLoss = r2(losses.reduce((s, t) => s + Math.abs(t.netPnl), 0));

  const worst5PctCount = Math.max(1, Math.ceil(closed.length * 0.05));
  let worstLoss: number | null = null;
  let worstLossShare: number | null = null;
  let worst5PctShare: number | null = null;
  if (lossCount > 0 && grossLoss > 0) {
    const sorted = losses.map((t) => Math.abs(t.netPnl)).sort((a, b) => b - a);
    worstLoss = r2(sorted[0]);
    worstLossShare = r4(sorted[0] / grossLoss);
    const topSum = sorted.slice(0, worst5PctCount).reduce((s, v) => s + v, 0);
    worst5PctShare = r4(topSum / grossLoss);
  }

  const planLosses = losses.filter((t) => hasPlanR(t) && t.rMultiple != null);
  const deep = planLosses.filter((t) => t.rMultiple! <= DEEP_LOSS_R);
  const clean = planLosses.filter((t) => t.rMultiple! > DEEP_LOSS_R);
  const mean = (xs: WinLossTrade[]) =>
    xs.length ? r2(xs.reduce((s, t) => s + t.netPnl, 0) / xs.length) : null;
  const deepLossAvg = mean(deep);
  const cleanLossAvg = mean(clean);
  const deepLossGapPerTrade =
    deepLossAvg != null && cleanLossAvg != null ? r2(cleanLossAvg - deepLossAvg) : null;

  return {
    lossCount,
    grossLoss,
    worstLoss,
    worstLossShare,
    worst5PctCount,
    worst5PctShare,
    planLossCoverage: { recorded: planLosses.length, total: lossCount },
    deepLossCount: deep.length,
    cleanLossCount: clean.length,
    deepLossAvg,
    cleanLossAvg,
    deepLossGapPerTrade,
    deepLossGapTotal:
      deepLossGapPerTrade != null ? r2(deepLossGapPerTrade * deep.length) : null,
  };
}
