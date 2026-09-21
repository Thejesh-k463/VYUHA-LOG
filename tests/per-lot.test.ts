import { describe, expect, it } from "vitest";
import { lotsOf, perLotAggregate, perLotUnknownNote, rPerLotLabel, type PerLotTrade } from "@/lib/analytics/per-lot";
import { INDEX_LOTS_AS_OF } from "@/lib/domain/index-contracts";

/**
 * v4.4.0 D3 — the per-lot second line.
 *
 * WRONG looks like: "₹3,100 per lot" on a Dec-2025 NIFTY book computed with lot
 * 65 for contracts that traded in lots of 75. Every case below is one of the
 * ways that number gets manufactured.
 */

const t = (o: Partial<PerLotTrade> = {}): PerLotTrade => ({
  lotSize: null, symbol: "NIFTY", expiry: "2026-03-26",
  buyQty: 65, sellQty: 65, netPnl: 1000, riskAmount: 500, rMultiple: 2, ...o,
});

describe("lotsOf — the chain and its two refusals", () => {
  it("the stored lot_size wins and names itself", () => {
    expect(lotsOf(t({ lotSize: 65, buyQty: 130, sellQty: 130 }))).toEqual({ lot: 65, lots: 2, source: "trade", asOf: null });
  });

  it("130 qty at lot 65 is 2 lots; 100 at lot 65 is NOT 1.54 lots — it is null", () => {
    expect(lotsOf(t({ lotSize: 65, buyQty: 130, sellQty: 130 }))!.lots).toBe(2);
    expect(lotsOf(t({ lotSize: 65, buyQty: 100, sellQty: 100 }))).toBeNull();
  });

  it("a Dec-2025 NIFTY expiry with no stored lot_size resolves to NOTHING", () => {
    // The bundled 65 speaks for 2026-01-01 onward. Applying it to a contract
    // that expired before that invents lots that never traded.
    expect(lotsOf(t({ expiry: "2025-12-24" }))).toBeNull();
    expect(lotsOf(t({ expiry: null }))).toBeNull();
    // …and the SAME row with the lot the user actually recorded is fine.
    expect(lotsOf(t({ expiry: "2025-12-24", lotSize: 75, buyQty: 75, sellQty: 75 }))!.lots).toBe(1);
  });

  it("an expiry on or after the snapshot date uses the bundled lot, dated", () => {
    expect(lotsOf(t({ expiry: INDEX_LOTS_AS_OF }))).toEqual({ lot: 65, lots: 1, source: "bundled", asOf: INDEX_LOTS_AS_OF });
  });

  it("the instruments upload beats the bundled table — but only when it is at least as recent", () => {
    const fresh = new Map([["NIFTY", { lotSize: 75, asOf: "2026-02-01" }]]);
    expect(lotsOf(t({ buyQty: 75, sellQty: 75 }), fresh)).toEqual({ lot: 75, lots: 1, source: "instruments", asOf: "2026-02-01" });
    const stale = new Map([["NIFTY", { lotSize: 75, asOf: "2025-06-01" }]]);
    expect(lotsOf(t({ buyQty: 75, sellQty: 75 }), stale), "a stale upload is an older fact, not a better one").toBeNull();
  });

  it("a non-index underlying with no stored lot is null (no bundled stock lots ship)", () => {
    expect(lotsOf(t({ symbol: "RELIANCE" }))).toBeNull();
  });
});

describe("perLotAggregate — all or dash, and the arithmetic reconciles", () => {
  const book = [
    t({ lotSize: 65, buyQty: 130, sellQty: 130, netPnl: 2600, riskAmount: 1300, rMultiple: 2 }),  // 2 lots
    t({ lotSize: 65, buyQty: 195, sellQty: 195, netPnl: -1300, riskAmount: 1300, rMultiple: -1 }), // 3 lots
  ];

  it("per-lot × lots = per-trade to the paisa", () => {
    const a = perLotAggregate(book);
    expect(a.lots).toBe(5);
    expect(a.expectancyPerLot).toBe(260); // (2600 − 1300) / 5
    expect(a.expectancyPerLot! * a.lots!).toBeCloseTo(book.reduce((s, x) => s + x.netPnl, 0), 2);
    expect(a.rupeesPerLotR).toBe(520); // (1300 + 1300) / 5
    expect(rPerLotLabel(a)).toBe("1R = ₹520 per lot");
    expect(perLotUnknownNote(a)).toBeNull();
  });

  it("ONE unknown row dashes the WHOLE line and says how many", () => {
    const a = perLotAggregate([...book, t({ expiry: "2025-12-24" })]);
    expect(a.unknown).toBe(1);
    expect(a.lots).toBeNull();
    expect(a.expectancyPerLot).toBeNull();
    expect(a.rupeesPerLotR).toBeNull();
    expect(rPerLotLabel(a)).toBe("—");
    expect(perLotUnknownNote(a)).toBe("lot size unknown on 1 of 3");
  });

  it("no row carries an R ⇒ 1R per lot is null, never 0 (invariant 6)", () => {
    const a = perLotAggregate([t({ lotSize: 65, rMultiple: null, riskAmount: null })]);
    expect(a.expectancyPerLot).not.toBeNull();
    expect(a.rupeesPerLotR).toBeNull();
  });

  it("every figure names its lot source and the date it speaks for", () => {
    expect(perLotAggregate([t({})]).sources).toEqual([`bundled (${INDEX_LOTS_AS_OF})`]);
  });

  it("the LCM blind spot is documented in the module, not silently tolerated", () => {
    // 975 = 15 × 65 = 13 × 75: the qty % lot guard cannot tell these apart.
    expect(lotsOf(t({ lotSize: 65, buyQty: 975, sellQty: 975 }))!.lots).toBe(15);
    expect(lotsOf(t({ lotSize: 75, buyQty: 975, sellQty: 975 }))!.lots).toBe(13);
  });
});
