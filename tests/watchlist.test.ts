import { describe, expect, it } from "vitest";
import {
  parseWatchlistText,
  extractTickerColumn,
  extractTickerTokensFromText,
  canonicaliseWatchlist,
  canonicaliseWatchlistSymbol,
  looksLikeTicker,
  ISIN_RE,
} from "@/lib/import/watchlist";

const noIsin = () => null;
const sources = (over: Partial<{ aliasMap: Map<string, string>; isinLookup: (i: string) => string | null }> = {}) => ({
  aliasMap: new Map<string, string>(),
  isinLookup: noIsin,
  ...over,
});

describe("watchlist — .txt parsing", () => {
  it("splits on commas, spaces, newlines and semicolons, deduped and upper-cased", () => {
    const r = parseWatchlistText("nifty, RELIANCE\nhdfcbank;TCS  nifty");
    expect(r.symbols).toEqual(["NIFTY", "RELIANCE", "HDFCBANK", "TCS"]);
    expect(r.requiresConfirmation).toBe(false);
  });

  it("keeps numeric scrip codes and ISINs — the save path resolves those", () => {
    const r = parseWatchlistText("544866 INE009A01021 RELIANCE");
    expect(r.symbols).toEqual(["544866", "INE009A01021", "RELIANCE"]);
  });

  it("returns nothing for an empty file", () => {
    expect(parseWatchlistText("  \n\n ").symbols).toEqual([]);
  });
});

describe("watchlist — ticker column extraction", () => {
  it("claims a one-column file without asking", () => {
    const r = extractTickerColumn(["Symbols"], [["NIFTY"], ["RELIANCE"], ["TCS"]]);
    expect(r.symbols).toEqual(["NIFTY", "RELIANCE", "TCS"]);
    expect(r.requiresConfirmation).toBe(false);
  });

  it("picks the only ticker-looking column among data columns", () => {
    const r = extractTickerColumn(
      ["Scrip", "Qty", "Price"],
      [["RELIANCE", "10", "2810.50"], ["INFY", "5", "1650.00"]],
    );
    expect(r.symbols).toEqual(["RELIANCE", "INFY"]);
    expect(r.ambiguousColumns).toBeUndefined();
  });

  it("breaks a two-column tie by the symbol-named header", () => {
    const r = extractTickerColumn(
      ["Symbol", "Sector"],
      [["RELIANCE", "ENERGY"], ["INFY", "IT"]],
    );
    expect(r.symbols).toEqual(["RELIANCE", "INFY"]);
    expect(r.requiresConfirmation).toBe(false);
  });

  it("asks rather than guesses when two unnamed columns both look like tickers", () => {
    const r = extractTickerColumn(
      ["A", "B"],
      [["RELIANCE", "ENERGY"], ["INFY", "IT"]],
    );
    expect(r.symbols).toEqual([]);
    expect(r.requiresConfirmation).toBe(true);
    expect(r.ambiguousColumns).toHaveLength(2);
    expect(r.ambiguousColumns![0].symbols).toEqual(["RELIANCE", "INFY"]);
  });

  it("finds nothing to claim in a table of numbers", () => {
    const r = extractTickerColumn(["Qty", "Price"], [["10", "2810.50"], ["5", "1650.00"]]);
    expect(r.symbols).toEqual([]);
    expect(r.ambiguousColumns).toBeUndefined();
  });
});

describe("watchlist — PDF token extraction", () => {
  it("always requires confirmation and never claims table structure", () => {
    const r = extractTickerTokensFromText("Watchlist for Monday: RELIANCE, HDFCBANK and TATAMOTORS at 2810.50");
    expect(r.requiresConfirmation).toBe(true);
    expect(r.symbols).toContain("RELIANCE");
    expect(r.symbols).toContain("HDFCBANK");
    expect(r.symbols).toContain("TATAMOTORS");
  });

  it("drops report words and bare numbers", () => {
    const r = extractTickerTokensFromText("SYMBOL PRICE QTY TOTAL 2810.50 100 RELIANCE");
    expect(r.symbols).toEqual(["RELIANCE"]);
  });

  it("caps the candidate list", () => {
    const text = Array.from({ length: 500 }, (_, i) => `SYM${i}A`).join(" ");
    expect(extractTickerTokensFromText(text, 200).symbols).toHaveLength(200);
  });
});

describe("watchlist — canonicalisation on save", () => {
  it("resolves a broker full name through the alias map", () => {
    const aliasMap = new Map([["BAJAJ AUTO LIMITED", "BAJAJ-AUTO"]]);
    expect(canonicaliseWatchlistSymbol("bajaj auto limited", sources({ aliasMap }))).toBe("BAJAJ-AUTO");
  });

  it("resolves an ISIN through the lookup chain", () => {
    const isinLookup = (i: string) => (i === "INE009A01021" ? "INFY" : null);
    expect(canonicaliseWatchlistSymbol("INE009A01021", sources({ isinLookup }))).toBe("INFY");
  });

  it("keeps an unresolvable ISIN as typed rather than refusing or guessing", () => {
    expect(canonicaliseWatchlistSymbol("INE999Z09999", sources())).toBe("INE999Z09999");
  });

  it("keeps a bare scrip code as typed — a code carries no ISIN to look up", () => {
    expect(canonicaliseWatchlistSymbol("544866", sources())).toBe("544866");
  });

  it("keeps an unknown ticker exactly as typed", () => {
    expect(canonicaliseWatchlistSymbol("myprivatename", sources())).toBe("MYPRIVATENAME");
  });

  it("dedupes AFTER resolution — an alias and its ticker collapse to one entry", () => {
    const aliasMap = new Map([["HDFC BANK LIMITED", "HDFCBANK"]]);
    const r = canonicaliseWatchlist(["HDFCBANK", "hdfc bank limited", "TCS"], sources({ aliasMap }));
    expect(r).toEqual(["HDFCBANK", "TCS"]);
  });
});

describe("watchlist — token shapes", () => {
  it("accepts real ticker shapes, including digit-led and &/-/.", () => {
    for (const t of ["RELIANCE", "3MINDIA", "M&M", "BAJAJ-AUTO", "360ONE", "NIFTY"]) {
      expect(looksLikeTicker(t), t).toBe(true);
    }
  });
  it("rejects numbers, decimals and one-char noise", () => {
    for (const t of ["2810.50", "100", "-5", "A", ""]) {
      expect(looksLikeTicker(t), t || "(empty)").toBe(false);
    }
  });
  it("recognises the ISIN shape", () => {
    expect(ISIN_RE.test("INE009A01021")).toBe(true);
    expect(ISIN_RE.test("RELIANCE")).toBe(false);
  });
});
