import { describe, it, expect } from "vitest";
import { compareBrokers, type CompareTrade } from "@/lib/analytics/broker-compare";
import { seedRatesMap } from "@/lib/engine/rates";
import { BROKERS } from "@/lib/domain/constants";
import type { ChargeRates } from "@/lib/engine/types";

// Minimal rate factory for deterministic assertions.
const rate = (broker: string, over: Partial<ChargeRates>): ChargeRates => ({
  broker: broker as ChargeRates["broker"],
  plan: "default", planLabel: null, subscriptionMonthly: 0,
  segment: "eq_delivery",
  exchange: "NSE",
  brokerageFlat: null, brokeragePct: 0, brokerageCap: null, brokerageFloor: 0,
  sttPct: 0.001, sttSide: "sell", exchangeTxnPct: 0, sebiPct: 0, stampPct: 0, ipftPct: 0,
  gstPct: 0.18, dpCharge: 0, dpPct: 0, dpGstApplicable: false, dpMinValue: 0,
  mtfInterestAnnual: 0, mtfRateUnknown: false, mtfTiers: null, pledgeCharge: 0, unpledgeCharge: 0,
  ...over,
});

describe("compareBrokers — deterministic", () => {
  const map = new Map<string, ChargeRates>([
    ["A|default|eq_delivery|NSE", rate("A", { brokeragePct: 0 })], // zero brokerage
    ["B|default|eq_delivery|NSE", rate("B", { brokerageFlat: 20 })], // ₹20/order
    // "C" intentionally has no rate row.
  ]);
  const trades: CompareTrade[] = [
    { segment: "eq_delivery", exchange: "NSE", buyValue: 100000, sellValue: 100000, buyQty: 100, sellQty: 100, buyOrderCount: 1, sellOrderCount: 1, actualCharges: 160 },
  ];
  const r = compareBrokers(trades, map, ["A", "B", "C"], "B");

  it("prices each broker from its own rate card", () => {
    const A = r.brokers.find((x) => x.broker === "A")!;
    const B = r.brokers.find((x) => x.broker === "B")!;
    expect(A.total).toBe(100); // STT only: 0.1% × 100000 sell
    expect(B.total).toBeCloseTo(147.2, 1); // +₹40 brokerage +₹7.2 GST
    expect(B.brokerage).toBe(40);
  });

  it("picks the cheapest covered broker and computes savings vs actual", () => {
    expect(r.cheapest!.broker).toBe("A");
    expect(r.maxSaving).toBe(60); // actual 160 − cheapest 100
    expect(r.current!.broker).toBe("B");
    expect(r.current!.vsActual).toBeCloseTo(-12.8, 1); // 147.2 − 160
  });

  it("a broker with no rate coverage sorts last and is never cheapest", () => {
    const C = r.brokers.find((x) => x.broker === "C")!;
    expect(C.covered).toBe(0);
    expect(C.missing).toBe(1);
    expect(C.total).toBe(0);
    expect(r.brokers[r.brokers.length - 1].broker).toBe("C");
  });
});

describe("compareBrokers — against the real seed rate cards", () => {
  const map = seedRatesMap();
  const trades: CompareTrade[] = [
    { segment: "eq_delivery", exchange: "NSE", buyValue: 200000, sellValue: 205000, buyQty: 50, sellQty: 50, buyOrderCount: 1, sellOrderCount: 1, actualCharges: 400 },
    { segment: "eq_intraday", exchange: "NSE", buyValue: 300000, sellValue: 301000, buyQty: 200, sellQty: 200, buyOrderCount: 2, sellOrderCount: 2, actualCharges: 250 },
  ];
  const r = compareBrokers(trades, map, [...BROKERS], "dhan");

  it("returns one cost row per broker PLAN with positive totals", () => {
    // One row per offer, not per broker: Kotak Neo sells a paid tier alongside
    // its free one, and the whole point is to see them side by side.
    expect(r.brokers.length).toBe(BROKERS.length + 1);
    expect(r.brokers.filter((b) => b.plan !== "default").map((b) => b.broker)).toEqual(["kotakneo"]);
    expect(r.cheapest).not.toBeNull();
    for (const b of r.brokers) {
      expect(b.covered).toBe(2);
      expect(b.total).toBeGreaterThan(0);
    }
  });

  it("cheapest total ≤ every other broker total", () => {
    const min = Math.min(...r.brokers.map((b) => b.total));
    expect(r.cheapest!.total).toBe(min);
  });
});

describe("a paid plan carries its subscription into the total", () => {
  const map = seedRatesMap();
  // Two months apart, so the ₹249/month fee is charged twice.
  const trades: CompareTrade[] = [
    { segment: "eq_delivery", exchange: "NSE", buyValue: 200000, sellValue: 205000, buyQty: 50, sellQty: 50, buyOrderCount: 1, sellOrderCount: 1, actualCharges: 400, buyDate: "2026-05-04", sellDate: "2026-05-06" },
    { segment: "eq_delivery", exchange: "NSE", buyValue: 100000, sellValue: 104000, buyQty: 25, sellQty: 25, buyOrderCount: 1, sellOrderCount: 1, actualCharges: 250, buyDate: "2026-07-02", sellDate: "2026-07-04" },
  ];
  const r = compareBrokers(trades, map, [...BROKERS]);
  const pro = r.brokers.find((b) => b.plan === "pro")!;
  const free = r.brokers.find((b) => b.broker === "kotakneo" && b.plan === "default")!;

  it("amortises the monthly fee over the window the trades span", () => {
    expect(pro.months).toBe(2);
    expect(pro.subscription).toBe(498);
  });

  it("adds the fee to the total rather than reporting brokerage alone", () => {
    // On ~₹6L of delivery turnover the halved brokerage saves more than the
    // ₹498 of fees, so Pro really is the cheaper offer here — but only because
    // the fee was counted and still lost. That is the comparison being right,
    // not the plan being flattered.
    expect(pro.brokerage).toBeLessThan(free.brokerage);
    expect(pro.total).toBeLessThan(free.total);
    expect(pro.total - pro.subscription).toBeLessThan(pro.total);
  });

  it("lets the fee OUTWEIGH the saving on a small book", () => {
    // The case that matters for most users: trade little, and a ₹249/month
    // plan costs far more than the brokerage it saves. Comparing brokerage
    // alone would have recommended it anyway.
    const small: CompareTrade[] = [
      { segment: "eq_delivery", exchange: "NSE", buyValue: 20000, sellValue: 20500, buyQty: 10, sellQty: 10, buyOrderCount: 1, sellOrderCount: 1, actualCharges: 40, buyDate: "2026-05-04", sellDate: "2026-05-06" },
    ];
    const s = compareBrokers(small, map, ["kotakneo"]);
    const sPro = s.brokers.find((b) => b.plan === "pro")!;
    const sFree = s.brokers.find((b) => b.plan === "default")!;
    expect(sPro.brokerage).toBeLessThan(sFree.brokerage);
    expect(sPro.total).toBeGreaterThan(sFree.total);
    expect(s.cheapest!.plan).toBe("default");
  });

  it("charges a free plan nothing", () => {
    for (const b of r.brokers.filter((x) => x.plan === "default")) {
      expect(b.subscription, b.broker).toBe(0);
    }
  });

  it("assumes ONE month when the trades carry no dates", () => {
    // The smallest honest charge rather than none — and it is the assumption
    // that flatters the paid plan least.
    const undated = trades.map(({ buyDate: _b, sellDate: _s, ...t }) => t);
    const u = compareBrokers(undated, map, ["kotakneo"]);
    expect(u.brokers.find((b) => b.plan === "pro")!.subscription).toBe(249);
  });
});
