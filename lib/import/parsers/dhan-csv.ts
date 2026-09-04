import Papa from "papaparse";
import * as XLSX from "xlsx";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParseContext, ParsedFile } from "../types";
import { workbookOf } from "../types";
import { isDhanDividendText, isDhanGtrText, isDhanLedgerText } from "./dhan-ledger";

const toNum = (v: unknown): number => {
  if (v == null) return 0;
  const x = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(x) ? x : 0;
};

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z&%]/g, "");

/** The scrip table header — identical in the CSV and the XLSX (verified on
 *  two real `.xlsx` exports, 2026-09-04): `Scrip Name | Buy Qty. | Avg. Buy
 *  Price | Buy Value | Sell Qty. | Avg. Sell Price | Sell Value | Closing
 *  Price | Realised P&L | Realised P&L % | Unrealised P&L | Unrealised P&L %`. */
function isPnlHeaderRow(r: string[]): boolean {
  const c = r.map(norm);
  return c[0] === "scripname" && c.includes("buyqty") && c.includes("realisedp&l");
}

/** The Realised P&L report's segment-summary header. Its detail blocks never
 *  start with `Scrip Name`, but the stand-down is explicit anyway: two Dhan
 *  workbooks that both say "Realised P&L" must not be told apart by luck. */
function isRealisedSummaryRow(r: string[]): boolean {
  const c = r.map(norm);
  return c[0] === "segment" && c.includes("grossp&l") && c.includes("netp&l") && c.includes("totalcharges");
}

const FOOTER_LABELS: Record<string, keyof NonNullable<ParsedFile["reported"]>> = {
  "net p&l": "netPnl",
  brokerage: "brokerage",
  "gross p&l": "grossPnl",
  "total charges": "totalCharges",
};

/** The workbook's P&L sheet, or null. The sheet NAME is the Dhan marker —
 *  `Dhan_P&L` on both real exports — so a P&L table with the same twelve
 *  columns in a workbook that names no broker is not claimed. */
function dhanSheet(ctx: ParseContext): string[][] | null {
  if (!ctx.buffer || !/\.xlsx?$/i.test(ctx.filename)) return null;
  let wb: XLSX.WorkBook;
  try {
    wb = workbookOf(ctx);
  } catch {
    return null;
  }
  const name = wb.SheetNames.find((n) => /dhan/i.test(n));
  if (!name) return null;
  const ws = wb.Sheets[name];
  if (!ws) return null;
  return (XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "" }) as unknown[][]).map((r) =>
    r.map((c) => String(c ?? "")),
  );
}

/** Where a Dhan CSV names its broker — the trading name, or either legal name.
 *  Mirrors `DHAN_MARKER` in `dhan-realised-pnl.ts`, deliberately: two parsers
 *  for the same broker must recognise the same identity. */
const DHAN_MARKER = /\bdhan\b|raise securities|moneylicious/i;

/** Confidence this is a Dhan P&L export — the CSV, or its `.xlsx` twin. */
export function detectDhanCsv(ctx: ParseContext): number {
  const text = ctx.text ?? "";
  if (text) {
    // A Global Transaction Report is also a Dhan CSV with the same footer, but a
    // different and much richer body. Stand down explicitly rather than relying
    // on the other parser simply scoring higher. The ledger and the dividend
    // payout report are Dhan CSVs too, with a `Scrip Name` column of their own —
    // and until 2026-09-04 this detector claimed both at 0.30 on the word
    // "dhan" in the FILENAME. They have their own sources now; zero here.
    if (isDhanGtrText(text) || isDhanLedgerText(text) || isDhanDividendText(text)) return 0;
    let score = 0;
    if (/dhan/i.test(ctx.filename)) score += 0.3;
    // IDENTITY BEFORE SHAPE (AGENTS.md). Until 2026-09-04 the shape rule was
    // `/Scrip Name,.*Realised P&L/i` — a substring match with no word boundary
    // and no column anchoring, so Angel One's tax-P&L header line
    // (`…,Scrip Name,…,Short term Unrealised P&L`) scored 0.4 with no broker
    // named anywhere, beating the generic mapper's 0.05. Nothing above the
    // FILENAME bonus is awarded now unless the content names Dhan (trading or
    // legal name) or carries Dhan's own `PnL report` title line — the same gate
    // `detectDhanRealisedPnl` applies to the workbook.
    const titled = /^PnL report/i.test(text.trimStart());
    if (!titled && !DHAN_MARKER.test(text)) return Math.min(1, score);
    if (titled) score += 0.4;
    // The header as COLUMNS, not as a substring: `Scrip Name` must be column 0
    // and `Realised P&L` a whole cell of its own — `Unrealised P&L` is not it.
    const rows = (Papa.parse<string[]>(text, { skipEmptyLines: true }).data ?? []) as string[][];
    if (rows.some((r) => Array.isArray(r) && isPnlHeaderRow(r))) score += 0.4;
    if (/Net P&L,.*Brokerage,.*Gross P&L,.*Total Charges/i.test(text)) score += 0.2;
    return Math.min(1, score);
  }

  // XLSX variant (verified 2026-09-04): sheet `Dhan_P&L`, `PnL report | From …`
  // in B2, the identical header on row 6, then the footer as four label/value
  // ROWS (`Net P&L`, `Brokerage`, `Gross P&L`, `Total Charges`) instead of the
  // CSV's single eight-cell line. The fingerprint is the sheet name — content,
  // not filename.
  const rows = dhanSheet(ctx);
  if (!rows) return 0;
  if (rows.some(isRealisedSummaryRow)) return 0;
  const hdr = rows.findIndex(isPnlHeaderRow);
  if (hdr < 0) return 0;
  let score = 0.9;
  if (rows.slice(0, hdr).some((r) => r.some((c) => /^PnL report/i.test(c.trim())))) score += 0.05;
  if (rows.some((r) => /^net p&l$/i.test((r[0] ?? "").trim()))) score += 0.05;
  return Math.min(1, score);
}

/**
 * Dhan P&L CSV: 5-row identity header, blank line, scrip-aggregated table, then a
 * footer `Net P&L,.,Brokerage,.,Gross P&L,.,Total Charges,.`.
 * Row P&L is GROSS. No per-trade dates, no segment tag, no per-scrip charges.
 * Rows with Sell Qty = 0 are open positions (use Closing Price for MTM).
 *
 * The `.xlsx` export is the same table on sheet `Dhan_P&L`; only the footer's
 * shape differs, so both are read by the same loop. F&O rows are named
 * `OPT …` / `FUT …` among the equity rows with no tag of their own — the
 * classifier reads the name, exactly as it does for the CSV.
 */
export function parseDhanCsv(ctx: ParseContext): ParsedFile {
  const text = ctx.text ?? "";
  const rows: string[][] = text
    ? (Papa.parse<string[]>(text, { skipEmptyLines: false }).data ?? [])
    : dhanSheet(ctx) ?? [];
  const warnings: string[] = [];

  const hdr = rows.findIndex((r) => (r[0] ?? "").trim() === "Scrip Name");
  if (hdr < 0) {
    return {
      sourceId: "dhan-csv",
      broker: "dhan",
      format: "pnl",
      trades: [],
      warnings: ["Could not find the 'Scrip Name' header row — is this a Dhan P&L export?"],
    };
  }

  const trades: NormalizedTrade[] = [];
  let reported: Record<string, number> | undefined;

  for (let i = hdr + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[0]) continue;
    const label = r[0].trim().toLowerCase();
    if (label in FOOTER_LABELS) {
      // CSV: one row of label/value pairs. XLSX: one pair per row. Reading the
      // row AS pairs serves both without knowing which it is.
      reported ??= {};
      for (let k = 0; k + 1 < r.length; k += 2) {
        const key = FOOTER_LABELS[r[k].trim().toLowerCase()];
        if (key) reported[key] = toNum(r[k + 1]);
      }
      continue;
    }
    if (r[0].startsWith("NOTE")) continue;
    if (r.length < 12) continue;

    trades.push({
      broker: "dhan",
      tradingsymbol: r[0].trim(),
      isin: null,
      buyQty: toNum(r[1]),
      avgBuyPrice: toNum(r[2]),
      buyValue: toNum(r[3]),
      sellQty: toNum(r[4]),
      avgSellPrice: toNum(r[5]),
      sellValue: toNum(r[6]),
      closingPrice: toNum(r[7]) || null,
      grossPnl: toNum(r[8]),
      unrealisedPnl: toNum(r[10]),
      buyDate: null,
      sellDate: null,
      productHint: null, // Dhan P&L carries no segment tag → equity defaults to delivery
      exchangeHint: null,
      sourceFile: ctx.filename,
    });
  }

  warnings.push(
    "Dhan P&L has no segment/MTF flag or per-trade dates — equity rows default to delivery; re-tag MTF/intraday in Trades.",
  );

  return { sourceId: "dhan-csv", broker: "dhan", format: "pnl", trades, reported, warnings };
}
