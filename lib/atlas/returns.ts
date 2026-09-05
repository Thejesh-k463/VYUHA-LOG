/**
 * A5 / A6 — window returns and YTD, plus the corporate-action guard.
 *
 * A5: `close[t] / close[t-N] - 1`, and the DENOMINATOR counts only symbols
 * that actually have N+1 valid closes. A symbol listed three weeks ago does
 * not get to sit in the 3-month denominator.
 *
 * A6 (YTD): the anchor is the last completed close BEFORE the calendar year.
 * When there is no such bar the anchor falls back to the first close OF the
 * year, and which one was used travels with the number (`anchorKind`) — a YTD
 * measured from 3 January is a different statement from one measured from
 * 31 December, and the screen has to be able to say which it made.
 *
 * The guard (04 section 4.4): raw bhavcopy is UNADJUSTED, so a 1:5 split
 * prints as -80%. A close-to-close move beyond 35% with no comparable move in
 * the rest of the market is flagged `corporate_action_unreconciled`; the
 * symbol is dropped from any RETURN window that spans the gap and stays in
 * breadth (A1-A4), which is where the raw move is a fact rather than an error.
 */
import {
  CA_GAP_THRESHOLD_PPM,
  RETURN_WINDOWS,
  meanMetric,
  roundPpm,
  type IsoDate,
  type Metric,
  type ReturnWindowKey,
  type Series,
} from "./types";

export interface CaGap {
  date: IsoDate;
  /** `close/prevClose - 1` in ppm. */
  ratioPpm: number;
}

export interface CaOptions {
  thresholdPpm?: number;
  /** Median move of the whole universe on that date, ppm — the "comparable market move" test. */
  marketMovePpmByDate?: Map<IsoDate, number>;
}

/** Every unadjusted-looking gap in a series, in date order. */
export function detectCorporateActionGaps(series: Series, opts: CaOptions = {}): CaGap[] {
  const threshold = opts.thresholdPpm ?? CA_GAP_THRESHOLD_PPM;
  const gaps: CaGap[] = [];
  for (let i = 1; i < series.bars.length; i++) {
    const prev = series.bars[i - 1].close;
    const curr = series.bars[i].close;
    if (!(prev > 0)) continue;
    const movePpm = roundPpm((curr / prev - 1) * 1_000_000);
    if (Math.abs(movePpm) <= threshold) continue;
    const market = opts.marketMovePpmByDate?.get(series.bars[i].date) ?? 0;
    // A market-wide move of the same size is a market event, not a split.
    if (Math.abs(movePpm - market) <= threshold) continue;
    gaps.push({ date: series.bars[i].date, ratioPpm: movePpm });
  }
  return gaps;
}

/** The median close-to-close move per session, ppm — the guard's market baseline. */
export function marketMoveByDate(series: Series[]): Map<IsoDate, number> {
  const byDate = new Map<IsoDate, number[]>();
  for (const s of series) {
    for (let i = 1; i < s.bars.length; i++) {
      const prev = s.bars[i - 1].close;
      if (!(prev > 0)) continue;
      const movePpm = roundPpm((s.bars[i].close / prev - 1) * 1_000_000);
      const arr = byDate.get(s.bars[i].date) ?? [];
      arr.push(movePpm);
      byDate.set(s.bars[i].date, arr);
    }
  }
  const out = new Map<IsoDate, number>();
  for (const [date, moves] of byDate) {
    moves.sort((a, b) => a - b);
    const mid = moves.length >> 1;
    out.set(date, moves.length % 2 === 1 ? moves[mid] : roundPpm((moves[mid - 1] + moves[mid]) / 2));
  }
  return out;
}

/** `close[t]/close[t-N] - 1` in ppm, or `null` without N+1 valid closes. */
export function symbolReturnPpm(series: Series, sessions: number): number | null {
  const n = series.bars.length;
  if (sessions <= 0 || n < sessions + 1) return null;
  const base = series.bars[n - 1 - sessions].close;
  const last = series.bars[n - 1].close;
  if (!(base > 0)) return null;
  return roundPpm((last / base - 1) * 1_000_000);
}

/** Does a flagged gap fall inside the N-session window ending at the anchor? */
export function gapInWindow(series: Series, sessions: number, gaps: CaGap[]): boolean {
  const n = series.bars.length;
  if (n < sessions + 1) return false;
  const from = series.bars[n - 1 - sessions].date;
  const to = series.bars[n - 1].date;
  return gaps.some((g) => g.date > from && g.date <= to);
}

export interface ReturnWindowResult {
  key: ReturnWindowKey;
  sessions: number;
  metric: Metric;
  /** Symbols without N+1 closes. */
  insufficient: string[];
  /** Symbols dropped by the corporate-action guard for this window. */
  corporateActionExcluded: string[];
}

/** A5 for every configured window. Equal-weighted across valid symbols. */
export function computeReturns(
  series: Series[],
  coverageBase: number,
  gapsBySymbol: Map<string, CaGap[]> = new Map(),
  windows = RETURN_WINDOWS,
): Record<ReturnWindowKey, ReturnWindowResult> {
  const out = {} as Record<ReturnWindowKey, ReturnWindowResult>;
  for (const w of windows) {
    const values: number[] = [];
    const insufficient: string[] = [];
    const corporateActionExcluded: string[] = [];
    for (const s of series) {
      const gaps = gapsBySymbol.get(s.symbol) ?? [];
      if (gapInWindow(s, w.sessions, gaps)) {
        corporateActionExcluded.push(s.symbol);
        continue;
      }
      const r = symbolReturnPpm(s, w.sessions);
      if (r === null) {
        insufficient.push(s.symbol);
        continue;
      }
      values.push(r);
    }
    out[w.key] = {
      key: w.key,
      sessions: w.sessions,
      metric: meanMetric(values, coverageBase, values.length === 0 ? "insufficient_history" : undefined),
      insufficient: insufficient.sort(),
      corporateActionExcluded: corporateActionExcluded.sort(),
    };
  }
  return out;
}

export type YtdAnchorKind = "prior_year_close" | "first_close_of_year";

export interface YtdValue {
  value_ppm: number;
  anchorKind: YtdAnchorKind;
  anchorDate: IsoDate;
}

/**
 * A6 for one symbol at `year`. Prefers the last completed close before
 * 1 January; falls back to the first close of the year and says so.
 */
export function symbolYtd(series: Series, year: number): YtdValue | null {
  const n = series.bars.length;
  if (n === 0) return null;
  const yearStart = `${year}-01-01`;
  const last = series.bars[n - 1];
  if (last.date < yearStart) return null;

  let anchorIndex = -1;
  for (let i = 0; i < n; i++) {
    if (series.bars[i].date < yearStart) anchorIndex = i;
    else break;
  }
  let anchorKind: YtdAnchorKind = "prior_year_close";
  if (anchorIndex < 0) {
    anchorIndex = series.bars.findIndex((b) => b.date >= yearStart);
    anchorKind = "first_close_of_year";
  }
  if (anchorIndex < 0 || anchorIndex === n - 1) return null;
  const base = series.bars[anchorIndex].close;
  if (!(base > 0)) return null;
  return {
    value_ppm: roundPpm((last.close / base - 1) * 1_000_000),
    anchorKind,
    anchorDate: series.bars[anchorIndex].date,
  };
}

export interface YtdResult {
  metric: Metric;
  /** How many symbols used each anchor rule — the screen must be able to say. */
  anchorKinds: Record<YtdAnchorKind, number>;
  insufficient: string[];
  corporateActionExcluded: string[];
}

/** A6 across the universe, equal-weighted, guard applied over the YTD span. */
export function computeYtd(
  series: Series[],
  year: number,
  coverageBase: number,
  gapsBySymbol: Map<string, CaGap[]> = new Map(),
): YtdResult {
  const values: number[] = [];
  const anchorKinds: Record<YtdAnchorKind, number> = { prior_year_close: 0, first_close_of_year: 0 };
  const insufficient: string[] = [];
  const corporateActionExcluded: string[] = [];
  for (const s of series) {
    const ytd = symbolYtd(s, year);
    if (!ytd) {
      insufficient.push(s.symbol);
      continue;
    }
    const gaps = gapsBySymbol.get(s.symbol) ?? [];
    const to = s.bars[s.bars.length - 1].date;
    if (gaps.some((g) => g.date > ytd.anchorDate && g.date <= to)) {
      corporateActionExcluded.push(s.symbol);
      continue;
    }
    values.push(ytd.value_ppm);
    anchorKinds[ytd.anchorKind] += 1;
  }
  return {
    metric: meanMetric(values, coverageBase, values.length === 0 ? "insufficient_history" : undefined),
    anchorKinds,
    insufficient: insufficient.sort(),
    corporateActionExcluded: corporateActionExcluded.sort(),
  };
}
