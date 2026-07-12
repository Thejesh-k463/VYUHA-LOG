import { describe, it, expect } from "vitest";
import {
  positionSize,
  optionLotSize,
  dailyLossStatus,
  counter,
  mtfBreakeven,
  concentrationPct,
  plannedRewardRisk,
} from "@/lib/risk/calculators";

describe("positionSize", () => {
  it("max qty so risk ≤ cap (0.73% rule example)", () => {
    const r = positionSize({ entry: 100, stop: 95, riskAmount: 9500 });
    expect(r.riskPerUnit).toBe(5);
    expect(r.maxQty).toBe(1900);
    expect(r.totalRisk).toBe(9500);
    expect(r.capitalRequired).toBe(190000);
  });
  it("rounds down to whole lots for derivatives", () => {
    const r = positionSize({ entry: 100, stop: 97, riskAmount: 9500, lotSize: 75 });
    expect(r.riskPerUnit).toBe(3);
    expect(r.lots).toBe(42); // floor(3166/75)
    expect(r.maxQty).toBe(3150);
    expect(r.totalRisk).toBe(9450);
  });
  it("zero risk-per-unit yields zero qty", () => {
    expect(positionSize({ entry: 100, stop: 100, riskAmount: 9500 }).maxQty).toBe(0);
  });
});

describe("optionLotSize", () => {
  it("max lots for a long option", () => {
    const r = optionLotSize({ premium: 50, stopPremium: 30, lotSize: 75, riskAmount: 9500 });
    expect(r.riskPerLot).toBe(1500); // 20 × 75
    expect(r.maxLots).toBe(6);
    expect(r.totalRisk).toBe(9000);
    expect(r.premiumOutlay).toBe(22500);
  });
});

describe("dailyLossStatus", () => {
  it("flips to STOP when loss ≥ daily stop", () => {
    const s = dailyLossStatus({ netToday: -26000, dailyStop: 25000 });
    expect(s.hit).toBe(true);
    expect(s.remaining).toBe(0);
  });
  it("tracks remaining budget while under the stop", () => {
    const s = dailyLossStatus({ netToday: -10000, dailyStop: 25000 });
    expect(s.hit).toBe(false);
    expect(s.remaining).toBe(15000);
    expect(s.pctUsed).toBeCloseTo(0.4, 5);
  });
  it("a green day uses no budget", () => {
    const s = dailyLossStatus({ netToday: 5000, dailyStop: 25000 });
    expect(s.lossSoFar).toBe(0);
    expect(s.hit).toBe(false);
  });
});

describe("counter", () => {
  it("warns near the limit and flags exceed", () => {
    expect(counter(14, 15)).toMatchObject({ remaining: 1, warn: true, exceeded: false });
    expect(counter(16, 15).exceeded).toBe(true);
    expect(counter(5, 15).warn).toBe(false);
  });
});

describe("mtfBreakeven", () => {
  it("accrues interest and computes break-even move %", () => {
    const r = mtfBreakeven({ fundedAmount: 800000, annualRate: 0.1349, days: 10, positionValue: 1000000, otherCharges: 500 });
    expect(r.interest).toBeCloseTo(2956.71, 2);
    expect(r.totalCost).toBeCloseTo(3456.71, 2);
    expect(r.breakevenMovePct).toBeCloseTo(0.35, 2);
    expect(r.dailyInterest).toBeCloseTo(295.67, 2);
  });
});

describe("concentrationPct", () => {
  it("position vs bucket capital", () => {
    expect(concentrationPct(260000, 1300000)).toBe(20);
  });
});

describe("plannedRewardRisk", () => {
  it("computes risking-1-to-make-X for a long", () => {
    // entry 100, SL 95 (risk 5), target 115 (reward 15) -> 1:3
    expect(plannedRewardRisk(100, 95, 115)).toBe(3);
  });

  it("computes risking-1-to-make-X for a short (SL/target above/below entry)", () => {
    // entry 100, SL 105 (risk 5), target 85 (reward 15) -> 1:3
    expect(plannedRewardRisk(100, 105, 85)).toBe(3);
  });

  it("returns null when SL or target is missing", () => {
    expect(plannedRewardRisk(100, null, 115)).toBeNull();
    expect(plannedRewardRisk(100, 95, null)).toBeNull();
  });

  it("returns null when SL equals entry (zero risk, undefined ratio)", () => {
    expect(plannedRewardRisk(100, 100, 115)).toBeNull();
  });

  it("returns null for a non-positive entry", () => {
    expect(plannedRewardRisk(0, 95, 115)).toBeNull();
  });
});
