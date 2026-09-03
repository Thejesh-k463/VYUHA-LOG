import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  bundledIsinBySymbol,
  bundledSymbolByIsin,
  createListingLookup,
  isCodedSymbol,
  listingByBseCode,
  listingByIsin,
  LISTED_SYMBOLS_AS_OF,
  LISTED_SYMBOLS_COUNT,
  nameByIsin,
  searchListingsByName,
  symbolByBseCode,
  type ListingTuple,
} from "@/lib/import/isin-symbol";
import { SECTOR_MAP_COUNT, taxonomyEntries } from "@/lib/analytics/instruments";

/**
 * COVERAGE OF THE BUNDLED ISIN→SYMBOL SNAPSHOT, measured against the owner's
 * real Paytm books — the only files that state scrip codes rather than tickers.
 *
 * Two independent skips, both deliberate:
 *   • no private fixtures (CI, and any clone that is not the owner's machine);
 *   • no bundled snapshot yet (`lib/data/isin-symbols.json` still the empty
 *     placeholder). The resolution chain works without it — it just falls back
 *     to the index map — so an absent snapshot must not turn CI red.
 *
 * What it pins, once both exist: EVERY numeric scrip code in a real book
 * resolves to a ticker. The point of the snapshot is that a trader never sees
 * `544434` where they expect a name, and a partial answer is how that
 * regressed in the first place (76 of 215 on 2026-08-30, all the misses SME).
 *
 * The v3.8 blocks below pin the snapshot's two identity rules on SYNTHETIC
 * tables (so they run everywhere): a BSE code is keyed on the code, never the
 * ticker, and NSE wins an ISIN collision while BSE's code still attaches.
 */

const PRIV = path.join(process.cwd(), "tests", "fixtures", "private");

/** Every distinct numeric Script code in a Paytm tradebook, with its ISIN. */
function codesIn(file: string): Map<string, string> {
  const wb = XLSX.read(fs.readFileSync(file));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {
    header: 1, raw: false, defval: "",
  }) as string[][];
  const hi = rows.findIndex((r) => String(r[1]).trim() === "Script");
  const out = new Map<string, string>();
  for (const r of rows.slice(hi + 1)) {
    const code = String(r[1] ?? "").trim();
    const isin = String(r[2] ?? "").trim().toUpperCase();
    if (code && isin && isCodedSymbol(code) && !out.has(code)) out.set(code, isin);
  }
  return out;
}

const BOOKS = [
  { label: "the 414-execution book the diagnosis was built on", file: "Paytm Money - Tradebook (real).xlsx", codes: 66 },
  { label: "the demo book that failed live on 2026-08-30", file: "Paytm Money - Tradebook (demo 2026-08-30).xlsx", codes: 215 },
];

const haveBundle = LISTED_SYMBOLS_COUNT > 0;

describe("bundled ISIN→symbol snapshot", () => {
  it.skipIf(!haveBundle)("is a dated snapshot, not a hand-edited file", () => {
    expect(LISTED_SYMBOLS_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Both boards of both exchanges is several thousand securities. A snapshot
    // materially smaller than that was built from an incomplete folder, which
    // looks like success and silently leaves SME names as numbers.
    expect(LISTED_SYMBOLS_COUNT).toBeGreaterThan(4000);
  });

  for (const b of BOOKS) {
    const file = path.join(PRIV, b.file);
    const have = fs.existsSync(file);

    it.skipIf(!have)(`sees the expected number of scrip codes in ${b.label}`, () => {
      expect(codesIn(file).size).toBe(b.codes);
    });

    it.skipIf(!have || !haveBundle)(`resolves EVERY scrip code in ${b.label}`, () => {
      const unresolved: string[] = [];
      for (const [code, isin] of codesIn(file)) {
        if (!bundledSymbolByIsin(isin)) unresolved.push(`${code} (${isin})`);
      }
      expect(unresolved, `${unresolved.length} scrip codes would still show as numbers: ${unresolved.slice(0, 15).join(", ")}`).toEqual([]);
    });
  }

  it.skipIf(!haveBundle)("never maps one ISIN to a numeric code", () => {
    // The snapshot exists to REMOVE codes. A numeric value here would swap one
    // code for another and read as a successful resolution.
    const bad: string[] = [];
    for (const code of BOOKS.flatMap((b) => {
      const f = path.join(PRIV, b.file);
      return fs.existsSync(f) ? [...codesIn(f).values()] : [];
    })) {
      const sym = bundledSymbolByIsin(code);
      if (sym && isCodedSymbol(sym)) bad.push(`${code} → ${sym}`);
    }
    expect(bad).toEqual([]);
  });

  it.skipIf(!haveBundle)("carries name, board, BSE code and series per row (v3.8)", () => {
    // ABB India is dual-listed: NSE won the ticker, BSE's code is attached.
    expect(listingByIsin("INE117A01022")).toEqual({
      isin: "INE117A01022", symbol: "ABB", name: "ABB India Limited", board: "nse", bseCode: "500002", series: "EQ",
    });
    expect(nameByIsin("INE117A01022")).toBe("ABB India Limited");
    expect(symbolByBseCode("500002")).toBe("ABB");
  });

  it.skipIf(!haveBundle)("TECHNOCRAT (BSE 544877) and MARC (NSE Emerge) are two companies, resolved by name and by code", () => {
    // A trader who remembers "Technocrats" means Marc Technocrats, which
    // trades as MARC on Emerge; BSE's ticker TECHNOCRAT is Technocrats
    // Plasma Systems, a different company with its own ISIN. The name search
    // therefore returns BOTH, and a BSE code answers only from its own row.
    const marc = searchListingsByName("marc technocrats");
    expect(marc.map((l) => [l.symbol, l.isin, l.board])).toEqual([["MARC", "INE0TD401015", "sme"]]);
    expect(bundledIsinBySymbol("MARC")).toBe("INE0TD401015");
    expect(nameByIsin("INE0TD401015")).toBe("Marc Technocrats Limited");

    const bse = listingByBseCode("544877");
    expect(bse).toMatchObject({ symbol: "TECHNOCRAT", isin: "INE19QK01022", board: "bse" });
    expect(bse!.isin).not.toBe("INE0TD401015");

    const both = searchListingsByName("technocrat").map((l) => l.symbol);
    expect(both).toContain("MARC");
    expect(both).toContain("TECHNOCRAT");
  });

  it.skipIf(!haveBundle)("the bundled sector taxonomy covers ≥ 2,200 ISINs of the snapshot", () => {
    // sector-map.json is keyed by ISIN; the chain re-keys it to tickers
    // through this snapshot. Coverage below this means one of the two files
    // was rebuilt from a stale or partial source.
    let covered = 0;
    for (const e of taxonomyEntries()) if (listingByIsin(e.isin)) covered++;
    expect(SECTOR_MAP_COUNT).toBeGreaterThanOrEqual(2200);
    expect(covered).toBeGreaterThanOrEqual(2200);
  });
});

// ---------------------------------------------------------------------------
// Identity rules on a synthetic table — these run everywhere.
// ---------------------------------------------------------------------------

/** Real ISINs and codes (2026-09-04 lists); the tickers really do collide. */
const SYNTHETIC: Record<string, ListingTuple> = {
  INE593W01028: ["FOCUS", "Focus Lighting and Fixtures Limited", "nse", "", "BE"],
  INE0DXR01010: ["FOCUS", "Focus Business Solution Limited", "bse", "543312", "M"],
  INE0GYI01028: ["HSIL", "Hemant Surgical Industries Limited", "bse", "543916", "M"],
  INE610E01010: ["KALYANI", "Kalyani Commercials Limited", "nse", "", "BE"],
  INE0N6U01018: ["KALYANI", "Kalyani Cast-Tech Limited", "bse", "544023", "M"],
  INE117A01022: ["ABB", "ABB India Limited", "nse", "500002", "EQ"], // dual listing: NSE won, code attached
  INE0TD401015: ["MARC", "Marc Technocrats Limited", "sme", "", "SM"],
};

describe("listing lookup — a BSE code is keyed on the CODE, never the ticker", () => {
  const lk = createListingLookup(SYNTHETIC);

  it("answers a BSE code from its own row, even when the ticker collides with NSE", () => {
    expect(lk.listingByBseCode("543312")).toMatchObject({ symbol: "FOCUS", isin: "INE0DXR01010", board: "bse" });
    expect(lk.listingByBseCode("544023")).toMatchObject({ symbol: "KALYANI", isin: "INE0N6U01018", board: "bse" });
    expect(lk.symbolByBseCode("543916")).toBe("HSIL");
    expect(lk.symbolByBseCode(" 500002 ")).toBe("ABB");
  });

  it("refuses a ticker or an unknown code where a code is expected", () => {
    expect(lk.symbolByBseCode("FOCUS")).toBeNull();
    expect(lk.symbolByBseCode("999999")).toBeNull();
    expect(lk.symbolByBseCode("")).toBeNull();
  });

  it("gives a colliding ticker to NSE first, then Emerge, then BSE", () => {
    expect(lk.isinBySymbol("FOCUS")).toBe("INE593W01028");
    expect(lk.isinBySymbol("kalyani")).toBe("INE610E01010");
    expect(lk.isinBySymbol("HSIL")).toBe("INE0GYI01028"); // BSE-only, so BSE it is
    expect(lk.isinBySymbol("MARC")).toBe("INE0TD401015");
  });

  it("exposes name and board, and searches names without collapsing hits", () => {
    expect(lk.nameByIsin("ine0dxr01010")).toBe("Focus Business Solution Limited");
    expect(lk.listingByIsin("INE117A01022")?.board).toBe("nse");
    expect(lk.searchByName("focus").map((l) => l.isin)).toEqual(["INE593W01028", "INE0DXR01010"]); // NSE first
    expect(lk.searchByName("")).toEqual([]);
    expect(lk.count).toBe(7);
  });
});

describe("build-isin-symbols.mjs — NSE wins the ISIN, BSE's code still attaches", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyuha-isin-"));
  fs.writeFileSync(path.join(dir, "EQUITY_L.csv"), [
    "SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE",
    "ABB,ABB India Limited, EQ, 13-MAR-2002, 2, 1, INE117A01022, 2",
    "FOCUS,Focus Lighting and Fixtures Limited, BE, 24-NOV-2021, 2, 1, INE593W01028, 2",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "SME_EQUITY_L.csv"), [
    "SYMBOL,NAME_OF_COMPANY,SERIES,DATE_OF_LISTING,PAID_UP_VALUE,ISIN_NUMBER,FACE_VALUE,",
    "MARC,Marc Technocrats Limited,SM,24-Dec-25,10,INE0TD401015,10,",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "bse-scrips.json"), JSON.stringify([
    // Same ISIN as NSE's ABB, under a different BSE ticker: NSE must win, the code must attach.
    { SCRIP_CD: "500002", Scrip_Name: "ABB India Ltd", Status: "Active", GROUP: "A", ISIN_NUMBER: "INE117A01022", scrip_id: "ABBINDIA", Segment: "Equity", Issuer_Name: "ABB India Limited" },
    // BSE's own FOCUS — a different company from NSE's FOCUS.
    { SCRIP_CD: "543312", Scrip_Name: "Focus Business Solution Ltd", Status: "Active", GROUP: "M", ISIN_NUMBER: "INE0DXR01010", scrip_id: "FOCUS", Segment: "Equity", Issuer_Name: "Focus Business Solution Limited" },
    // Filters that must survive: non-equity and non-active rows never land.
    { SCRIP_CD: "900001", Scrip_Name: "Some Bond", Status: "Active", GROUP: "F", ISIN_NUMBER: "INE0BOND0001", scrip_id: "SOMEBOND", Segment: "Debt", Issuer_Name: "Some Bond Issuer" },
    { SCRIP_CD: "900002", Scrip_Name: "Gone Ltd", Status: "Delisted", GROUP: "B", ISIN_NUMBER: "INE0GONE0001", scrip_id: "GONE", Segment: "Equity", Issuer_Name: "Gone Limited" },
  ]));
  const out = path.join(dir, "out.json");
  execFileSync(process.execPath, [path.join(process.cwd(), "scripts", "build-isin-symbols.mjs"), "--src", dir, "--as-of", "2026-01-01", "--out", out], { stdio: "pipe" });
  const built = JSON.parse(fs.readFileSync(out, "utf8")) as { count: number; bseCodes: number; fields: string[]; byIsin: Record<string, ListingTuple> };

  it("keeps NSE's ticker for the dual listing and attaches BSE's code to that row", () => {
    expect(built.byIsin.INE117A01022).toEqual(["ABB", "ABB India Limited", "nse", "500002", "EQ"]);
  });

  it("keeps BSE's FOCUS as its own row — a different ISIN, keyed by its code", () => {
    expect(built.byIsin.INE0DXR01010).toEqual(["FOCUS", "Focus Business Solution Limited", "bse", "543312", "M"]);
    expect(built.byIsin.INE593W01028).toEqual(["FOCUS", "Focus Lighting and Fixtures Limited", "nse", "", "BE"]);
    expect(createListingLookup(built.byIsin).symbolByBseCode("543312")).toBe("FOCUS");
    expect(createListingLookup(built.byIsin).isinBySymbol("FOCUS")).toBe("INE593W01028");
  });

  it("reads the Emerge list's underscore headers and labels the board", () => {
    expect(built.byIsin.INE0TD401015).toEqual(["MARC", "Marc Technocrats Limited", "sme", "", "SM"]);
  });

  it("still drops non-equity and non-active BSE rows, and documents the tuple", () => {
    expect(built.byIsin.INE0BOND0001).toBeUndefined();
    expect(built.byIsin.INE0GONE0001).toBeUndefined();
    expect(built.count).toBe(4);
    expect(built.bseCodes).toBe(2);
    expect(built.fields).toEqual(["symbol", "name", "board", "bseCode", "series"]);
  });
});
