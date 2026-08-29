import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";
import {
  bundledSymbolByIsin,
  isCodedSymbol,
  LISTED_SYMBOLS_AS_OF,
  LISTED_SYMBOLS_COUNT,
} from "@/lib/import/isin-symbol";

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
});
