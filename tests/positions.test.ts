import { describe, expect, it } from "vitest";
import { deriveOpenPositions } from "../lib/analytics/positions";
import type { Trade } from "../lib/db/schema";

const trade = (over: Partial<Trade>): Trade =>
  ({
    id: 1,
    broker: "dhan",
    bucket: "active",
    segment: "stock_option",
    instrumentType: "option",
    exchange: "NSE",
    symbol: "X",
    tradingsymbol: "X",
    isin: null,
    expiry: null,
    strike: null,
    optionType: null,
    lotSize: null,
    buyQty: 0,
    avgBuyPrice: 0,
    buyValue: 0,
    sellQty: 0,
    avgSellPrice: 0,
    sellValue: 0,
    closingPrice: null,
    buyDate: null,
    sellDate: null,
    entryTime: null,
    exitTime: null,
    grossPnl: 0,
    chargesTotal: 0,
    netPnl: 0,
    unrealisedPnl: 0,
    realisedPct: null,
    isOpen: true,
    buyOrderCount: 1,
    sellOrderCount: 1,
    setupTag: null,
    notes: null,
    playbookId: null,
    emotionTag: null,
    slPlanned: null,
    trailingSl: null,
    targetPlanned: null,
    riskAmount: null,
    impliedVol: null,
    fmv31Jan2018: null,
    rMultiple: null,
    ruleViolations: null,
    mistakeTags: null,
    brokerage: 0,
    sttCtt: 0,
    exchangeTxn: 0,
    sebi: 0,
    stampDuty: 0,
    ipft: 0,
    gst: 0,
    dpCharges: 0,
    mtfInterest: 0,
    mtfFundedAmount: null,
    pledgeCharges: 0,
    sourceFile: null,
    importBatchId: null,
    dedupHash: "h",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  }) as Trade;

describe("deriveOpenPositions — long", () => {
  it("qty/entry/invested/unrealised computed off the buy leg", () => {
    const p = deriveOpenPositions(
      [trade({ buyQty: 100, avgBuyPrice: 1000, buyDate: "2026-06-01" })],
      new Map([["X", 1100]]),
      "2026-06-05",
    )[0];
    expect(p.qty).toBe(100);
    expect(p.avgPrice).toBe(1000);
    expect(p.invested).toBe(100000);
    expect(p.mtmPrice).toBe(1100);
    expect(p.unrealised).toBe(10000); // (1100-1000)*100 — profits when price rises
    expect(p.unrealisedPct).toBe(10);
    expect(p.daysHeld).toBe(4);
  });

  it("loses when price falls", () => {
    const p = deriveOpenPositions([trade({ buyQty: 100, avgBuyPrice: 1000 })], new Map([["X", 950]]), "2026-06-05")[0];
    expect(p.unrealised).toBe(-5000);
  });
});

describe("deriveOpenPositions — short (sell-to-open)", () => {
  // Regression: buyQty=0/sellQty=N used to make qty/avgPrice/invested all
  // evaluate to 0 for any open short (written option or short future) —
  // qty = max(0, buyQty - sellQty) and avgPrice = avgBuyPrice, both wrong for
  // a position with no buy leg at all.
  it("qty/entry/invested come off the SELL leg, not zeroed", () => {
    const p = deriveOpenPositions(
      [trade({ sellQty: 75, avgSellPrice: 100, sellDate: "2026-06-01", strike: 24000, optionType: "CE", segment: "stock_option" })],
      new Map([["X", 80]]),
      "2026-06-05",
    )[0];
    expect(p.qty).toBe(75);
    expect(p.avgPrice).toBe(100);
    expect(p.invested).toBe(7500);
    expect(p.mtmPrice).toBe(80);
    expect(p.daysHeld).toBe(4); // measured from sellDate (the open leg for a short), not buyDate
  });

  it("profits when price falls below entry (mirror of long)", () => {
    const p = deriveOpenPositions([trade({ sellQty: 75, avgSellPrice: 100 })], new Map([["X", 80]]), "2026-06-05")[0];
    expect(p.unrealised).toBe(1500); // (100-80)*75
    expect(p.unrealisedPct).toBeCloseTo(20, 5);
  });

  it("loses when price rises above entry", () => {
    const p = deriveOpenPositions([trade({ sellQty: 75, avgSellPrice: 100 })], new Map([["X", 120]]), "2026-06-05")[0];
    expect(p.unrealised).toBe(-1500); // (100-120)*75
  });

  it("rMultiple sign follows the short-corrected unrealised, not the old always-zero value", () => {
    const p = deriveOpenPositions(
      [trade({ sellQty: 75, avgSellPrice: 100, riskAmount: 750 })],
      new Map([["X", 80]]),
      "2026-06-05",
    )[0];
    expect(p.rMultiple).toBe(2); // 1500 / 750
  });
});

describe("deriveOpenPositions — MTF stays long-only and unaffected", () => {
  it("eq_mtf position (always long) is untouched by the short-handling branch", () => {
    const p = deriveOpenPositions(
      [trade({ segment: "eq_mtf", instrumentType: "equity", buyQty: 100, avgBuyPrice: 200, mtfFundedAmount: 15000 })],
      new Map([["X", 210]]),
      "2026-06-05",
    )[0];
    expect(p.isMtf).toBe(true);
    expect(p.qty).toBe(100);
    expect(p.avgPrice).toBe(200);
    expect(p.fundedAmount).toBe(15000);
    expect(p.ownCapital).toBe(5000);
    expect(p.unrealised).toBe(1000); // (210-200)*100
  });
});
