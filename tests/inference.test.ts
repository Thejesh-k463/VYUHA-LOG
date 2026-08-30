import { describe, expect, it } from "vitest";
import {
  benjaminiHochberg,
  benjaminiYekutieli,
  fmtIntervalPct,
  meanInterval,
  proportionPValue,
  rateVerdict,
  wilsonInterval,
} from "@/lib/analytics/inference";

/**
 * Pinned against PUBLISHED values, not against whatever the implementation
 * happened to produce. A statistics module that only agrees with itself is
 * worth nothing.
 */

describe("wilsonInterval", () => {
  it("matches published Wilson values at 95%", () => {
    // Brown, Cai & DasGupta (2001) worked examples.
    const a = wilsonInterval(5, 10);
    expect(a.lo).toBeCloseTo(0.2366, 3);
    expect(a.hi).toBeCloseTo(0.7634, 3);

    const b = wilsonInterval(9, 10);
    expect(b.lo).toBeCloseTo(0.5958, 3);
    expect(b.hi).toBeCloseTo(0.9821, 3);
  });

  it("never claims certainty from zero successes — the Wald interval's worst failure", () => {
    const w = wilsonInterval(0, 10);
    expect(w.point).toBe(0);
    expect(w.lo).toBe(0);
    // Wald would give [0, 0]: absolute certainty from ten trades. Wilson does not.
    expect(w.hi).toBeCloseTo(0.2775, 3);
    expect(w.hi).toBeGreaterThan(0.25);
  });

  it("never leaves [0,1] at either extreme", () => {
    for (const [k, n] of [[0, 1], [1, 1], [0, 3], [3, 3], [1, 200], [199, 200]]) {
      const w = wilsonInterval(k, n);
      expect(w.lo).toBeGreaterThanOrEqual(0);
      expect(w.hi).toBeLessThanOrEqual(1);
      expect(w.lo).toBeLessThanOrEqual(w.hi);
    }
  });

  it("says everything is possible when there is no evidence at all", () => {
    const w = wilsonInterval(0, 0);
    expect(w.n).toBe(0);
    expect(w.lo).toBe(0);
    expect(w.hi).toBe(1);
    expect(Number.isNaN(w.point)).toBe(true);
  });

  it("narrows as evidence accumulates at the same rate", () => {
    const widths = [10, 50, 250, 1000].map((n) => {
      const w = wilsonInterval(n * 0.6, n);
      return w.hi - w.lo;
    });
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeLessThan(widths[i - 1]);
  });

  /**
   * THE MOTIVATING CASE. `/reports/edge` will rank a setup on this, and
   * MIN_SAMPLE gates let 15 through.
   */
  it("shows how little a 68% win rate on 15 trades actually says", () => {
    const w = wilsonInterval(10, 15); // 66.7%
    expect(w.hi - w.lo).toBeGreaterThan(0.4); // the interval is over 40 points wide
    expect(w.lo).toBeLessThan(0.45); // and reaches down near a coin flip
  });
});

describe("meanInterval", () => {
  it("uses a t-quantile, so small samples get honestly wider intervals", () => {
    const vals = [1, 2, 3, 4, 5];
    const ci = meanInterval(vals);
    expect(ci.point).toBe(3);
    // mean 3, sd 1.5811, se 0.7071, t(4)=2.776 → ±1.963
    expect(ci.lo).toBeCloseTo(1.037, 2);
    expect(ci.hi).toBeCloseTo(4.963, 2);
  });

  it("refuses to put an interval on a single observation", () => {
    const ci = meanInterval([42]);
    expect(ci.point).toBe(42);
    expect(Number.isNaN(ci.lo)).toBe(true);
    expect(Number.isNaN(ci.hi)).toBe(true);
  });

  it("returns nothing at all for an empty sample", () => {
    expect(meanInterval([]).n).toBe(0);
    expect(Number.isNaN(meanInterval([]).point)).toBe(true);
  });

  it("brackets the mean and widens with dispersion", () => {
    const tight = meanInterval([10, 10.1, 9.9, 10, 10.05]);
    const loose = meanInterval([10, 50, -30, 80, -60]);
    expect(loose.hi - loose.lo).toBeGreaterThan(tight.hi - tight.lo);
  });
});

describe("proportionPValue", () => {
  it("returns 1 when the observation IS the null", () => {
    expect(proportionPValue(50, 100, 0.5)).toBe(1);
  });

  it("returns 1 rather than a small p from an empty sample", () => {
    expect(proportionPValue(0, 0, 0.5)).toBe(1);
  });

  it("finds a large, well-evidenced difference significant", () => {
    // 80/100 against a 50% null is overwhelming.
    expect(proportionPValue(80, 100, 0.5)).toBeLessThan(0.001);
  });

  it("does NOT find the same rate significant on a small sample", () => {
    // 8/10 is the same 80%, but ten trades cannot establish it.
    expect(proportionPValue(8, 10, 0.5)).toBeGreaterThan(0.05);
  });
});

describe("multiplicity control", () => {
  const items = [0.001, 0.008, 0.02, 0.04, 0.2].map((p, i) => ({ item: `slice${i}`, p }));

  it("BH matches the worked example from the original paper's method", () => {
    // m=5, q=0.05: thresholds 0.01, 0.02, 0.03, 0.04, 0.05.
    // Largest rank with p <= threshold is 4 (0.04 <= 0.04), so 4 are rejected.
    const out = benjaminiHochberg(items, 0.05);
    expect(out.filter((r) => r.significant).length).toBe(4);
    expect(out[4].significant).toBe(false); // p = 0.2
  });

  it("BY is STRICTLY more conservative — the price of arbitrary dependence", () => {
    const bh = benjaminiHochberg(items, 0.05).filter((r) => r.significant).length;
    const by = benjaminiYekutieli(items, 0.05).filter((r) => r.significant).length;
    expect(by).toBeLessThan(bh);
    /**
     * c(5) = 1 + 1/2 + 1/3 + 1/4 + 1/5 = 2.28333, so every BH threshold is
     * divided by that. Rank thresholds become 0.00438, 0.00876, 0.01314,
     * 0.01752, 0.02190 against sorted p 0.001, 0.008, 0.02, 0.04, 0.2.
     * The largest rank that clears is 2 (0.008 <= 0.00876), so TWO survive
     * where BH passed four. Worked through by hand — an earlier version of
     * this test asserted 1 and the implementation was right, not the test.
     */
    expect(by).toBe(2);
  });

  it("preserves input order in the output, whatever the p-value ranking", () => {
    const shuffled = [{ item: "a", p: 0.9 }, { item: "b", p: 0.001 }, { item: "c", p: 0.3 }];
    const out = benjaminiYekutieli(shuffled, 0.05);
    expect(out.map((r) => r.item)).toEqual(["a", "b", "c"]);
    expect(out[1].significant).toBe(true);
    expect(out[0].significant).toBe(false);
  });

  it("rejects nothing when every p-value is large", () => {
    const out = benjaminiYekutieli([0.4, 0.5, 0.9].map((p, i) => ({ item: i, p })), 0.05);
    expect(out.every((r) => !r.significant)).toBe(true);
  });

  it("handles an empty input without inventing a result", () => {
    expect(benjaminiYekutieli([], 0.05)).toEqual([]);
    expect(benjaminiHochberg([], 0.05)).toEqual([]);
  });

  it("names the method it used, so a screen can say so", () => {
    expect(benjaminiYekutieli(items)[0].method).toBe("BY");
    expect(benjaminiHochberg(items)[0].method).toBe("BH");
  });
});

describe("rateVerdict — what the screen actually says", () => {
  it("says a slice is not distinguishable when the interval spans the book's rate", () => {
    const v = rateVerdict(wilsonInterval(10, 15), 0.5);
    expect(v).toMatch(/not yet distinguishable/);
  });

  it("stops short of a verdict on a handful of trades", () => {
    expect(rateVerdict(wilsonInterval(2, 3), 0.5)).toMatch(/far too few/);
  });

  it("says nothing at all with no trades", () => {
    expect(rateVerdict(wilsonInterval(0, 0), 0.5)).toBe("no closed trades yet");
  });

  it("reports the interval when the slice IS distinguishable", () => {
    const v = rateVerdict(wilsonInterval(80, 100), 0.5);
    expect(v).not.toMatch(/not yet distinguishable/);
    expect(v).toMatch(/95% CI spans/);
  });

  it("never claims a finding — the copy marks, it does not assert", () => {
    for (const [k, n] of [[10, 15], [80, 100], [0, 0], [2, 3]]) {
      expect(rateVerdict(wilsonInterval(k, n), 0.5)).not.toMatch(/\bproven\b|\bconfirms?\b|\byour edge is\b/i);
    }
  });
});

describe("fmtIntervalPct", () => {
  it("formats a range", () => {
    expect(fmtIntervalPct(wilsonInterval(5, 10))).toBe("24%–76%");
  });

  it("returns the product's own refusal mark when there is no interval", () => {
    expect(fmtIntervalPct(meanInterval([1]))).toBe("—");
  });
});
