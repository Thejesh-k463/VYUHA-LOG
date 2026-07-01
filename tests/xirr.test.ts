import { describe, it, expect } from "vitest";
import { xirr, type CashFlow } from "@/lib/analytics/xirr";
import { toPaise } from "@/lib/money";

const cf = (date: string, rupees: number): CashFlow => ({ date, amountPaise: toPaise(rupees) });

describe("xirr", () => {
  it("solves a simple one-year 10% return", () => {
    const r = xirr([cf("2026-01-01", -100000), cf("2027-01-01", 110000)]);
    expect(r).not.toBeNull();
    expect(r!).toBeCloseTo(0.1, 3);
  });

  it("annualizes a half-year gain to >100%-equivalent? no — solves a 6-month +5%", () => {
    // invest 100000, get 105000 after ~6 months → annualized ≈ (1.05)^2 − 1 ≈ 10.25%
    const r = xirr([cf("2026-01-01", -100000), cf("2026-07-02", 105000)]);
    expect(r!).toBeGreaterThan(0.09);
    expect(r!).toBeLessThan(0.12);
  });

  it("handles multiple contributions (money-weighted)", () => {
    const r = xirr([
      cf("2026-01-01", -100000),
      cf("2026-07-01", -50000),
      cf("2027-01-01", 165000),
    ]);
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThan(0);
  });

  it("returns a negative rate for a loss", () => {
    const r = xirr([cf("2026-01-01", -100000), cf("2027-01-01", 80000)]);
    expect(r!).toBeCloseTo(-0.2, 2);
  });

  it("returns null without both an inflow and an outflow", () => {
    expect(xirr([cf("2026-01-01", -100000), cf("2027-01-01", -50000)])).toBeNull();
    expect(xirr([cf("2026-01-01", 100000)])).toBeNull();
    expect(xirr([])).toBeNull();
  });
});
