/**
 * A2 — % of the universe above its SMA(20 / 50 / 200).
 *
 * Membership is STRICTLY above: `close[t] > mean(close[t-N+1..t])`. Equality
 * is NOT membership. Changing that to "at or above" is a MAJOR SPEC_VERSION
 * bump (04 section 4.3), because it silently re-values every stored row.
 *
 * A symbol with fewer than N closes has no opinion and is excluded from the
 * DENOMINATOR — the universe count is never reused as the denominator of a
 * metric that needs 200 sessions (04 section 4.4, item 2).
 */
import { shareMetric, type Metric, type Series } from "./types";

export interface SmaBreadthResult {
  period: number;
  metric: Metric;
  /** Symbols with fewer than `period` closes. */
  insufficient: string[];
  /** The deepest history any symbol has, for the "you have N" shortfall line. */
  deepestSessions: number;
}

/** The simple mean of the last `period` closes, or `null` under `period` sessions. */
export function smaOf(closes: number[], period: number): number | null {
  if (period <= 0 || closes.length < period) return null;
  let sum = 0;
  for (let i = closes.length - period; i < closes.length; i++) sum += closes[i];
  return sum / period;
}

/** `true` only when the latest close is STRICTLY above the SMA. */
export function isAboveSma(closes: number[], period: number): boolean | null {
  const sma = smaOf(closes, period);
  if (sma === null) return null;
  return closes[closes.length - 1] > sma;
}

/** A2 for one period over an anchor-aligned universe. */
export function computeSmaBreadth(series: Series[], period: number, coverageBase: number): SmaBreadthResult {
  let above = 0;
  let valid = 0;
  let deepestSessions = 0;
  const insufficient: string[] = [];
  for (const s of series) {
    deepestSessions = Math.max(deepestSessions, s.bars.length);
    const closes = s.bars.map((b) => b.close);
    const verdict = isAboveSma(closes, period);
    if (verdict === null) {
      insufficient.push(s.symbol);
      continue;
    }
    valid += 1;
    if (verdict) above += 1;
  }
  return {
    period,
    metric: shareMetric(above, valid, coverageBase, valid === 0 ? "insufficient_history" : undefined),
    insufficient: insufficient.sort(),
    deepestSessions,
  };
}

/** A2 for every configured period, keyed by period. */
export function computeSmaBreadthSet(
  series: Series[],
  periods: readonly number[],
  coverageBase: number,
): Record<number, SmaBreadthResult> {
  const out: Record<number, SmaBreadthResult> = {};
  for (const p of periods) out[p] = computeSmaBreadth(series, p, coverageBase);
  return out;
}
