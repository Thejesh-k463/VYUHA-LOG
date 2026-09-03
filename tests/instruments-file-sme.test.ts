import { describe, expect, it } from "vitest";
import { parseInstrumentsFile } from "@/lib/import/instruments-file";

/**
 * NSE Emerge's SME_EQUITY_L.csv is the main-board securities list with two
 * differences that each made the whole file vanish before 2026-09-04:
 *
 *   • the headers use underscores (NAME_OF_COMPANY, ISIN_NUMBER) where
 *     EQUITY_L.csv pads with spaces — the parser matched only the latter, so
 *     the file fell through to "Unrecognised";
 *   • the series is SM or ST (SME normal / SME trade-for-trade) — ST was not
 *     on the equity allow-list, so 118 of the 568 Emerge names (2026-09-04
 *     list) were dropped even once the header matched.
 *
 * The excerpt below is the real layout, including the trailing comma NSE
 * leaves on every line.
 */
const SME_EQUITY_L = `SYMBOL,NAME_OF_COMPANY,SERIES,DATE_OF_LISTING,PAID_UP_VALUE,ISIN_NUMBER,FACE_VALUE,
MARC,Marc Technocrats Limited,SM,24-Dec-25,10,INE0TD401015,10,
HOLMARC,Holmarc Opto-Mechatronics Limited,SM,25-Sep-23,10,INE0LXA01019,10,
TFTLTD,Trade For Trade Example Limited,ST,01-Jan-24,10,INE0AAA01019,10,
`;

describe("parseInstrumentsFile — NSE Emerge securities list", () => {
  const r = parseInstrumentsFile(SME_EQUITY_L);

  it("recognises the underscore headers as the securities-list layout", () => {
    expect(r.format).toBe("securities-list");
    expect(r.fields).toEqual(["name", "isin"]);
    expect(r.warnings).toEqual([]);
  });

  it("reads name and ISIN through NAME_OF_COMPANY / ISIN_NUMBER", () => {
    expect(r.rows.find((x) => x.symbol === "MARC")).toEqual({
      symbol: "MARC",
      name: "Marc Technocrats Limited",
      isin: "INE0TD401015",
      lotSize: null,
      sector: null,
    });
  });

  it("keeps the ST (SME trade-for-trade) series alongside SM", () => {
    expect(r.count).toBe(3);
    expect(r.rows.map((x) => x.symbol)).toEqual(["MARC", "HOLMARC", "TFTLTD"]);
  });

  it("resolves 'Technocrat' by NAME to MARC, the NSE Emerge ticker", () => {
    // The company a trader remembers as "Technocrats" trades as MARC on
    // Emerge. (BSE's TECHNOCRAT, 544877, is a different company — see
    // tests/isin-bundle-coverage.test.ts.)
    const hit = r.rows.find((x) => /technocrat/i.test(x.name ?? ""));
    expect(hit?.symbol).toBe("MARC");
    expect(hit?.isin).toBe("INE0TD401015");
  });
});
