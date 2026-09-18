import { describe, it, expect } from "vitest";
import { computeCharges, mtfRateFor } from "@/lib/engine/charges";
import { seedRatesMap, findRates } from "@/lib/engine/rates";

const rates = seedRatesMap();

describe("computeCharges — exact statutory values", () => {
  it("Zerodha equity delivery (NSE): zero brokerage, STT both sides, DP on sell", () => {
    const r = findRates(rates, "zerodha", "eq_delivery", "NSE", "2026-06-15");
    const c = computeCharges(
      { segment: "eq_delivery", buyValue: 100000, sellValue: 110000, buyQty: 100, sellQty: 100 },
      r,
    );
    expect(c.brokerage).toBe(0);
    expect(c.sttCtt).toBe(210); // round(0.1% × 210000)
    expect(c.exchangeTxn).toBe(6.45); // 0.0030699% × 210000 (NSE FA73061, from 1 Mar 2026)
    expect(c.sebi).toBe(0.21);
    expect(c.stampDuty).toBe(15); // round(0.015% × 100000)
    expect(c.dpCharges).toBe(15.34); // Zerodha incl GST
    expect(c.gst).toBe(1.2); // 18% × (exchange + sebi); DP already incl GST
    expect(c.total).toBe(248.2);
  });

  it("Zerodha index option (NSE): ₹20/order flat, STT on sell premium", () => {
    const r = findRates(rates, "zerodha", "index_option", "NSE", "2026-06-15");
    const c = computeCharges(
      { segment: "index_option", buyValue: 10000, sellValue: 12000, buyQty: 50, sellQty: 50 },
      r,
    );
    expect(c.brokerage).toBe(40); // 20 buy + 20 sell
    expect(c.sttCtt).toBe(18); // round(0.15% × 12000)
    expect(c.exchangeTxn).toBe(7.82); // 0.0355299% × 22000 (NSE FA73061, from 1 Mar 2026)
    expect(c.sebi).toBe(0.02);
    expect(c.stampDuty).toBe(0); // round(0.003% × 10000 = 0.3)
    expect(c.gst).toBe(8.61);
    expect(c.dpCharges).toBe(0);
    expect(c.total).toBe(74.45);
  });

  it("Zerodha equity intraday (NSE): brokerage capped at ₹20/order, STT on sell", () => {
    const r = findRates(rates, "zerodha", "eq_intraday", "NSE", "2026-06-15");
    const c = computeCharges(
      { segment: "eq_intraday", buyValue: 200000, sellValue: 200000, buyQty: 100, sellQty: 100 },
      r,
    );
    expect(c.brokerage).toBe(40); // min(20, 0.03%×200000=60) × 2
    expect(c.sttCtt).toBe(50); // round(0.025% × 200000)
    expect(c.exchangeTxn).toBe(12.28); // 0.0030699% × 400000 (NSE FA73061, from 1 Mar 2026)
    expect(c.stampDuty).toBe(6); // round(0.003% × 200000)
    expect(c.dpCharges).toBe(0); // no DP on intraday
    expect(c.gst).toBe(9.48);
    expect(c.total).toBe(118.16);
  });

  it("Dhan commodity option (MCX): CTT 0.05% sell, no IPFT", () => {
    const r = findRates(rates, "dhan", "commodity_option", "MCX", "2026-06-15");
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
    const r = findRates(rates, "zerodha", "eq_delivery", "NSE", "2026-06-15");
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
    const r = findRates(rates, "dhan", "eq_mtf", "NSE", "2026-06-15");
    expect(mtfRateFor(400000, r)).toBe(0.1249);
    expect(mtfRateFor(800000, r)).toBe(0.1349);
    expect(mtfRateFor(2000000, r)).toBe(0.1449);
    expect(mtfRateFor(3000000, r)).toBe(0.1549);
  });

  it("accrues daily interest from funded amount", () => {
    const r = findRates(rates, "dhan", "eq_mtf", "NSE", "2026-06-15");
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
    const r = findRates(rates, "groww", "eq_mtf", "NSE", "2026-06-15");
    expect(mtfRateFor(999999999, r)).toBe(0.1495);
  });

  /**
   * D3 (v4.3.0 fix wave 2P, mtf-staged#2) — a TIERED broker's slab is evaluated on
   * `slabBasis` (the row's whole stated principal) when the caller states one, and
   * on the funded amount otherwise. The staged ladder hands each tranche its SHARE
   * as `fundedAmount` and the row's principal as `slabBasis`; every flat caller
   * hands one principal and no basis, so its figure is unchanged.
   */
  it("D3 · slabBasis picks the slab; absent, the funded amount does (every flat caller unchanged)", () => {
    const r = findRates(rates, "dhan", "eq_mtf", "NSE", "2026-06-15");
    const bill = (mtf: NonNullable<Parameters<typeof computeCharges>[0]["mtf"]>) =>
      computeCharges({ segment: "eq_mtf", buyValue: 0, sellValue: 0, buyQty: 0, sellQty: 0, mtf }, r).mtfInterest;
    // A 4,00,000 share of an 8,00,000 row, 19 days: the ≤10L slab (13.49%), not the ≤5L one.
    // THE assertion (on revert: 2600.66 — 12.49% on the share's own size).
    expect(bill({ fundedAmount: 400000, daysHeld: 19, slabBasis: 800000 })).toBe(2808.88);
    expect(bill({ fundedAmount: 400000, daysHeld: 19 })).toBe(2600.66);
    // Interest is still on the SHARE, only the rate is looked up on the basis.
    expect(bill({ fundedAmount: 400000, daysHeld: 19, slabBasis: 800000 })).toBe(Math.round((400000 * 0.1349 * 19) / 365 * 100) / 100);
    // A straddling flat amount is unchanged when no basis is stated.
    expect(bill({ fundedAmount: 800000, daysHeld: 19 })).toBe(5617.75);
    // Paytm's middle band is the dearest: a 75,000 share of a 1,50,000 row is 9.99%, not 7.99%.
    const p = findRates(rates, "paytm", "eq_mtf", "NSE", "2026-06-15");
    const paytm = (mtf: NonNullable<Parameters<typeof computeCharges>[0]["mtf"]>) =>
      computeCharges({ segment: "eq_mtf", buyValue: 0, sellValue: 0, buyQty: 0, sellQty: 0, mtf }, p).mtfInterest;
    expect(paytm({ fundedAmount: 75000, daysHeld: 19, slabBasis: 150000 })).toBe(Math.round((75000 * 0.0999 * 19) / 365 * 100) / 100);
    expect(paytm({ fundedAmount: 75000, daysHeld: 19 })).toBe(Math.round((75000 * 0.0799 * 19) / 365 * 100) / 100);
  });

  /**
   * D1 (v4.3.0 fix wave 2P, mtf-staged#0 — owner ruling 2O row 1: "no stored money on
   * a closed trade moves without the owner's say-so") — a CARRY sets the interest and
   * the pledge to the figures a closed null-funded ladder stored before 4.3.0, and
   * GST covers the carried pledge through the one base that knows what GST covers
   * (invariant 3: the ladder restates no statutory rule). Nothing is estimated:
   * `mtfRateFor` is not consulted for a carry.
   */
  it("D1 · a carry sets interest and pledge; GST covers the carried pledge; no carry + 0 bills nothing", () => {
    const r = findRates(rates, "zerodha", "eq_mtf", "NSE", "2026-06-15");
    const base = { segment: "eq_mtf" as const, buyValue: 10000, sellValue: 0, buyQty: 100, sellQty: 0 };
    const none = computeCharges({ ...base, mtf: { fundedAmount: 0, daysHeld: 14, pledgeScrips: 1 } }, r);
    const carried = computeCharges({ ...base, mtf: { fundedAmount: 0, daysHeld: 14, pledgeScrips: 1, carry: { mtfInterest: 44.8, pledgeCharges: 30 } } }, r);
    // The existing rule: 0 funded, no carry → neither interest nor pledge.
    expect([none.mtfInterest, none.pledgeCharges]).toEqual([0, 0]);
    // THE assertion (on revert: [0, 0] — the carry is ignored and the estimate released).
    expect([carried.mtfInterest, carried.pledgeCharges]).toEqual([44.8, 30]);
    // GST on the carried pledge, at the card's rate, on top of the same base.
    expect(carried.gst).toBe(Math.round((none.gst + r.gstPct * 30) * 100) / 100);
    expect(carried.total).toBe(Math.round((none.total + 44.8 + 30 + r.gstPct * 30) * 100) / 100);
    // A carry beside a positive funded amount still carries (the ladder never
    // builds that shape — a stated principal is billed by the D3 rule — but the
    // engine's rule is the carry, not an estimate).
    const both = computeCharges({ ...base, mtf: { fundedAmount: 5000, daysHeld: 14, pledgeScrips: 1, carry: { mtfInterest: 1, pledgeCharges: 2 } } }, r);
    expect([both.mtfInterest, both.pledgeCharges]).toEqual([1, 2]);
  });
});

describe("Groww floor brokerage", () => {
  it("equity brokerage floored at ₹5 per order", () => {
    const r = findRates(rates, "groww", "eq_delivery", "NSE", "2026-06-15");
    const c = computeCharges(
      { segment: "eq_delivery", buyValue: 2000, sellValue: 2000, buyQty: 10, sellQty: 10 },
      r,
    );
    // 0.1% × 2000 = 2 → floored to 5, both sides → 10
    expect(c.brokerage).toBe(10);
  });
});
