import { describe, expect, it } from "vitest";
import {
  assessDataQuality,
  etfClassSymbols,
  etfClassUndetermined,
  codedSymbolNoIsin,
  type QualityInputs,
  type QualityTrade,
} from "@/lib/analytics/data-quality";
import { assetClassFor, resolveCgHead } from "@/lib/analytics/cg-heads";

/**
 * v4.5.0 wave 3a — "ETF class undetermined" (dossier §F.2, ruling Q4(a)).
 *
 * Invariant 6, applied to a classification: the bundled NSE list is a SNAPSHOT
 * of NSE's own published file, so two shapes exist that it cannot settle, and
 * both are NAMED rather than guessed:
 *
 *  1. an INF-prefixed ISIN — a FUND unit, not a company share — that the list
 *     does not carry: the seven BSE-only Sensex/BSE-100 ETFs, SIF units,
 *     segregated portfolios. Its STT stays the equity-share rate, which is a
 *     statement about what the broker levied, not about what the unit is;
 *  2. a unit whose published `ETF Underlying` is `Hybrid` (NSE states one
 *     today, HYBRIDETF). Whether it is equity-oriented is a portfolio fact the
 *     list does not carry, so `etf_other` prices it and the card says so.
 *
 * And the deliberate NON-flag: a row with NO ISIN whose symbol is not on the
 * list is an ordinary share as far as anything here can tell. Flagging it would
 * put every equity trade in the book on the card, which is the same as having
 * no card. That case is the one most likely to be "fixed" by someone later, so
 * it is asserted as loudly as the two that do fire.
 */

const trade = (p: Partial<QualityTrade> = {}): QualityTrade => ({
  id: 1,
  isOpen: false,
  acquisition: null,
  acquisitionPrice: null,
  closingPrice: null,
  slPlanned: 90,
  riskAmount: 1000,
  segment: "eq_delivery",
  mtfFundedAmount: null,
  instrumentType: "equity",
  expiry: null,
  strike: null,
  optionType: null,
  symbol: "ABC",
  ...p,
});

const inputs = (p: Partial<QualityInputs> = {}): QualityInputs => ({
  trades: [],
  markedTradeIds: new Set(),
  knownSymbols: new Set(["ABC", "NIFTYBEES", "HYBRIDETF", "SENSEXBEES", "GOLDBEES"]),
  ipoLinkedTradeIds: new Set(),
  staleMtmCount: 0,
  missingAttachmentFiles: 0,
  ...p,
});

const EQ_SEGMENTS = ["eq_delivery", "eq_mtf", "eq_intraday"] as const;
/** A BSE-only Sensex ETF: a real fund ISIN, absent from NSE's own list. */
const UNLISTED = { isin: "INF200KA1FS0", symbol: "SENSEXBEES" };
/** NSE's one published `Hybrid` unit — ON the list, and still undetermined. */
const HYBRID = { isin: "INF769K01RJ5", symbol: "HYBRIDETF" };
const ids = (rows: QualityTrade[]) => rows.map((t) => t.id).sort((a, b) => a - b);

describe("etfClassUndetermined — which rows the list cannot settle", () => {
  it("fires for an INF ISIN the list does not carry, on ALL THREE equity segments and no others", () => {
    for (const segment of EQ_SEGMENTS) {
      expect(etfClassUndetermined([trade({ ...UNLISTED, segment })]), segment).toHaveLength(1);
    }
    for (const segment of ["index_option", "stock_option", "future", "commodity_future", "commodity_option"]) {
      expect(etfClassUndetermined([trade({ ...UNLISTED, segment })]), segment).toEqual([]);
    }
  });

  it("fires for the Hybrid unit — which IS on the list — on the same three segments, and not on F&O", () => {
    for (const segment of EQ_SEGMENTS) {
      expect(etfClassUndetermined([trade({ ...HYBRID, segment })]), segment).toHaveLength(1);
    }
    expect(etfClassUndetermined([trade({ ...HYBRID, segment: "index_option" })])).toEqual([]);
  });

  it("does NOT fire for a row with no ISIN whose symbol is unknown — an ordinary share is not an undetermined ETF", () => {
    expect(etfClassUndetermined([trade({ symbol: "SOMESHARE" })])).toEqual([]);
    expect(etfClassUndetermined([trade({ symbol: "SOMESHARE", isin: null })])).toEqual([]);
    expect(etfClassUndetermined([trade({ symbol: "SOMESHARE", isin: "" })])).toEqual([]);
    // An ordinary company ISIN is INE-prefixed: a share, settled, never flagged.
    expect(etfClassUndetermined([trade({ symbol: "RELIANCE", isin: "INE002A01018" })])).toEqual([]);
  });

  it("does NOT fire for a unit the list DOES settle, equity-oriented or not, by ISIN or by symbol alone", () => {
    expect(etfClassUndetermined([trade({ isin: "INF204KB14I2", symbol: "NIFTYBEES" })])).toEqual([]);
    expect(etfClassUndetermined([trade({ isin: "INF204KB17I5", symbol: "GOLDBEES" })])).toEqual([]);
    expect(etfClassUndetermined([trade({ symbol: "GOLDBEES" })])).toEqual([]);
    expect(etfClassUndetermined([trade({ symbol: "NIFTYBEES" })])).toEqual([]);
  });

  it("an unlisted INF ISIN whose SYMBOL is on the list is settled by the symbol, not flagged", () => {
    expect(etfClassUndetermined([trade({ isin: "INF999Z01ZZ9", symbol: "NIFTYBEES" })])).toEqual([]);
  });

  it("over a mixed book it returns exactly the two undetermined rows, in input order, and nothing else", () => {
    const book = [
      trade({ id: 1, symbol: "ABC" }),
      trade({ id: 2, ...UNLISTED }),
      trade({ id: 3, isin: "INF204KB14I2", symbol: "NIFTYBEES" }),
      trade({ id: 4, ...HYBRID, segment: "eq_mtf" }),
      trade({ id: 5, ...UNLISTED, segment: "index_option" }),
      trade({ id: 6, isin: "INE002A01018", symbol: "RELIANCE" }),
    ];
    expect(ids(etfClassUndetermined(book))).toEqual([2, 4]);
  });
});

describe("etfClassSymbols — how the card names them", () => {
  it("lists distinct symbols in upper case, sorted, and abbreviates past six", () => {
    expect(etfClassSymbols([trade({ symbol: "sensexbees" }), trade({ symbol: "SENSEXBEES" })])).toBe("SENSEXBEES");
    expect(etfClassSymbols([trade({ symbol: "B" }), trade({ symbol: "A" })])).toBe("A, B");
    const many = ["G", "F", "E", "D", "C", "B", "A"].map((s, i) => trade({ id: i, symbol: s }));
    expect(etfClassSymbols(many)).toBe("A, B, C, D, E, F and 1 more");
  });
});

describe("the issue the report raises", () => {
  const find = (i: QualityInputs) => assessDataQuality(i).issues.find((x) => x.code === "etf_class");

  it("is a warning with the right count, href and the symbols in its detail", () => {
    const issue = find(inputs({ trades: [trade({ id: 2, ...UNLISTED }), trade({ id: 3, ...HYBRID, segment: "eq_intraday" })] }));
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
    expect(issue?.title).toBe("ETF class undetermined");
    expect(issue?.count).toBe(2);
    expect(issue?.href).toBe("/trades");
    expect(issue?.ids).toEqual([2, 3]);
    expect(issue?.detail).toContain("HYBRIDETF, SENSEXBEES");
    // The copy must state the consequence, not just the gap (invariant 6).
    expect(issue?.detail).toMatch(/equity-share rate/);
    expect(issue?.detail).toMatch(/blank rather than guessed/);
  });

  it("is absent entirely from a book with nothing undetermined — a zero-count issue is never pushed", () => {
    expect(find(inputs({ trades: [trade(), trade({ id: 2, isin: "INF204KB14I2", symbol: "NIFTYBEES" })] }))).toBeUndefined();
    expect(find(inputs())).toBeUndefined();
  });

  it("ACCOUNT #3's class — a Dhan manual OPTION book has no equity segment, so the card says nothing about it", () => {
    const options = [1, 2, 3].map((id) =>
      trade({
        id,
        symbol: "NIFTY",
        segment: "index_option",
        instrumentType: "option",
        expiry: "2026-09-25",
        strike: 25000,
        optionType: "CE",
        // Even with an ETF's own ISIN pasted on, an option is not an ETF unit.
        isin: UNLISTED.isin,
      }),
    );
    expect(etfClassUndetermined(options)).toEqual([]);
    expect(find(inputs({ trades: options, knownSymbols: new Set(["NIFTY"]) }))).toBeUndefined();
  });
});

/**
 * P3 (v4.5.0 wave 3b) — a BARE NUMERIC SCRIP CODE with no ISIN.
 *
 * `isCodedSymbol` has recognised the shape since the Paytm work; what changed
 * is what it MEANS for tax. The resolution chain deliberately KEEPS a code it
 * cannot resolve (a trade you can see is worth more than one silently
 * discarded), but a kept code is NOT evidence that an equity share was traded —
 * and until this release every tax surface treated it as one and taxed it at
 * S.111A/S.112A on nothing at all. `assetClassFor` now answers `undetermined`,
 * which blanks the head, and this card names the code so the user can settle it.
 */
describe("codedSymbolNoIsin — P3, a numeric scrip code with no ISIN", () => {
  const find = (i: QualityInputs) => assessDataQuality(i).issues.find((x) => x.code === "coded_symbol_no_isin");

  it("fires on the three equity segments and never on F&O", () => {
    for (const segment of EQ_SEGMENTS) {
      expect(codedSymbolNoIsin([trade({ symbol: "532540", isin: null, segment })]), segment).toHaveLength(1);
    }
    // An F&O row is business income whatever its symbol looks like.
    for (const segment of ["index_option", "stock_option", "future", "commodity_future", "commodity_option"]) {
      expect(codedSymbolNoIsin([trade({ symbol: "532540", isin: null, segment })]), segment).toEqual([]);
    }
  });

  it("does NOT fire once the row states an ISIN — that is the fix the user applies", () => {
    expect(codedSymbolNoIsin([trade({ symbol: "532540", isin: "INE467B01029" })])).toEqual([]);
    // …nor for an ordinary ticker, which is the overwhelming majority of a book.
    expect(codedSymbolNoIsin([trade({ symbol: "TCS", isin: null })])).toEqual([]);
    // A code with letters in it is not a bare numeric code.
    expect(codedSymbolNoIsin([trade({ symbol: "532540A", isin: null })])).toEqual([]);
  });

  it("names the codes and states the CONSEQUENCE, not just the gap", () => {
    const issue = find(inputs({
      trades: [
        trade({ id: 1, symbol: "532540", isin: null }),
        trade({ id: 2, symbol: "500325", isin: null }),
        trade({ id: 3, symbol: "TCS", isin: "INE467B01029" }),
      ],
      knownSymbols: new Set(["532540", "500325", "TCS"]),
    }));
    expect(issue?.count).toBe(2);
    expect(issue?.ids).toEqual([1, 2]);
    expect(issue?.detail).toContain("500325, 532540");
    expect(issue?.detail).toMatch(/BLANK rather than assumed to be an equity share/);
    expect(issue?.severity).toBe("warning");
  });

  it("is absent entirely from a book with no coded symbols", () => {
    expect(find(inputs({ trades: [trade({ symbol: "TCS", isin: "INE467B01029" })] }))).toBeUndefined();
    expect(find(inputs())).toBeUndefined();
  });

  it("the head really is blank for exactly that shape (the DQ card and the tax head agree)", () => {
    expect(assetClassFor({ segment: "eq_delivery", symbol: "532540", isin: null })).toBe("undetermined");
    expect(resolveCgHead({ assetClass: "undetermined", acquiredOn: "2025-01-01", transferredOn: "2025-06-01" }).head).toBe("undetermined");
    expect(assetClassFor({ segment: "eq_delivery", symbol: "532540", isin: "INE467B01029" })).toBe("share");
  });
});
