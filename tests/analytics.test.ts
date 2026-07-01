import { describe, it, expect } from "vitest";
import {
  computeKpis,
  dailyPnl,
  equityCurve,
  bySegment,
  type AnalyticsTrade,
} from "@/lib/analytics/metrics";

function t(p: Partial<AnalyticsTrade>): AnalyticsTrade {
  return {
    broker: "dhan", bucket: "active", segment: "index_option",
    netPnl: 0, grossPnl: 0, chargesTotal: 0, rMultiple: null, isOpen: false,
    sellDate: "2026-06-01", buyDate: "2026-06-01", setupTag: null, ...p,
  };
}

const sample: AnalyticsTrade[] = [
  t({ sellDate: "2026-06-01", netPnl: 1000, grossPnl: 1100, chargesTotal: 100, rMultiple: 1.0 }),
  t({ sellDate: "2026-06-02", netPnl: -500, grossPnl: -400, chargesTotal: 100, rMultiple: -0.5 }),
  t({ sellDate: "2026-06-02", netPnl: 2000, grossPnl: 2100, chargesTotal: 100, rMultiple: 2.0 }),
  t({ sellDate: "2026-06-03", netPnl: -1500, grossPnl: -1400, chargesTotal: 100, rMultiple: -1.5 }),
  t({ isOpen: true, sellDate: null, netPnl: -50, grossPnl: 0, chargesTotal: 50 }),
];

describe("computeKpis", () => {
  const k = computeKpis(sample);
  it("counts closed vs open", () => {
    expect(k.closedCount).toBe(4);
    expect(k.openCount).toBe(1);
  });
  it("realised totals (closed only)", () => {
    expect(k.netPnl).toBe(1000);
    expect(k.grossPnl).toBe(1400);
    expect(k.charges).toBe(400);
    expect(k.chargePctOfGross).toBeCloseTo(28.57, 1);
  });
  it("win rate, profit factor, expectancy, avg R", () => {
    expect(k.winRate).toBe(0.5);
    expect(k.profitFactor).toBe(1.5); // 3000 / 2000
    expect(k.expectancy).toBe(250); // 1000 / 4
    expect(k.avgR).toBe(0.25);
    expect(k.avgWin).toBe(1500);
    expect(k.avgLoss).toBe(-1000);
  });
  it("max drawdown & streaks", () => {
    expect(k.maxDrawdown).toBe(1500);
    expect(k.maxWinStreak).toBe(1);
    expect(k.maxLossStreak).toBe(1);
    expect(k.currentStreak).toBe(-1);
  });
});

describe("tie-out invariants", () => {
  it("daily P&L sums to realised net", () => {
    const total = [...dailyPnl(sample).values()].reduce((a, b) => a + b, 0);
    expect(Math.round(total)).toBe(1000);
  });
  it("equity curve final cumulative equals realised net", () => {
    const curve = equityCurve(sample);
    expect(curve[curve.length - 1].cum).toBe(1000);
    expect(curve.some((p) => p.drawdown < 0)).toBe(true);
  });
});

describe("groupBy", () => {
  it("groups by segment with correct nets", () => {
    const mixed = [
      t({ segment: "index_option", netPnl: 500 }),
      t({ segment: "index_option", netPnl: -200 }),
      t({ segment: "eq_delivery", bucket: "equity", netPnl: 1000 }),
    ];
    const g = bySegment(mixed);
    expect(g.find((x) => x.key === "index_option")?.net).toBe(300);
    expect(g.find((x) => x.key === "eq_delivery")?.net).toBe(1000);
    expect(g[0].key).toBe("eq_delivery"); // sorted by net desc
  });
});
