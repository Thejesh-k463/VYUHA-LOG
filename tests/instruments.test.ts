import { describe, it, expect } from "vitest";
import { parseInstrumentList, buildSectorMap } from "@/lib/analytics/instruments";

describe("parseInstrumentList", () => {
  it("parses symbol + sector and upper-cases the symbol", () => {
    const rows = parseInstrumentList("reliance, Energy");
    expect(rows).toEqual([{ symbol: "RELIANCE", sector: "Energy", name: null, lotSize: null, isin: null }]);
  });

  it("classifies optional columns by shape (lot size, ISIN, name) regardless of order", () => {
    const rows = parseInstrumentList("TCS, IT, 175, INE467B01029, Tata Consultancy");
    expect(rows[0]).toEqual({
      symbol: "TCS",
      sector: "IT",
      name: "Tata Consultancy",
      lotSize: 175,
      isin: "INE467B01029",
    });
  });

  it("skips comments and a header row", () => {
    const rows = parseInstrumentList(["SYMBOL, SECTOR", "# a comment", "HDFCBANK, Financials"].join("\n"));
    expect(rows.map((r) => r.symbol)).toEqual(["HDFCBANK"]);
  });

  it("tolerates tab and pipe separators and symbol-only lines", () => {
    const rows = parseInstrumentList("INFY\tIT\nWIPRO | IT\nLT");
    expect(rows.map((r) => [r.symbol, r.sector])).toEqual([
      ["INFY", "IT"],
      ["WIPRO", "IT"],
      ["LT", null],
    ]);
  });
});

describe("buildSectorMap", () => {
  it("maps symbol → sector for entries with a sector, skipping the rest", () => {
    const m = buildSectorMap([
      { symbol: "RELIANCE", sector: "Energy" },
      { symbol: "LT", sector: null },
      { symbol: "infy", sector: "IT" },
    ]);
    expect(m.get("RELIANCE")).toBe("Energy");
    expect(m.get("INFY")).toBe("IT");
    expect(m.has("LT")).toBe(false);
    expect(m.size).toBe(2);
  });
});
