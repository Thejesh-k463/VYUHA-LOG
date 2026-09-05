/**
 * A3 / A4 — new 52-week highs and lows, and net high-low.
 *
 * `high[t] >= max(high over the last <=252 sessions INCLUDING t)` is a new
 * high; `low[t] <= min(low ...)` is a new low. The window is capped at 252
 * sessions but does NOT require 252: it requires at least 20, below which the
 * symbol has no opinion at all and leaves the denominator.
 *
 * The label matters as much as the number: only a full 252-session window may
 * be called "52w". Anything shorter is labelled `{n}d` by `highLowLabel()` and
 * the UI must print that label, not "52w".
 */
import {
  HIGH_LOW_LOOKBACK,
  HIGH_LOW_MIN_SESSIONS,
  barHigh,
  barLow,
  countMetric,
  shareMetric,
  type CountMetric,
  type Metric,
  type Series,
} from "./types";

export interface HighLowOptions {
  lookback?: number;
  minSessions?: number;
}

export interface HighLowResult {
  newHighs: Metric;
  newLows: Metric;
  /** A4: highs minus lows, over the same denominator. */
  netHighLow: CountMetric;
  counts: { highs: number; lows: number; valid: number };
  insufficient: string[];
  /** `"52w"` only at a full 252-session window; otherwise `"{n}d"`. */
  label: string;
  /** Sessions actually used by the deepest symbol in the window. */
  windowSessions: number;
}

/** The window label. A shorter window is never allowed to claim "52w". */
export function highLowLabel(windowSessions: number, lookback: number = HIGH_LOW_LOOKBACK): string {
  return windowSessions >= lookback ? "52w" : `${windowSessions}d`;
}

/** Is the last bar a new high / low over its own window? `null` under `minSessions`. */
export function symbolHighLow(
  series: Series,
  opts: HighLowOptions = {},
): { isHigh: boolean; isLow: boolean; sessions: number } | null {
  const lookback = opts.lookback ?? HIGH_LOW_LOOKBACK;
  const minSessions = opts.minSessions ?? HIGH_LOW_MIN_SESSIONS;
  const n = series.bars.length;
  if (n < minSessions) return null;
  const window = series.bars.slice(Math.max(0, n - lookback));
  const last = window[window.length - 1];
  let max = -Infinity;
  let min = Infinity;
  for (const b of window) {
    const h = barHigh(b);
    const l = barLow(b);
    if (h > max) max = h;
    if (l < min) min = l;
  }
  return { isHigh: barHigh(last) >= max, isLow: barLow(last) <= min, sessions: window.length };
}

/** A3 + A4 over an anchor-aligned universe. */
export function computeHighLow(series: Series[], coverageBase: number, opts: HighLowOptions = {}): HighLowResult {
  const lookback = opts.lookback ?? HIGH_LOW_LOOKBACK;
  let highs = 0;
  let lows = 0;
  let valid = 0;
  let windowSessions = 0;
  const insufficient: string[] = [];
  for (const s of series) {
    const verdict = symbolHighLow(s, opts);
    if (!verdict) {
      insufficient.push(s.symbol);
      continue;
    }
    valid += 1;
    windowSessions = Math.max(windowSessions, verdict.sessions);
    if (verdict.isHigh) highs += 1;
    if (verdict.isLow) lows += 1;
  }
  const reason = valid === 0 ? "insufficient_history" : undefined;
  return {
    newHighs: shareMetric(highs, valid, coverageBase, reason),
    newLows: shareMetric(lows, valid, coverageBase, reason),
    netHighLow: countMetric(valid === 0 ? null : highs - lows, valid, coverageBase, reason),
    counts: { highs, lows, valid },
    insufficient: insufficient.sort(),
    label: highLowLabel(windowSessions, lookback),
    windowSessions,
  };
}
