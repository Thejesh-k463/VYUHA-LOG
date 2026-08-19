import { describe, expect, it } from "vitest";
import nseIndexMap from "@/lib/data/nse-index-map.json";
import { bundledSymbolByIsin, isCodedSymbol, resolveCodedSymbols } from "@/lib/import/isin-symbol";
import type { NormalizedTrade } from "@/lib/engine/types";

/**
 * Turning Paytm Money's numeric scrip codes back into tickers via the ISIN.
 *
 * The rule being pinned is the refusal, not the lookup: an unknown ISIN keeps
 * the code, because a wrong ticker merges two companies' trades silently while
 * a visible number is a question the user can answer.
 */

const trade = (over: Partial<NormalizedTrade> = {}): NormalizedTrade => ({
  broker: "paytm",
  tradingsymbol: "216463",
  isin: "INE466L01038",
  buyQty: 10, avgBuyPrice: 100, buyValue: 1000,
  sellQty: 10, avgSellPrice: 110, sellValue: 1100,
  closingPrice: null, grossPnl: 100, unrealisedPnl: 0,
  buyDate: "2026-08-03", sellDate: "2026-08-04",
  productHint: "delivery", exchangeHint: "NSE", sourceFile: "x.xlsx",
  ...over,
});

/** A symbol/ISIN pair straight out of the bundled snapshot, so the test cannot
 *  drift when the map is refreshed. */
const sample = (() => {
  const symbols = (nseIndexMap as { symbols: Record<string, { isin?: string | null }> }).symbols;
  const hit = Object.entries(symbols).find(([, m]) => !!m.isin)!;
  return { symbol: hit[0], isin: hit[1].isin as string };
})();

describe("isCodedSymbol", () => {
  it("is true only for an all-digit symbol", () => {
    expect(isCodedSymbol("216463")).toBe(true);
    expect(isCodedSymbol(" 544866 ")).toBe(true);
    expect(isCodedSymbol("RELIANCE")).toBe(false);
    expect(isCodedSymbol("3MINDIA")).toBe(false);
    expect(isCodedSymbol("NIFTY26AUG25000CE")).toBe(false);
    expect(isCodedSymbol("")).toBe(false);
  });
});

describe("bundledSymbolByIsin", () => {
  it("resolves an ISIN that is in the bundled NSE index map", () => {
    expect(bundledSymbolByIsin(sample.isin)).toBe(sample.symbol);
    expect(bundledSymbolByIsin(sample.isin.toLowerCase())).toBe(sample.symbol);
  });

  it("returns null for an ISIN it does not carry — SME names are not in the map", () => {
    expect(bundledSymbolByIsin("INE000000009")).toBeNull();
    expect(bundledSymbolByIsin("")).toBeNull();
  });
});

describe("resolveCodedSymbols", () => {
  it("replaces a coded symbol and records where the ticker came from", () => {
    const [t] = resolveCodedSymbols([trade({ tradingsymbol: "216463", isin: "INE111" })], () => "acme");
    expect(t.tradingsymbol).toBe("ACME");
    expect(t.importNotes).toEqual(["Paytm scrip code 216463 → ACME via ISIN"]);
  });

  it("keeps the code when the ISIN resolves to nothing — no invented ticker", () => {
    const [t] = resolveCodedSymbols([trade({ tradingsymbol: "216463" })], () => null);
    expect(t.tradingsymbol).toBe("216463");
    expect(t.importNotes ?? null).toBeNull();
  });

  it("keeps the code when the row carries no ISIN at all", () => {
    const [t] = resolveCodedSymbols([trade({ isin: null })], () => "ACME");
    expect(t.tradingsymbol).toBe("216463");
  });

  it("leaves a real ticker untouched, lookup or no lookup", () => {
    const [t] = resolveCodedSymbols([trade({ tradingsymbol: "RELIANCE" })], () => "WRONG");
    expect(t.tradingsymbol).toBe("RELIANCE");
    expect(t.importNotes ?? null).toBeNull();
  });

  it("appends to existing notes rather than replacing them", () => {
    const [t] = resolveCodedSymbols([trade({ importNotes: ["earlier note"] })], () => "ACME");
    expect(t.importNotes).toEqual(["earlier note", "Paytm scrip code 216463 → ACME via ISIN"]);
  });

  it("resolves through the bundled map when a caller wires it as the lookup", () => {
    const [t] = resolveCodedSymbols(
      [trade({ tradingsymbol: "999999", isin: sample.isin })],
      bundledSymbolByIsin,
    );
    expect(t.tradingsymbol).toBe(sample.symbol);
  });
});
