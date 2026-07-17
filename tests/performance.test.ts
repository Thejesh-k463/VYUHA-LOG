import { describe, it, expect } from "vitest";
import { computePerformance, timeWeightedReturn, type DailyPoint } from "@/lib/analytics/performance";

describe("computePerformance", () => {
  const daily: DailyPoint[] = [
    { date: "2026-01-01", net: 1000 },
    { date: "2026-01-02", net: -500 },
    { date: "2026-01-05", net: 2000 },
  ];
  const p = computePerformance(daily, 100000, 0);

  it("equity path and total return", () => {
    expect(p.startEquity).toBe(100000);
    expect(p.endEquity).toBe(102500); // 100000 +1000 -500 +2000
    expect(p.totalReturnPct).toBe(2.5);
    expect(p.tradingDays).toBe(3);
  });

  it("max drawdown from peak", () => {
    // peak 101000 then dip to 100500 → -0.495%
    expect(p.maxDrawdownPct).toBeCloseTo(0.5, 1);
    expect(p.maxDrawdownAmt).toBe(500);
  });

  it("risk-adjusted ratios are finite and signed", () => {
    expect(p.volatilityPct).toBeGreaterThan(0);
    expect(p.sharpe).not.toBeNull();
    expect(p.sharpe!).toBeGreaterThan(0); // net positive period
    expect(p.positiveDaysPct).toBeCloseTo(66.67, 1); // 2 of 3 up
  });

  it("monthly return chains daily returns (telescopes to total within a month)", () => {
    expect(p.monthly.length).toBe(1);
    expect(p.monthly[0].ym).toBe("2026-01");
    expect(p.monthly[0].retPct).toBeCloseTo(2.5, 2);
    expect(p.monthly[0].net).toBe(2500);
  });

  it("does not annualise CAGR for short windows (<30d)", () => {
    expect(p.cagrPct).toBeNull();
  });
});

describe("computePerformance — CAGR over a real window", () => {
  it("annualises when span ≥ 30 days", () => {
    const daily: DailyPoint[] = [
      { date: "2026-01-01", net: 0 },
      { date: "2026-07-01", net: 10000 }, // ~181 days, +10% on 100000
    ];
    const p = computePerformance(daily, 100000, 0);
    expect(p.totalReturnPct).toBe(10);
    expect(p.cagrPct).not.toBeNull();
    expect(p.cagrPct!).toBeGreaterThan(10); // annualised > period return
  });
});

describe("monthlyReturns across months & years", () => {
  it("groups by month with geometric returns", () => {
    const p = computePerformance(
      [
        { date: "2026-01-15", net: 5000 },
        { date: "2026-02-10", net: -2000 },
        { date: "2027-01-05", net: 3000 },
      ],
      100000,
    );
    expect(p.monthly.map((m) => m.ym)).toEqual(["2026-01", "2026-02", "2027-01"]);
    expect(p.monthly[0].retPct).toBeCloseTo(5, 2); // 5000/100000
  });
});

describe("edge cases", () => {
  it("empty series returns zeros", () => {
    const p = computePerformance([], 100000);
    expect(p.tradingDays).toBe(0);
    expect(p.totalReturnPct).toBe(0);
    expect(p.sharpe).toBeNull();
    expect(p.monthly).toEqual([]);
  });
});

describe("timeWeightedReturn", () => {
  it("chains a single daily gain geometrically", () => {
    const r = timeWeightedReturn([{ date: "2026-01-01", net: 10000 }], 100000);
    expect(r).not.toBeNull();
    expect(r!.twrPct).toBeCloseTo(10, 6); // 10000/100000
    expect(r!.periods).toBe(1);
  });

  it("neutralises a deposit (capital in is not a return)", () => {
    // day1: +10% (100k→110k). day2: deposit 110k (→220k) then +22k = +10% again.
    // A flow-naive return would be skewed; true TWR chains 1.1 × 1.1 = 1.21.
    const r = timeWeightedReturn(
      [
        { date: "2026-01-01", net: 10000 },
        { date: "2026-01-02", net: 22000 },
      ],
      100000,
      [{ date: "2026-01-02", amount: 110000 }],
    );
    expect(r!.twrPct).toBeCloseTo(21, 6);
  });

  it("annualises geometrically over a one-year window", () => {
    // two +10% periods exactly 365 days apart → cumulative 21%, annualised = 21%
    const r = timeWeightedReturn(
      [
        { date: "2024-01-01", net: 10000 },
        { date: "2024-12-31", net: 11000 },
      ],
      100000,
    );
    expect(r!.twrPct).toBeCloseTo(21, 6);
    expect(r!.days).toBe(365);
    expect(r!.annualizedPct).toBeCloseTo(21, 4);
  });

  it("does not annualise short windows (<30d)", () => {
    const r = timeWeightedReturn(
      [
        { date: "2026-01-01", net: 1000 },
        { date: "2026-01-10", net: 1000 },
      ],
      100000,
    );
    expect(r!.annualizedPct).toBeNull();
  });

  it("returns null for an empty series", () => {
    expect(timeWeightedReturn([], 100000)).toBeNull();
  });
});
