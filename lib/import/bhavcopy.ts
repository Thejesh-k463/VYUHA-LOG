// IND-12 / P1.3 — NSE/BSE bhavcopy parser (PURE). Offline-first auto-MTM source:
// the user supplies the daily EOD bhavcopy CSV (free from NSE/BSE) and we extract
// SYMBOL → CLOSE. Handles the NSE cash bhavcopy, the new UDiFF full bhavcopy, and
// the BSE bhavcopy by auto-detecting columns. Derivative rows are skipped (this is
// the cash close = underlying spot); EQ series is preferred when a symbol repeats.

import Papa from "papaparse";

export type BhavcopyFormat = "nse-eq" | "nse-udiff" | "bse" | "generic";

export interface BhavcopyBar {
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
}

export interface BhavcopyResult {
  format: BhavcopyFormat;
  date: string | null; // ISO trade date if derivable
  prices: Record<string, number>; // SYMBOL (upper) → close
  bars: Record<string, BhavcopyBar>; // SYMBOL (upper) → OHLC + volume (P1.3 price_history)
  count: number;
  warnings: string[];
}

const SYMBOL_KEYS = ["SYMBOL", "TCKRSYMB", "SC_NAME", "TICKER", "SECURITY"];
const CLOSE_KEYS = ["CLOSE", "CLSPRIC", "CLOSE_PRICE", "CLOSE PRICE", "CLOSEPRICE"];
const OPEN_KEYS = ["OPEN", "OPNPRIC", "OPEN_PRICE", "OPN_PRIC", "OPENPRICE"];
const HIGH_KEYS = ["HIGH", "HGHPRIC", "HIGH_PRICE", "HIGHPRICE"];
const LOW_KEYS = ["LOW", "LWPRIC", "LOW_PRICE", "LOWPRICE"];
const VOL_KEYS = ["TOTTRDQTY", "TTL_TRD_QNTY", "TTLTRADGVOL", "VOLUME", "NO_OF_SHRS", "TRADED_QTY", "TTLTRFVAL"];
const SERIES_KEYS = ["SERIES", "SCTYSRS"];
const DATE_KEYS = ["TIMESTAMP", "TRADDT", "TRAD_DT", "DATE", "DATE1", "TDATDATE"];

const toNum = (v: unknown): number => {
  const x = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(x) ? x : NaN;
};

function pick(headers: string[], candidates: string[]): string | null {
  for (const c of candidates) if (headers.includes(c)) return c;
  return null;
}

const MONTHS: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

function toIsoDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); // 2026-06-28
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[- ]([A-Za-z]{3})[- ](\d{4})/); // 28-JUN-2026
  if (m) {
    const mm = MONTHS[m[2].toUpperCase()];
    if (mm) return `${m[3]}-${mm}-${m[1].padStart(2, "0")}`;
  }
  m = s.match(/^(\d{2})[/-](\d{2})[/-](\d{4})/); // 28/06/2026
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

export function parseBhavcopy(text: string): BhavcopyResult {
  const warnings: string[] = [];
  if (!text || !text.trim()) return { format: "generic", date: null, prices: {}, bars: {}, count: 0, warnings: ["Empty file."] };

  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.replace(/^﻿/, "").trim().toUpperCase(),
  });
  const rows = parsed.data ?? [];
  if (rows.length === 0) return { format: "generic", date: null, prices: {}, bars: {}, count: 0, warnings: ["No data rows."] };

  const headers = Object.keys(rows[0]);
  const symKey = pick(headers, SYMBOL_KEYS);
  const closeKey = pick(headers, CLOSE_KEYS);
  if (!symKey || !closeKey) {
    return {
      format: "generic",
      date: null,
      prices: {},
      bars: {},
      count: 0,
      warnings: [`Could not find symbol/close columns. Saw: ${headers.slice(0, 12).join(", ")}`],
    };
  }
  const seriesKey = pick(headers, SERIES_KEYS);
  const dateKey = pick(headers, DATE_KEYS);
  const openKey = pick(headers, OPEN_KEYS);
  const highKey = pick(headers, HIGH_KEYS);
  const lowKey = pick(headers, LOW_KEYS);
  const volKey = pick(headers, VOL_KEYS);
  const hasFinTp = headers.includes("FININSTRMTP");

  const format: BhavcopyFormat = headers.includes("TCKRSYMB")
    ? "nse-udiff"
    : headers.includes("SC_NAME") || headers.includes("SC_CODE")
      ? "bse"
      : headers.includes("SYMBOL")
        ? "nse-eq"
        : "generic";

  const prices: Record<string, number> = {};
  const bars: Record<string, BhavcopyBar> = {};
  const eqSyms = new Set<string>();
  let date: string | null = null;

  const optNum = (v: unknown): number | null => {
    const n = toNum(v);
    return Number.isFinite(n) ? n : null;
  };

  for (const r of rows) {
    const finTp = hasFinTp ? (r["FININSTRMTP"] ?? "").toUpperCase() : "";
    const series = seriesKey ? (r[seriesKey] ?? "").toUpperCase().trim() : "";
    // Skip derivative rows — bhavcopy cash close is the underlying spot.
    if (/FUT|OPT/.test(finTp) || /FUT|OPT/.test(series)) continue;

    const sym = (r[symKey] ?? "").trim().toUpperCase();
    const close = toNum(r[closeKey]);
    if (!sym || !Number.isFinite(close) || close <= 0) continue;

    const bar: BhavcopyBar = {
      open: openKey ? optNum(r[openKey]) : null,
      high: highKey ? optNum(r[highKey]) : null,
      low: lowKey ? optNum(r[lowKey]) : null,
      close,
      volume: volKey ? optNum(r[volKey]) : null,
    };

    const isEq = series === "EQ" || finTp === "STK" || finTp === "IDX" || (!series && !finTp);
    if (isEq) {
      prices[sym] = close;
      bars[sym] = bar;
      eqSyms.add(sym);
    } else if (!(sym in prices) && !eqSyms.has(sym)) {
      prices[sym] = close;
      bars[sym] = bar;
    }

    if (!date && dateKey) date = toIsoDate(r[dateKey]);
  }

  const count = Object.keys(prices).length;
  if (count === 0) warnings.push("Parsed the file but found no usable cash close prices.");
  return { format, date, prices, bars, count, warnings };
}
