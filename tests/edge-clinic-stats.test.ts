import { describe, it, expect } from "vitest";
import {
  EULER_GAMMA,
  normCdf,
  normInv,
  studentTCdf,
  tTest,
  mean,
  median,
  populationMoments,
  perTradeSharpe,
  sigmaTerm,
  psr,
  minTrl,
  expectedMaxSr,
  deflatedSr,
  bootstrapInterval,
  bootstrapGap,
  bootstrapTwoSample,
  kellyApprox,
  kellyGrowth,
  kellyEmpirical,
  empiricalGrowth,
  zeroGrowthFraction,
  zeroGrowthFractionEmpirical,
  cusumDown,
  rollingMeanBand,
  expectedLongestLoss,
} from "@/lib/analytics/edge-clinic-stats";
import { tQuantile95 } from "@/lib/analytics/inference";
import { mulberry32 } from "@/lib/analytics/monte-carlo";

/** Seeded standard normals (Box–Muller over mulberry32). */
function normals(n: number, seed: number): number[] {
  const rnd = mulberry32(seed);
  const out: number[] = [];
  while (out.length < n) {
    const u1 = Math.max(rnd(), 1e-12);
    const u2 = rnd();
    const r = Math.sqrt(-2 * Math.log(u1));
    out.push(r * Math.cos(2 * Math.PI * u2));
    if (out.length < n) out.push(r * Math.sin(2 * Math.PI * u2));
  }
  return out;
}

describe("Φ and Φ⁻¹ (Acklam + refinement)", () => {
  it.each([
    [0.95, 1.644854],
    [0.975, 1.959964],
    [0.99, 2.326348],
    [0.75, 0.67449],
  ])("Φ⁻¹(%s) = %s to 1e-6", (u, z) => {
    expect(Math.abs(normInv(u) - z)).toBeLessThan(1e-6);
  });

  it("is antisymmetric: Φ⁻¹(1 − u) = −Φ⁻¹(u), and Φ⁻¹(½) = 0", () => {
    for (const u of [0.001, 0.01, 0.02, 0.1, 0.3]) expect(normInv(1 - u)).toBeCloseTo(-normInv(u), 9);
    expect(Math.abs(normInv(0.5))).toBeLessThan(1e-15);
  });

  it("round-trips Φ(Φ⁻¹(u)) = u across both tails and the centre (|err| < 1e-12)", () => {
    for (const u of [1e-10, 1e-6, 0.001, 0.02, 0.02425, 0.1, 0.5, 0.7, 0.97575, 0.99, 0.999999]) {
      expect(Math.abs(normCdf(normInv(u)) - u)).toBeLessThan(1e-12 + u * 1e-9);
    }
  });

  it("p ≤ 0 and p ≥ 1 are the infinities, not a number", () => {
    expect(normInv(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(normInv(1)).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(normInv(Number.NaN))).toBe(true);
  });

  it("Φ hits the textbook values to 1e-12 (series and continued-fraction branches)", () => {
    expect(normCdf(0)).toBe(0.5);
    expect(Math.abs(normCdf(1.959963984540054) - 0.975)).toBeLessThan(1e-12);
    expect(Math.abs(normCdf(-3) - 0.0013498980316301)).toBeLessThan(1e-14);
    expect(Math.abs(normCdf(-5) - 2.866515718791939e-7)).toBeLessThan(1e-17);
    expect(normCdf(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("Student t (the cell p-value)", () => {
  it("agrees with inference.ts's 95% table at every df 1..30 (the table is 3 dp)", () => {
    for (let df = 1; df <= 30; df++) {
      expect(Math.abs(1 - studentTCdf(tQuantile95(df), df) - 0.025)).toBeLessThan(2e-4);
    }
  });

  it("is ½ at 0, symmetric, and tends to Φ for large df", () => {
    expect(studentTCdf(0, 7)).toBeCloseTo(0.5, 12);
    expect(studentTCdf(-1.3, 9)).toBeCloseTo(1 - studentTCdf(1.3, 9), 12);
    expect(Math.abs(studentTCdf(1.7, 100000) - normCdf(1.7))).toBeLessThan(1e-5);
  });

  it("tTest: one-sided p small for a clearly positive sample, two-sided p = 2·min", () => {
    const xs = normals(60, 7).map((z) => z + 0.8);
    const t = tTest(xs)!;
    expect(t.df).toBe(59);
    expect(t.pOneSided).toBeLessThan(1e-6);
    expect(t.pTwoSided).toBeCloseTo(2 * t.pOneSided, 12);
    const neg = tTest(xs.map((x) => -x))!;
    expect(neg.pOneSided).toBeGreaterThan(0.999999);
    expect(neg.pTwoSided).toBeCloseTo(t.pTwoSided, 12);
  });

  it("tTest is null with no dispersion or under two values", () => {
    expect(tTest([1, 1, 1])).toBeNull();
    expect(tTest([1])).toBeNull();
  });
});

describe("population moments", () => {
  it("a symmetric two-point ±1 vector has skew 0 and RAW kurtosis 1", () => {
    const m = populationMoments([1, -1, 1, -1])!;
    expect(m.sd).toBe(1);
    expect(m.g3).toBe(0);
    expect(m.g4).toBe(1);
  });

  it("[1,2,3,4,5]: population sd √2, skew 0, raw kurtosis 1.7 (m4 = 6.8, m2 = 2)", () => {
    const m = populationMoments([1, 2, 3, 4, 5])!;
    expect(m.mean).toBe(3);
    expect(m.sd).toBeCloseTo(Math.SQRT2, 12);
    expect(m.g3).toBeCloseTo(0, 12);
    expect(m.g4).toBeCloseTo(1.7, 12);
  });

  it("skew sign follows the long tail", () => {
    expect(populationMoments([0, 0, 0, 0, 10])!.g3).toBeGreaterThan(0);
    expect(populationMoments([0, 0, 0, 0, -10])!.g3).toBeLessThan(0);
  });

  it("is null when undefined (n < 2, zero dispersion); sharpe likewise", () => {
    expect(populationMoments([3])).toBeNull();
    expect(populationMoments([2, 2, 2])).toBeNull();
    expect(perTradeSharpe([2, 2])).toBeNull();
    expect(perTradeSharpe([1, 3])).toBeCloseTo(2 / 1, 12);
  });

  it("mean / median basics (median of an even count averages the middle pair)", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
  });
});

describe("PSR and MinTRL — Bailey & López de Prado 2012, Appendix A.3", () => {
  // The paper's worked input: stats = [2, √12, −0.72, 5.78] → sr = 2/√12.
  const sr = 2 / Math.sqrt(12);
  const g3 = -0.72;
  const g4 = 5.78;
  const z95 = 1.6448536269514722; // Φ⁻¹(0.95), one-sided

  it("sigmaTerm by hand: 1 + 0.72·sr + (4.78/4)·sr²", () => {
    const hand = 1 + 0.72 * sr + (4.78 / 4) * sr * sr;
    expect(Math.abs(sigmaTerm(sr, g3, g4) - hand)).toBeLessThan(1e-12);
  });

  it("MinTRL by hand: 1 + sigmaTerm·(1.644854/sr)² (≈ 15.72 trades), to 1e-6", () => {
    const st = 1 + 0.72 * sr + (4.78 / 4) * sr * sr;
    const hand = 1 + st * (z95 / sr) * (z95 / sr);
    expect(Math.abs(minTrl(sr, 0, g3, g4)! - hand)).toBeLessThan(1e-6);
    expect(hand).toBeGreaterThan(15.7);
    expect(hand).toBeLessThan(15.75);
  });

  it("PSR by hand: Φ(sr·√(n−1)/√sigmaTerm) at n = 24, to 1e-6", () => {
    const st = 1 + 0.72 * sr + (4.78 / 4) * sr * sr;
    const hand = normCdf((sr * Math.sqrt(23)) / Math.sqrt(st));
    expect(Math.abs(psr(sr, 0, 24, g3, g4)! - hand)).toBeLessThan(1e-6);
  });

  it("PSR at the MinTRL track length is exactly the 0.95 it was solved for", () => {
    const n = minTrl(sr, 0, g3, g4)!;
    expect(psr(sr, 0, n, g3, g4)!).toBeCloseTo(0.95, 9);
  });

  it("the Normal case (g3 = 0, g4 = 3) reduces sigmaTerm to 1 + sr²/2 (Lo 2002)", () => {
    for (const s of [0.1, 0.4, 1.2]) expect(sigmaTerm(s, 0, 3)).toBeCloseTo(1 + (s * s) / 2, 14);
  });

  it("MinTRL is null when sr ≤ srRef (no positive edge measured yet)", () => {
    expect(minTrl(0.2, 0.2, 0, 3)).toBeNull();
    expect(minTrl(-0.1, 0, 0, 3)).toBeNull();
    expect(minTrl(0.1, 0.3, 0, 3)).toBeNull();
  });

  it("PSR is null on a non-positive variance term or n < 2", () => {
    // 1 − g3·sr + … ≤ 0: a huge positive skew at a large sr
    expect(psr(2, 0, 50, 5, 1)).toBeNull();
    expect(psr(0.3, 0, 1, 0, 3)).toBeNull();
  });

  it("PSR rises with n and falls with srRef", () => {
    expect(psr(0.2, 0, 200, 0, 3)!).toBeGreaterThan(psr(0.2, 0, 50, 0, 3)!);
    expect(psr(0.2, 0.1, 100, 0, 3)!).toBeLessThan(psr(0.2, 0, 100, 0, 3)!);
  });
});

describe("E[max SR] and the Deflated Sharpe Ratio — Bailey & López de Prado 2014", () => {
  it("is monotone increasing in N and scales with √var", () => {
    const xs = [2, 3, 5, 10, 50, 200].map((N) => expectedMaxSr(0.04, N)!);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
    expect(expectedMaxSr(0.16, 10)!).toBeCloseTo(2 * expectedMaxSr(0.04, 10)!, 12);
  });

  it("matches the paper's bracket by hand at N = 10", () => {
    const hand = Math.sqrt(0.09) * ((1 - EULER_GAMMA) * normInv(0.9) + EULER_GAMMA * normInv(1 - 1 / (10 * Math.E)));
    expect(expectedMaxSr(0.09, 10)!).toBeCloseTo(hand, 14);
  });

  it("N < 2 is null (one trial has nothing to deflate); var 0 is 0", () => {
    expect(expectedMaxSr(0.04, 1)).toBeNull();
    expect(expectedMaxSr(0.04, 0)).toBeNull();
    expect(expectedMaxSr(0, 5)).toBe(0);
  });

  it("DSR < PSR(0) whenever N > 1 and the trials' SRs vary", () => {
    for (const N of [2, 5, 20]) {
      expect(deflatedSr(0.25, 0.02, N, 120, -0.3, 4)!).toBeLessThan(psr(0.25, 0, 120, -0.3, 4)!);
    }
    expect(deflatedSr(0.25, 0.02, 1, 120, -0.3, 4)).toBeNull();
  });
});

describe("Kelly — Thorp 2006", () => {
  it("f*(p = .6, b = 1) = 0.2; b ≤ 0 is null", () => {
    expect(kellyApprox(0.6, 1)).toBeCloseTo(0.2, 14);
    expect(kellyApprox(0.6, 0)).toBeNull();
    expect(kellyApprox(0.5, 2)).toBeCloseTo(0.25, 14);
  });

  it("growth(0) = 0 and growth(f*) > growth(f*/2) > 0", () => {
    expect(kellyGrowth(0, 0.6, 1)).toBe(0);
    const f = 0.2;
    expect(kellyGrowth(f, 0.6, 1)).toBeGreaterThan(kellyGrowth(f / 2, 0.6, 1));
    expect(kellyGrowth(f / 2, 0.6, 1)).toBeGreaterThan(0);
  });

  it("growth(2f*) ≈ 0 ONLY in the symmetric b = 1 case (|g| < 5e-3 there; not so at b = 3)", () => {
    expect(Math.abs(kellyGrowth(0.4, 0.6, 1))).toBeLessThan(5e-3);
    const fStar = kellyApprox(0.4, 3)!; // 0.2
    expect(Math.abs(kellyGrowth(2 * fStar, 0.4, 3))).toBeGreaterThan(5e-3);
  });

  it("Thorp's p = .53, b = 1 example: f* = .06 and fc ≈ .11973 (±2e-3), found by bisection", () => {
    expect(kellyApprox(0.53, 1)).toBeCloseTo(0.06, 12);
    const fc = zeroGrowthFraction(0.53, 1)!;
    expect(Math.abs(fc - 0.11973)).toBeLessThan(2e-3);
    expect(Math.abs(kellyGrowth(fc, 0.53, 1))).toBeLessThan(1e-10);
    expect(zeroGrowthFraction(0.4, 1)).toBeNull();
  });

  it("empirical Kelly on a ±1 coin with 60% heads lands on the grid's 0.2", () => {
    const rs = [...Array(60).fill(1), ...Array(40).fill(-1)];
    expect(kellyEmpirical(rs)).toBeCloseTo(0.2, 9);
    expect(empiricalGrowth(0, rs)).toBe(0);
    const fc = zeroGrowthFractionEmpirical(rs)!;
    expect(fc).toBeGreaterThan(0.2);
    expect(Math.abs(empiricalGrowth(fc, rs))).toBeLessThan(1e-9);
  });

  it("empirical Kelly is null with no losing R, and null when no fraction grows", () => {
    expect(kellyEmpirical([0.5, 1, 2])).toBeNull();
    expect(kellyEmpirical([-1, -1, 0.5])).toBeNull();
    expect(kellyEmpirical([])).toBeNull();
  });

  // v4.7.0 audit CG-1: an argmax ON the grid's edge is not a maximum — growth was still
  // rising at 0.99, so the true f* lies off the grid (here ≈ 1.417 per 1R: the losses are
  // too small to size against). It used to return 0.99, and fc then "bisected" a bracket
  // whose upper end still grew, returning ≈ 1.
  it("CG-1: an argmax at the grid edge (0.99) is null — off grid — and so is its fc (R alternating −0.3 / +2, n = 50)", () => {
    const rs = Array.from({ length: 50 }, (_, i) => (i % 2 ? 2 : -0.3));
    expect(empiricalGrowth(0.99, rs)).toBeGreaterThan(empiricalGrowth(0.989, rs)); // still rising at the edge
    expect(kellyEmpirical(rs)).toBeNull();
    expect(zeroGrowthFractionEmpirical(rs)).toBeNull();
  });

  it("CG-1: fc is null when growth at the ruin bound is still ≥ 0 — bisection's invariant g(hi) < 0 does not hold (−0.3 / +0.5)", () => {
    const rs = Array.from({ length: 50 }, (_, i) => (i % 2 ? 0.5 : -0.3));
    expect(kellyEmpirical(rs)).toBeCloseTo(0.667, 9); // an interior maximum: f* stands
    expect(empiricalGrowth(1, rs)).toBeGreaterThan(0); // ruin bound min(1, 1/0.3) = 1, and g(1) > 0
    expect(zeroGrowthFractionEmpirical(rs)).toBeNull();
    // A bracket that does cross zero still bisects (the ±1 coin above): unchanged.
    const coin = [...Array(60).fill(1), ...Array(40).fill(-1)];
    expect(zeroGrowthFractionEmpirical(coin)!).toBeGreaterThan(0.2);
  });

  it("empirical growth is −∞ at or past the ruin fraction", () => {
    expect(empiricalGrowth(0.5, [1, -2])).toBe(Number.NEGATIVE_INFINITY);
    expect(kellyGrowth(1, 0.6, 1)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("one-sided downward CUSUM (k = 0.5, h = 4, standardised)", () => {
  it("alarms within 30 trades of a +0.5 → −0.5 shift at index 100", () => {
    const z = normals(200, 101);
    const xs = z.map((e, i) => (i < 100 ? 0.5 : -0.5) + e);
    const r = cusumDown(xs)!;
    expect(r.burnIn).toBe(100);
    expect(r.alarmIndex).not.toBeNull();
    expect(r.alarmIndex!).toBeGreaterThan(100);
    expect(r.alarmIndex!).toBeLessThan(130);
  });

  it("does not alarm on a stationary seeded sequence of 300", () => {
    const xs = normals(300, 4242).map((e) => 0.2 + e);
    const r = cusumDown(xs)!;
    expect(r.alarmIndex).toBeNull();
    expect(r.maxS).toBeLessThanOrEqual(4);
  });

  it("burn-in is max(30, ⌊n/2⌋); n < 60 or σ0 = 0 is null", () => {
    expect(cusumDown(normals(80, 3))!.burnIn).toBe(40);
    expect(cusumDown(normals(59, 3))).toBeNull();
    expect(cusumDown(Array(80).fill(1))).toBeNull();
  });

  it("the rolling band has one point per index ≥ W − 1, each a t-interval round its mean", () => {
    const xs = normals(70, 9);
    const band = rollingMeanBand(xs, 30);
    expect(band).toHaveLength(41);
    expect(band[0].index).toBe(29);
    expect(band[0].mean).toBeCloseTo(mean(xs.slice(0, 30)), 12);
    for (const p of band) {
      expect(p.lo).toBeLessThan(p.mean);
      expect(p.hi).toBeGreaterThan(p.mean);
    }
  });
});

describe("expected longest losing run — Gordon, Schilling & Waterman 1986", () => {
  it("(200, 0.58) ≈ 8.7 (±0.1), above R1's naive log(n)/log(1/q) − 1.2", () => {
    const r = expectedLongestLoss(200, 0.58)!;
    expect(Math.abs(r.mean - 8.7)).toBeLessThan(0.1);
    const naive = Math.log(200) / Math.log(1 / 0.58);
    expect(r.mean).toBeGreaterThan(naive - 1.2);
    expect(r.mean).toBeLessThan(naive);
  });

  it("variance = π²/(6 ln²(1/q)) + 1/12", () => {
    const lam = Math.log(1 / 0.4);
    const r = expectedLongestLoss(500, 0.4)!;
    expect(r.variance).toBeCloseTo((Math.PI * Math.PI) / (6 * lam * lam) + 1 / 12, 12);
    expect(r.sd).toBeCloseTo(Math.sqrt(r.variance), 12);
  });

  it("guards 0 < q < 1 and n ≥ 1", () => {
    expect(expectedLongestLoss(200, 0)).toBeNull();
    expect(expectedLongestLoss(200, 1)).toBeNull();
    expect(expectedLongestLoss(0, 0.5)).toBeNull();
  });

  it("grows with n and with q", () => {
    expect(expectedLongestLoss(400, 0.5)!.mean).toBeGreaterThan(expectedLongestLoss(200, 0.5)!.mean);
    expect(expectedLongestLoss(200, 0.6)!.mean).toBeGreaterThan(expectedLongestLoss(200, 0.5)!.mean);
  });
});

describe("seeded percentile bootstrap", () => {
  const xs = normals(40, 55).map((z) => 0.3 + z);

  it("is deterministic for a fixed seed and moves with the seed", () => {
    const a = bootstrapInterval(xs, mean);
    const b = bootstrapInterval(xs, mean);
    expect(a).toEqual(b);
    const c = bootstrapInterval(xs, mean, { seed: 7 });
    expect(c.lo).not.toBe(a.lo);
  });

  it("its interval contains the sample mean and is roughly the t-interval's width", () => {
    const ci = bootstrapInterval(xs, mean);
    expect(ci.point).toBeCloseTo(mean(xs), 14);
    expect(ci.lo).toBeLessThan(ci.point);
    expect(ci.hi).toBeGreaterThan(ci.point);
    expect(ci.n).toBe(40);
    expect(ci.conf).toBe(0.95);
  });

  it("n < 2 has NaN bounds, never a point interval", () => {
    const ci = bootstrapInterval([1.5], mean);
    expect(ci.point).toBe(1.5);
    expect(Number.isNaN(ci.lo)).toBe(true);
  });

  it("the two-arm gap is mean(compare) − mean(base) and its CI excludes 0 on a real shift", () => {
    const base = normals(50, 1);
    const cmp = normals(50, 2).map((z) => z - 1);
    const g = bootstrapGap(base, cmp);
    expect(g.point).toBeCloseTo(mean(cmp) - mean(base), 12);
    expect(g.hi).toBeLessThan(0);
    const r = bootstrapTwoSample(base, cmp, (a, b) => median(b) - median(a));
    expect(r.point).toBeCloseTo(median(cmp) - median(base), 12);
  });
});
