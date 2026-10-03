// v4.7.0 C2 — MAE/MFE from the user's TYPED intra-trade high/low, and the ONE
// shared MaeTradeInput builder (lib/analytics/mae-input.ts). Design D6 + review
// change 8: typed H/L are used at READ time only while low ≤ min(entry, exit) and
// high ≥ max(entry, exit); otherwise the EOD bars, exactly as before.
import { describe, expect, it } from "vitest";
import { computeMaeMfe, typedRangeValid, type MaeBar, type MaeTradeInput } from "@/lib/analytics/mae-mfe";
import { maeInputOf, maeInputsOf, type MaeSourceRow } from "@/lib/analytics/mae-input";

const bars = new Map<string, MaeBar[]>([
  ["ATGL", [
    { date: "2026-07-01", high: 105, low: 95, close: 100 },
    { date: "2026-07-02", high: 120, low: 98, close: 118 },
  ]],
]);

const t = (over: Partial<MaeTradeInput>): MaeTradeInput => ({
  id: 1, symbol: "ATGL", ticker: "ATGL", side: "long", qty: 10, entry: 100, exit: 110,
  entryDate: "2026-07-01", exitDate: "2026-07-02", netPnl: 100, isOpen: false, ...over,
});

const src = (over: Partial<MaeSourceRow>): MaeSourceRow => ({
  id: 7, symbol: "atgl", buyQty: 10, sellQty: 10, side: "long", buyDate: "2026-07-01", sellDate: "2026-07-02",
  avgBuyPrice: 100, avgSellPrice: 110, netPnl: 100, isOpen: false, riskAmount: 50, ...over,
});

describe("typedRangeValid", () => {
  it("needs both, finite, and bracketing both fills", () => {
    expect(typedRangeValid(100, 110, 112, 97)).toBe(true);
    expect(typedRangeValid(100, 110, 110, 100)).toBe(true); // touching is a bracket
    expect(typedRangeValid(100, 110, 112, null)).toBe(false);
    expect(typedRangeValid(100, 110, null, 97)).toBe(false);
    expect(typedRangeValid(100, 110, 109, 97)).toBe(false); // high below the exit
    expect(typedRangeValid(100, 110, 112, 101)).toBe(false); // low above the entry
    expect(typedRangeValid(100, 110, Number.NaN, 97)).toBe(false);
  });
});

describe("computeMaeMfe — the typed path", () => {
  it("a valid typed range is used even with NO bars (an option, an intraday trade): source typed, barsUsed 0", () => {
    const r = computeMaeMfe([t({ ticker: "NIFTY26JULCE", intraHigh: 115, intraLow: 96 })], bars);
    expect(r.covered).toBe(1);
    expect(r.uncovered).toBe(0);
    const row = r.rows[0];
    expect(row.source).toBe("typed");
    expect(row.barsUsed).toBe(0);
    expect(row.mfeRs).toBe(150); // (115 − 100) × 10
    expect(row.maeRs).toBe(40); // (100 − 96) × 10
  });

  it("a short reads the typed range from the other side", () => {
    const row = computeMaeMfe([t({ side: "short", entry: 110, exit: 100, intraHigh: 113, intraLow: 95 })], bars).rows[0];
    expect(row.source).toBe("typed");
    expect(row.mfeRs).toBe(150); // (110 − 95) × 10
    expect(row.maeRs).toBe(30); // (113 − 110) × 10
  });

  it("an INVALID typed range falls back to the EOD bars (source bars), never a clipped zero excursion", () => {
    // low 101 sits ABOVE the 100 entry: the typed range no longer contains the trade.
    const row = computeMaeMfe([t({ intraHigh: 115, intraLow: 101 })], bars).rows[0];
    expect(row.source).toBe("bars");
    expect(row.barsUsed).toBe(2);
    expect(row.maeRs).toBe(50); // bars: 100 − 95
    expect(row.mfeRs).toBe(200); // bars: 120 − 100
  });

  it("an invalid typed range with no bars is uncovered, not a row", () => {
    const r = computeMaeMfe([t({ ticker: "NOBARS", intraHigh: 105, intraLow: 99 })], bars);
    expect(r.covered).toBe(0);
    expect(r.uncovered).toBe(1);
  });

  it("no typed range = the C1 bars path, unchanged", () => {
    const row = computeMaeMfe([t({})], bars).rows[0];
    expect(row.source).toBe("bars");
    expect(row.barsUsed).toBe(2);
  });
});

describe("maeInputOf / maeInputsOf — the one shared builder", () => {
  it("maps a long's fills, dates, qty and risk; passes a bracketing typed range through", () => {
    const i = maeInputOf(src({ intraHigh: 112, intraLow: 98 }), "ATGL");
    expect(i).toMatchObject({ id: 7, ticker: "ATGL", side: "long", qty: 10, entry: 100, exit: 110,
      entryDate: "2026-07-01", exitDate: "2026-07-02", riskAmount: 50, intraHigh: 112, intraLow: 98 });
  });

  it("a short opens on its sale: entry = avgSell, exit = avgBuy, entry date = sell date", () => {
    const i = maeInputOf(src({ side: "short", avgBuyPrice: 100, avgSellPrice: 110, buyDate: "2026-07-02", sellDate: "2026-07-01" }), "ATGL");
    expect(i).toMatchObject({ side: "short", entry: 110, exit: 100, entryDate: "2026-07-01", exitDate: "2026-07-02" });
  });

  it("DROPS a typed range that no longer brackets the fills (bars decide), and one with only one side", () => {
    expect(maeInputOf(src({ intraHigh: 109, intraLow: 98 }), "ATGL")).toMatchObject({ intraHigh: null, intraLow: null });
    expect(maeInputOf(src({ intraHigh: 112, intraLow: null }), "ATGL")).toMatchObject({ intraHigh: null, intraLow: null });
  });

  it("maeInputsOf keeps closed rows only and resolves the UPPER-cased symbol", () => {
    const seen: string[] = [];
    const out = maeInputsOf([src({}), src({ id: 8, isOpen: true })], (s) => (seen.push(s), `T:${s}`));
    expect(out.map((x) => x.id)).toEqual([7]);
    expect(out[0].ticker).toBe("T:ATGL");
    expect(seen).toEqual(["ATGL"]);
  });
});
