/**
 * Dhan **Realised P&L Report** (`realized_pnl-report.xls`) — the golden book.
 *
 * Verified on two real exports 2026-09-04. One sheet, `Realised P&L Report`,
 * ~160–1,000 merged ranges, and the ONLY Dhan file that states charges PER
 * SEGMENT with every head broken out:
 *
 *   row 8   `Segment | Buy Value | Sell Value | Gross P&L | Brokerage |
 *            Exch. Charges | SEBI Fees | GST | STT | Stamp Duty |
 *            Other Charges | Total Charges | Net P&L`
 *   rows 9+ `Equity` / `Futures and Options` / `Commodities` / `Currency`
 *
 * then one detail block per segment, each introduced by a title cell
 * (`Equity Segment`, `F&O Segment`, `Commodities Segment`, `Currency Segment`)
 * and its own header
 *
 *   `Sr. | Security Name | ISIN | Qty. | Avg. Buy Price | Buy Value |
 *    Avg. Sell Price | Sell Value | Realised P&L | Realised P&L%`
 *
 * Blocks are found by their TITLE and HEADER TEXT, never by row number — the
 * equity block ran 19 rows on one account and 157 on the other. Every money
 * cell is TEXT with thousands separators and a trailing space (` 1,170,466.04 `);
 * a bare `-` (or ` -   `) means blank; F&O rows carry `-` for ISIN; a stray
 * `Generated on dd-mm-yyyy` cell sits inside the equity data (column P of the
 * 19th row on both files). There are NO dates and NO product column, which is
 * exactly the P&L CSV's honesty rule: equity rows default to delivery and are
 * re-tagged in Trades.
 *
 * The broker never writes the word "Dhan" into this file. Its legal name does
 * appear — `Raise Securities Private Limited (formerly known as Moneylicious
 * Securities Private Limited)` in the footer — and that is the in-content
 * fingerprint, the same way Upstox is recognised by its legal-entity banner.
 */

import * as XLSX from "xlsx";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { Exchange } from "@/lib/domain/constants";
import type { ParseContext, ParsedFile } from "../types";

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z&%]/g, "");

/**
 * Text money → number. ` 1,23,456.78 ` → 123456.78 (Indian or Western
 * grouping — the commas are simply removed), `-` / ` -   ` / `` → 0,
 * `(1,234.00)` → -1234. Anything unreadable is 0, never NaN.
 */
export function parseTextMoney(v: unknown): number {
  const s = String(v ?? "").replace(/[₹,\s]/g, "");
  if (!s || s === "-") return 0;
  const neg = /^\(.*\)$/.test(s);
  const x = Number(s.replace(/[()]/g, ""));
  if (!Number.isFinite(x)) return 0;
  return neg ? -x : x;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function isSummaryHeader(r: string[]): boolean {
  const c = r.map(norm);
  return c[0] === "segment" && c.includes("grossp&l") && c.includes("netp&l") && c.includes("totalcharges");
}

function isDetailHeader(r: string[]): boolean {
  const c = r.map(norm);
  return c[0] === "sr" && c.includes("securityname") && c.includes("realisedp&l");
}

/** The P&L CSV/XLSX table header — the sibling this parser must never claim. */
function isPnlTableHeader(r: string[]): boolean {
  const c = r.map(norm);
  return c[0] === "scripname" && c.includes("buyqty") && c.includes("realisedp&l");
}

const DHAN_MARKER = /\bdhan\b|raise securities|moneylicious/i;

function sheets(ctx: ParseContext): { name: string; rows: string[][] }[] {
  if (!ctx.buffer || !/\.xlsx?$/i.test(ctx.filename)) return [];
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(ctx.buffer, { type: "buffer" });
  } catch {
    return [];
  }
  return wb.SheetNames.map((name) => ({
    name,
    rows: (XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name]!, { header: 1, raw: false, defval: "" }) as unknown[][]).map(
      (r) => r.map((c) => String(c ?? "")),
    ),
  }));
}

/** Where the workbook names its broker: a sheet name, or any cell. */
function hasDhanMarker(name: string, rows: string[][]): boolean {
  if (DHAN_MARKER.test(name)) return true;
  return rows.some((r) => r.some((c) => DHAN_MARKER.test(c)));
}

/**
 * Detection. The segment-summary header is the format fingerprint; the
 * broker's name (legal or trading) in the content is the identity. Both are
 * required for the 0.9 claim. A CSV of any kind is never this file, and the
 * P&L CSV/XLSX table header without a segment summary is the sibling parser's.
 */
export function detectDhanRealisedPnl(ctx: ParseContext): number {
  if (ctx.text != null) return 0;
  for (const { name, rows } of sheets(ctx)) {
    const summaryAt = rows.findIndex(isSummaryHeader);
    if (summaryAt < 0) {
      if (rows.some(isPnlTableHeader)) return 0;
      continue;
    }
    if (!hasDhanMarker(name, rows)) return 0;
    let score = 0.9;
    if (rows.slice(0, summaryAt).some((r) => r.some((c) => /realised profit and loss report/i.test(c)))) score += 0.05;
    if (/realised|realized/i.test(ctx.filename)) score += 0.05;
    return Math.min(1, score);
  }
  return 0;
}

const SUMMARY_FIELDS: Record<string, string> = {
  buyvalue: "buyValue",
  sellvalue: "sellValue",
  "grossp&l": "grossPnl",
  brokerage: "brokerage",
  exchcharges: "exchangeTxn",
  sebifees: "sebi",
  gst: "gst",
  stt: "stt",
  stampduty: "stamp",
  othercharges: "otherCharges",
  totalcharges: "totalCharges",
  "netp&l": "netPnl",
};

/** Summary-row label → reported-key prefix. */
function segmentKey(label: string): string | null {
  const l = label.toLowerCase();
  if (l.startsWith("equity")) return "equity";
  if (l.startsWith("futures") || l.startsWith("f&o")) return "fno";
  if (l.startsWith("commodit")) return "commodity";
  if (l.startsWith("currency")) return "currency";
  return null;
}

interface BlockKind {
  key: string;
  /** Vyuha has no currency segment; those rows are counted and skipped. */
  supported: boolean;
  exchangeHint: Exchange | null;
}

function blockKind(title: string): BlockKind | null {
  const key = segmentKey(title);
  if (!key) return null;
  if (key === "currency") return { key, supported: false, exchangeHint: null };
  if (key === "commodity") return { key, supported: true, exchangeHint: "MCX" };
  return { key, supported: true, exchangeHint: null };
}

export function parseDhanRealisedPnl(ctx: ParseContext): ParsedFile {
  const empty = (why: string): ParsedFile => ({
    sourceId: "dhan-realised-pnl", broker: "dhan", format: "pnl", trades: [], warnings: [why],
  });
  const sheet = sheets(ctx).find((s) => s.rows.some(isSummaryHeader));
  if (!sheet) return empty("Could not find the segment summary (Segment | Buy Value | … | Net P&L) — is this a Dhan Realised P&L report?");
  const rows = sheet.rows;
  const warnings: string[] = [];

  // ── Segment summary → reported, per segment and in total ──────────────────
  const reported: Record<string, number> = {};
  const summaryAt = rows.findIndex(isSummaryHeader);
  const sHeader = rows[summaryAt].map(norm);
  const sCol = (k: string) => sHeader.indexOf(k);
  for (let i = summaryAt + 1; i < rows.length; i++) {
    const r = rows[i];
    const label = (r[0] ?? "").trim();
    if (!label) break; // blank row ends the summary
    if (/segment$/i.test(label)) break; // a detail-block title
    const key = segmentKey(label);
    if (!key) continue;
    for (const [h, field] of Object.entries(SUMMARY_FIELDS)) {
      const c = sCol(h);
      if (c < 0) continue;
      const v = r2(parseTextMoney(r[c]));
      reported[`${key}.${field}`] = v;
      reported[field] = r2((reported[field] ?? 0) + v);
    }
  }

  // ── Detail blocks → trades ────────────────────────────────────────────────
  const trades: NormalizedTrade[] = [];
  let sourceRows = 0;
  let skippedCurrency = 0;
  const seenBlocks: string[] = [];
  for (let i = 0; i + 1 < rows.length; i++) {
    const title = (rows[i][0] ?? "").trim();
    if (!/\bsegment$/i.test(title) || !isDetailHeader(rows[i + 1])) continue;
    const kind = blockKind(title);
    if (!kind) {
      warnings.push(`Unrecognised block "${title}" was skipped.`);
      continue;
    }
    seenBlocks.push(title);
    const h = rows[i + 1].map(norm);
    const col = (k: string) => h.indexOf(k);
    const cSr = col("sr"), cName = col("securityname"), cIsin = col("isin"), cQty = col("qty");
    const cBuyAvg = col("avgbuyprice"), cBuyVal = col("buyvalue"), cSellAvg = col("avgsellprice");
    const cSellVal = col("sellvalue"), cPnl = col("realisedp&l");
    for (let j = i + 2; j < rows.length; j++) {
      const r = rows[j];
      const sr = (r[cSr] ?? "").trim();
      const name = (r[cName] ?? "").trim();
      if (!/^\d+$/.test(sr) || !name) break;
      sourceRows++;
      if (!kind.supported) {
        skippedCurrency++;
        continue;
      }
      const qty = parseTextMoney(r[cQty]);
      const buyValue = parseTextMoney(r[cBuyVal]);
      const sellValue = parseTextMoney(r[cSellVal]);
      const isin = (r[cIsin] ?? "").trim();
      trades.push({
        broker: "dhan",
        tradingsymbol: name,
        isin: /^[A-Z]{2}[A-Z0-9]{10}$/.test(isin) ? isin : null,
        buyQty: qty,
        avgBuyPrice: parseTextMoney(r[cBuyAvg]) || (qty ? buyValue / qty : 0),
        buyValue,
        sellQty: qty,
        avgSellPrice: parseTextMoney(r[cSellAvg]) || (qty ? sellValue / qty : 0),
        sellValue,
        closingPrice: null,
        grossPnl: cPnl >= 0 ? parseTextMoney(r[cPnl]) : r2(sellValue - buyValue),
        unrealisedPnl: 0,
        buyDate: null,
        sellDate: null,
        productHint: null, // no product column → equity defaults to delivery
        exchangeHint: kind.exchangeHint,
        sourceFile: ctx.filename,
        importNotes: [`Dhan Realised P&L report, ${title}`],
      });
    }
    i += 1;
  }

  if (seenBlocks.length === 0) warnings.push("Segment summary found, but no per-segment detail block followed it.");
  if (skippedCurrency > 0) {
    warnings.push(`${skippedCurrency} Currency-segment row${skippedCurrency === 1 ? "" : "s"} skipped — Vyuha has no currency segment; the segment's charges are still in the reported totals.`);
  }
  warnings.push(
    "Dhan Realised P&L has no per-trade dates and no product column — equity rows default to delivery; re-tag MTF/intraday in Trades. Realised rows are closed lots (buy qty = sell qty).",
  );
  warnings.push(
    "Import EITHER the Global Transaction Report OR this report for a window, never both — they describe the same trades and would double-count.",
  );

  return {
    sourceId: "dhan-realised-pnl",
    broker: "dhan",
    format: "pnl",
    trades,
    reported: Object.keys(reported).length ? reported : undefined,
    sourceRows,
    warnings,
  };
}
