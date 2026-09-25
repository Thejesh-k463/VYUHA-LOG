/**
 * Relative strength, RSI extremes and rank Δ (v4.6.0 W5, owner rulings AQ5 /
 * AQ9 / AQ20 / AQ26).
 *
 * RS (Sentinel S11, adopted): per symbol,
 *     rs_ppm = Σ w_i × (r_i − median_i),   windows 5 / 21 / 63, weights 0.5 / 0.3 / 0.2
 * where `median_i` is the CROSS-SECTIONAL MEDIAN of r_i over the ELIGIBLE
 * universe — the market median is the only benchmark in W5 (AQ20; an index leg,
 * if ever wanted, is an owner file drop first). Eligibility: anchor-bar
 * turnover (close × volume) ≥ ₹1 cr, close ≥ ₹20, no corporate-action gap in
 * the 63-session span, ≥ 64 bars. A symbol with no volume on the anchor bar is
 * INELIGIBLE (`no_baseline`): a turnover floor cannot be checked against a null.
 *
 * The per-symbol figure is a `{ rsPpm, eligible, reason }` row, not a Metric —
 * three weighted windows are not a denominator of anything real (invariant 6),
 * so the universe publishes ONE honest count instead: "RS over N eligible of M
 * priced". Group RS is the MEDIAN of member rs (≥ 3 to compute, ≥ 8 to rank).
 *
 * Rank Δ is a helper over two ranked snapshots; WHICH snapshots is the query's
 * business (`atlas_metric JOIN atlas_daily ON as_of` under one `spec_version`,
 * design review A1) and the shortfall line prints how many exist.
 *
 * RSI is Wilder's smoothing over closes, period 14; "extreme" is ≤ 30 / ≥ 70
 * and both thresholds travel with the counts so the tile can print them.
 *
 * PURE: no DB, no React, no clock.
 */
import { gapInWindow, symbolReturnPpm, type CaGap } from "./returns";
import {
  GROUP_MIN_COMPUTE,
  RSI_HIGH,
  RSI_LOW,
  RSI_PERIOD,
  RS_MIN_BARS,
  RS_MIN_PRICE,
  RS_MIN_TURNOVER_RUPEES,
  RS_WEIGHTS,
  RS_WINDOWS,
  countMetric,
  medianMetric,
  roundPpm,
  type CountMetric,
  type Metric,
  type Series,
} from "./types";

// ---------------------------------------------------------------------------
// RSI
// ---------------------------------------------------------------------------

/**
 * Wilder's RSI over the closes, or `null` under `period + 1` closes. The first
 * average gain/loss is the simple mean of the first `period` changes; every
 * later one is `(prev × (period − 1) + change) / period`. No losses at all is
 * 100; no gains at all is 0.
 */
export function wilderRsi(closes: number[], period: number = RSI_PERIOD): number | null {
  if (period <= 0 || closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

export interface RsiOptions {
  period?: number;
  low?: number;
  high?: number;
}

export interface RsiExtremesResult {
  /** Symbols at or below `thresholds.low`, over the symbols with an RSI. */
  low: CountMetric;
  /** Symbols at or above `thresholds.high`, over the same denominator. */
  high: CountMetric;
  /** Symbols with `period + 1` closes. */
  valid: number;
  insufficient: string[];
  /** Printed on the tile — the thresholds are constants, never a hidden rule. */
  thresholds: { period: number; low: number; high: number };
  /** Per-symbol RSI for the callers that rank or group it. */
  bySymbol: Map<string, number>;
}

/** RSI extremes over an anchor-aligned set. `coverageBase` is the included universe (or the group). */
export function rsiExtremes(series: Series[], coverageBase: number, opts: RsiOptions = {}): RsiExtremesResult {
  const period = opts.period ?? RSI_PERIOD;
  const low = opts.low ?? RSI_LOW;
  const high = opts.high ?? RSI_HIGH;
  const bySymbol = new Map<string, number>();
  const insufficient: string[] = [];
  let lows = 0;
  let highs = 0;
  for (const s of series) {
    const rsi = wilderRsi(s.bars.map((b) => b.close), period);
    if (rsi === null) {
      insufficient.push(s.symbol);
      continue;
    }
    bySymbol.set(s.symbol, rsi);
    if (rsi <= low) lows++;
    if (rsi >= high) highs++;
  }
  const valid = bySymbol.size;
  const reason = valid === 0 ? "insufficient_history" : undefined;
  return {
    low: countMetric(valid === 0 ? null : lows, valid, coverageBase, reason),
    high: countMetric(valid === 0 ? null : highs, valid, coverageBase, reason),
    valid,
    insufficient: insufficient.sort(),
    thresholds: { period, low, high },
    bySymbol,
  };
}

// ---------------------------------------------------------------------------
// Relative strength
// ---------------------------------------------------------------------------

/** The anchor bar's turnover, close × volume in rupees, or `null` without a volume. */
export function anchorTurnover(series: Series): number | null {
  const last = series.bars[series.bars.length - 1];
  if (!last || last.volume === null || last.volume === undefined || !(last.close > 0)) return null;
  return last.close * last.volume;
}

export type RsIneligibleReason =
  | "insufficient_history"
  | "no_baseline"
  | "below_turnover_floor"
  | "below_price_floor"
  | "corporate_action_unreconciled";

export interface RsRow {
  symbol: string;
  /** Integer ppm, `null` when ineligible. */
  rsPpm: number | null;
  eligible: boolean;
  reason?: RsIneligibleReason;
  /** The windowed returns that went in, keyed by session count ("5", "21", "63"). */
  returns: Record<string, number | null>;
  turnover: number | null;
}

export interface RsOptions {
  windows?: readonly number[];
  weights?: readonly number[];
  minTurnoverRupees?: number;
  minPrice?: number;
  minBars?: number;
}

export interface RsResult {
  bySymbol: Map<string, RsRow>;
  /** Symbols that passed every floor and carry an rs. */
  eligible: number;
  /** Symbols submitted (the aligned universe). */
  priced: number;
  /** The cross-sectional median return per window over the eligible set, ppm. */
  medians: Record<string, number | null>;
  windows: readonly number[];
  weights: readonly number[];
  floors: { minTurnoverRupees: number; minPrice: number; minBars: number };
  /** How many symbols each reason removed — printed under the table. */
  ineligible: Partial<Record<RsIneligibleReason, number>>;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : roundPpm((sorted[mid - 1] + sorted[mid]) / 2);
}

/** RS for every symbol of an anchor-aligned universe. See the module header for the formula. */
export function computeRelativeStrength(
  series: Series[],
  opts: RsOptions = {},
  gapsBySymbol: Map<string, CaGap[]> = new Map(),
): RsResult {
  const windows = opts.windows ?? RS_WINDOWS;
  const weights = opts.weights ?? RS_WEIGHTS;
  if (windows.length !== weights.length) throw new Error("computeRelativeStrength: windows and weights differ in length");
  const floors = {
    minTurnoverRupees: opts.minTurnoverRupees ?? RS_MIN_TURNOVER_RUPEES,
    minPrice: opts.minPrice ?? RS_MIN_PRICE,
    minBars: opts.minBars ?? RS_MIN_BARS,
  };
  const longest = Math.max(...windows);

  const bySymbol = new Map<string, RsRow>();
  const ineligible: Partial<Record<RsIneligibleReason, number>> = {};
  const eligibleRows: RsRow[] = [];
  const drop = (row: RsRow, reason: RsIneligibleReason) => {
    row.eligible = false;
    row.reason = reason;
    row.rsPpm = null;
    ineligible[reason] = (ineligible[reason] ?? 0) + 1;
  };

  for (const s of series) {
    const turnover = anchorTurnover(s);
    const returns: Record<string, number | null> = {};
    for (const w of windows) returns[String(w)] = symbolReturnPpm(s, w);
    const row: RsRow = { symbol: s.symbol, rsPpm: null, eligible: true, returns, turnover };
    bySymbol.set(s.symbol, row);

    const last = s.bars[s.bars.length - 1];
    if (s.bars.length < floors.minBars || windows.some((w) => returns[String(w)] === null)) {
      drop(row, "insufficient_history");
      continue;
    }
    if (turnover === null) {
      drop(row, "no_baseline");
      continue;
    }
    if (last.close < floors.minPrice) {
      drop(row, "below_price_floor");
      continue;
    }
    if (turnover < floors.minTurnoverRupees) {
      drop(row, "below_turnover_floor");
      continue;
    }
    if (gapInWindow(s, longest, gapsBySymbol.get(s.symbol) ?? [])) {
      drop(row, "corporate_action_unreconciled");
      continue;
    }
    eligibleRows.push(row);
  }

  const medians: Record<string, number | null> = {};
  for (const w of windows) {
    medians[String(w)] = median(eligibleRows.map((r) => r.returns[String(w)] as number));
  }
  for (const row of eligibleRows) {
    let sum = 0;
    windows.forEach((w, i) => {
      sum += weights[i] * ((row.returns[String(w)] as number) - (medians[String(w)] as number));
    });
    row.rsPpm = roundPpm(sum);
  }

  return {
    bySymbol,
    eligible: eligibleRows.length,
    priced: series.length,
    medians,
    windows,
    weights,
    floors,
    ineligible,
  };
}

/**
 * Group RS: the MEDIAN of the members' rs over the members that carry one.
 * Under `minMembers` eligible members the figure is null with
 * `insufficient_members` (AQ26: 3 to compute); the 8-to-rank floor is the
 * caller's, because ranking is a property of the table, not of one row.
 */
export function groupRs(members: Series[], rs: RsResult, minMembers: number = GROUP_MIN_COMPUTE): Metric {
  const values: number[] = [];
  for (const m of members) {
    const row = rs.bySymbol.get(m.symbol);
    if (row?.eligible && row.rsPpm !== null) values.push(row.rsPpm);
  }
  if (values.length < minMembers) {
    return { value_ppm: null, numerator: 0, denominator: values.length, coverage_ppm: 0, reason: "insufficient_members" };
  }
  return medianMetric(values, members.length);
}

// ---------------------------------------------------------------------------
// Rank Δ
// ---------------------------------------------------------------------------

/**
 * Dense ranking, 1 = the highest value; ties broken by name so the answer is
 * stable across runs. A null value has no rank and is absent from the map.
 */
export function rankByValue(rows: { group: string; value: number | null }[]): Map<string, number> {
  const ranked = rows
    .filter((r): r is { group: string; value: number } => r.value !== null)
    .sort((a, b) => b.value - a.value || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
  const out = new Map<string, number>();
  ranked.forEach((r, i) => out.set(r.group, i + 1));
  return out;
}

/**
 * `past rank − current rank` per group: positive = climbed. `null` when the
 * past snapshot is missing or did not rank the group — never a silent 0.
 */
export function rankDelta(current: Map<string, number>, past: Map<string, number> | null): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const [group, rank] of current) {
    const before = past?.get(group);
    out.set(group, before === undefined ? null : before - rank);
  }
  return out;
}

/** The sentence a table prints while it lacks the snapshots (design review A1: DAILY SNAPSHOTS, not sessions). */
export function rankDeltaShortfallLine(have: number, need: number): string {
  return (
    `rank Δ needs ${need} daily snapshots under this formula set; you have ${have} ` +
    "(one is written each day Atlas is opened with new bars)"
  );
}
