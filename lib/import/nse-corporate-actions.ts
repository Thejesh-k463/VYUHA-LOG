/**
 * NSE corporate-actions CSV parser (PURE).
 *
 * Input: the "Corporate Actions" download from nseindia.com (Corporates →
 * Corporate Actions → download CSV, often named CF-CA-*.csv). Its PURPOSE
 * column is free text; only the three purposes this app can apply are
 * extracted — splits, bonuses and cash dividends — and each parsed row carries
 * the ORIGINAL purpose string in `note`, so the user can verify the reading
 * before applying anything. Everything else (rights, buybacks, AGMs, mergers)
 * is skipped and counted, never guessed at.
 *
 * Ratio encoding matches lib/analytics/corporate-actions.splitBonusMultiplier:
 *   split  → multiplier = toUnits / fromUnits
 *            NSE says "FROM RS X TO RS Y"  → from=Y, to=X   (10→2 = ×5)
 *   bonus  → multiplier = (fromUnits + toUnits) / fromUnits
 *            NSE says "BONUS A:B" (A new per B held) → from=B, to=A  (1:1 = ×2)
 */

import Papa from "papaparse";

export interface NseCorporateAction {
  symbol: string;
  type: "split" | "bonus" | "dividend";
  exDate: string; // ISO
  fromUnits: number | null;
  toUnits: number | null;
  dividendPerShare: number | null;
  /** The verbatim PURPOSE text — the user's means of checking our reading. */
  note: string;
}

export interface NseCaResult {
  rows: NseCorporateAction[];
  count: number;
  /** Purposes we deliberately did not translate, with occurrence counts. */
  skipped: Record<string, number>;
  warnings: string[];
}

const MONTHS: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

function toIso(raw: string): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/); // 04-Jul-2026 (NSE's format)
  if (m) {
    const mm = MONTHS[m[2].toUpperCase()];
    if (mm) return `${m[3]}-${mm}-${m[1].padStart(2, "0")}`;
  }
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

const num = (s: string): number => Number(s.replace(/,/g, ""));

/** Translate one PURPOSE string, or null when it isn't a split/bonus/dividend. */
export function parsePurpose(purpose: string): Pick<NseCorporateAction, "type" | "fromUnits" | "toUnits" | "dividendPerShare"> | null {
  const p = purpose.toUpperCase();

  // BONUS A:B — A new shares per B held.
  let m = p.match(/BONUS\s+(\d+)\s*:\s*(\d+)/);
  if (m) {
    const a = num(m[1]);
    const b = num(m[2]);
    if (a > 0 && b > 0) return { type: "bonus", fromUnits: b, toUnits: a, dividendPerShare: null };
  }

  // FACE VALUE SPLIT … FROM RS X … TO … RS Y (order is always old → new).
  if (/SPLIT|SUB-?DIVISION/.test(p)) {
    const fvs = [...p.matchAll(/R[SE]\.?\s*(\d+(?:\.\d+)?)/g)].map((x) => num(x[1]));
    if (fvs.length >= 2 && fvs[0] > 0 && fvs[1] > 0 && fvs[0] !== fvs[1]) {
      const [oldFv, newFv] = fvs;
      // A "split" to a LARGER face value is a consolidation; the multiplier
      // formula handles it the same way (to/from < 1).
      return { type: "split", fromUnits: newFv, toUnits: oldFv, dividendPerShare: null };
    }
    return null; // a split we couldn't read is worse than none — skip it
  }

  // DIVIDEND — RS N (interim/final/special; several segments may appear, and
  // each credits the holder on the same ex-date, so amounts sum).
  if (/DIVIDEND/.test(p)) {
    const amounts = [...p.matchAll(/R[SE]\.?\s*(\d+(?:\.\d+)?)/g)].map((x) => num(x[1]));
    const total = amounts.reduce((s, x) => s + x, 0);
    if (total > 0) return { type: "dividend", fromUnits: null, toUnits: null, dividendPerShare: total };
    return null;
  }

  return null;
}

export function parseNseCorporateActions(text: string): NseCaResult {
  const warnings: string[] = [];
  if (!text || !text.trim()) return { rows: [], count: 0, skipped: {}, warnings: ["Empty file."] };

  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.replace(/^﻿/, "").trim().toUpperCase(),
  });
  const data = parsed.data ?? [];
  if (data.length === 0) return { rows: [], count: 0, skipped: {}, warnings: ["No data rows."] };

  const headers = Object.keys(data[0]);
  const symKey = headers.find((h) => h === "SYMBOL");
  const purposeKey = headers.find((h) => h === "PURPOSE");
  const exKey = headers.find((h) => h.startsWith("EX-DATE") || h === "EX DATE" || h === "EXDATE");
  if (!symKey || !purposeKey || !exKey) {
    return {
      rows: [], count: 0, skipped: {},
      warnings: [`Not an NSE corporate-actions file. Expected SYMBOL / PURPOSE / EX-DATE — saw: ${headers.slice(0, 8).join(", ")}`],
    };
  }
  const seriesKey = headers.find((h) => h === "SERIES");

  const rows: NseCorporateAction[] = [];
  const skipped: Record<string, number> = {};
  const seen = new Set<string>();

  for (const r of data) {
    const symbol = (r[symKey] ?? "").trim().toUpperCase();
    const purpose = (r[purposeKey] ?? "").trim();
    const exDate = toIso(r[exKey] ?? "");
    if (!symbol || !purpose) continue;
    if (seriesKey && !["EQ", "BE", "BZ", ""].includes((r[seriesKey] ?? "").trim().toUpperCase())) continue;
    if (!exDate) {
      warnings.push(`${symbol}: unreadable ex-date "${r[exKey]}" — row skipped.`);
      continue;
    }
    const read = parsePurpose(purpose);
    if (!read) {
      // First word of the purpose is a good-enough bucket label for the recap.
      const kind = purpose.split(/[\s/-]+/)[0].toUpperCase() || "OTHER";
      skipped[kind] = (skipped[kind] ?? 0) + 1;
      continue;
    }
    // The file repeats a row per series — one event per symbol+date+purpose.
    const key = `${symbol}|${exDate}|${purpose}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ symbol, exDate, note: purpose, ...read });
  }

  if (rows.length === 0 && Object.keys(skipped).length === 0) {
    warnings.push("Parsed the file but found no splits, bonuses or dividends.");
  }
  return { rows, count: rows.length, skipped, warnings };
}
