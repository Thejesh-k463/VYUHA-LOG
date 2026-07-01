import { describe, it, expect } from "vitest";
import { compareBrokers, type CompareTrade } from "@/lib/analytics/broker-compare";
import { seedRatesMap } from "@/lib/engine/rates";
import { BROKERS } from "@/lib/domain/constants";
import type { ChargeRates } from "@/lib/engine/types";

// Minimal rate factory for deterministic assertions.
const rate = (broker: string, over: Partial<ChargeRates>): ChargeRates => ({
  broker: broker as ChargeRates["broker"],
  segment: "eq_delivery",
  exchange: "NSE",
  brokerageFlat: null, brokeragePct: 0, brokerageCap: null, brokerageFloor: 0,
  sttPct: 0.001, sttSide: "sell", exchangeTxnPct: 0, sebiPct: 0, stampPct: 0, ipftPct: 0,
  gstPct: 0.18, dpCharge: 0, dpGstApplicable: false, dpMinValue: 0,
  mtfInterestAnnual: 0, mtfTiers: null, pledgeCharge: 0, unpledgeCharge: 0,
  ...over,
});

describe("compareBrokers — deterministic", () => {
  const map = new Map<string, ChargeRates>([
    ["A|eq_delivery|NSE", rate("A", { brokeragePct: 0 })], // zero brokerage
    ["B|eq_delivery|NSE", rate("B", { brokerageFlat: 20 })], // ₹20/order
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

  it("returns one cost row per broker with positive totals", () => {
    expect(r.brokers.length).toBe(BROKERS.length);
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
