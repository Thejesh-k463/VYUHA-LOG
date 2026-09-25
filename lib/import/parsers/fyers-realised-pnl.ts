/**
 * Fyers **Realised P&L report** (`.csv`) — a REFERENCE source, not a book.
 * v4.6.0 W9, VERIFIED against one real owner export (2026-07-25 → 2026-08-25;
 * docs/BROKER_FORMATS.md § Fyers).
 *
 *   rows 0-5  the same identity preamble as the tradebook, title
 *             `Report Title,Realised P&L report`
 *   then      a TOTALS block of label/value rows: `Total turnover (ICAI)`,
 *             `Gross P&L`, `Transaction charges`, `IPFT`, `Stamp duty`, `GST`,
 *             `Brokerage`, `CTT`, `SEBI`, `STT`, `Total charges`
 *   blank
 *   then      `Symbol name,Symbol code,Segment,Gross P&L,Buy qty,Sell qty,
 *              Buy price,Sell price`, one row per contract, the symbol carrying
 *             an exchange prefix (`NSE:ALKEM26AUG5800CE`, `BSE:SENSEX…`)
 *
 * WHY IT EMITS NO TRADES — the `paytm-realised-pnl.ts` rule: this is Fyers'
 * own arithmetic over the executions the TRADEBOOK already carries, so
 * importing both would count them twice. Per-contract gross P&L equals the
 * tradebook's real fills to the paisa on 21 of 22 contracts (the 22nd was
 * bought before the window). What it states that Vyuha cannot derive travels
 * in `reference` (one `scrip` row per contract) and `reported` (the totals).
 *
 * THE CHARGES BLOCK DOES NOT RECONCILE with the tradebook of the same window
 * (Brokerage ₹2,700 exceeds ₹20 × the 98 fills the tradebook lists), while STT
 * (0.15% of sell premium) and SEBI do. It is carried AS STATED — a segment row
 * when every contract is in one segment, exactly as the Dhan Realised P&L's
 * segment rows are — and said so in a warning, never adjusted.
 *
 * Like the tradebook, the content never names Fyers: the claim needs the name
 * in the filename plus the title line.
 */

import Papa from "papaparse";
import { extractDate } from "../time-parse";
import { fyOfDate } from "@/lib/analytics/ais";
import type { ParseContext, ParsedFile, ReferenceRow } from "../types";
import { fyersHeaderIndex, fyersTitleIs } from "./fyers-tradebook";

export const FYERS_REALISED_SOURCE_ID = "fyers-realised-pnl";

export const FYERS_PNL_HEADER = [
  "Symbol name", "Symbol code", "Segment", "Gross P&L", "Buy qty", "Sell qty", "Buy price", "Sell price",
] as const;

/** Totals-block label → the canonical `reported` key. */
const TOTALS: Record<string, string> = {
  "total turnover (icai)": "turnover",
  "gross p&l": "grossPnl",
  "transaction charges": "exchangeTxn",
  ipft: "ipft",
  "stamp duty": "stampDuty",
  gst: "gst",
  brokerage: "brokerage",
  ctt: "ctt",
  sebi: "sebi",
  stt: "stt",
  "total charges": "totalCharges",
};

const toNum = (v: unknown): number => {
  const s = String(v ?? "").replace(/,/g, "").trim();
  if (!s || s === "-") return 0;
  const x = Number(s);
  return Number.isFinite(x) ? x : 0;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

function rowsOf(text: string): string[][] {
  return ((Papa.parse<string[]>(text, { skipEmptyLines: false }).data ?? []) as string[][])
    .map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? "").trim()) : []));
}

/** Detection: the broker's name in the filename AND Fyers' title line. */
export function detectFyersRealisedPnl(ctx: ParseContext): number {
  const text = ctx.text;
  if (text == null || !text) return 0;
  if (!/fyers/i.test(ctx.filename)) return 0;
  return fyersTitleIs(text, "Realised P&L report") ? 0.95 : 0;
}

/** `From 25/07/2026 to 25/08/2026` → both ends as ISO dates. */
function periodOf(rows: string[][]): { from: string | null; to: string | null } {
  const r = rows.find((x) => (x[0] ?? "").toLowerCase() === "date range");
  const m = (r?.[1] ?? "").match(/from\s+(\S+)\s+to\s+(\S+)/i);
  return { from: extractDate(m?.[1] ?? null), to: extractDate(m?.[2] ?? null) };
}

/** `NSE:ALKEM26AUG5800CE` → exchange NSE, symbol ALKEM26AUG5800CE. */
function splitPrefix(label: string): { exchange: string | null; symbol: string } {
  const m = label.match(/^([A-Z]{2,4}):(.+)$/i);
  return m ? { exchange: m[1].toUpperCase(), symbol: m[2].trim().toUpperCase() } : { exchange: null, symbol: label.trim().toUpperCase() };
}

export function parseFyersRealisedPnl(ctx: ParseContext): ParsedFile {
  const base = { sourceId: FYERS_REALISED_SOURCE_ID, broker: "fyers" as const, format: "reference", trades: [] };
  const rows = rowsOf(ctx.text ?? "");
  const h = fyersHeaderIndex(rows, FYERS_PNL_HEADER);
  const warnings: string[] = [];

  // ── The totals block, above the table ────────────────────────────────────
  const reported: Record<string, number> = {};
  for (const r of rows.slice(0, h < 0 ? rows.length : h)) {
    const key = TOTALS[(r[0] ?? "").toLowerCase()];
    if (key) reported[key] = toNum(r[1]);
  }

  if (h < 0) {
    return { ...base, reported: Object.keys(reported).length ? reported : undefined, warnings: ["Could not find the Fyers Realised P&L table (Symbol name, Symbol code, Segment, Gross P&L, …) — is this a Fyers Realised P&L report?"] };
  }

  const { from, to } = periodOf(rows);
  // The FY the figures belong to, only when the WHOLE period sits inside one
  // (invariant 6: a figure filed under a year the file does not state is a
  // fabricated denominator with a date on it).
  const fy = from && to && fyOfDate(from) === fyOfDate(to) ? fyOfDate(to) : null;

  const reference: ReferenceRow[] = [];
  const segments = new Set<string>();
  let sourceRows = 0;
  let sumGross = 0;
  for (const r of rows.slice(h + 1)) {
    const label = (r[0] ?? "").trim();
    if (!label) continue;
    const { exchange, symbol } = splitPrefix(label);
    sourceRows++;
    segments.add((r[2] ?? "").trim().toLowerCase());
    const grossPnl = r2(toNum(r[3]));
    sumGross += grossPnl;
    reference.push({
      scope: "scrip",
      key: symbol,
      isin: null,
      symbol,
      fy,
      asOf: to,
      figures: {
        grossPnl,
        buyQty: toNum(r[4]),
        sellQty: toNum(r[5]),
        buyPrice: toNum(r[6]),
        sellPrice: toNum(r[7]),
      },
      note: exchange ? `Fyers Realised P&L, ${exchange}:${symbol}` : "Fyers Realised P&L",
    });
  }

  // ── The totals as ONE segment row, when the table is one segment ─────────
  // The Dhan Realised P&L precedent: statement-level charges live on a
  // `segment` row, where the reconciliation compares them with the book's own
  // family. With contracts in two segments the block cannot be attributed to
  // either, so it stays in `reported` only.
  const onlyDerivatives = segments.size === 1 && segments.has("derivatives");
  if (onlyDerivatives && Object.keys(reported).length > 0) {
    const figures: Record<string, number> = {};
    for (const k of ["grossPnl", "brokerage", "exchangeTxn", "sebi", "gst", "stt", "ctt", "stampDuty", "ipft", "totalCharges"]) {
      if (reported[k] != null) figures[k] = r2(reported[k]);
    }
    reference.push({ scope: "segment", key: "fno", isin: null, symbol: null, fy, asOf: to, figures, note: "Fyers Realised P&L totals block" });
  } else if (Object.keys(reported).length > 0) {
    warnings.push("The table spans more than one segment, so the totals block is kept as the file's figures and not attributed to any one segment.");
  }

  if (reported.grossPnl != null && Math.abs(r2(sumGross) - r2(reported.grossPnl)) > 0.005) {
    warnings.push(`The contract rows sum to ₹${r2(sumGross).toFixed(2)} but the file's own Gross P&L says ₹${r2(reported.grossPnl).toFixed(2)} — some rows were not read as this parser expects.`);
  }
  if (!fy) {
    warnings.push("This report's period is missing or spans two financial years, so its figures are stored without a financial year.");
  }
  warnings.push(
    "The charges block is stored exactly as Fyers states it. On the one real export examined it did NOT agree with the tradebook of the same window (its Brokerage exceeds ₹20 for every fill the tradebook lists) — compare it with your contract notes before relying on it.",
  );
  warnings.push(
    `${reference.filter((x) => x.scope === "scrip").length} contract figures were read as the BROKER'S OWN numbers. They are stored beside your journal for reconciliation and import no trades — the book stays the Fyers tradebook.`,
  );

  return { ...base, reported, reference, sourceRows, warnings };
}
