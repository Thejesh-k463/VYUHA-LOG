import { describe, expect, it } from "vitest";
import { estimateMargin, defaultMtfFundedAmount, marginKey, type MarginPositionInput } from "../lib/risk/margin";

const rates = new Map<string, number>([
  [marginKey("dhan", "index_option"), 12],
  [marginKey("dhan", "stock_option"), 20],
  [marginKey("dhan", "future"), 15],
  [marginKey("dhan", "eq_intraday"), 20],
  [marginKey("dhan", "eq_mtf"), 25],
  [marginKey("dhan", "eq_delivery"), 100],
  [marginKey("zerodha", "eq_mtf"), 20], // deliberately different, to prove broker-awareness
]);
const capitals = { equity: 1_300_000, active: 400_000 };

const pos = (over: Partial<MarginPositionInput>): MarginPositionInput => ({
  id: 1,
  symbol: "X",
  bucket: "active",
  broker: "dhan",
  segment: "index_option",
  side: "long",
  qty: 75,
  entry: 100,
  mtm: 100,
  strike: 24000,
  optionType: "CE",
  spot: null,
  ...over,
});

describe("estimateMargin", () => {
  it("long option margin = premium paid, no rate", () => {
    const s = estimateMargin([pos({})], rates, capitals);
    expect(s.positions[0].margin).toBe(7500);
    expect(s.positions[0].rateUsed).toBeNull();
  });

  it("short option margin = pct × strike notional when no spot", () => {
    const s = estimateMargin([pos({ side: "short" })], rates, capitals);
    // 12% × 75 × 24000 = 216000
    expect(s.positions[0].margin).toBe(216000);
    expect(s.positions[0].rateUsed).toBe(12);
  });

  it("short option prefers spot over strike for notional", () => {
    const s = estimateMargin([pos({ side: "short", spot: 25000 })], rates, capitals);
    expect(s.positions[0].margin).toBe(0.12 * 75 * 25000);
  });

  it("futures margin = pct × current value (mtm)", () => {
    const s = estimateMargin(
      [pos({ segment: "future", optionType: null, strike: null, qty: 50, entry: 24000, mtm: 24500 })],
      rates,
      capitals,
    );
    expect(s.positions[0].margin).toBe(0.15 * 50 * 24500);
  });

  it("MTF margin = pct × invested (entry value); delivery = 100%", () => {
    const s = estimateMargin(
      [
        pos({ id: 1, bucket: "equity", segment: "eq_mtf", optionType: null, qty: 100, entry: 500, mtm: 550 }),
        pos({ id: 2, bucket: "equity", segment: "eq_delivery", optionType: null, qty: 10, entry: 1000, mtm: 900 }),
      ],
      rates,
      capitals,
    );
    const mtf = s.positions.find((p) => p.id === 1)!;
    const del = s.positions.find((p) => p.id === 2)!;
    expect(mtf.margin).toBe(0.25 * 100 * 500);
    expect(del.margin).toBe(10000);
  });

  it("unknown broker+segment falls back to 100% and is reported", () => {
    const s = estimateMargin(
      [pos({ segment: "commodity_future", optionType: null, qty: 10, entry: 700, mtm: 700 })],
      rates,
      capitals,
    );
    expect(s.positions[0].margin).toBe(7000);
    expect(s.missingRateSegments).toEqual(["dhan|commodity_future"]);
  });

  it("uses the position's OWN broker's rate, not a flat global one", () => {
    const s = estimateMargin(
      [
        pos({ id: 1, broker: "dhan", bucket: "equity", segment: "eq_mtf", optionType: null, qty: 100, entry: 500, mtm: 550 }),
        pos({ id: 2, broker: "zerodha", bucket: "equity", segment: "eq_mtf", optionType: null, qty: 100, entry: 500, mtm: 550 }),
      ],
      rates,
      capitals,
    );
    const dhan = s.positions.find((p) => p.id === 1)!;
    const zerodha = s.positions.find((p) => p.id === 2)!;
    expect(dhan.margin).toBe(0.25 * 100 * 500); // dhan eq_mtf = 25%
    expect(zerodha.margin).toBe(0.2 * 100 * 500); // zerodha eq_mtf = 20%
    expect(dhan.margin).not.toBe(zerodha.margin);
  });

  it("aggregates per bucket with utilisation vs capital", () => {
    const s = estimateMargin(
      [
        pos({ id: 1, side: "short" }), // active: 216000
        pos({ id: 2, bucket: "equity", segment: "eq_delivery", optionType: null, qty: 100, entry: 1300, mtm: 1300 }), // 130000
      ],
      rates,
      capitals,
    );
    const active = s.byBucket.find((b) => b.bucket === "active")!;
    expect(active.margin).toBe(216000);
    expect(active.utilisationPct).toBe(54);
    const equity = s.byBucket.find((b) => b.bucket === "equity")!;
    expect(equity.utilisationPct).toBe(10);
    expect(s.totalMargin).toBe(346000);
  });
});

describe("defaultMtfFundedAmount", () => {
  it("funds the position value minus the trader's own margin share", () => {
    // 716 × 310.45 = 222,282.20; at 25% own margin, broker funds 75%.
    expect(defaultMtfFundedAmount(222282.2, 25)).toBeCloseTo(166711.65, 2);
  });

  it("never treats the FULL position as broker-funded when a margin % is configured", () => {
    const funded = defaultMtfFundedAmount(100000, 25);
    expect(funded).toBeLessThan(100000);
    expect(funded).toBe(75000);
  });

  it("clamps an out-of-range margin % into [0,100]", () => {
    expect(defaultMtfFundedAmount(100000, -10)).toBe(100000); // clamped to 0% own margin
    expect(defaultMtfFundedAmount(100000, 150)).toBe(0); // clamped to 100% own margin
  });

  it("treats non-finite margin % as 0 (fully financed) rather than throwing", () => {
    expect(defaultMtfFundedAmount(100000, NaN)).toBe(100000);
  });
});
