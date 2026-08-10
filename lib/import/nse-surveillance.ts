// NSE SURVEILLANCE FILE PARSERS (PURE, no DB/React).
//
// Two official daily files, both verified against real downloads on
// 2026-08-10 (see docs/DECISIONS.md for the URLs and captured shapes):
//
//   fo_secban.csv            — F&O securities in ban period. A dated header
//                              line, then numbered "N,SYMBOL" rows:
//                                Securities in Ban For Trade Date 10-AUG-2026:
//                                1,BANDHANBNK
//   REG_INDDDMMYY.csv        — the consolidated Surveillance Indicator file
//                              (one row per listed security; the GSM /
//                              Long-Term ASM / Short-Term ASM / ESM columns
//                              carry the STAGE, with the sentinel 100 meaning
//                              "not under this measure"; GSM stage 0 is a real
//                              stage, not "absent").
//
// Detection requires a CONTENT FINGERPRINT — the ban file's dated header line,
// or the surveillance file's exact column set. Shape alone never claims a file
// (the same rule the broker importers follow): a stray CSV with a Symbol
// column must fall through to null, where the UI says "not a recognised NSE
// surveillance file" instead of importing garbage confidently.
//
// The category is assigned FROM THE FILE — neither file carries a category
// column. Skipped values are counted and reported, never guessed.

import Papa from "papaparse";
import type { RestrictionCategory } from "@/lib/analytics/restrictions";

export type SurveillanceKind = "fo_ban" | "reg_ind";

export interface ParsedSurveillanceRow {
  symbol: string;
  category: RestrictionCategory;
  stage: string | null;
  note: string | null;
}

export interface NseSurveillanceResult {
  kind: SurveillanceKind;
  /** Human name for recaps ("F&O ban list", "surveillance indicator file"). */
  kindLabel: string;
  /** Every category this file SPEAKS FOR — replace exactly these, no others. */
  categories: RestrictionCategory[];
  rows: ParsedSurveillanceRow[];
  count: number;
  /** ISO date derived from the file itself (header line / filename), or null —
   *  the caller falls back and SAYS it fell back, never silently guesses. */
  asOf: string | null;
  warnings: string[];
  skipped: Record<string, number>;
}

const MONTHS: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

/** "10-AUG-2026" → "2026-08-10", or null. */
function banDateToIso(d: string, mon: string, y: string): string | null {
  const mm = MONTHS[mon.toUpperCase()];
  return mm ? `${y}-${mm}-${d}` : null;
}

/** REG_IND filename date: DDMMYY with a 20xx century. */
function regIndDateFromFilename(fileName: string | undefined): string | null {
  const m = /REG_IND(\d{2})(\d{2})(\d{2})\.csv$/i.exec(fileName ?? "");
  return m ? `20${m[3]}-${m[2]}-${m[1]}` : null;
}

const BAN_HEADER = /Securities\s+in\s+Ban\s+For\s+Trade\s+Date\s+(\d{2})-([A-Za-z]{3})-(\d{4})/i;

/** Strip BOM + trim — NSE headers arrive with both. */
const cleanHeader = (h: string) => h.replace(/^﻿/, "").trim();

function parseFoBan(text: string): NseSurveillanceResult {
  const warnings: string[] = [];
  const skipped: Record<string, number> = {};
  const lines = text.split(/\r?\n/);
  const m = BAN_HEADER.exec(lines[0] ?? "");
  const asOf = m ? banDateToIso(m[1], m[2], m[3]) : null;
  if (m && !asOf) warnings.push(`Unreadable month in ban-list date: ${lines[0].trim()}`);

  const rows: ParsedSurveillanceRow[] = [];
  for (const line of lines.slice(1)) {
    const t = line.trim();
    if (!t) continue;
    // "1,BANDHANBNK" — the symbol is the LAST cell; the leading ordinal is
    // presentation, not data.
    const parts = t.split(",").map((p) => p.trim()).filter(Boolean);
    const symbol = (parts[parts.length - 1] ?? "").toUpperCase();
    if (!/^[A-Z0-9&\-]{1,20}$/.test(symbol)) {
      skipped["unreadable line"] = (skipped["unreadable line"] ?? 0) + 1;
      continue;
    }
    rows.push({ symbol, category: "fno_ban", stage: null, note: null });
  }
  if (rows.length === 0) warnings.push("Ban-list header found but no symbols under it — an empty ban day, or a truncated file.");
  return {
    kind: "fo_ban",
    kindLabel: "F&O ban list (fo_secban.csv)",
    categories: ["fno_ban"],
    rows,
    count: rows.length,
    asOf,
    warnings,
    skipped,
  };
}

/** The REG_IND sentinel for "not under this measure". */
const NOT_UNDER = "100";

function parseRegInd(text: string, fileName: string | undefined): NseSurveillanceResult | null {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: cleanHeader,
  });
  const data = parsed.data ?? [];
  if (data.length === 0) return null;

  const headers = Object.keys(data[0]);
  const symKey = headers.find((h) => h === "Symbol");
  const gsmKey = headers.find((h) => h === "GSM");
  const ltKey = headers.find((h) => h.startsWith("Long_Term_Additional_Surveillance_Measure"));
  const stKey = headers.find((h) => h.startsWith("Short_Term_Additional_Surveillance_Measure"));
  const esmKey = headers.find((h) => h === "ESM");
  // The fingerprint: this exact column family. A CSV that merely HAS a Symbol
  // column is not this file.
  if (!symKey || !gsmKey || !ltKey || !stKey) return null;

  const rows: ParsedSurveillanceRow[] = [];
  const skipped: Record<string, number> = {};
  const stageOf = (v: string | undefined): string | null => {
    const t = (v ?? "").trim();
    if (t === "" || t === NOT_UNDER) return null;
    if (!/^\d{1,2}$/.test(t)) {
      skipped[`unreadable stage "${t}"`] = (skipped[`unreadable stage "${t}"`] ?? 0) + 1;
      return null;
    }
    return t;
  };

  for (const r of data) {
    const symbol = (r[symKey] ?? "").trim().toUpperCase();
    if (!symbol) continue;

    const gsm = stageOf(r[gsmKey]);
    if (gsm !== null) rows.push({ symbol, category: "gsm", stage: `Stage ${gsm}`, note: null });

    // Long-term and short-term ASM are one category with the flavour in the
    // stage text; a scrip under both gets ONE row with both named.
    const asmStages: string[] = [];
    const lt = stageOf(r[ltKey]);
    if (lt !== null) asmStages.push(`Long-term Stage ${lt}`);
    const st = stageOf(r[stKey]);
    if (st !== null) asmStages.push(`Short-term Stage ${st}`);
    if (asmStages.length > 0) rows.push({ symbol, category: "asm", stage: asmStages.join(" · "), note: null });

    if (esmKey) {
      const esm = stageOf(r[esmKey]);
      if (esm !== null) rows.push({ symbol, category: "esm", stage: `Stage ${esm}`, note: null });
    }
  }

  return {
    kind: "reg_ind",
    kindLabel: "surveillance indicator file (REG_IND)",
    // ESM is replaced even when the column is absent in some future variant:
    // this file is the only NSE source for it, so "absent" means "nothing
    // under ESM today", not "unknown".
    categories: ["gsm", "asm", "esm"],
    rows,
    count: rows.length,
    asOf: regIndDateFromFilename(fileName),
    warnings: [],
    skipped,
  };
}

/**
 * Parse an uploaded NSE surveillance file, or return the reason it was
 * refused. `null` is never returned: an unrecognised file gets an explicit
 * refusal with the headers actually seen, so the user learns WHY.
 */
export function parseNseSurveillance(
  text: string,
  fileName?: string,
): NseSurveillanceResult | { refused: string } {
  if (!text || !text.trim()) return { refused: "Empty file." };

  if (BAN_HEADER.test(text.split(/\r?\n/)[0] ?? "")) return parseFoBan(text);

  const reg = parseRegInd(text, fileName);
  if (reg) return reg;

  const firstLine = (text.split(/\r?\n/)[0] ?? "").slice(0, 160);
  return {
    refused:
      `Not a recognised NSE surveillance file. Expected fo_secban.csv (a "Securities in Ban For Trade Date …" header) ` +
      `or REG_INDDDMMYY.csv (Symbol / GSM / Long_Term & Short_Term ASM columns) — the file starts: ${firstLine}`,
  };
}
