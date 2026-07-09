import { describe, it, expect } from "vitest";
import { monteCarloEquity, mulberry32 } from "@/lib/analytics/monte-carlo";

const flat = (r: number, n = 60) => new Array(n).fill(r);

describe("mulberry32", () => {
  it("is deterministic for a given seed and in [0,1)", () => {
    const a = mulberry32(7), b = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe("monteCarloEquity", () => {
  it("refuses to simulate on too little history (<20 days) or bad equity", () => {
    expect(monteCarloEquity(flat(0.01, 10), 100000)).toBeNull();
    expect(monteCarloEquity(flat(0.01), 0)).toBeNull();
  });

  it("is deterministic for the same seed", () => {
    const returns = [0.01, -0.02, 0.005, 0.015, -0.01, 0.02, -0.005, 0.001, -0.015, 0.03,
      0.002, -0.008, 0.012, -0.02, 0.007, 0.018, -0.011, 0.004, -0.006, 0.009, 0.013, -0.017];
    const a = monteCarloEquity(returns, 100000, { paths: 500, seed: 1 })!;
    const b = monteCarloEquity(returns, 100000, { paths: 500, seed: 1 })!;
    expect(a).toEqual(b);
  });

  it("all-positive returns → zero ruin, zero loss probability, p5 above start", () => {
    const r = monteCarloEquity(flat(0.005), 100000, { paths: 300, horizonDays: 100 })!;
    expect(r.riskOfRuinPct).toBe(0);
    expect(r.probLossPct).toBe(0);
    expect(r.terminal.p5).toBeGreaterThan(100000);
    // deterministic compounding: exactly 100000 × 1.005^100
    expect(r.terminal.p50).toBeCloseTo(100000 * Math.pow(1.005, 100), 0);
  });

  it("all-negative returns → certain ruin (deep horizon) and 100% loss probability", () => {
    const r = monteCarloEquity(flat(-0.01), 100000, { paths: 200, horizonDays: 252 })!;
    expect(r.probLossPct).toBe(100);
    // 0.99^252 ≈ 0.079 → well below the 0.5 ruin level, every path ruins
    expect(r.riskOfRuinPct).toBe(100);
  });

  it("percentiles are monotonic and mean sits inside [p5, p95]", () => {
    const returns = [0.02, -0.02, 0.01, -0.01, 0.03, -0.03, 0.005, -0.005, 0.015, -0.015,
      0.025, -0.025, 0.008, -0.008, 0.012, -0.012, 0.001, -0.001, 0.018, -0.018, 0.006, -0.006];
    const r = monteCarloEquity(returns, 100000, { paths: 1000 })!;
    const t = r.terminal;
    expect(t.p5).toBeLessThanOrEqual(t.p25);
    expect(t.p25).toBeLessThanOrEqual(t.p50);
    expect(t.p50).toBeLessThanOrEqual(t.p75);
    expect(t.p75).toBeLessThanOrEqual(t.p95);
    expect(t.mean).toBeGreaterThanOrEqual(t.p5);
    expect(t.mean).toBeLessThanOrEqual(t.p95);
  });

  it("a tighter ruin threshold (smaller drawdown) ruins more often", () => {
    const returns = [0.02, -0.025, 0.01, -0.015, 0.03, -0.03, 0.005, -0.02, 0.015, -0.01,
      0.025, -0.028, 0.008, -0.012, 0.012, -0.022, 0.001, -0.005, 0.018, -0.026, 0.006, -0.009];
    const loose = monteCarloEquity(returns, 100000, { paths: 800, ruinFrac: 0.3, seed: 5 })!; // ruin at −70%
    const tight = monteCarloEquity(returns, 100000, { paths: 800, ruinFrac: 0.8, seed: 5 })!; // ruin at −20%
    expect(tight.riskOfRuinPct).toBeGreaterThanOrEqual(loose.riskOfRuinPct);
  });
});
