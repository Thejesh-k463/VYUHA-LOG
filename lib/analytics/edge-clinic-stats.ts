/**
 * EDGE CLINIC — the numerical core (PURE: no DB, no React, no server-only).
 *
 * Every formula here is pinned against its primary source in
 * VYUHA/LIVE-DESK-RESEARCH/22-V460-BUILD/research/R1F-BAILEY-LDP-FORMULAS-2026-10-01.md
 * ("Builder contract"). Conventions are DECIDED there and are not re-derived:
 *
 *   - per-trade (never annualised) Sharpe sr = mean(R)/sd(R) with POPULATION
 *     moments; skewness g3 = m3/σ³; kurtosis g4 = m4/σ⁴ RAW (Normal = 3);
 *   - PSR / MinTRL — Bailey & López de Prado 2012, Appendix A.3 code;
 *   - E[max SR] / DSR — Bailey & López de Prado 2014, eq.(1)-(2), under the null;
 *   - Kelly — Thorp 2006 §2 (discrete) and (vi) (empirical E log);
 *   - one-sided CUSUM — NIST/SEMATECH §6.3.2.3 on standardised data, k = 0.5, h = 4;
 *   - longest losing run — Gordon, Schilling & Waterman 1986 (asymptotic).
 *
 * The only imports are the existing inference machinery and the seeded PRNG.
 */
import type { Interval } from "@/lib/analytics/inference";
import { mulberry32 } from "@/lib/analytics/monte-carlo";

/** Euler–Mascheroni constant (the papers' `emc`). */
export const EULER_GAMMA = 0.5772156649;

const SQRT_PI = Math.sqrt(Math.PI);
const SQRT_2PI = Math.sqrt(2 * Math.PI);

// ── Normal distribution ─────────────────────────────────────────────────────

/** erfc(z) for z ≥ 2.5 by the classical continued fraction (modified Lentz). */
function erfcContinuedFraction(z: number): number {
  // erfc(z) = e^{-z²}/√π · 1/(z + (1/2)/(z + 1/(z + (3/2)/(z + 2/(z + …)))))
  const tiny = 1e-300;
  let f = z;
  let c = z;
  let d = 0;
  for (let j = 1; j < 500; j++) {
    const a = j / 2;
    d = z + a * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = z + a / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = c * d;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return Math.exp(-z * z) / (SQRT_PI * f);
}

/**
 * Standard normal CDF Φ to near double precision (|rel err| ~1e-15).
 *
 * `inference.ts` keeps its own A&S 7.1.26 Φ (|err| < 1.5e-7) for p-values; that
 * is NOT accurate enough to drive the refinement step of `normInv` below — a
 * 1.5e-7 error in Φ moves Φ⁻¹(0.95) by ~1.5e-6 — so this module carries the
 * precise one, and every Φ in the Edge Clinic goes through it.
 */
export function normCdf(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x === Number.POSITIVE_INFINITY) return 1;
  if (x === Number.NEGATIVE_INFINITY) return 0;
  const z = Math.abs(x) / Math.SQRT2;
  let erfc: number;
  if (z < 2.5) {
    // erf(z) = 2/√π · e^{-z²} · Σ (2z²)ⁿ z / (1·3·…·(2n+1)) — all terms positive,
    // so no cancellation.
    let term = z;
    let sum = z;
    for (let n = 1; n < 300; n++) {
      term *= (2 * z * z) / (2 * n + 1);
      sum += term;
      if (term < sum * 1e-17) break;
    }
    erfc = 1 - (2 / SQRT_PI) * Math.exp(-z * z) * sum;
  } else {
    erfc = erfcContinuedFraction(z);
  }
  return x >= 0 ? 1 - erfc / 2 : erfc / 2;
}

/** Standard normal density φ. */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

// Acklam's rational approximation (|rel err| < 1.15e-9 before refinement).
const AK_A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
const AK_B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const AK_C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const AK_D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
const AK_P_LOW = 0.02425;

/**
 * Inverse standard normal Φ⁻¹(p) — Acklam's algorithm plus one step of
 * Halley's refinement against the precise `normCdf` (the step Acklam publishes
 * alongside it), which takes the result to full double precision.
 * p ≤ 0 → −∞, p ≥ 1 → +∞.
 */
export function normInv(p: number): number {
  if (Number.isNaN(p)) return Number.NaN;
  if (p <= 0) return Number.NEGATIVE_INFINITY;
  if (p >= 1) return Number.POSITIVE_INFINITY;
  let x: number;
  if (p < AK_P_LOW) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((AK_C[0] * q + AK_C[1]) * q + AK_C[2]) * q + AK_C[3]) * q + AK_C[4]) * q + AK_C[5]) /
      ((((AK_D[0] * q + AK_D[1]) * q + AK_D[2]) * q + AK_D[3]) * q + 1);
  } else if (p <= 1 - AK_P_LOW) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((AK_A[0] * r + AK_A[1]) * r + AK_A[2]) * r + AK_A[3]) * r + AK_A[4]) * r + AK_A[5]) * q) /
      (((((AK_B[0] * r + AK_B[1]) * r + AK_B[2]) * r + AK_B[3]) * r + AK_B[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((AK_C[0] * q + AK_C[1]) * q + AK_C[2]) * q + AK_C[3]) * q + AK_C[4]) * q + AK_C[5]) /
      ((((AK_D[0] * q + AK_D[1]) * q + AK_D[2]) * q + AK_D[3]) * q + 1);
  }
  // Refinement (Halley): e = Φ(x) − p; u = e·√(2π)·e^{x²/2}; x ← x − u/(1 + x·u/2).
  const e = normCdf(x) - p;
  const u = e * SQRT_2PI * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

// ── Student t (for the one-sided p of a cell's mean R) ──────────────────────

/** ln Γ(x), Lanczos (g = 7, n = 9); x > 0. */
function lnGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const xx = x - 1;
  let a = c[0];
  const t = xx + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (xx + i);
  return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the regularized incomplete beta (Numerical Recipes `betacf`). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 500; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
function regIncBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betaContinuedFraction(a, b, x)) / a;
  return 1 - (bt * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** P(T ≤ t) for Student's t with `df` degrees of freedom. */
export function studentTCdf(t: number, df: number): number {
  if (!(df > 0) || Number.isNaN(t)) return Number.NaN;
  if (t === Number.POSITIVE_INFINITY) return 1;
  if (t === Number.NEGATIVE_INFINITY) return 0;
  const tail = 0.5 * regIncBeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

export interface TTest {
  t: number;
  df: number;
  /** One-sided p for H0: E[R] ≤ 0 (small = evidence of a POSITIVE mean). */
  pOneSided: number;
  /** Two-sided p for H0: E[R] = 0 — what the multiplicity step consumes. */
  pTwoSided: number;
}

/**
 * One-sample t-test of the mean against 0, with the SAMPLE sd (n − 1) — the
 * same estimator `meanInterval` uses, so the p and the CI agree. Null when
 * n < 2 or every value is identical (no dispersion, no test).
 */
export function tTest(values: readonly number[]): TTest | null {
  const n = values.length;
  if (n < 2) return null;
  const m = mean(values);
  const v = values.reduce((s, x) => s + (x - m) * (x - m), 0) / (n - 1);
  if (!(v > 0)) return null;
  const t = m / Math.sqrt(v / n);
  const df = n - 1;
  const pOneSided = 1 - studentTCdf(t, df);
  return { t, df, pOneSided, pTwoSided: Math.min(1, 2 * Math.min(pOneSided, 1 - pOneSided)) };
}

// ── Descriptive helpers ─────────────────────────────────────────────────────

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  // A typed array sorts numerically without a comparator — this runs inside
  // every resample of the hold-time bootstrap, so it is the hot path.
  const s = Float64Array.from(xs).sort();
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Population variance (divide by n). */
export function populationVariance(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const m = mean(xs);
  return xs.reduce((s, x) => s + (x - m) * (x - m), 0) / xs.length;
}

export interface Moments {
  n: number;
  mean: number;
  /** Population standard deviation. */
  sd: number;
  /** Skewness m3/σ³. */
  g3: number;
  /** RAW kurtosis m4/σ⁴ (Normal = 3) — the paper's γ4. */
  g4: number;
}

/** Population moments (the authors' code divides by n). Null when n < 2 or σ = 0. */
export function populationMoments(xs: readonly number[]): Moments | null {
  const n = xs.length;
  if (n < 2) return null;
  const m = mean(xs);
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const x of xs) {
    const d = x - m;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
    m4 += d2 * d2;
  }
  m2 /= n;
  m3 /= n;
  m4 /= n;
  if (!(m2 > 0)) return null;
  const sd = Math.sqrt(m2);
  return { n, mean: m, sd, g3: m3 / (sd * sd * sd), g4: m4 / (m2 * m2) };
}

/** Per-trade Sharpe mean/sd (population). Null when undefined. */
export function perTradeSharpe(xs: readonly number[]): number | null {
  const mo = populationMoments(xs);
  return mo ? mo.mean / mo.sd : null;
}

// ── PSR, MinTRL, E[max SR], DSR ─────────────────────────────────────────────

/** 1 − g3·sr + ((g4 − 1)/4)·sr² — the PSR variance term (Normal: 1 + sr²/2). */
export function sigmaTerm(sr: number, g3: number, g4: number): number {
  return 1 - g3 * sr + ((g4 - 1) / 4) * sr * sr;
}

/**
 * Probabilistic Sharpe Ratio: Φ((sr − srRef)·√(n−1)/√sigmaTerm). √(n−1), not √n
 * (Bessel, paper p.8). Null when n < 2 or the variance term is not positive.
 */
export function psr(sr: number, srRef: number, n: number, g3: number, g4: number): number | null {
  if (!(n >= 2) || !Number.isFinite(sr) || !Number.isFinite(srRef)) return null;
  const st = sigmaTerm(sr, g3, g4);
  if (!(st > 0)) return null;
  return normCdf(((sr - srRef) * Math.sqrt(n - 1)) / Math.sqrt(st));
}

/**
 * Minimum Track Record Length (in trades): 1 + sigmaTerm·(z/(sr − srRef))², z the
 * ONE-sided quantile Φ⁻¹(prob). Defined only for sr > srRef (eq.12) — otherwise
 * null ("no positive edge measured yet"), never a meaningless finite number.
 */
export function minTrl(sr: number, srRef: number, g3: number, g4: number, prob = 0.95): number | null {
  if (!(sr > srRef)) return null;
  const st = sigmaTerm(sr, g3, g4);
  if (!(st > 0)) return null;
  const z = normInv(prob);
  return 1 + st * (z / (sr - srRef)) ** 2;
}

/**
 * E[max SR] over N trials UNDER THE NULL (true SR = 0): the paper's
 * E[{SR}] + √V·bracket with the mean term dropped (DSR paper p.9).
 * `varOfTrialSRs` is the variance ACROSS the trials' estimated SRs — not the
 * return-series variance. N < 2 → null (Φ⁻¹(0) is −∞ at N = 1: one trial has no
 * selection to deflate).
 */
export function expectedMaxSr(varOfTrialSRs: number, nTrials: number): number | null {
  if (!(nTrials >= 2) || !(varOfTrialSRs >= 0)) return null;
  const bracket =
    (1 - EULER_GAMMA) * normInv(1 - 1 / nTrials) + EULER_GAMMA * normInv(1 - 1 / (nTrials * Math.E));
  return Math.sqrt(varOfTrialSRs) * bracket;
}

/** Deflated Sharpe Ratio = PSR against E[max SR] of N trials (the SELECTED strategy's n, g3, g4). */
export function deflatedSr(
  sr: number,
  varOfTrialSRs: number,
  nTrials: number,
  n: number,
  g3: number,
  g4: number,
): number | null {
  const ref = expectedMaxSr(varOfTrialSRs, nTrials);
  return ref == null ? null : psr(sr, ref, n, g3, g4);
}

// ── Seeded percentile bootstrap ─────────────────────────────────────────────

export interface BootstrapOptions {
  resamples?: number;
  seed?: number;
  conf?: number;
}

export const BOOTSTRAP_DEFAULTS = { resamples: 2000, seed: 20261001, conf: 0.95 } as const;

/** Type-7 (linear) quantile of a SORTED array. */
function sortedQuantile(sorted: readonly number[], u: number): number {
  if (sorted.length === 0) return Number.NaN;
  const h = (sorted.length - 1) * u;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sorted[lo];
  const a = sorted[lo];
  const b = sorted[hi];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return u < 0.5 ? a : b;
  return a + (h - lo) * (b - a);
}

function percentileInterval(stats: number[], point: number, n: number, conf: number): Interval {
  const kept = stats.filter((s) => !Number.isNaN(s)).sort((a, b) => a - b);
  if (kept.length === 0) return { point, lo: Number.NaN, hi: Number.NaN, n, conf };
  const alpha = (1 - conf) / 2;
  return { point, lo: sortedQuantile(kept, alpha), hi: sortedQuantile(kept, 1 - alpha), n, conf };
}

/**
 * Percentile bootstrap of `stat` over `values` (resampled with replacement),
 * deterministic for a fixed seed. n < 2 → NaN bounds (a single value has no
 * dispersion to resample).
 */
export function bootstrapInterval(
  values: readonly number[],
  stat: (xs: number[]) => number,
  opts: BootstrapOptions = {},
): Interval {
  const { resamples, seed, conf } = { ...BOOTSTRAP_DEFAULTS, ...opts };
  const n = values.length;
  const point = n > 0 ? stat([...values]) : Number.NaN;
  if (n < 2) return { point, lo: Number.NaN, hi: Number.NaN, n, conf };
  const rnd = mulberry32(seed);
  const buf = new Array<number>(n);
  const stats = new Array<number>(resamples);
  for (let b = 0; b < resamples; b++) {
    for (let i = 0; i < n; i++) buf[i] = values[Math.floor(rnd() * n)];
    stats[b] = stat(buf);
  }
  return percentileInterval(stats, point, n, conf);
}

/**
 * Two-sample percentile bootstrap: each arm resampled independently, `stat`
 * applied to the pair. `n` on the result is the smaller arm. Either arm < 2 →
 * NaN bounds.
 */
export function bootstrapTwoSample(
  a: readonly number[],
  b: readonly number[],
  stat: (a: number[], b: number[]) => number,
  opts: BootstrapOptions = {},
): Interval {
  const { resamples, seed, conf } = { ...BOOTSTRAP_DEFAULTS, ...opts };
  const n = Math.min(a.length, b.length);
  const point = a.length > 0 && b.length > 0 ? stat([...a], [...b]) : Number.NaN;
  if (a.length < 2 || b.length < 2) return { point, lo: Number.NaN, hi: Number.NaN, n, conf };
  const rnd = mulberry32(seed);
  const ba = new Array<number>(a.length);
  const bb = new Array<number>(b.length);
  const stats = new Array<number>(resamples);
  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < a.length; i++) ba[i] = a[Math.floor(rnd() * a.length)];
    for (let i = 0; i < b.length; i++) bb[i] = b[Math.floor(rnd() * b.length)];
    stats[r] = stat(ba, bb);
  }
  return percentileInterval(stats, point, n, conf);
}

/** The bootstrap CI of mean(compare) − mean(base): every two-arm GAP in the clinic. */
export function bootstrapGap(base: readonly number[], compare: readonly number[], opts: BootstrapOptions = {}): Interval {
  return bootstrapTwoSample(base, compare, (a, b) => mean(b) - mean(a), opts);
}

// ── Kelly ───────────────────────────────────────────────────────────────────

/** Thorp's discrete f* = p − (1 − p)/b. Null when b is not a positive number. */
export function kellyApprox(p: number, b: number): number | null {
  if (!(b > 0) || !Number.isFinite(p)) return null;
  return p - (1 - p) / b;
}

/** g(f) = p·ln(1 + b·f) + (1 − p)·ln(1 − f); −∞ at or past ruin. */
export function kellyGrowth(f: number, p: number, b: number): number {
  if (f >= 1 || 1 + b * f <= 0) return Number.NEGATIVE_INFINITY;
  return p * Math.log(1 + b * f) + (1 - p) * Math.log(1 - f);
}

/** Mean ln(1 + f·Rᵢ) — the exact E log over the empirical R distribution; −∞ past ruin. */
export function empiricalGrowth(f: number, rs: readonly number[]): number {
  if (rs.length === 0) return Number.NaN;
  let s = 0;
  for (const r of rs) {
    const w = 1 + f * r;
    if (w <= 0) return Number.NEGATIVE_INFINITY;
    s += Math.log(w);
  }
  return s / rs.length;
}

/**
 * Empirical Kelly: argmax over f ∈ [0, 0.99] (step 0.001) of mean ln(1 + f·Rᵢ)
 * (Thorp (vi), "maximizes E log(1 + f U)"). Null when no R is negative (the
 * maximiser runs off the grid — no loss measured, nothing to size against), when
 * the argmax is 0 (no positive growth at any fraction), and when the argmax is
 * the grid's EDGE, 0.99 (v4.7.0 audit CG-1): growth was still rising there, so
 * the maximum lies off the grid and 0.99 is not it — "off grid", not a figure.
 */
export function kellyEmpirical(rs: readonly number[]): number | null {
  if (rs.length === 0 || rs.every((r) => r >= 0)) return null;
  const GRID_EDGE = 990;
  let bestF = 0;
  let bestG = 0;
  for (let i = 1; i <= GRID_EDGE; i++) {
    const f = i / 1000;
    const g = empiricalGrowth(f, rs);
    if (!Number.isFinite(g)) break; // past ruin — every larger f is ruin too
    if (g > bestG) {
      bestG = g;
      bestF = f;
    } else if (g < bestG) {
      break; // E log is concave in f: once it falls it keeps falling
    }
  }
  return bestF > 0 && bestF < GRID_EDGE / 1000 ? bestF : null;
}

function bisectRoot(g: (f: number) => number, lo: number, hi: number): number {
  // Invariant: g(lo) > 0, g(hi) < 0 (or −∞).
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (g(mid) > 0) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-12) break;
  }
  return (lo + hi) / 2;
}

/**
 * fc: the zero-growth fraction BEYOND f* for the binary bet (p, b), by
 * bisection — never assumed to be 2f* (Thorp p.407; his example p = .53, b = 1:
 * f* = .06, fc = .11973). Null when f* is not positive.
 */
export function zeroGrowthFraction(p: number, b: number): number | null {
  const fStar = kellyApprox(p, b);
  if (fStar == null || !(fStar > 0) || fStar >= 1) return null;
  return bisectRoot((f) => kellyGrowth(f, p, b), fStar, 1);
}

/**
 * fc for the empirical E log, beyond the empirical f*. Null when f* is null, and
 * null when growth at the ruin bound is still ≥ 0 (v4.7.0 audit CG-1): there is
 * no zero crossing in [f*, ruin] for bisection to find — its invariant needs
 * g(hi) < 0 — so no fc is stated rather than the bracket's end.
 */
export function zeroGrowthFractionEmpirical(rs: readonly number[]): number | null {
  const fStar = kellyEmpirical(rs);
  if (fStar == null) return null;
  const worst = Math.min(...rs);
  const ruin = worst < 0 ? Math.min(1, 1 / -worst) : 1;
  const g = (f: number) => empiricalGrowth(f, rs);
  if (!(g(ruin) < 0)) return null;
  return bisectRoot(g, fStar, ruin);
}

// ── One-sided (downward) CUSUM ──────────────────────────────────────────────

export interface CusumOptions {
  /** Allowance in σ units (NIST: half the shift to detect). */
  k?: number;
  /** Decision interval in σ units. */
  h?: number;
  /** Minimum burn-in length; the burn-in is max(this, ⌊n/2⌋). */
  minBurnIn?: number;
}

export interface CusumResult {
  /** 0-based index into the sequence of the first S_t > h, or null. */
  alarmIndex: number | null;
  burnIn: number;
  mu0: number;
  sigma0: number;
  k: number;
  h: number;
  /** Largest S reached after the burn-in. */
  maxS: number;
}

/**
 * Downward-shift CUSUM on standardised R: x_t = (R_t − μ0)/σ0,
 * S_t = max(0, S_{t−1} − k − x_t), alarm at S_t > h. μ0 and σ0 (population)
 * come from the burn-in (the first max(minBurnIn, ⌊n/2⌋) values); monitoring
 * starts after it. Null when n < 2·minBurnIn or σ0 = 0.
 *
 * With k = 0.5 and h = 4 the in-control run length of a one-sided CUSUM is
 * roughly 330 observations, so a stationary book monitored for a few hundred
 * trades can alarm by chance — the clinic reports an alarm as "a possible
 * shift, test it", never as an imperative.
 */
export function cusumDown(xs: readonly number[], opts: CusumOptions = {}): CusumResult | null {
  const k = opts.k ?? 0.5;
  const h = opts.h ?? 4;
  const minBurnIn = opts.minBurnIn ?? 30;
  const n = xs.length;
  if (n < 2 * minBurnIn) return null;
  const burnIn = Math.max(minBurnIn, Math.floor(n / 2));
  const head = xs.slice(0, burnIn);
  const mu0 = mean(head);
  const sigma0 = Math.sqrt(populationVariance(head));
  if (!(sigma0 > 0)) return null;
  let s = 0;
  let maxS = 0;
  let alarmIndex: number | null = null;
  for (let t = burnIn; t < n; t++) {
    const x = (xs[t] - mu0) / sigma0;
    s = Math.max(0, s - k - x);
    if (s > maxS) maxS = s;
    if (alarmIndex == null && s > h) alarmIndex = t;
  }
  return { alarmIndex, burnIn, mu0, sigma0, k, h, maxS };
}

/** The most points a decay trace carries (v4.8.0 F1) — a 64 px chart cannot show more, and the cache stores every one. */
export const TRACE_MAX_POINTS = 120;

/**
 * Which of `n` positions (0 … n − 1) a down-sampled series keeps: all of them when
 * n ≤ max, else `max` positions evenly spaced by rounding — strictly increasing, the
 * FIRST (0) and the LAST (n − 1) always kept. Pure and deterministic: the same n and
 * max give the same positions on every machine (integer arithmetic after one round).
 */
export function downsampleIndices(n: number, max: number = TRACE_MAX_POINTS): number[] {
  if (!(n > 0) || !(max > 0)) return [];
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  if (max === 1) return [n - 1];
  const out: number[] = [];
  for (let k = 0; k < max; k++) out.push(Math.round((k * (n - 1)) / (max - 1)));
  return out;
}

/** One point of a decay trace: [tradeNumber (1-based, the window's LAST trade), the window's mean]. */
export type TracePoint = [tradeNumber: number, mean: number];

/**
 * The rolling W-trade mean — one point per window, at every trade number ≥ W —
 * down-sampled by `downsampleIndices` to at most `maxPoints`. Each kept point is the
 * EXACT mean of its own window (the windows are picked first, then averaged; nothing
 * is interpolated or smoothed). Empty when W < 2 or fewer than W values.
 */
export function rollingMeanTrace(xs: readonly number[], window: number, maxPoints: number = TRACE_MAX_POINTS): TracePoint[] {
  if (window < 2 || xs.length < window) return [];
  return downsampleIndices(xs.length - window + 1, maxPoints).map((j) => [j + window, mean(xs.slice(j, j + window))]);
}

// ── Longest losing run ──────────────────────────────────────────────────────

export interface LongestRun {
  /** Expected longest run of losses in n trades. */
  mean: number;
  variance: number;
  sd: number;
}

/**
 * Gordon–Schilling–Waterman (1986), k = 0, an ASYMPTOTIC APPROXIMATION:
 * E[L_n] ≈ ln(n(1−q))/ln(1/q) + γ/ln(1/q) − ½, Var ≈ π²/(6 ln²(1/q)) + 1/12,
 * q = the loss probability. Null unless 0 < q < 1 and n ≥ 1.
 */
export function expectedLongestLoss(n: number, q: number): LongestRun | null {
  if (!(q > 0 && q < 1) || !(n >= 1)) return null;
  const lam = Math.log(1 / q);
  const m = Math.log(n * (1 - q)) / lam + EULER_GAMMA / lam - 0.5;
  const variance = (Math.PI * Math.PI) / (6 * lam * lam) + 1 / 12;
  return { mean: m, variance, sd: Math.sqrt(variance) };
}
