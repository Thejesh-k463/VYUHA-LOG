import { describe, it, expect } from "vitest";
import { computeCharges, mtfRateFor } from "@/lib/engine/charges";
import { seedRatesMap, findRates } from "@/lib/engine/rates";

const rates = seedRatesMap();

describe("computeCharges — exact statutory values", () => {
  it("Zerodha equity delivery (NSE): zero brokerage, STT both sides, DP on sell", () => {
    const r = findRates(rates, "zerodha", "eq_delivery", "NSE");
    const c = computeCharges(
      { segment: "eq_delivery", buyValue: 100000, sellValue: 110000, buyQty: 100, sellQty: 100 },
      r,
    );
    expect(c.brokerage).toBe(0);
    expect(c.sttCtt).toBe(210); // round(0.1% × 210000)
    expect(c.exchangeTxn).toBe(6.24); // 0.00297% × 210000
    expect(c.sebi).toBe(0.21);
    expect(c.stampDuty).toBe(15); // round(0.015% × 100000)
    expect(c.dpCharges).toBe(15.34); // Zerodha incl GST
    expect(c.gst).toBe(1.16); // 18% × (exchange + sebi); DP already incl GST
    expect(c.total).toBe(247.95);
  });

  it("Zerodha index option (NSE): ₹20/order flat, STT on sell premium", () => {
    const r = findRates(rates, "zerodha", "index_option", "NSE");
    const c = computeCharges(
      { segment: "index_option", buyValue: 10000, sellValue: 12000, buyQty: 50, sellQty: 50 },
      r,
    );
    expect(c.brokerage).toBe(40); // 20 buy + 20 sell
    expect(c.sttCtt).toBe(18); // round(0.15% × 12000)
    expect(c.exchangeTxn).toBe(7.71); // 0.03503% × 22000
    expect(c.sebi).toBe(0.02);
    expect(c.stampDuty).toBe(0); // round(0.003% × 10000 = 0.3)
    expect(c.gst).toBe(8.59);
    expect(c.dpCharges).toBe(0);
    expect(c.total).toBe(74.32);
  });

  it("Zerodha equity intraday (NSE): brokerage capped at ₹20/order, STT on sell", () => {
    const r = findRates(rates, "zerodha", "eq_intraday", "NSE");
    const c = computeCharges(
      { segment: "eq_intraday", buyValue: 200000, sellValue: 200000, buyQty: 100, sellQty: 100 },
      r,
    );
    expect(c.brokerage).toBe(40); // min(20, 0.03%×200000=60) × 2
    expect(c.sttCtt).toBe(50); // round(0.025% × 200000)
    expect(c.exchangeTxn).toBe(11.88);
    expect(c.stampDuty).toBe(6); // round(0.003% × 200000)
    expect(c.dpCharges).toBe(0); // no DP on intraday
    expect(c.gst).toBe(9.41);
    expect(c.total).toBe(117.69);
  });

  it("Dhan commodity option (MCX): CTT 0.05% sell, no IPFT", () => {
    const r = findRates(rates, "dhan", "commodity_option", "MCX");
    const c = computeCharges(
      { segment: "commodity_option", buyValue: 27500, sellValue: 27550, buyQty: 500, sellQty: 500 },
      r,
    );
    expect(c.brokerage).toBe(40);
    expect(c.sttCtt).toBe(14); // round(0.05% × 27550)
    expect(c.exchangeTxn).toBe(23.01); // 0.0418% × 55050
    expect(c.ipft).toBe(0); // MCX has no IPFT
    expect(c.stampDuty).toBe(1); // round(0.003% × 27500 = 0.825)
    expect(c.total).toBe(89.42);
  });

  it("open position (sell qty 0): only buy-side brokerage & STT base", () => {
    const r = findRates(rates, "zerodha", "eq_delivery", "NSE");
    const c = computeCharges(
      { segment: "eq_delivery", buyValue: 50000, sellValue: 0, buyQty: 50, sellQty: 0 },
      r,
    );
    expect(c.sttCtt).toBe(50); // 0.1% × 50000 (buy side only present)
    expect(c.dpCharges).toBe(0); // no sell, no DP
  });
});

describe("MTF interest", () => {
  it("picks the right tier (Dhan slabs)", () => {
    const r = findRates(rates, "dhan", "eq_mtf", "NSE");
    expect(mtfRateFor(400000, r)).toBe(0.1249);
    expect(mtfRateFor(800000, r)).toBe(0.1349);
    expect(mtfRateFor(2000000, r)).toBe(0.1449);
    expect(mtfRateFor(3000000, r)).toBe(0.1549);
  });

  it("accrues daily interest from funded amount", () => {
    const r = findRates(rates, "dhan", "eq_mtf", "NSE");
    const c = computeCharges(
      {
        segment: "eq_mtf",
        buyValue: 800000,
        sellValue: 810000,
        buyQty: 1000,
        sellQty: 1000,
        mtf: { fundedAmount: 800000, daysHeld: 10, pledgeScrips: 1 },
      },
      r,
    );
    // 800000 × 0.1349 × 10 / 365
    expect(c.mtfInterest).toBeCloseTo(2956.71, 2);
    expect(c.pledgeCharges).toBe(40); // 20 pledge + 20 unpledge
  });

  it("flat-rate broker (Groww) uses annual rate", () => {
    const r = findRates(rates, "groww", "eq_mtf", "NSE");
    expect(mtfRateFor(999999999, r)).toBe(0.1495);
  });
});

describe("Groww floor brokerage", () => {
  it("equity brokerage floored at ₹5 per order", () => {
    const r = findRates(rates, "groww", "eq_delivery", "NSE");
    const c = computeCharges(
      { segment: "eq_delivery", buyValue: 2000, sellValue: 2000, buyQty: 10, sellQty: 10 },
      r,
    );
    // 0.1% × 2000 = 2 → floored to 5, both sides → 10
    expect(c.brokerage).toBe(10);
  });
});
