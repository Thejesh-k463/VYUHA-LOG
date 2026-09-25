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
  | "unclassified"
  /** v4.6.0 W5 (AQ26): fewer than `GROUP_MIN_COMPUTE` members produced a figure. */
  | "insufficient_members"
  /** v4.6.0 W5 (AQ44): the denominator covers less than `COVERAGE_FLOOR_PPM` of the universe. */
  | "coverage_below_floor";

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

/**
 * Semver on the formula set, not on the code.
 *
 * 2.0.0 (v4.6.0 W5, owner ruling AQ18): the group statistic is the MEDIAN
 * (the mean is persisted beside it under its own name), the regime honours
 * `COVERAGE_FLOOR_PPM` (AQ44/A9), the 2m window is gone (AQ7) and every
 * universe window is a median too. A stored `atlas_daily` row under 1.0.0 is
 * recomputed on the existing spec-mismatch path; its `atlas_metric` rows for
 * earlier sessions survive and are excluded from any cross-session read by the
 * `spec_version` join (`lib/queries/atlas.ts`, design review A1).
 */
export const SPEC_VERSION = "atlas-core/2.0.0";

/**
 * `1d` is the current-day rotation window (A8/A9); the rest are the A5 windows.
 * `2m` was removed in 2.0.0 (AQ7: "1w / 1m / 3m / YTD now, 2m LATER") — no
 * stored reader named it, so the type member went with the row.
 */
export type ReturnWindowKey = "1d" | "1w" | "1m" | "3m";

/** Return windows in sessions (04 section 1, A5; AQ7 drops 2m). */
export const RETURN_WINDOWS: { key: ReturnWindowKey; sessions: number }[] = [
  { key: "1w", sessions: 5 },
  { key: "1m", sessions: 21 },
  { key: "3m", sessions: 63 },
];

/**
 * The group statistic (AQ18). MEDIAN ships; the mean sits behind a labelled
 * toggle and is persisted beside it, so the toggle is a READ, not a recompute.
 */
export type Statistic = "median" | "mean";
export const DEFAULT_STATISTIC: Statistic = "median";

/** The exchanges' four classification levels (v4.6.0 W2: macro 12 / sector 22 / industry 59 / basic 197). */
export type ClassificationLevel = "macro" | "sector" | "industry" | "basic";

/**
 * AQ44 — below this coverage a tile prints its COVERAGE ("40 of 1,900 priced
 * (2%)") instead of its value, and the regime label refuses to vote (A9).
 * 30% is a PROPOSAL, not a measurement (owner, 2026-09-25).
 */
export const COVERAGE_FLOOR_PPM = 300_000;

/**
 * AQ26 floors. 3 members to compute a group figure, 8 to appear in a ranking;
 * the hidden count is always stated. PROPOSALS, not measurements.
 */
export const GROUP_MIN_COMPUTE = 3;
export const GROUP_MIN_RANK = 8;

/**
 * AQ26 / Q51 #4 — a cohort needs at least this many PRICED constituents AND
 * this coverage of its membership, else the row says "cohort too thin to
 * compare (3 of 41 priced)". 5 and 60% are PROPOSALS, not measurements.
 */
export const COHORT_MIN_PRICED = 5;
export const COHORT_MIN_COVERAGE_PPM = 600_000;

/**
 * AQ9 / AQ20 — relative strength: 5/21/63-session returns weighted 0.5/0.3/0.2
 * against the CROSS-SECTIONAL MEDIAN of the eligible universe (Sentinel S11's
 * definition, the market median as the only benchmark in W5).
 */
export const RS_WINDOWS: readonly number[] = [5, 21, 63];
export const RS_WEIGHTS: readonly number[] = [0.5, 0.3, 0.2];
/** Eligibility floors: anchor-bar turnover (close × volume) ≥ ₹1 crore, close ≥ ₹20. */
export const RS_MIN_TURNOVER_RUPEES = 10_000_000;
export const RS_MIN_PRICE = 20;
/** 63 sessions of return need 64 bars; the corporate-action guard covers the same span. */
export const RS_MIN_BARS = 64;

/** RSI (AQ5): Wilder's 14, "extreme" at ≤ 30 or ≥ 70. The thresholds are printed on the tile. */
export const RSI_PERIOD = 14;
export const RSI_LOW = 30;
export const RSI_HIGH = 70;

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
 * An equal-weighted mean of per-symbol ppm figures (the mean toggle).
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

/** The configured group statistic over per-symbol ppm figures (AQ18). */
export function statMetric(
  valuesPpm: number[],
  coverageBase: number,
  statistic: Statistic = DEFAULT_STATISTIC,
  reason?: MetricReason,
): Metric {
  return statistic === "mean" ? meanMetric(valuesPpm, coverageBase, reason) : medianMetric(valuesPpm, coverageBase, reason);
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
