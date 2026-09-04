/**
 * Dhan **DP Charges** report (`dp-charges.xls`) — the depository fees that
 * appear in NO other Dhan export.
 *
 * ZERO DB and ZERO React imports; pure functions over plain data.
 *
 * ── Verified on two real exports, 2026-09-04 ──────────────────────────────
 *
 * One sheet, `DP Charges`. Row 1 carries the report title in a single cell —
 * `DP Charges | From 01-April-2026 to 03-September-2026` — beside the account
 * identity labels. Row 5 is the header
 *
 *   `Sr. | Date | ISIN | Security Name | … | Quantity | Buy/Sell |
 *    Type of Transaction | | Charges`
 *
 * (columns 0,1,2,3,9,10,11,13 — the gaps are the workbook's merge padding),
 * then one row per debit, then `Total <amount>` and a
 * `This is a system generated report …` / `Generated on dd-mm-yyyy` footer.
 * Account 1: 173 data rows, Total 2492.5. Account 2: 94 rows, Total 1325.0.
 * Both files sum to their own Total to the paisa.
 *
 * ── The named exception to the broker-name rule ───────────────────────────
 *
 * AGENTS.md: "A broker-named parser must see the broker's NAME before it
 * claims a file." This file names NO broker — not "Dhan", not the legal
 * entity, nowhere in any cell or sheet name. The owner ruled (2026-09-04)
 * that the FORMAT itself is the fingerprint here, and it is a narrow one:
 * the sheet must be called `DP Charges`, the title cell must say `DP Charges`
 * and the header must be that exact eight-column set. Nothing else Vyuha has
 * ever seen looks like that, and unlike a tradebook this shape is not generic
 * — no other broker's export in `tests/fixtures/redacted/` comes close. The
 * word "dhan" in the filename is worth a further 0.1, so a file that both
 * looks and is named right wins outright; a file that merely looks right is
 * still claimed, because the alternative is the column mapper asking the user
 * to hand-map a DP charge sheet it cannot book as a trade anyway.
 *
 * ── The merges ────────────────────────────────────────────────────────────
 *
 * The sheet carries 352 merged ranges (194 on account 2) and every one of them
 * is cosmetic: `Security Name` spans columns 3-8, `Type of Transaction` spans
 * 11-12, the footer signature spans 0-4, and the ONLY merge that touches the
 * Charges column (13) is the title row's 11-13 on row 1. No data row loses its
 * Charges cell to a merge, which is asserted rather than assumed —
 * `chargeCellsCoveredByMerge()` reports any data row whose Charges cell is
 * inside a merged range, and the parser warns instead of silently reading 0.
 *
 * ── What it emits ─────────────────────────────────────────────────────────
 *
 * BOTH, because the file is two things at once:
 *   • ledger rows (`LedgerRow`, kind `charge`, amount NEGATIVE — money out),
 *     one per line, for the Cash & Ledger screen; and
 *   • `reference` rows (scope `charge`) keyed by ISIN and dated, so the
 *     reconciliation screen can show the broker's own DP fee per scrip per
 *     day beside Vyuha's. Lines are AGGREGATED per (ISIN, date) because
 *     `reference` is keyed on (scope, key, asOf) — the fee types that made up
 *     the day are listed in `note`, so nothing is lost.
 * Never a trade: a DP charge is a fee on a delivery, not an execution.
 */

import * as XLSX from "xlsx";
import type { ParseContext, ParsedFile, ReferenceRow } from "../types";
import { workbookOf } from "../types";
import { parseLedgerDate, type LedgerRow } from "./dhan-ledger";
import { parseTextMoney } from "./dhan-realised-pnl";

const SHEET_NAME = /^dp\s*charges$/i;
const TITLE = /\bdp\s*charges\b/i;

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z/]/g, "");

/** Column indices as the real export lays them out, found by header text. */
export interface DpCols {
  sr: number;
  date: number;
  isin: number;
  security: number;
  qty: number;
  side: number;
  type: number;
  charges: number;
}

/** The header row, or null. Every one of the eight fields must be present. */
export function findDpHeader(rows: string[][]): { at: number; cols: DpCols } | null {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const c = rows[i]!.map(norm);
    const at = (name: string) => c.findIndex((x) => x === name);
    const cols: DpCols = {
      sr: at("sr"),
      date: at("date"),
      isin: at("isin"),
      security: at("securityname"),
      qty: at("quantity"),
      side: at("buy/sell"),
      type: at("typeoftransaction"),
      charges: at("charges"),
    };
    if (Object.values(cols).every((v) => v >= 0)) return { at: i, cols };
  }
  return null;
}

function sheetRows(ws: XLSX.WorkSheet): string[][] {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "" }) as unknown[][];
  const out = rows.map((r) => r.map((c) => String(c ?? "")));
  // The BIFF8 export declares the full 65,536-row grid; everything past the
  // footer is empty padding and is dropped so row counts mean something.
  let last = -1;
  for (let i = 0; i < out.length; i++) if (out[i]!.some((c) => c.trim() !== "")) last = i;
  return out.slice(0, last + 1);
}

function dpSheet(ctx: ParseContext): { name: string; rows: string[][]; ws: XLSX.WorkSheet } | null {
  if (ctx.text != null) return null; // a CSV is never this file
  if (!ctx.buffer || !/\.xlsx?$/i.test(ctx.filename)) return null;
  let wb: XLSX.WorkBook;
  try {
    wb = workbookOf(ctx);
  } catch {
    return null;
  }
  for (const name of wb.SheetNames) {
    if (!SHEET_NAME.test(name.trim())) continue;
    const ws = wb.Sheets[name]!;
    return { name, rows: sheetRows(ws), ws };
  }
  return null;
}

/**
 * Every broker Vyuha has a named parser for, minus this one. A format-only
 * fingerprint cannot tell a rival's identically-shaped file apart, so the
 * one thing it CAN read — whose name is on the document — becomes a veto.
 */
const RIVALS = /(?<![a-z0-9])(zerodha|groww|upstox|paytm|angel[\s_-]?one|angel[\s_-]?broking)(?![a-z0-9])/i;

/**
 * Detection. Sheet name + title cell + the exact header = the format, worth
 * 0.9 on its own (see the header note above); "dhan" in the filename adds 0.1.
 *
 * ── The veto (2026-09-04) ────────────────────────────────────────────────
 *
 * Because this claim rests on FORMAT alone, a rival broker who ships a DP
 * charges sheet with the same eight headers would be imported as Dhan and
 * priced at Dhan's rates — the exact 2026-08-12 defect AGENTS.md records for
 * `detectZerodha`. The filename cannot VOUCH for a broker here (that is why
 * the format is the fingerprint), but it can VETO one: a file whose name, or
 * whose sheet names or cells, name a DIFFERENT known broker is not claimed at
 * all. It falls to the generic column mapper, which asks.
 */
export function detectDhanDpCharges(ctx: ParseContext): number {
  const sheet = dpSheet(ctx);
  if (!sheet) return 0;
  const found = findDpHeader(sheet.rows);
  if (!found) return 0;
  const titled = sheet.rows.slice(0, found.at).some((r) => r.some((c) => TITLE.test(c)));
  if (!titled) return 0;
  if (RIVALS.test(ctx.filename)) return 0;
  if (RIVALS.test(sheet.name)) return 0;
  if (sheet.rows.some((r) => r.some((c) => RIVALS.test(c)))) return 0;
  return Math.min(1, 0.9 + (/dhan/i.test(ctx.filename) ? 0.1 : 0));
}

/** `From 01-April-2026 to 03-September-2026` out of the title cell. */
export function dpWindow(rows: string[][]): { from: string | null; to: string | null } {
  for (const r of rows) {
    for (const c of r) {
      const m = /from\s+(.+?)\s+to\s+(.+?)\s*$/i.exec(String(c ?? ""));
      if (m) return { from: parseLedgerDate(m[1]!), to: parseLedgerDate(m[2]!) };
    }
  }
  return { from: null, to: null };
}

/**
 * Every data row whose Charges cell falls inside a merged range — i.e. every
 * row that COULD have lost its figure to the merge flattening. Empty on both
 * real exports; a non-empty list becomes a warning rather than a silent 0.
 */
export function chargeCellsCoveredByMerge(ws: XLSX.WorkSheet, chargeCol: number, rowIdxs: number[]): number[] {
  const merges = (ws["!merges"] ?? []) as XLSX.Range[];
  return rowIdxs.filter((r) =>
    merges.some((m) => m.s.r <= r && m.e.r >= r && m.s.c <= chargeCol && m.e.c >= chargeCol && (m.s.c !== chargeCol || m.e.c !== chargeCol)),
  );
}

export interface ParsedDpCharges {
  /** One per printed line, kind `charge`, amount negative (money out). */
  rows: LedgerRow[];
  /** Broker-stated figures: one per (ISIN, date). */
  reference: ReferenceRow[];
  /** Σ of the lines, rounded to the paisa. */
  total: number;
  /** The file's own `Total` row, or null when it states none. */
  statedTotal: number | null;
  from: string | null;
  to: string | null;
  /** How many merged ranges the sheet carries, and what they cover. */
  merges: number;
  warnings: string[];
}

const empty = (warnings: string[]): ParsedDpCharges => ({
  rows: [], reference: [], total: 0, statedTotal: null, from: null, to: null, merges: 0, warnings,
});

/** Read the DP charges sheet. */
export function parseDhanDpChargesWorkbook(ctx: ParseContext): ParsedDpCharges {
  const sheet = dpSheet(ctx);
  if (!sheet) return empty(["This is not a Dhan DP charges workbook (no `DP Charges` sheet)."]);
  const found = findDpHeader(sheet.rows);
  if (!found) {
    return empty(["Could not find the DP charges header row (Sr., Date, ISIN, Security Name, Quantity, Buy/Sell, Type of Transaction, Charges)."]);
  }
  const { at, cols } = found;
  const warnings: string[] = [];
  const rows: LedgerRow[] = [];
  const reference: ReferenceRow[] = [];
  const refIndex = new Map<string, ReferenceRow>();
  const dataRowIdx: number[] = [];
  let statedTotal: number | null = null;

  for (let i = at + 1; i < sheet.rows.length; i++) {
    const r = sheet.rows[i]!;
    const cell = (n: number) => String(r[n] ?? "").trim();

    // The file's own Total row.
    //
    // Detected by the row's FIRST FILLED CELL — the real export prints the
    // label in the `Type of Transaction` column with everything before it
    // blank, so "column 0" literally would find nothing. `r.some(...)` was
    // the other extreme: it matched the word "Total" anywhere on the row, so
    // a security called `Total Gas` or a transaction type containing "Total"
    // would be read as the footer and its charge silently dropped from the
    // sum. A data row's first filled cell is always its Sr. number, so this
    // cannot collide with one.
    const firstFilled = r.map((c) => String(c ?? "").trim()).find((c) => c !== "") ?? "";
    if (/^total$/i.test(firstFilled)) {
      const v = cell(cols.charges);
      if (!v) {
        warnings.push(`Row ${i + 1} is a Total row with no figure in the Charges column, so this file states no total and the lines could not be checked against one.`);
      } else if (statedTotal !== null) {
        // Two Totals is a file that was concatenated or re-exported. The LAST
        // one is the one that follows every data row, so it is the one used —
        // said out loud rather than silently overwritten.
        statedTotal = parseTextMoney(v);
        warnings.push(`This file states more than one Total row; the LAST one (₹${statedTotal.toFixed(2)}) is the one the lines are checked against.`);
      } else {
        statedTotal = parseTextMoney(v);
      }
      continue;
    }
    if (!/^\d+$/.test(cell(cols.sr))) continue; // footer / blank / padding

    const date = parseLedgerDate(cell(cols.date));
    if (!date) {
      warnings.push(`Row ${i + 1} has no readable date (${JSON.stringify(cell(cols.date))}) and was skipped.`);
      continue;
    }
    dataRowIdx.push(i);
    const isin = cell(cols.isin);
    const security = cell(cols.security);
    const qty = parseTextMoney(cell(cols.qty));
    const side = cell(cols.side);
    const type = cell(cols.type) || "DP charge";
    const charges = Math.round(parseTextMoney(cell(cols.charges)) * 100) / 100;

    rows.push({
      date,
      // Narration carries the broker's own words: what the fee was for, on
      // what, for how much stock. Nothing is invented.
      narration: `DP charge · ${type} · ${security} · ${qty}`,
      amount: -charges,
      kind: "charge",
      unclassified: false,
      balance: null,
    });

    const key = isin || security || "unknown";
    const existing = refIndex.get(`${key}|${date}`);
    if (existing) {
      existing.figures.qty = Math.round((existing.figures.qty! + qty) * 1000) / 1000;
      existing.figures.charges = Math.round((existing.figures.charges! + charges) * 100) / 100;
      if (!existing.note!.includes(type)) existing.note = `${existing.note}, ${type}`;
      continue;
    }
    const ref: ReferenceRow = {
      scope: "charge",
      key,
      isin: isin || null,
      symbol: null,
      asOf: date,
      figures: { qty, charges },
      note: `${type}${side ? ` (${side})` : ""}`,
    };
    refIndex.set(`${key}|${date}`, ref);
    reference.push(ref);
  }

  const total = Math.round(rows.reduce((s, r) => s + Math.abs(r.amount), 0) * 100) / 100;
  if (statedTotal === null && rows.length > 0) {
    warnings.push(`This file states no total, so conservation is unchecked: the ${rows.length} lines add up to ₹${total.toFixed(2)} and there is nothing in the file to check that against.`);
  }
  if (statedTotal !== null && Math.abs(total - statedTotal) >= 0.005) {
    warnings.push(
      `The rows add up to ₹${total.toFixed(2)} but the file's own Total says ₹${statedTotal.toFixed(2)} — a difference of ₹${(total - statedTotal).toFixed(2)}. The lines are shown as read; nothing was adjusted to make them agree.`,
    );
  }
  const merges = ((sheet.ws["!merges"] ?? []) as XLSX.Range[]).length;
  const swallowed = chargeCellsCoveredByMerge(sheet.ws, cols.charges, dataRowIdx);
  if (swallowed.length > 0) {
    warnings.push(
      `${swallowed.length} charge cell${swallowed.length === 1 ? " is" : "s are"} inside a merged range, so the figure may belong to a neighbouring column — those rows are listed for review rather than trusted.`,
    );
  }
  if (rows.length === 0) warnings.push("No DP charge rows were found in this file.");

  const { from, to } = dpWindow(sheet.rows.slice(0, at));
  return { rows, reference, total, statedTotal, from, to, merges, warnings };
}

/** The registered import source. Emits reference figures and no trades. */
export function parseDhanDpCharges(ctx: ParseContext): ParsedFile {
  const parsed = parseDhanDpChargesWorkbook(ctx);
  const window = parsed.from ? ` (${parsed.rows.length} charges, ${parsed.from} → ${parsed.to})` : "";
  return {
    sourceId: "dhan-dp-charges",
    broker: "dhan",
    format: "ledger",
    trades: [],
    sourceRows: parsed.rows.length,
    reported: { totalCharges: parsed.total, ...(parsed.statedTotal !== null ? { statedTotalCharges: parsed.statedTotal } : {}) },
    reference: parsed.reference,
    warnings: [
      `This is a Dhan DP charges report${window} — depository fees on delivery debits and pledges, not trades. No trade is created from it: upload it on the Cash & Ledger screen, which accepts it (v3.9.0) and lands each line as a charge entry.`,
      ...parsed.warnings,
    ],
  };
}
