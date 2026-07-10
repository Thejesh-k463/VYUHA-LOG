import { describe, it, expect } from "vitest";
import {
  computePortfolioVar,
  symbolBeta,
  betaWeightedExposure,
  stressScenarios,
  closesToReturnSeries,
  type RetPoint,
  type VarPosition,
} from "@/lib/risk/portfolio";

/** n days of returns cycling through the given values, dated consecutively. */
function series(rets: number[], n = 40, startDay = 1): RetPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-01-${String(startDay + i).padStart(2, "0")}`,
    ret: rets[i % rets.length],
  }));
}

describe("computePortfolioVar", () => {
  it("returns null with no usable history, and reports partial coverage", () => {
    const positions: VarPosition[] = [
      { id: 1, symbol: "AAA", exposure: 100000 },
      { id: 2, symbol: "BBB", exposure: 50000 },
    ];
    expect(computePortfolioVar(positions, new Map())).toBeNull();

    const map = new Map([["AAA", series([0.01, -0.01])]]); // only AAA has history
    const r = computePortfolioVar(positions, map)!;
    expect(r).not.toBeNull();
    expect(r.uncoveredSymbols).toEqual(["BBB"]);
    expect(r.coveredExposure).toBe(100000);
    expect(r.uncoveredExposure).toBe(50000);
    expect(r.coveragePct).toBeCloseTo(66.67, 1);
  });

  it("hand-checked historical VaR on a single flat-distribution position", () => {
    // 40 days alternating ±1% on ₹1,00,000 → daily P&L alternates ±1,000.
    // The 5th-percentile of {−1000×20, +1000×20} interpolates inside the −1000 block → VaR95 = 1000.
    const r = computePortfolioVar([{ id: 1, symbol: "AAA", exposure: 100000 }], new Map([["AAA", series([0.01, -0.01])]]))!;
    expect(r.var95).toBe(1000);
    expect(r.cvar95).toBe(1000); // whole tail is −1000
    expect(r.daysUsed).toBe(40);
    // sample σ (n−1) of a ±1000 series over 40 days = 1000×√(40/39) ≈ 1012.74
    // → parametric VaR95 = 1.645 × 1012.74 ≈ 1665.96
    expect(r.parametricVar95).toBeCloseTo(1665.96, 1);
  });

  it("a hedged book (long + equal short, same symbol) nets to zero risk", () => {
    const positions: VarPosition[] = [
      { id: 1, symbol: "AAA", exposure: 100000 },
      { id: 2, symbol: "AAA", exposure: -100000 },
    ];
    // net exposure 0 → nothing covered → null
    expect(computePortfolioVar(positions, new Map([["AAA", series([0.02, -0.02])]]))).toBeNull();
  });

  it("uses only the COMMON date grid across covered symbols", () => {
    const a = series([0.01, -0.01], 40, 1); // days 1..40
    const b = series([0.02, -0.02], 40, 6); // days 6..45 → overlap 6..40 = 35 days
    const r = computePortfolioVar(
      [
        { id: 1, symbol: "AAA", exposure: 50000 },
        { id: 2, symbol: "BBB", exposure: 50000 },
      ],
      new Map([["AAA", a], ["BBB", b]]),
    )!;
    expect(r.daysUsed).toBe(35);
  });

  it("VaR is a positive loss magnitude, clamped at 0 for an always-up book", () => {
    const r = computePortfolioVar([{ id: 1, symbol: "AAA", exposure: 100000 }], new Map([["AAA", series([0.01, 0.005])]]))!;
    expect(r.var95).toBe(0);
    expect(r.cvar95).toBe(0);
  });
});

describe("symbolBeta", () => {
  it("beta = 2 when the symbol always moves 2× the bench", () => {
    const bench = series([0.01, -0.02, 0.015, -0.005]);
    const sym = bench.map((b) => ({ date: b.date, ret: b.ret * 2 }));
    expect(symbolBeta(sym, bench)!.beta).toBe(2);
  });

  it("beta = -1 for a perfect inverse", () => {
    const bench = series([0.01, -0.02, 0.015, -0.005]);
    const sym = bench.map((b) => ({ date: b.date, ret: -b.ret }));
    expect(symbolBeta(sym, bench)!.beta).toBe(-1);
  });

  it("null when overlap is below minDays or bench has zero variance", () => {
    const bench = series([0.01, -0.02]);
    expect(symbolBeta(series([0.01], 10), bench)).toBeNull(); // 10 < 30 overlap
    expect(symbolBeta(series([0.01, -0.01]), series([0.005]))).toBeNull(); // flat bench
  });
});

describe("betaWeightedExposure", () => {
  it("weights by beta and flags fallbacks", () => {
    const e = betaWeightedExposure([
      { id: 1, symbol: "HIBETA", exposure: 100000, beta: 1.5 },
      { id: 2, symbol: "SHORT", exposure: -50000, beta: 1 },
      { id: 3, symbol: "NOHIST", exposure: 20000, beta: null },
    ]);
    expect(e.grossExposure).toBe(170000);
    expect(e.netExposure).toBe(70000);
    expect(e.betaWeightedExposure).toBe(100000 * 1.5 - 50000 + 20000); // fallback β=1
    expect(e.withBetaPct).toBeCloseTo(((100000 + 50000) / 170000) * 100, 1);
    expect(e.positions.find((p) => p.symbol === "NOHIST")!.betaIsFallback).toBe(true);
  });
});

describe("stressScenarios", () => {
  it("first-order equity: −5% on ₹1L at β=1 loses ₹5,000; β=2 doubles it", () => {
    const [r] = stressScenarios(
      [{ id: 1, symbol: "A", exposure: 100000, beta: 1 }],
      [{ label: "−5%", marketPct: -5, ivShiftPts: 0 }],
    );
    expect(r.pnl).toBe(-5000);
    const [r2] = stressScenarios(
      [{ id: 1, symbol: "A", exposure: 100000, beta: 2 }],
      [{ label: "−5%", marketPct: -5, ivShiftPts: 0 }],
    );
    expect(r2.pnl).toBe(-10000);
  });

  it("gamma adds a positive convexity kick for a long option in BOTH directions", () => {
    // long option: positive gamma → gains from movement either way
    const pos = [{ id: 1, symbol: "O", exposure: 50000, beta: 1, gamma: 0.02, spot: 1000, vega: 0 }];
    const [down] = stressScenarios(pos, [{ label: "−5%", marketPct: -5, ivShiftPts: 0 }]);
    // delta: 50000×−0.05 = −2500 ; gamma: ½×0.02×(1000×−0.05)² = 0.01×2500 = +25
    expect(down.deltaPnl).toBe(-2500);
    expect(down.gammaPnl).toBe(25);
    expect(down.pnl).toBe(-2475);
    const [up] = stressScenarios(pos, [{ label: "+5%", marketPct: 5, ivShiftPts: 0 }]);
    expect(up.gammaPnl).toBe(25); // same sign both ways
  });

  it("vega: IV +20 pts on a short-vega book loses vega×20", () => {
    const [r] = stressScenarios(
      [{ id: 1, symbol: "O", exposure: 0, beta: 1, vega: -150, gamma: 0, spot: 1000 }],
      [{ label: "IV+20", marketPct: 0, ivShiftPts: 20 }],
    );
    expect(r.vegaPnl).toBe(-3000);
    expect(r.pnl).toBe(-3000);
  });
});

describe("closesToReturnSeries", () => {
  it("derives returns from closes regardless of input order", () => {
    const rets = closesToReturnSeries([
      { date: "2026-01-03", close: 110 },
      { date: "2026-01-01", close: 100 },
      { date: "2026-01-02", close: 105 },
    ]);
    expect(rets).toHaveLength(2);
    expect(rets[0].date).toBe("2026-01-02");
    expect(rets[0].ret).toBeCloseTo(0.05, 10);
    expect(rets[1].date).toBe("2026-01-03");
    expect(rets[1].ret).toBeCloseTo(110 / 105 - 1, 10);
  });
});
