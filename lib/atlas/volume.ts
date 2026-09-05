/**
 * A7 — volume expansion.
 *
 * `vol[t] / mean(vol[t-20..t-1])`. The CURRENT bar is excluded from its own
 * baseline: including it damps every reading towards 1 and makes a genuine
 * 5x day read as 1.2x. That requires 21 sessions, not 20.
 *
 * Published as a median (a mean is destroyed by one illiquid symbol printing
 * 400x) with its denominator, plus the share of symbols expanding above 1.0.
 */
import { VOLUME_BASELINE, medianMetric, roundPpm, shareMetric, type Metric, type Series } from "./types";

export interface VolumeResult {
  /** Median expansion in ppm; 1_000_000 ppm = flat, 2_000_000 = twice the baseline. */
  medianExpansion: Metric;
  /** Share of valid symbols whose latest volume exceeds the prior-20 mean. */
  expandingShare: Metric;
  insufficient: string[];
  baselineSessions: number;
}

/**
 * Expansion in ppm for one symbol, or `null` without `baseline + 1` sessions
 * or with a zero/absent baseline (never divide by a fabricated denominator).
 */
export function volumeExpansionPpm(series: Series, baseline: number = VOLUME_BASELINE): number | null {
  const n = series.bars.length;
  if (baseline <= 0 || n < baseline + 1) return null;
  const current = series.bars[n - 1].volume;
  if (current === null || current === undefined) return null;
  let sum = 0;
  for (let i = n - 1 - baseline; i < n - 1; i++) {
    const v = series.bars[i].volume;
    if (v === null || v === undefined) return null;
    sum += v;
  }
  const mean = sum / baseline;
  if (!(mean > 0)) return null;
  return roundPpm((current / mean) * 1_000_000);
}

/** A7 over an anchor-aligned universe. */
export function computeVolumeExpansion(
  series: Series[],
  coverageBase: number,
  baseline: number = VOLUME_BASELINE,
): VolumeResult {
  const values: number[] = [];
  const insufficient: string[] = [];
  let expanding = 0;
  for (const s of series) {
    const v = volumeExpansionPpm(s, baseline);
    if (v === null) {
      insufficient.push(s.symbol);
      continue;
    }
    values.push(v);
    if (v > 1_000_000) expanding += 1;
  }
  const reason = values.length === 0 ? "insufficient_history" : undefined;
  return {
    medianExpansion: medianMetric(values, coverageBase, reason),
    expandingShare: shareMetric(expanding, values.length, coverageBase, reason),
    insufficient: insufficient.sort(),
    baselineSessions: baseline,
  };
}
