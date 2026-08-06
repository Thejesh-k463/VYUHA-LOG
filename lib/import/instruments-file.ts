/**
 * Instruments-master file parser (PURE).
 *
 * Feeds the Instruments screen from the files NSE actually publishes, instead
 * of asking the user to type a security master by hand:
 *
 * - the daily CM bhavcopy (UDiFF `BhavCopy_NSE_CM_*.csv` or the old
 *   `cmDDMMMYYYYbhav.csv`)   → SYMBOL, ISIN         (name in UDiFF only)
 * - the securities list (`EQUITY_L.csv`)  → SYMBOL, NAME, ISIN
 * - the F&O market-lots file (`fo_mktlots.csv`) → SYMBOL, LOT SIZE
 *
 * What these files deliberately do NOT supply: SECTOR. NSE publishes no
 * sector column in any of them, and inventing one would break the
 * "never fabricate" rule — sector tagging stays a manual (or bulk-paste) act.
 * The result carries `fields` so the caller can merge-upsert exactly what the
 * file proved, and leave every other column untouched.
 */

import Papa from "papaparse";

export type InstrumentsFileFormat = "bhavcopy" | "securities-list" | "fo-lots" | "unknown";

export interface InstrumentFileRow {
  symbol: string;
  name: string | null;
  isin: string | null;
  lotSize: number | null;
}

export interface InstrumentsFileResult {
  format: InstrumentsFileFormat;
  /** Which instrument columns this file actually supplies. */
  fields: ("name" | "isin" | "lotSize")[];
  rows: InstrumentFileRow[];
  count: number;
  warnings: string[];
}

const clean = (v: unknown) => String(v ?? "").trim();
const up = (v: unknown) => clean(v).toUpperCase();

/** ISINs are 12 chars, IN-prefixed for Indian listings. Reject junk cells. */
const asIsin = (v: unknown): string | null => {
  const s = up(v);
  return /^[A-Z]{2}[A-Z0-9]{10}$/.test(s) ? s : null;
};

function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    // NSE files pad headers with spaces (" ISIN NUMBER") and ship BOMs.
    transformHeader: (h) => h.replace(/^﻿/, "").trim().toUpperCase(),
  });
  const rows = parsed.data ?? [];
  return { headers: rows.length ? Object.keys(rows[0]) : [], rows };
}

export function parseInstrumentsFile(text: string): InstrumentsFileResult {
  const empty = (w: string): InstrumentsFileResult => ({
    format: "unknown", fields: [], rows: [], count: 0, warnings: [w],
  });
  if (!text || !text.trim()) return empty("Empty file.");

  const { headers, rows } = parseCsv(text);
  if (rows.length === 0) return empty("No data rows.");

  // ── F&O market lots: UNDERLYING, SYMBOL, <month>, <month>, … ─────────────
  const monthCols = headers.filter((h) => /^[A-Z]{3}[- ]?\d{2,4}$/.test(h));
  if (headers.includes("SYMBOL") && monthCols.length >= 1 && headers.includes("UNDERLYING")) {
    const out: InstrumentFileRow[] = [];
    for (const r of rows) {
      const symbol = up(r["SYMBOL"]);
      // The file interleaves section headings ("Derivatives on …") as rows.
      if (!symbol || /DERIVATIVE|UNDERLYING|SYMBOL/.test(symbol)) continue;
      // Nearest expiry first; later months exist for lot-revision windows.
      let lot: number | null = null;
      for (const c of monthCols) {
        const n = Number(clean(r[c]).replace(/,/g, ""));
        if (Number.isFinite(n) && n > 0) { lot = n; break; }
      }
      if (lot != null) out.push({ symbol, name: null, isin: null, lotSize: lot });
    }
    return {
      format: "fo-lots",
      fields: ["lotSize"],
      rows: out,
      count: out.length,
      warnings: out.length ? [] : ["Recognised the F&O lots layout but found no lot sizes."],
    };
  }

  // ── Securities list (EQUITY_L.csv): SYMBOL, NAME OF COMPANY, ISIN NUMBER ─
  if (headers.includes("SYMBOL") && headers.includes("NAME OF COMPANY")) {
    const isinKey = headers.find((h) => h.includes("ISIN")) ?? null;
    const seriesKey = headers.find((h) => h === "SERIES") ?? null;
    const out: InstrumentFileRow[] = [];
    for (const r of rows) {
      const symbol = up(r["SYMBOL"]);
      if (!symbol) continue;
      if (seriesKey && !["EQ", "BE", "BZ", "SM", ""].includes(up(r[seriesKey]))) continue;
      out.push({
        symbol,
        name: clean(r["NAME OF COMPANY"]) || null,
        isin: isinKey ? asIsin(r[isinKey]) : null,
        lotSize: null,
      });
    }
    return {
      format: "securities-list",
      fields: ["name", "isin"],
      rows: out,
      count: out.length,
      warnings: out.length ? [] : ["Recognised the securities-list layout but found no rows."],
    };
  }

  // ── Bhavcopy (UDiFF or old EQ): symbol + ISIN, name only in UDiFF ────────
  const symKey = headers.includes("TCKRSYMB") ? "TCKRSYMB" : headers.includes("SYMBOL") ? "SYMBOL" : null;
  const isinKey = headers.find((h) => h === "ISIN") ?? null;
  if (symKey && isinKey) {
    const nameKey = headers.find((h) => h === "FININSTRMNM") ?? null;
    const seriesKey = headers.find((h) => h === "SCTYSRS" || h === "SERIES") ?? null;
    const finTpKey = headers.includes("FININSTRMTP") ? "FININSTRMTP" : null;
    const out = new Map<string, InstrumentFileRow>();
    for (const r of rows) {
      const series = seriesKey ? up(r[seriesKey]) : "";
      const finTp = finTpKey ? up(r[finTpKey]) : "";
      // Cash instruments only — the FO bhavcopy repeats symbols per contract.
      if (/FUT|OPT/.test(series) || /FUT|OPT/.test(finTp)) continue;
      const symbol = up(r[symKey]);
      const isin = asIsin(r[isinKey]);
      if (!symbol || !isin) continue;
      // Prefer the EQ series row when a symbol repeats across series.
      if (!out.has(symbol) || series === "EQ") {
        out.set(symbol, {
          symbol,
          name: nameKey ? clean(r[nameKey]) || null : null,
          isin,
          lotSize: null,
        });
      }
    }
    const rowsOut = [...out.values()];
    return {
      format: "bhavcopy",
      fields: rowsOut.some((r) => r.name) ? ["name", "isin"] : ["isin"],
      rows: rowsOut,
      count: rowsOut.length,
      warnings: rowsOut.length ? [] : ["Recognised a bhavcopy but found no usable cash rows."],
    };
  }

  return empty(
    `Unrecognised file. Expected an NSE bhavcopy, EQUITY_L.csv, or fo_mktlots.csv — saw columns: ${headers.slice(0, 10).join(", ")}`,
  );
}
