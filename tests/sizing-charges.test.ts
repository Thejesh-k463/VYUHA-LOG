import { describe, it, expect } from "vitest";
import { chargesAdjustedRisk, mtfInterestDrag, sizeFixedFractional } from "@/lib/risk/sizing";
import { mtfBreakeven } from "@/lib/risk/calculators";
import type { ChargeRates } from "@/lib/engine/types";
import type { Broker, Exchange, Segment } from "@/lib/domain/constants";
import defaults from "@/lib/data/charge-rates-defaults.json";

/**
 * The rates arrive as an ARGUMENT (invariant 3: the charges engine reads rates
 * only from charge_config, and lib/risk holds none of its own). This helper
 * stands in for the app's charge_config read: it picks the dated epoch that
 * applied on a date and hands the engine a ChargeRates.
 */
function ratesOn(segment: Segment, onDate: string): ChargeRates {
  const epoch = defaults.epochs.find(
    (e) =>
      e.segment === segment &&
      e.effectiveFrom <= onDate &&
      (e.effectiveTo == null || onDate < e.effectiveTo),
  );
  if (!epoch) throw new Error(`no dated rate epoch for ${segment} on ${onDate}`);
  return {
    effectiveFrom: epoch.effectiveFrom,
    effectiveTo: epoch.effectiveTo,
    broker: defaults.broker as Broker,
    plan: defaults.plan,
    planLabel: null,
    subscriptionMonthly: 0,
    segment,
    exchange: defaults.exchange as Exchange,
    ...epoch.rates,
    sttSide: epoch.rates.sttSide as ChargeRates["sttSide"],
    mtfInterestAnnual: 0,
    mtfRateUnknown: false,
    mtfTiers: null,
    pledgeCharge: 0,
    unpledgeCharge: 0,
  };
}

const CAPITAL_P = 100_000_000; // Rs 10,00,000
const ENTRY_P = 285_000; // Rs 2,850
const STOP_P = 260_000; // Rs 2,600

describe("chargesAdjustedRisk - 03 §2.1, the delivery round trip stopped out", () => {
  const qty = sizeFixedFractional({ capitalP: CAPITAL_P, riskPpm: 20_000, entryP: ENTRY_P, stopP: STOP_P }).qty;
  const r = chargesAdjustedRisk(
    { segment: "eq_delivery", qty, entryP: ENTRY_P, stopP: STOP_P, capitalP: CAPITAL_P },
    ratesOn("eq_delivery", "2026-09-05"),
  );

  it("prices the 80-share round trip component by component", () => {
    expect(qty).toBe(80);
    expect(r.breakdownP.brokerage).toBe(0); // delivery
    expect(r.breakdownP.sttCtt).toBe(43_600); // Rs 436.00, 0.1% of Rs 4,36,000
    expect(r.breakdownP.exchangeTxn).toBe(1_339); // Rs 13.39
    expect(r.breakdownP.sebi).toBe(44); // Rs 0.44
    expect(r.breakdownP.stampDuty).toBe(3_400); // Rs 34.00 - stamp duty rounds to the rupee
    expect(r.breakdownP.dpCharges).toBe(1_534); // Rs 15.34
    expect(r.breakdownP.gst).toBe(525); // 18% of txn + SEBI + DP
  });

  it("adds the round trip to the price risk", () => {
    // 03 §2.1 totals Rs 504.62 by leaving stamp duty unrounded; the shipped
    // engine rounds stamp (and STT) to the nearest rupee as the statute does,
    // which is 20 paise less. The engine is the app's single charges truth, so
    // this test pins the engine and records the 20-paise deviation from 03.
    expect(r.chargesP).toBe(50_442); // Rs 504.42
    expect(r.riskAtStopP).toBe(2_000_000); // Rs 20,000
    expect(r.effectiveRiskP).toBe(2_050_442); // Rs 20,504.42
    expect(r.effectiveRiskPctOfCapitalPpm).toBe(20_504); // 2.05% of capital
    expect(r.chargeUpliftPpm).toBe(25_221); // charges inflate R by about 2.5%
  });

  it("holds no rate of its own — a different rates object gives a different total", () => {
    const zeroed = { ...ratesOn("eq_delivery", "2026-09-05"), sttPct: 0, dpCharge: 0 };
    const cheap = chargesAdjustedRisk(
      { segment: "eq_delivery", qty, entryP: ENTRY_P, stopP: STOP_P, capitalP: CAPITAL_P },
      zeroed,
    );
    expect(cheap.chargesP).toBeLessThan(r.chargesP);
    expect(cheap.breakdownP.sttCtt).toBe(0);
  });

  it("reports null percentages when capital is unconfigured", () => {
    const noCapital = chargesAdjustedRisk(
      { segment: "eq_delivery", qty, entryP: ENTRY_P, stopP: STOP_P },
      ratesOn("eq_delivery", "2026-09-05"),
    );
    expect(noCapital.effectiveRiskPctOfCapitalPpm).toBeNull();
    expect(noCapital.chargesP).toBe(r.chargesP);
  });
});

/**
 * A SHORT enters on the SELL leg and exits on the BUY leg, and intraday STT is
 * charged on the sell side alone. Pricing a short as though entry were the
 * purchase therefore taxes the wrong number: the stop is the larger figure on a
 * short, so the charge came out too high and the effective risk with it. The
 * price risk |entry - stop| is symmetric and must not move.
 */
describe("chargesAdjustedRisk knows which leg is the sale (M6)", () => {
  const SHORT_ENTRY_P = 285_000; // Rs 2,850 - the SELL leg
  const SHORT_STOP_P = 290_000; // Rs 2,900 - the BUY leg
  const QTY = 80;
  const rates = ratesOn("eq_intraday", "2026-09-05");
  const trade = {
    segment: "eq_intraday" as Segment,
    qty: QTY,
    entryP: SHORT_ENTRY_P,
    stopP: SHORT_STOP_P,
    capitalP: CAPITAL_P,
  };

  it("charges intraday STT on the Rs 2,28,000 entry value, because that is the sale", () => {
    const short = chargesAdjustedRisk({ ...trade, direction: "short" }, rates);
    expect(QTY * SHORT_ENTRY_P).toBe(22_800_000); // Rs 2,28,000, the sell leg
    expect(short.breakdownP.sttCtt).toBe(5_700); // Rs 57.00 = 0.025% of Rs 2,28,000
  });

  it("prices the same two levels differently long, where the sale is the stop", () => {
    const long = chargesAdjustedRisk({ ...trade, direction: "long" }, rates);
    expect(long.breakdownP.sttCtt).toBe(5_800); // Rs 58.00 = 0.025% of Rs 2,32,000
    const short = chargesAdjustedRisk({ ...trade, direction: "short" }, rates);
    expect(long.chargesP - short.chargesP).toBe(100); // the whole difference is STT
  });

  it("leaves the price risk alone — |entry - stop| has no side", () => {
    const short = chargesAdjustedRisk({ ...trade, direction: "short" }, rates);
    const long = chargesAdjustedRisk({ ...trade, direction: "long" }, rates);
    expect(short.riskAtStopP).toBe(400_000); // Rs 4,000
    expect(long.riskAtStopP).toBe(short.riskAtStopP);
    expect(short.effectiveRiskP).toBe(short.riskAtStopP + short.chargesP);
  });

  it("defaults to long, so every existing caller is priced exactly as before", () => {
    const implicit = chargesAdjustedRisk(trade, rates);
    const explicit = chargesAdjustedRisk({ ...trade, direction: "long" }, rates);
    expect(implicit.chargesP).toBe(explicit.chargesP);
    expect(implicit.breakdownP.sttCtt).toBe(explicit.breakdownP.sttCtt);
  });
});

describe("the rate table is dated, because STT moves — one epoch per circular", () => {
  it("a 2024-09-30 futures trade uses the old STT and a 2026-04-01 trade the new", () => {
    expect(ratesOn("future", "2024-09-30").sttPct).toBe(0.000125);
    expect(ratesOn("future", "2024-10-01").sttPct).toBe(0.0002);
    expect(ratesOn("future", "2026-03-31").sttPct).toBe(0.0002);
    expect(ratesOn("future", "2026-04-01").sttPct).toBe(0.0005);
  });

  it("the same options round trip costs more on the later epoch", () => {
    const trade = { segment: "index_option" as Segment, qty: 65, entryP: 12_000, stopP: 8_000 };
    const before = chargesAdjustedRisk(trade, ratesOn("index_option", "2026-03-31"));
    const after = chargesAdjustedRisk(trade, ratesOn("index_option", "2026-04-01"));
    expect(after.chargesP).toBeGreaterThan(before.chargesP);
    expect(after.riskAtStopP).toBe(before.riskAtStopP); // price risk is unchanged
  });

  /**
   * R91 (v4.3.0 fix wave 1): `verified` means a primary NSE circular (FATAX)
   * states the epoch, its start included. The 1970 futures and options epochs
   * cite FATAX for the RATE, but when that rate began (Finance Act 2008) is not
   * verified, so they ship verified:false with "NOT verified" in their note.
   * Re-pinned 2026-09-11; this used to assert verified === true on every epoch.
   * tests/stt-epoch-2024.test.ts pins the F&O windows, the 1970 pair and
   * verified => FATAX; this pins the marker rule over EVERY epoch, both ways.
   * The note match is case-sensitive on purpose: eq_intraday's "earlier history
   * is not verified here" is about history the table does not carry, and that
   * epoch is verified.
   */
  const FATAX_SOURCE = /^https:\/\/nsearchives\.nseindia\.com\/content\/circulars\/FATAX\d+\.pdf$/;
  type Epoch = { segment: string; effectiveFrom: string; verified: unknown; sources?: unknown; note?: string };
  /** Null when the epoch's marker agrees with its sources and note; otherwise what is wrong. */
  const markerFault = (e: Epoch): string | null => {
    if (!Array.isArray(e.sources) || e.sources.length === 0) return "no sources";
    if (typeof e.verified !== "boolean") return "verified is not a boolean";
    const primary = e.sources.some((s) => typeof s === "string" && FATAX_SOURCE.test(s));
    const expected = primary && !/NOT verified/.test(e.note ?? "");
    return e.verified === expected ? null : `verified is ${e.verified}; its sources and note say ${expected}`;
  };

  it("every shipped epoch carries sources, and is marked verified exactly when a FATAX circular states it (R91)", () => {
    expect(defaults.epochs.length).toBeGreaterThan(0);
    for (const e of defaults.epochs) expect(markerFault(e), `${e.segment} ${e.effectiveFrom}`).toBeNull();
    expect(defaults.epochs.filter((e) => !e.verified).map((e) => `${e.segment} ${e.effectiveFrom}`)).toEqual([
      "future 1970-01-01",
      "index_option 1970-01-01",
    ]);
    expect(defaults.sources.primary).toMatch(/^https:\/\//);
    expect(defaults.asOf).toBe("2026-09-05");
  });

  it("the marker rule goes red on a broker-blog-only epoch marked verified, an unverified start flipped, or no sources", () => {
    const real = defaults.epochs.find((e) => e.segment === "future" && e.effectiveFrom === "2013-06-01")!;
    const start = defaults.epochs.find((e) => e.segment === "future" && e.effectiveFrom === "1970-01-01")!;
    expect(markerFault(real)).toBeNull();
    expect(markerFault({ ...real, sources: ["https://zerodha.com/z-connect/budget-2013-stt"] })).not.toBeNull();
    expect(markerFault({ ...start, verified: true })).not.toBeNull();
    expect(markerFault({ ...real, sources: [] })).not.toBeNull();
  });
});

describe("mtfInterestDrag", () => {
  it("matches the rupee-API break-even calculator to the paise", () => {
    // Rs 8,00,000 funded at 13.49% p.a. for 10 days, on a Rs 10,00,000 position.
    const drag = mtfInterestDrag(
      { fundedP: 80_000_000, positionValueP: 100_000_000, otherChargesP: 50_000 },
      134_900,
      10,
    );
    expect(drag.interestP).toBe(295_671); // Rs 2,956.71
    expect(drag.dailyInterestP).toBe(29_567); // Rs 295.67
    expect(drag.totalCostP).toBe(345_671); // Rs 3,456.71
    expect(drag.breakevenMovePpm).toBe(3_456); // 0.3456%

    const rupees = mtfBreakeven({
      fundedAmount: 800_000,
      annualRate: 0.1349,
      days: 10,
      positionValue: 1_000_000,
      otherCharges: 500,
    });
    expect(Math.round(rupees.interest * 100)).toBe(drag.interestP);
    expect(Math.round(rupees.totalCost * 100)).toBe(drag.totalCostP);
  });

  it("keeps precision on a one-crore funded book held a year", () => {
    // funded x ratePpm x days = 1e10 x 182500 x 365 passes MAX_SAFE_INTEGER.
    expect(1_000_000_000 * 182_500 * 365).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    const drag = mtfInterestDrag({ fundedP: 1_000_000_000, positionValueP: 2_000_000_000 }, 182_500, 365);
    expect(drag.interestP).toBe(182_500_000); // Rs 18,25,000 = exactly 18.25%
    expect(drag.breakevenMovePpm).toBe(91_250); // 9.125% of the position value
  });

  it("zero days accrues nothing and a missing denominator stays null", () => {
    const drag = mtfInterestDrag({ fundedP: 80_000_000 }, 146_000, 0);
    expect(drag.interestP).toBe(0);
    expect(drag.breakevenMovePpm).toBeNull();
  });

  it("the bundled broker rates are dated presets, each with a source", () => {
    for (const b of defaults.mtfPresets.brokers) {
      expect(b.annualPpm).toBeGreaterThan(0);
      expect(b.source).toMatch(/^https:\/\//);
    }
    expect(defaults.mtfPresets.asOf).toBe("2026-09-05");
  });
});
