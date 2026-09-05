/**
 * lib/atlas — the daily market-context definitions, PURE.
 *
 * Layering (AGENTS.md invariant 2): nothing here imports the DB, React,
 * `node:*` or `fetch`, and nothing calls `Date.now()`. The clock, the hash
 * function and the classification lookup are all passed in, which is what
 * makes byte-for-byte golden tests possible at all.
 *
 * Units (AGENTS.md invariant 1): `price_history` stores per-unit PRICES as
 * REAL rupees, so this layer is rupee-native, not paise-native. Every ratio it
 * publishes is an INTEGER ppm (2% = 20_000), so a stored `atlas_metric.value`
 * is exact in a REAL column and a "strictly above" rule can never drift into
 * "at or above" through float noise.
 *
 * Denominators (AGENTS.md invariant 6): every figure is a `Metric` or a
 * `CountMetric` — a value ALWAYS travels with its numerator, its denominator
 * and the coverage it was computed over, and it is `null` with a reason rather
 * than 0 when the denominator is empty.
 */

/** ISO `YYYY-MM-DD`. String comparison is chronological, which is why it is the key. */
export type IsoDate = string;

/** One `price_history` row, narrowed to what the definitions read. */
export interface Bar {
  symbol: string;
  date: IsoDate;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
}

/** One symbol's bars, ascending by date, de-duplicated on date. */
export interface Series {
  symbol: string;
  bars: Bar[];
}

/** Why a figure is `null`, or why a denominator is smaller than the universe. */
export type MetricReason =
  | "empty_denominator"
  | "insufficient_history"
  | "no_baseline"
  | "no_anchor"
  | "unclassified";

/** The five ledger reasons; also the `atlas_staleness.reason` value set. */
export type ExclusionReason =
  | "no_bar_on_anchor"
  | "insufficient_history"
  | "non_equity"
  | "truncated_to_anchor"
  | "corporate_action_unreconciled";

/** A ratio figure. `value_ppm` is `numerator / denominator` in integer ppm. */
export interface Metric {
  value_ppm: number | null;
  numerator: number;
  denominator: number;
  /** `denominator` as a share of the included universe, integer ppm. */
  coverage_ppm: number;
  reason?: MetricReason;
}

/** A count figure (net high-low, constituent counts) — same honesty contract. */
export interface CountMetric {
  value: number | null;
  denominator: number;
  coverage_ppm: number;
  reason?: MetricReason;
}

/** What the caller's classification chain returns for one symbol. */
export interface SectorRef {
  sector: string;
  /** `getSectorResolution()`'s tier — "user" | taxonomy confidence | "index". */
  tier?: string;
  source?: string;
}

// ---------------------------------------------------------------------------
// Constants. Changing any of these changes the FORMULA SET, which is a
// SPEC_VERSION bump (04 section 4.3) and invalidates stored atlas_metric rows.
// ---------------------------------------------------------------------------

/** Semver on the formula set, not on the code. */
export const SPEC_VERSION = "atlas-core/1.0.0";

/** `1d` is the current-day rotation window (A8/A9); the rest are the A5 windows. */
export type ReturnWindowKey = "1d" | "1w" | "1m" | "2m" | "3m";

/** Return windows in sessions (04 section 1, A5). */
export const RETURN_WINDOWS: { key: ReturnWindowKey; sessions: number }[] = [
  { key: "1w", sessions: 5 },
  { key: "1m", sessions: 21 },
  { key: "2m", sessions: 42 },
  { key: "3m", sessions: 63 },
];

/** Current-day rotation (A8/A9). Kept out of RETURN_WINDOWS: it is not an A5 window. */
export const ROTATION_WINDOW: { key: ReturnWindowKey; sessions: number } = { key: "1d", sessions: 1 };

/** SMA periods (A2). Membership is STRICTLY above the mean. */
export const SMA_PERIODS = [20, 50, 200] as const;

/** 52-week window (A3): at most 252 sessions INCLUDING the current one. */
export const HIGH_LOW_LOOKBACK = 252;
/** Below this many sessions a symbol has no 52w opinion at all (A3). */
export const HIGH_LOW_MIN_SESSIONS = 20;
/** Volume baseline (A7): the mean of the PRIOR 20 sessions, current excluded. */
export const VOLUME_BASELINE = 20;
/** Replay depth (A11). */
export const HISTORY_SESSIONS = 90;
/** Corporate-action gap threshold (04 section 4.4): |ratio - 1| > 0.35. */
export const CA_GAP_THRESHOLD_PPM = 350_000;

// ---------------------------------------------------------------------------
// Constructors — the only places a value_ppm is allowed to be produced.
// ---------------------------------------------------------------------------

/** Deterministic integer ppm; never returns `-0`, which serialises inconsistently. */
export function roundPpm(x: number): number {
  const r = Math.round(x);
  return Object.is(r, -0) ? 0 : r;
}

function coverage(denominator: number, coverageBase: number): number {
  if (coverageBase <= 0) return 0;
  return roundPpm((denominator * 1_000_000) / coverageBase);
}

/** A share: `numerator` of `denominator`, e.g. advancing of valid. */
export function shareMetric(
  numerator: number,
  denominator: number,
  coverageBase: number,
  reason?: MetricReason,
): Metric {
  if (denominator <= 0) {
    return {
      value_ppm: null,
      numerator,
      denominator: 0,
      coverage_ppm: 0,
      reason: reason ?? "empty_denominator",
    };
  }
  const m: Metric = {
    value_ppm: roundPpm((numerator * 1_000_000) / denominator),
    numerator,
    denominator,
    coverage_ppm: coverage(denominator, coverageBase),
  };
  if (reason) m.reason = reason;
  return m;
}

/**
 * An equal-weighted mean of per-symbol ppm figures (returns, group returns).
 * `numerator` is the SUM, so the row still shows its own arithmetic.
 */
export function meanMetric(valuesPpm: number[], coverageBase: number, reason?: MetricReason): Metric {
  const denominator = valuesPpm.length;
  if (denominator === 0) {
    return { value_ppm: null, numerator: 0, denominator: 0, coverage_ppm: 0, reason: reason ?? "empty_denominator" };
  }
  const numerator = valuesPpm.reduce((a, b) => a + b, 0);
  const m: Metric = {
    value_ppm: roundPpm(numerator / denominator),
    numerator,
    denominator,
    coverage_ppm: coverage(denominator, coverageBase),
  };
  if (reason) m.reason = reason;
  return m;
}

/** The median of per-symbol ppm figures; even counts take the mean of the middle two. */
export function medianMetric(valuesPpm: number[], coverageBase: number, reason?: MetricReason): Metric {
  const denominator = valuesPpm.length;
  if (denominator === 0) {
    return { value_ppm: null, numerator: 0, denominator: 0, coverage_ppm: 0, reason: reason ?? "empty_denominator" };
  }
  const sorted = [...valuesPpm].sort((a, b) => a - b);
  const mid = denominator >> 1;
  const value_ppm = denominator % 2 === 1 ? sorted[mid] : roundPpm((sorted[mid - 1] + sorted[mid]) / 2);
  const m: Metric = {
    value_ppm,
    numerator: value_ppm,
    denominator,
    coverage_ppm: coverage(denominator, coverageBase),
  };
  if (reason) m.reason = reason;
  return m;
}

/** A plain count (net high-low), still carrying what it was counted over. */
export function countMetric(
  value: number | null,
  denominator: number,
  coverageBase: number,
  reason?: MetricReason,
): CountMetric {
  if (denominator <= 0) {
    return { value: null, denominator: 0, coverage_ppm: 0, reason: reason ?? "empty_denominator" };
  }
  const m: CountMetric = { value, denominator, coverage_ppm: coverage(denominator, coverageBase) };
  if (reason) m.reason = reason;
  return m;
}

/** Ascending, de-duplicated on `(symbol, date)`; the last row for a date wins. */
export function toSeries(bars: Bar[]): Series[] {
  const bySymbol = new Map<string, Map<IsoDate, Bar>>();
  for (const b of bars) {
    const key = b.symbol.toUpperCase();
    let m = bySymbol.get(key);
    if (!m) {
      m = new Map();
      bySymbol.set(key, m);
    }
    m.set(b.date, { ...b, symbol: key });
  }
  const out: Series[] = [];
  for (const [symbol, m] of bySymbol) {
    out.push({
      symbol,
      bars: [...m.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    });
  }
  out.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return out;
}

/** `high` / `low` are nullable in `price_history`; a bar with neither is flat at its close. */
export function barHigh(b: Bar): number {
  return b.high ?? b.close;
}

export function barLow(b: Bar): number {
  return b.low ?? b.close;
}
