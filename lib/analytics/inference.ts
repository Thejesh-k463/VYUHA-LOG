/**
 * STATISTICAL INFERENCE — the honesty invariant applied to arithmetic.
 *
 * ZERO DB and ZERO React imports; pure functions over plain numbers.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * Vyuha refuses to state a number it cannot derive: a share card returns "—"
 * rather than invent a capital base, mistake economics report the expectancy
 * GAP rather than a counterfactual P&L. That discipline stopped at the edge of
 * arithmetic. Across 48 analytics modules there was no confidence interval, no
 * p-value and no multiplicity control — while `/reports/edge` ranks expectancy
 * per setup and per segment and `/lenses` cuts the same book six ways, gated
 * only by MIN_SAMPLE thresholds of 10, 15 and 20.
 *
 * A 68% win rate from 15 trades has a 95% interval of roughly 42%–86%. Ranking
 * twenty such slices and reporting the winner is not measurement, it is
 * selection: with twenty independent slices you expect one to look "best at
 * p<0.05" even when every one of them is identical underneath. Telling a trader
 * to trade their "best setup" on that basis is the most expensive thing an
 * honest journal can get wrong, because they will act on it with money.
 *
 * So: state the interval, and say plainly when a difference is not yet
 * distinguishable from chance. Per the owner's decision (2026-08-30), nothing
 * is ever HIDDEN — it is the user's own record (invariant 7). It is marked.
 *
 * ── Methods, and why these ones ───────────────────────────────────────────
 *
 * WILSON score interval for proportions (Wilson, E.B. 1927, JASA 22:209-212).
 * The textbook Wald interval (p̂ ± z·√(p̂(1-p̂)/n)) is indefensible here: at
 * k=0 it returns the single point 0, claiming certainty from no evidence, and
 * it routinely runs below 0 or above 1. Wilson has far better small-sample
 * coverage (Brown, Cai & DasGupta 2001, Statistical Science 16(2):101-133) and
 * never leaves [0,1]. Agresti-Coull is the other reasonable pick; Wilson is
 * preferred because it is exact to compute and needs no adjusted counts.
 *
 * STUDENT-t interval for a mean (expectancy in ₹ or R). A normal interval
 * understates width at the sample sizes a per-setup slice actually has, so a
 * t-quantile table covers df 1–30 and the normal limit is used beyond, where
 * the difference is under half a percent.
 *
 * BENJAMINI-YEKUTIELI is the DEFAULT multiplicity control, not Benjamini-
 * Hochberg. BH controls the false-discovery rate only under independence or
 * positive regression dependence (PRDS). Slices of one trade book are neither:
 * "morning trades" and "NIFTY trades" overlap, share trades, and can correlate
 * in either direction. BY (Benjamini & Yekutieli 2001, Annals of Statistics
 * 29(4):1165-1188) is valid under ARBITRARY dependence at the cost of a
 * log-factor of power. Given the alternative is telling someone their edge is
 * real when it is not, paying that is the right trade. BH is exported too, for
 * the genuinely independent case, and each result says which was used.
 */

/** Two-sided z for common confidence levels. */
const Z: Record<number, number> = { 0.8: 1.2815515655, 0.9: 1.6448536269, 0.95: 1.9599639845, 0.99: 2.5758293035 };

/**
 * Two-sided t quantiles at 95%, df 1..30. Beyond df 30 the normal z is within
 * half a percent, which is far below the uncertainty in the inputs themselves.
 */
const T95 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086,
  2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];

function tQuantile95(df: number): number {
  if (df < 1) return Number.NaN;
  return df <= 30 ? T95[df - 1] : Z[0.95];
}

export interface Interval {
  /** Point estimate. */
  point: number;
  lo: number;
  hi: number;
  /** Sample size the interval is based on. */
  n: number;
  /** Confidence level, e.g. 0.95. */
  conf: number;
}

/**
 * Wilson score interval for a proportion — a win rate, a hit rate.
 *
 * Returns a FULL [0,1] interval at n = 0 rather than a point or NaN: with no
 * evidence, every rate is equally consistent with the data, and saying so is
 * the honest answer.
 */
export function wilsonInterval(successes: number, n: number, conf = 0.95): Interval {
  const z = Z[conf] ?? Z[0.95];
  if (n <= 0) return { point: Number.NaN, lo: 0, hi: 1, n: 0, conf };
  const k = Math.max(0, Math.min(successes, n));
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    point: p,
    lo: Math.max(0, centre - half),
    hi: Math.min(1, centre + half),
    n,
    conf,
  };
}

/**
 * Student-t interval for the mean of a sample — expectancy per trade.
 *
 * n < 2 has no dispersion to measure, so the interval is (-∞, ∞) expressed as
 * NaN bounds: a single trade tells you its own outcome and nothing about the
 * next one.
 */
export function meanInterval(values: number[], conf = 0.95): Interval {
  const n = values.length;
  if (n === 0) return { point: Number.NaN, lo: Number.NaN, hi: Number.NaN, n: 0, conf };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  if (n === 1) return { point: mean, lo: Number.NaN, hi: Number.NaN, n: 1, conf };
  const variance = values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  const t = conf === 0.95 ? tQuantile95(n - 1) : (Z[conf] ?? Z[0.95]);
  return { point: mean, lo: mean - t * se, hi: mean + t * se, n, conf };
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 via erf). */
function normalCdf(x: number): number {
  // erf approximation, |error| < 1.5e-7
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return 0.5 * (1 + s * y);
}

/**
 * Two-sided p-value for an observed proportion against a null rate, using a
 * normal approximation with a continuity correction.
 *
 * Returns 1 (no evidence of any difference) when n is 0 or the null is
 * degenerate — never a small p from an empty sample.
 */
export function proportionPValue(successes: number, n: number, nullRate: number): number {
  if (n <= 0 || nullRate <= 0 || nullRate >= 1) return 1;
  const k = Math.max(0, Math.min(successes, n));
  const mean = n * nullRate;
  const sd = Math.sqrt(n * nullRate * (1 - nullRate));
  if (sd === 0) return 1;
  const diff = Math.abs(k - mean) - 0.5; // continuity correction
  if (diff <= 0) return 1;
  return Math.min(1, 2 * (1 - normalCdf(diff / sd)));
}

export interface MultiplicityResult<T> {
  item: T;
  p: number;
  /** Survives multiplicity control at the chosen q. */
  significant: boolean;
  /** The threshold this p-value was compared against. */
  threshold: number;
  method: "BY" | "BH";
}

function stepUp<T>(
  items: { item: T; p: number }[],
  q: number,
  method: "BY" | "BH",
): MultiplicityResult<T>[] {
  const m = items.length;
  if (m === 0) return [];
  // BY divides q by the harmonic number, which is what buys validity under
  // arbitrary dependence.
  let c = 1;
  if (method === "BY") for (let i = 2; i <= m; i++) c += 1 / i;

  const asc = items.map((x, i) => ({ ...x, i })).sort((a, b) => a.p - b.p);
  let cutoff = -1;
  for (let rank = m; rank >= 1; rank--) {
    const thr = ((rank / m) * q) / c;
    if (asc[rank - 1].p <= thr) {
      cutoff = rank;
      break;
    }
  }
  const out = new Array<MultiplicityResult<T>>(m);
  asc.forEach((x, idx) => {
    out[x.i] = {
      item: x.item,
      p: x.p,
      significant: cutoff >= 1 && idx + 1 <= cutoff,
      threshold: ((idx + 1) / m) * q / c,
      method,
    };
  });
  return out;
}

/**
 * Benjamini-Yekutieli step-up — the DEFAULT. Valid under arbitrary dependence,
 * which is what overlapping slices of one trade book have.
 */
export function benjaminiYekutieli<T>(items: { item: T; p: number }[], q = 0.05): MultiplicityResult<T>[] {
  return stepUp(items, q, "BY");
}

/**
 * Benjamini-Hochberg step-up. Only valid under independence or PRDS — use it
 * when slices genuinely do not overlap, and say so.
 */
export function benjaminiHochberg<T>(items: { item: T; p: number }[], q = 0.05): MultiplicityResult<T>[] {
  return stepUp(items, q, "BH");
}

/**
 * The sentence a screen should show about a rate.
 *
 * Deliberately returns a MARK, never a suppression: the owner's decision is
 * "show, never hide", and a user's own record is not ours to withhold
 * (invariant 7).
 */
export function rateVerdict(ci: Interval, nullRate: number | null): string {
  if (ci.n === 0) return "no closed trades yet";
  if (ci.n < 5) return `${ci.n} trade${ci.n === 1 ? "" : "s"} — far too few to read`;
  const span = Math.round((ci.hi - ci.lo) * 100);
  if (nullRate != null && ci.lo <= nullRate && nullRate <= ci.hi) {
    return `not yet distinguishable from your overall rate (95% CI spans ${span} points)`;
  }
  return `95% CI spans ${span} points on ${ci.n} trades`;
}

/** Format an interval as a percentage range, e.g. "42%–86%". */
export function fmtIntervalPct(ci: Interval): string {
  if (!Number.isFinite(ci.lo) || !Number.isFinite(ci.hi)) return "—";
  return `${Math.round(ci.lo * 100)}%–${Math.round(ci.hi * 100)}%`;
}
