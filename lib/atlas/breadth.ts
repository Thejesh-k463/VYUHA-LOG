/**
 * A1 — advance / decline / unchanged.
 *
 * `close[t] > close[t-1]` advances, `<` declines, `=` is unchanged. Two
 * sessions is the whole requirement; a symbol with one bar has no direction
 * and is counted as insufficient history, never as "unchanged" (that would
 * fabricate a denominator, invariant 6).
 *
 * A symbol flagged `corporate_action_unreconciled` STAYS here (04 section 4.4:
 * the guard excludes from the return windows, not from breadth) — a 1:5 split
 * is a real down-close in the raw bhavcopy and the ledger says so separately.
 */
import { shareMetric, type Metric, type Series } from "./types";

export type Direction = "advance" | "decline" | "unchanged";

export interface BreadthCounts {
  advancing: number;
  declining: number;
  unchanged: number;
  /** Symbols with a usable pair of closes. */
  valid: number;
}

export interface BreadthResult {
  counts: BreadthCounts;
  advancing: Metric;
  declining: Metric;
  unchanged: Metric;
  /** Symbols with fewer than two closes at the anchor. */
  insufficient: string[];
}

/** The direction of one pair of closes. */
export function classifyDirection(previousClose: number, currentClose: number): Direction {
  if (currentClose > previousClose) return "advance";
  if (currentClose < previousClose) return "decline";
  return "unchanged";
}

/** The last two closes of a series, or `null` under two sessions. */
export function lastPair(series: Series): { previous: number; current: number } | null {
  const n = series.bars.length;
  if (n < 2) return null;
  return { previous: series.bars[n - 2].close, current: series.bars[n - 1].close };
}

/** A1 over an anchor-aligned universe. `coverageBase` is the included universe. */
export function computeBreadth(series: Series[], coverageBase: number): BreadthResult {
  const counts: BreadthCounts = { advancing: 0, declining: 0, unchanged: 0, valid: 0 };
  const insufficient: string[] = [];
  for (const s of series) {
    const pair = lastPair(s);
    if (!pair) {
      insufficient.push(s.symbol);
      continue;
    }
    counts.valid += 1;
    const dir = classifyDirection(pair.previous, pair.current);
    if (dir === "advance") counts.advancing += 1;
    else if (dir === "decline") counts.declining += 1;
    else counts.unchanged += 1;
  }
  const reason = counts.valid === 0 ? "insufficient_history" : undefined;
  return {
    counts,
    advancing: shareMetric(counts.advancing, counts.valid, coverageBase, reason),
    declining: shareMetric(counts.declining, counts.valid, coverageBase, reason),
    unchanged: shareMetric(counts.unchanged, counts.valid, coverageBase, reason),
    insufficient: insufficient.sort(),
  };
}
