import { describe, it, expect } from "vitest";
import { computeCharges, computeChargesPaise } from "@/lib/engine/charges";
import { seedRatesMap, findRates } from "@/lib/engine/rates";
import { toPaise } from "@/lib/money";

describe("computeChargesPaise — P0.1 paise-native engine", () => {
  const rates = findRates(seedRatesMap(), "zerodha", "eq_delivery", "NSE");

  it("returns whole paise that exactly match the rupee API", () => {
    const rupee = { segment: "eq_delivery" as const, buyValue: 200000, sellValue: 205000, buyQty: 50, sellQty: 50, buyOrderCount: 1, sellOrderCount: 1 };
    const r = computeCharges(rupee, rates);
    const p = computeChargesPaise(
      { segment: "eq_delivery", buyValue: toPaise(200000), sellValue: toPaise(205000), buyQty: 50, sellQty: 50, buyOrderCount: 1, sellOrderCount: 1 },
      rates,
    );
    for (const k of Object.keys(p) as (keyof typeof p)[]) {
      expect(Number.isInteger(p[k])).toBe(true); // whole paise, no fractions
      expect(p[k]).toBe(toPaise(r[k])); // identical to the rupee result
    }
  });

  it("MTF interest computes in paise", () => {
    const mtfRates = findRates(seedRatesMap(), "dhan", "eq_mtf", "NSE");
    const p = computeChargesPaise(
      { segment: "eq_mtf", buyValue: toPaise(500000), sellValue: 0, buyQty: 100, sellQty: 0, buyOrderCount: 1, sellOrderCount: 0, mtf: { fundedAmount: toPaise(500000), daysHeld: 30, pledgeScrips: 1 } },
      mtfRates,
    );
    expect(p.mtfInterest).toBeGreaterThan(0);
    expect(Number.isInteger(p.mtfInterest)).toBe(true);
  });
});
