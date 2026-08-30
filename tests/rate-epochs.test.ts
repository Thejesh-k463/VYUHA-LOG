import { describe, expect, it } from "vitest";
import {
  addEpoch,
  epochSpans,
  epochsFor,
  findRates,
  pricingDate,
  ratesMapOf,
  seedRatesMap,
  type RatesMap,
} from "@/lib/engine/rates";
import type { ChargeRates } from "@/lib/engine/types";

/**
 * EFFECTIVE-DATED CHARGE RATES (migration 0050).
 *
 * Before this, `charge_config` held exactly one row per
 * (broker, plan, segment, exchange) with no time dimension, so a trade from any
 * year was priced at whatever that row held TODAY. A book spanning a statutory
 * change was priced wholly at the newer regime. `/reports/broker-compare`
 * re-prices and is directly affected; `/reports/charges` reads stored values.
 *
 * The two properties that matter are pinned here: the RIGHT epoch is chosen for
 * a date, and NO epoch is substituted when none covers it.
 */

const base = (over: Partial<ChargeRates> = {}): ChargeRates =>
  ({
    broker: "zerodha",
    plan: "default",
    planLabel: null,
    subscriptionMonthly: 0,
    segment: "future",
    exchange: "NSE",
    brokerageFlat: 20,
    brokeragePct: 0,
    brokerageCap: 0,
    brokerageFloor: 0,
    sttPct: 0.0002,
    sttSide: "sell",
    exchangeTxnPct: 0.0000173,
    sebiPct: 0.000001,
    stampPct: 0.00002,
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

/** Two abutting epochs for one key: an old rate, then a higher one. */
function twoEpochs(): RatesMap {
  return ratesMapOf([
    base({ effectiveFrom: "1970-01-01", effectiveTo: "2026-04-01", sttPct: 0.0002 }),
    base({ effectiveFrom: "2026-04-01", effectiveTo: null, sttPct: 0.0005 }),
  ]);
}

describe("findRates — epoch selection", () => {
  it("prices a trade at the rate in force on ITS OWN date, not today's", () => {
    const m = twoEpochs();
    expect(findRates(m, "zerodha", "future", "NSE", "2026-03-31").sttPct).toBe(0.0002);
    expect(findRates(m, "zerodha", "future", "NSE", "2026-08-30").sttPct).toBe(0.0005);
  });

  it("treats effectiveFrom as INCLUSIVE and effectiveTo as EXCLUSIVE", () => {
    const m = twoEpochs();
    // The boundary date belongs to exactly one epoch — the new one.
    expect(findRates(m, "zerodha", "future", "NSE", "2026-04-01").sttPct).toBe(0.0005);
    // And the day before belongs to the old one. No date falls in both.
    expect(findRates(m, "zerodha", "future", "NSE", "2026-03-31").sttPct).toBe(0.0002);
  });

  it("REFUSES rather than substituting the nearest epoch", () => {
    // A gap: nothing covers 2025.
    const m = ratesMapOf([
      base({ effectiveFrom: "2026-04-01", effectiveTo: null }),
    ]);
    expect(() => findRates(m, "zerodha", "future", "NSE", "2025-06-01")).toThrow(
      /No charge_config epoch covers 2025-06-01/,
    );
    // The error names the windows on file, so the answer is actionable.
    expect(() => findRates(m, "zerodha", "future", "NSE", "2025-06-01")).toThrow(/2026-04-01→open/);
  });

  it("still refuses when the key itself is unknown", () => {
    expect(() => findRates(twoEpochs(), "groww", "future", "NSE", "2026-08-30")).toThrow(
      /No charge_config for groww/,
    );
  });

  it("keeps epochs newest-first regardless of insertion order", () => {
    const m: RatesMap = new Map();
    addEpoch(m, base({ effectiveFrom: "1970-01-01" }));
    addEpoch(m, base({ effectiveFrom: "2027-01-01" }));
    addEpoch(m, base({ effectiveFrom: "2026-04-01" }));
    expect(epochsFor(m, "zerodha", "future", "NSE").map((e) => e.effectiveFrom)).toEqual([
      "2027-01-01",
      "2026-04-01",
      "1970-01-01",
    ]);
  });
});

describe("migration 0050 safety — nothing re-prices on upgrade", () => {
  it("the seed still answers every date, because its rows are open-ended", () => {
    // Existing installs get effective_from '1970-01-01' with an open end, so
    // every key covers all of history and no stored figure changes on upgrade.
    const m = seedRatesMap();
    for (const onDate of ["1999-01-01", "2020-07-15", "2026-08-30", "2099-12-31"]) {
      expect(() => findRates(m, "zerodha", "eq_delivery", "NSE", onDate)).not.toThrow();
    }
  });

  it("a single open-ended epoch gives the same answer on every date", () => {
    const m = seedRatesMap();
    const a = findRates(m, "zerodha", "eq_delivery", "NSE", "2001-01-01");
    const b = findRates(m, "zerodha", "eq_delivery", "NSE", "2026-08-30");
    expect(a.sttPct).toBe(b.sttPct);
    expect(a.brokerageFlat).toBe(b.brokerageFlat);
  });
});

describe("pricingDate — one rule, not eleven call-site opinions", () => {
  it("prefers the sell date, because STT and DP both fall there", () => {
    expect(pricingDate({ buyDate: "2026-01-10", sellDate: "2026-05-20" }, "2026-08-30")).toBe("2026-05-20");
  });

  it("falls back to the buy date for an open position", () => {
    expect(pricingDate({ buyDate: "2026-01-10", sellDate: null }, "2026-08-30")).toBe("2026-01-10");
  });

  it("falls back to the caller's date when the row carries neither", () => {
    expect(pricingDate({ buyDate: null, sellDate: null }, "2026-08-30")).toBe("2026-08-30");
  });

  it("rejects the empty and partial dates broker files produce", () => {
    expect(pricingDate({ sellDate: "" }, "2026-08-30")).toBe("2026-08-30");
    expect(pricingDate({ sellDate: "2026-05" }, "2026-08-30")).toBe("2026-08-30");
  });

  it("trims a timestamp down to the date", () => {
    expect(pricingDate({ sellDate: "2026-05-20T09:15:00" }, "2026-08-30")).toBe("2026-05-20");
  });

  /**
   * REGRESSION. `buildRow` prices a trade BEFORE `normalizeDate` runs at insert
   * time, so a Groww row still reads `06-05-2026` at this point. Comparing that
   * against an ISO window matched no epoch and made findRates refuse a valid
   * trade — the whole Groww import test failed on it.
   */
  it("accepts the day-first dates broker files carry before normalisation", () => {
    expect(pricingDate({ sellDate: "06-05-2026" }, "2026-08-30")).toBe("2026-05-06");
    expect(pricingDate({ sellDate: "06/05/2026" }, "2026-08-30")).toBe("2026-05-06");
    // …and does not mistake an ISO date for a day-first one.
    expect(pricingDate({ sellDate: "2026-05-06" }, "2026-08-30")).toBe("2026-05-06");
  });

  it("resolves a day-first date to the correct epoch end to end", () => {
    const m = twoEpochs();
    // 31-03-2026 is day-first for 2026-03-31 → the OLD epoch.
    expect(findRates(m, "zerodha", "future", "NSE", pricingDate({ sellDate: "31-03-2026" }, "2026-08-30")).sttPct).toBe(0.0002);
    expect(findRates(m, "zerodha", "future", "NSE", pricingDate({ sellDate: "01-04-2026" }, "2026-08-30")).sttPct).toBe(0.0005);
  });
});

describe("epochSpans — interest that accrues across a rate change", () => {
  /**
   * The MTF accrual job writes `chargesTotal` and `netPnl` back to the trade,
   * so pricing a whole holding period at TODAY's rate silently restates
   * interest already accrued under the old one — a stored P&L changing with no
   * prompt. DECISIONS 2026-08-30 decision 6 forbids that; an adversarial review
   * found the job doing it anyway.
   */
  it("returns ONE span for a single open-ended epoch, so nothing changes for anybody today", () => {
    const m = ratesMapOf([base({ segment: "eq_mtf" })]);
    const spans = epochSpans(m, "zerodha", "eq_mtf", "NSE", "2026-01-01", "2026-03-02");
    expect(spans.length).toBe(1);
    // 31 (Jan) + 28 (Feb) + 1 = 60 days, identical to (to − from).
    expect(spans[0].days).toBe(60);
  });

  it("splits the period at the boundary and the days still sum to the whole", () => {
    const m = ratesMapOf([
      base({ segment: "eq_mtf", effectiveFrom: "1970-01-01", effectiveTo: "2026-04-01", mtfInterestAnnual: 0.12 }),
      base({ segment: "eq_mtf", effectiveFrom: "2026-04-01", effectiveTo: null, mtfInterestAnnual: 0.18 }),
    ]);
    const spans = epochSpans(m, "zerodha", "eq_mtf", "NSE", "2026-03-02", "2026-05-01");
    expect(spans.length).toBe(2);
    expect(spans[0].to).toBe("2026-04-01");
    expect(spans[1].from).toBe("2026-04-01");
    expect(spans[0].days).toBe(30); // 2 Mar → 1 Apr
    expect(spans[1].days).toBe(30); // 1 Apr → 1 May
    // The whole period is accounted for exactly once — no day double-counted,
    // none dropped. This is the property that keeps the total honest.
    expect(spans[0].days + spans[1].days).toBe(60);
    expect(spans[0].rates.mtfInterestAnnual).toBe(0.12);
    expect(spans[1].rates.mtfInterestAnnual).toBe(0.18);
  });

  it("stays inside the period when an epoch starts before or ends after it", () => {
    const m = ratesMapOf([
      base({ segment: "eq_mtf", effectiveFrom: "1970-01-01", effectiveTo: "2026-04-01" }),
      base({ segment: "eq_mtf", effectiveFrom: "2026-04-01", effectiveTo: null }),
    ]);
    const spans = epochSpans(m, "zerodha", "eq_mtf", "NSE", "2026-04-10", "2026-04-20");
    expect(spans.length).toBe(1);
    expect(spans[0].from).toBe("2026-04-10");
    expect(spans[0].to).toBe("2026-04-20");
    expect(spans[0].days).toBe(10);
  });

  it("REFUSES a period it cannot fully cover rather than stretching a neighbour", () => {
    const m = ratesMapOf([base({ segment: "eq_mtf", effectiveFrom: "2026-04-01", effectiveTo: null })]);
    expect(() => epochSpans(m, "zerodha", "eq_mtf", "NSE", "2026-01-01", "2026-05-01")).toThrow(
      /No charge_config epoch covers/,
    );
  });

  it("returns nothing for a zero-length or inverted period", () => {
    const m = ratesMapOf([base({ segment: "eq_mtf" })]);
    expect(epochSpans(m, "zerodha", "eq_mtf", "NSE", "2026-04-01", "2026-04-01")).toEqual([]);
    expect(epochSpans(m, "zerodha", "eq_mtf", "NSE", "2026-04-02", "2026-04-01")).toEqual([]);
  });
});
