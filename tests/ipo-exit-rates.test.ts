import { describe, expect, it, beforeAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { findRates, ratesMapOf, seedRatesMap, statutoryRatesFor, type RatesMap } from "@/lib/engine/rates";
import { ipoSellCharges } from "@/lib/analytics/ipo";
import type { ChargeRates } from "@/lib/engine/types";

// IMPORTANT: point the DB at a throwaway file BEFORE any module imports
// @/lib/db — lib/queries/ipos pulls it in statically. chargerFor itself never
// touches the DB (the rates map is injected), so no migration is needed.
process.env.VYUHA_DB_PATH ??= path.join(os.tmpdir(), `vyuha-ipo-rates-${process.pid}-${Date.now()}.sqlite`);

/**
 * B7 — IPO exit charges must be priced at the EXIT DATE's charge_config epoch,
 * not today's. An exit sold before a rate change (the 1-Apr-2026 STT bump is
 * the live example) was being re-priced at today's rates, silently restating
 * its realised net — which flows into capital compounding.
 */

let chargerFor: typeof import("@/lib/queries/ipos").chargerFor;
let chargeBreakdownFor: typeof import("@/lib/queries/ipos").chargeBreakdownFor;

beforeAll(async () => {
  ({ chargerFor, chargeBreakdownFor } = await import("@/lib/queries/ipos"));
});

const CRORE = 10_000_000;

const base = (over: Partial<ChargeRates> = {}): ChargeRates =>
  ({
    broker: "zerodha",
    plan: "default",
    planLabel: null,
    subscriptionMonthly: 0,
    segment: "eq_delivery",
    exchange: "NSE",
    brokerageFlat: 0,
    brokeragePct: 0,
    brokerageCap: 0,
    brokerageFloor: 0,
    sttPct: 0.001,
    sttSide: "sell",
    exchangeTxnPct: 0,
    sebiPct: 0,
    stampPct: 0,
    ipftPct: 0,
    gstPct: 0.18,
    dpCharge: 0,
    dpPct: 0,
    dpGstApplicable: false,
    dpMinValue: 0,
    mtfInterestAnnual: 0,
    mtfRateUnknown: false,
    mtfTiers: null,
    pledgeCharge: 0,
    unpledgeCharge: 0,
    ...over,
  }) as ChargeRates;

/** STT doubles at 2026-04-01 — the only difference between the two epochs. */
function twoEpochs(): RatesMap {
  return ratesMapOf([
    base({ effectiveFrom: "1970-01-01", effectiveTo: "2026-04-01", sttPct: 0.001 }),
    base({ effectiveFrom: "2026-04-01", effectiveTo: null, sttPct: 0.002 }),
  ]);
}

describe("IPO exit charges — effective-dated rates (B7)", () => {
  it("prices the exit at the epoch in force on the EXIT DATE, not today's", () => {
    const m = twoEpochs();
    const before = chargerFor("zerodha", "NSE", "2026-03-15", m)(100000, 90000);
    const after = chargerFor("zerodha", "NSE", "2026-04-15", m)(100000, 90000);
    // Same sale, same size — only the epoch differs. Old STT 0.1% = ₹100,
    // new 0.2% = ₹200 on a ₹1,00,000 sell (STT rounds to the rupee).
    expect(after! - before!).toBeCloseTo(100, 2);
    expect(before).toBeCloseTo(100, 2);
  });

  it("prices a not-yet-exited IPO prospectively at today (no exit date)", () => {
    const m = twoEpochs();
    // Today is inside the open-ended 2026-04-01 epoch.
    expect(chargerFor("zerodha", "NSE", null, m)(100000, 90000)).toBeCloseTo(200, 2);
  });

  it("a date before every epoch prices at the earliest one; only a missing row throws, and only when priced — never a frozen estimate", () => {
    // Only an epoch from 2026-04-01 — nothing covers a 2025 exit, for this
    // broker or any other. Re-pinned (R36): before, this returned the frozen
    // ipoSellCharges(100000, 90000) = 131.96 (measured at 654d534); a substituted rate is a wrong
    // number in a right number's typeface, so it threw as findRates does.
    // Re-pinned (N13, measured: threw at charger BUILD → 100): a date before the
    // earliest epoch prices at the earliest schedule, and rates resolve on the first
    // call, not at build. A map with no row at all still throws, when priced.
    const m = ratesMapOf([base({ effectiveFrom: "2026-04-01", effectiveTo: null })]);
    expect(chargerFor("zerodha", "NSE", "2025-06-01", m)(100000, 90000)).toBe(100);
    const none = chargerFor(null, "NSE", "2026-06-15", new Map());
    expect(() => none(100000, 90000)).toThrow(/No charge_config/);
  });

  it("the no-broker fallback prices through the statutory row of charge_config", () => {
    const m = twoEpochs();
    expect(chargerFor(null, "NSE", "2026-03-15", m)(100000, 90000)).toBe(
      ipoSellCharges(100000, 90000, statutoryRatesFor(m, "eq_delivery", "NSE", "2026-03-15")),
    );
    // Only STT 0.1% of the SALE in this fixture (every other column is 0).
    expect(chargerFor(null, "NSE", "2026-03-15", m)(100000, 90000)).toBe(100);
  });
});

describe("IPO no-broker fallback — statutory columns from charge_config (R36)", () => {
  const seed = seedRatesMap();

  it("pins the WHOLE fallback total: ₹1 cr exit on a ₹1 cr allotment, NSE 2026-06-15", () => {
    // STT 0.1% of the SALE 10000 · exchange 306.99 + IPFT 0.01 + SEBI 10 on the
    // sale · GST 18% over those 57.06 · stamp 0.015% on the allotment 1500 ·
    // no brokerage, no DP. Frozen constants gave 11877.60. The second argument is
    // the allotment's STAMP BASE: computeIpo passes it only for an allotment before
    // 1 Jul 2020 and 0 from then, when the issuer bears the stamp (N14,
    // tests/ipo-charger-dates.test.ts).
    expect(chargerFor(null, "NSE", "2026-06-15", seed)(CRORE, CRORE)).toBe(11874.06);
  });

  it("pins the WHOLE fallback total on BSE (the frozen path ignored the exchange)", () => {
    // BSE cash 0.00375% = 375, no IPFT · SEBI 10 · GST 69.30 · STT 10000 · stamp 1500.
    expect(chargerFor(null, "BSE", "2026-06-15", seed)(CRORE, CRORE)).toBe(11954.3);
  });

  it("exchange txn + IPFT come from the (exchange, exit-date) row", () => {
    const leg = (exchange: string, on: string) => {
      const b = chargeBreakdownFor(null, exchange, on, seed)(CRORE, CRORE)!;
      return Math.round((b.exchangeTxn + b.ipft) * 100) / 100;
    };
    expect(leg("NSE", "2026-06-15")).toBe(307);
    expect(leg("NSE", "2024-01-15")).toBe(335);
    expect(leg("BSE", "2026-06-15")).toBe(375);
  });

  it("charges no DP and no brokerage (no broker is recorded)", () => {
    const b = chargeBreakdownFor(null, "NSE", "2026-06-15", seed)(CRORE, CRORE)!;
    expect(b.dpCharges).toBe(0);
    expect(b.brokerage).toBe(0);
    expect(b.sttCtt).toBe(10000); // the sale only — an allotment is not an exchange purchase
    expect(b.stampDuty).toBe(1500); // on the stamp base passed (a pre-1-Jul-2020 allotment's value, N14)
  });
});

describe("statutoryRatesFor — broker-independent, deterministic, non-mutating", () => {
  it("picks the default-plan row of the first broker in BROKERS order, whatever the map order", () => {
    const m = ratesMapOf([
      base({ broker: "zerodha", exchangeTxnPct: 0.00002 }),
      base({ broker: "dhan", plan: "pro", exchangeTxnPct: 0.00004 }),
      base({ broker: "dhan", exchangeTxnPct: 0.00003 }),
    ]);
    const s = statutoryRatesFor(m, "eq_delivery", "NSE", "2026-06-15");
    expect(s.broker).toBe("dhan");
    expect(s.plan).toBe("default");
    expect(s.exchangeTxnPct).toBe(0.00003);
  });

  it("neutralises the broker columns and never mutates the map", () => {
    const seed = seedRatesMap();
    const s = statutoryRatesFor(seed, "eq_delivery", "NSE", "2026-06-15");
    expect([s.brokerageFlat, s.brokeragePct, s.brokerageCap, s.brokerageFloor]).toEqual([null, 0, null, 0]);
    expect([s.dpCharge, s.dpPct, s.dpGstApplicable, s.dpMinValue]).toEqual([0, 0, false, 0]);
    expect(s.exchangeTxnPct).toBe(0.000030699);
    const row = findRates(seed, s.broker, "eq_delivery", "NSE", "2026-06-15");
    expect(row.dpCharge).toBeGreaterThan(0);
    expect(row.sttSide).toBe("both");
  });

  it("throws when no row covers the date", () => {
    const m = ratesMapOf([base({ effectiveFrom: "2026-04-01", effectiveTo: null })]);
    expect(() => statutoryRatesFor(m, "eq_delivery", "NSE", "2025-06-01")).toThrow(/No charge_config/);
  });
});

describe("IPO broker path — no purchase STT on the allotment (QS-IPO, FATAX56235 row 1)", () => {
  it("a real seed row (sttSide 'both'): ₹1 cr allotment + ₹1 cr sale owes STT on the sale only", () => {
    const seed = seedRatesMap();
    expect(findRates(seed, "zerodha", "eq_delivery", "NSE", "2026-06-15").sttSide).toBe("both");
    const b = chargeBreakdownFor("zerodha", "NSE", "2026-06-15", seed)(CRORE, CRORE)!;
    expect(b.sttCtt).toBe(10000);
    // Computed on a COPY: the map's row still says 'both'.
    expect(findRates(seed, "zerodha", "eq_delivery", "NSE", "2026-06-15").sttSide).toBe("both");
    expect(chargerFor("zerodha", "NSE", "2026-06-15", seed)(CRORE, CRORE)).toBe(b.total);
  });
});

describe("IPO broker path — exchange-turnover levies on the SALE only (W2-IPO2)", () => {
  // An allotment is not a transaction on a recognised exchange (the QS-IPO
  // reason), so exchange txn, the SEBI turnover fee, IPFT and the GST on them
  // price on the sell value alone. Brokerage + DP stay the broker's charges on
  // the sale; stamp duty stays on the allotment. Before this fix the broker
  // path passed buyValue: allottedValue and so levied them on BOTH values —
  // measured at the unfixed tree: zerodha NSE exchangeTxn 613.98, sebi 20,
  // ipft 0.02, gst 114.12, total 12263.46; zerodha BSE total 12423.94; groww
  // NSE total 12295.32.
  const seed = seedRatesMap();

  it("zerodha NSE 2026-06-15, ₹1 cr allotted / ₹1 cr sold: every head and the WHOLE total", () => {
    const b = chargeBreakdownFor("zerodha", "NSE", "2026-06-15", seed)(CRORE, CRORE);
    // exchange 0.0030699% × 1 cr = 306.99 · IPFT 1e-9 × 1 cr = 0.01 · SEBI
    // 0.0001% = 10 · GST 18% × (306.99 + 10 + 0.01) = 57.06 · STT 0.1% of the
    // sale 10000 · stamp 0.015% of the allotment 1500 · zerodha DP 15.34
    // (no GST on its row) · zerodha delivery brokerage 0.
    expect(b).toEqual({
      brokerage: 0, sttCtt: 10000, exchangeTxn: 306.99, sebi: 10, stampDuty: 1500, ipft: 0.01,
      gst: 57.06, dpCharges: 15.34, mtfInterest: 0, pledgeCharges: 0, total: 11889.4,
    });
    expect(chargerFor("zerodha", "NSE", "2026-06-15", seed)(CRORE, CRORE)).toBe(11889.4);
  });

  it("zerodha BSE 2026-06-15: exchange 0.00375% on the sale only, no IPFT", () => {
    const b = chargeBreakdownFor("zerodha", "BSE", "2026-06-15", seed)(CRORE, CRORE);
    // exchange 375 · SEBI 10 · GST 18% × 385 = 69.30 · STT 10000 · stamp 1500 · DP 15.34.
    expect(b).toEqual({
      brokerage: 0, sttCtt: 10000, exchangeTxn: 375, sebi: 10, stampDuty: 1500, ipft: 0,
      gst: 69.3, dpCharges: 15.34, mtfInterest: 0, pledgeCharges: 0, total: 11969.64,
    });
    expect(chargerFor("zerodha", "BSE", "2026-06-15", seed)(CRORE, CRORE)).toBe(11969.64);
  });

  it("a brokerage-charging broker (groww NSE) keeps its sell brokerage, DP and their GST", () => {
    const b = chargeBreakdownFor("groww", "NSE", "2026-06-15", seed)(CRORE, CRORE);
    // brokerage 20 (the cap, one sell order) · DP 20 with GST · exchange 306.99 ·
    // SEBI 10 · IPFT 0.01 · GST 18% × (20 + 306.99 + 10 + 0.01 + 20) = 64.26 ·
    // STT 10000 · stamp 1500.
    expect(b).toEqual({
      brokerage: 20, sttCtt: 10000, exchangeTxn: 306.99, sebi: 10, stampDuty: 1500, ipft: 0.01,
      gst: 64.26, dpCharges: 20, mtfInterest: 0, pledgeCharges: 0, total: 11921.26,
    });
  });
});
