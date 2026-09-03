/**
 * Instruments-master file parser (PURE).
 *
 * Feeds the Instruments screen from the files NSE actually publishes, instead
 * of asking the user to type a security master by hand:
 *
 * - the daily CM bhavcopy (UDiFF `BhavCopy_NSE_CM_*.csv` or the old
 *   `cmDDMMMYYYYbhav.csv`)   → SYMBOL, ISIN         (name in UDiFF only)
 * - the securities lists (`EQUITY_L.csv`, and NSE Emerge's `SME_EQUITY_L.csv`,
 *   which spells the same columns with underscores)  → SYMBOL, NAME, ISIN
 * - the F&O market-lots file (`fo_mktlots.csv`) → SYMBOL, LOT SIZE
 * - an index-constituent list (`ind_*_list.csv` from niftyindices.com)
 *                             → SYMBOL, NAME, ISIN, SECTOR (official Industry)
 *
 * SECTOR comes ONLY from constituent lists — the trading files (bhavcopy,
 * EQUITY_L, lots) carry no sector column and none is ever invented for them.
 * The result carries `fields` so the caller can merge-upsert exactly what the
 * file proved, and leave every other column untouched.
 */

import Papa from "papaparse";

export type InstrumentsFileFormat =
  | "bhavcopy"
  | "securities-list"
  | "fo-lots"
  | "index-constituents"
  | "unknown";

export interface InstrumentFileRow {
  symbol: string;
  name: string | null;
  isin: string | null;
  lotSize: number | null;
  /** Official NSE industry — present ONLY in index-constituent lists. */
  sector: string | null;
}

export interface InstrumentsFileResult {
  format: InstrumentsFileFormat;
  /** Which instrument columns this file actually supplies. */
  fields: ("name" | "isin" | "lotSize" | "sector")[];
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

/**
 * "ind_niftyIndiaRailwaysPSU_list.csv" → "Nifty India Railways PSU".
 * Null when the filename doesn't follow the standard constituent-list pattern
 * — an unrecognised name records no membership rather than a wrong one.
 * (scripts/build-nse-index-map.mjs carries the same logic for build time.)
 */
export function indexLabelFromFilename(fileName: string): string | null {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  if (!/^ind[_-].+\.csv$/i.test(base)) return null;
  let n = base
    .replace(/^ind[_-]/i, "")
    .replace(/[_-]?list\.csv$/i, "")
    .replace(/\.csv$/i, "")
    .replace(/^nifty[_-]?/i, "");
  n = n
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .trim();
  if (!n) return null;
  n = n
    .split(/\s+/)
    .map((w) => (/^(psu|nbfc|sfbs|mfis|ipo|ev|cpse|mnc|fmcg|it)$/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
  return "Nifty " + n;
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
      if (lot != null) out.push({ symbol, name: null, isin: null, lotSize: lot, sector: null });
    }
    return {
      format: "fo-lots",
      fields: ["lotSize"],
      rows: out,
      count: out.length,
      warnings: out.length ? [] : ["Recognised the F&O lots layout but found no lot sizes."],
    };
  }

  // ── Index constituents (ind_*_list.csv): COMPANY NAME, INDUSTRY, SYMBOL ──
  if (headers.includes("SYMBOL") && headers.includes("INDUSTRY") && headers.some((h) => h.includes("COMPANY"))) {
    const nameKey = headers.find((h) => h.includes("COMPANY"))!;
    const isinKey = headers.find((h) => h.includes("ISIN")) ?? null;
    const out: InstrumentFileRow[] = [];
    for (const r of rows) {
      const symbol = up(r["SYMBOL"]);
      if (!symbol) continue;
      out.push({
        symbol,
        name: clean(r[nameKey]) || null,
        isin: isinKey ? asIsin(r[isinKey]) : null,
        lotSize: null,
        sector: clean(r["INDUSTRY"]) || null,
      });
    }
    return {
      format: "index-constituents",
      fields: ["name", "isin", "sector"],
      rows: out,
      count: out.length,
      warnings: out.length ? [] : ["Recognised an index-constituent list but found no rows."],
    };
  }

  // ── Securities list (EQUITY_L.csv / SME_EQUITY_L.csv) ─────────────────────
  // NSE ships the two with DIFFERENT header spellings: the main board pads
  // with spaces ("NAME OF COMPANY", " ISIN NUMBER"), Emerge uses underscores
  // ("NAME_OF_COMPANY", "ISIN_NUMBER"). Until 2026-09-04 only the first was
  // matched, so every SME list parsed as "unrecognised".
  const nameKey = headers.find((h) => h === "NAME OF COMPANY" || h === "NAME_OF_COMPANY") ?? null;
  if (headers.includes("SYMBOL") && nameKey) {
    const isinKey = headers.find((h) => h.includes("ISIN")) ?? null;
    const seriesKey = headers.find((h) => h === "SERIES") ?? null;
    // ALLOW-list of cash-equity series. EQ/BE/BZ are the main board (normal,
    // trade-for-trade, surveillance); SM and ST are NSE Emerge's equivalents
    // (SM = SME normal, ST = SME trade-for-trade). ST was missing until
    // 2026-09-04, which silently dropped 118 of the 568 Emerge names (2026-09-04 list) — a
    // series absent from this list is not "filtered", it is LOST, so add
    // a new equity series here rather than widening the regex elsewhere.
    const EQUITY_SERIES = ["EQ", "BE", "BZ", "SM", "ST", ""];
    const out: InstrumentFileRow[] = [];
    for (const r of rows) {
      const symbol = up(r["SYMBOL"]);
      if (!symbol) continue;
      if (seriesKey && !EQUITY_SERIES.includes(up(r[seriesKey]))) continue;
      out.push({
        symbol,
        name: clean(r[nameKey]) || null,
        isin: isinKey ? asIsin(r[isinKey]) : null,
        lotSize: null,
        sector: null,
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
          sector: null,
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
