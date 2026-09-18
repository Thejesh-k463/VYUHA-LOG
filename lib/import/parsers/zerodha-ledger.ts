/**
 * Zerodha Console ledger (Console → Funds → Statement → Ledger, downloaded as
 * `ledger-<client id>.xlsx`).
 *
 * VERIFIED against a real owner export, 2026-09-16 (6 lines, 2025-06-23 →
 * 2025-07-04), redacted to
 * `tests/fixtures/redacted/zerodha-ledger-2025-01-01_2026-08-01.xlsx`.
 * ZERO DB and ZERO React imports; pure functions over the workbook.
 *
 * ── Layout ────────────────────────────────────────────────────────────────
 *   sheet `Equity` (the segment the statement was pulled for), data from col B
 *   r7    Client ID | <id>
 *   r11   Ledger for Equity from <yyyy-mm-dd> to <yyyy-mm-dd>
 *   r15   Particulars | Posting Date | Cost Center | Voucher Type | Debit |
 *         Credit | Net Balance
 *   r16   Opening Balance | … | <net balance>          ← a statement, not an entry
 *   r17+  entries — `NSE-EQ - Z` cost centre, ISO posting dates, NUMERIC money
 *         to four decimal places (a DP charge of 15.045)
 *   last  Closing Balance | … | <net balance>
 *
 * ── Why the claim is legitimate (AGENTS.md: NAME before SHAPE) ─────────────
 * The filename names nobody (`ledger-<id>.xlsx`), and a ledger's column shape
 * is every broker's. The claim is carried by the COST CENTRE: Zerodha's
 * Console suffixes every account head with ` - Z` (`NSE-EQ - Z`), the same
 * fingerprint `detectZerodha` already uses for the Console P&L's charge heads
 * (`Brokerage - Z`). A ledger header whose rows carry no ` - Z` cost centre
 * claims nothing unless the filename names Zerodha or Kite. (The real file
 * also embeds a `zerodha-logo` picture, but SheetJS drops drawings on rewrite,
 * so a redacted copy could not prove it — the cost centre is what both carry.)
 *
 * ── Money and conservation ────────────────────────────────────────────────
 * Debit and credit collapse into one signed rupee amount (money out is
 * negative), as every other cash parser does. Zerodha states four decimal
 * places, so the running Net Balance is re-derived in integer ten-thousandths
 * of a rupee — opening + credits − debits must equal EVERY row's stated Net
 * Balance and the file's own Closing Balance exactly. A money cell that is not
 * a number is REFUSED (the row is reported, never read as 0).
 */
import type { ParseContext, ParsedFile } from "../types";
import { classifyNarration, parseLedgerDate, type LedgerKind, type LedgerRow } from "./dhan-ledger";
import { sheetMatrices, type ParsedCashFile } from "./upstox-ledger";

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

const HEADER = ["particulars", "postingdate", "costcenter", "vouchertype", "debit", "credit", "netbalance"];

/** Index of the ledger header row, or -1. */
export function findZerodhaLedgerHeader(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const cells = rows[i]!.map(norm);
    if (HEADER.every((h) => cells.includes(h))) return i;
  }
  return -1;
}

/** Zerodha's Console account-head suffix: `NSE-EQ - Z`. */
const Z_SUFFIX = /\s-\s?Z$/;
const NAMED_FILE = /zerodha|kite/i;

/**
 * Confidence this workbook is a Zerodha Console ledger. Binary container only
 * (the export is `.xlsx`); a text context scores 0 on content, not extension.
 */
export function detectZerodhaLedger(ctx: ParseContext): number {
  if (ctx.text != null || !ctx.buffer) return 0;
  const named = NAMED_FILE.test(ctx.filename);
  for (const { rows } of sheetMatrices(ctx)) {
    const h = findZerodhaLedgerHeader(rows);
    if (h < 0) continue;
    const head = rows[h]!.map(norm);
    const cCost = head.indexOf("costcenter");
    const zRows = rows.slice(h + 1).filter((r) => Z_SUFFIX.test(String(r[cCost] ?? "").trim())).length;
    if (zRows === 0 && !named) continue; // shape without a name is never a claim
    return named ? 1 : 0.9;
  }
  return 0;
}

/** A money cell: blank or a number. Anything else is unreadable → null. */
function cellAmount(raw: unknown): number | null {
  const s = String(raw ?? "").trim().replace(/,/g, "");
  if (s === "") return 0;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/** Round RUPEES to the four decimals Zerodha states — a rounding, never a unit change. */
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * Voucher type first, narration second. Only the type observed on a real
 * export is mapped: "Funds transferred back as part of quarterly settlement"
 * is a `Bank Payments` voucher — money paid OUT to the bank — and the
 * narration classifier alone reads the word "settlement" as trading P&L.
 */
export function classifyZerodhaRow(voucherType: string, particulars: string, amount: number): { kind: LedgerKind; unclassified: boolean } {
  const v = norm(voucherType);
  if (v === "bankpayments") return { kind: amount <= 0 ? "withdrawal" : "deposit", unclassified: false };
  return classifyNarration(particulars);
}

export interface ZerodhaLedgerParse extends ParsedCashFile {
  /** The file's own Closing Balance row, as stated. */
  closingBalance: number | null;
  /** Rows whose stated Net Balance ≠ opening + credits − debits so far. */
  balanceBreaks: { date: string; narration: string; stated: number; derived: number }[];
  /** Rows refused because a money cell or the date could not be read. */
  refused: { line: number; reason: string }[];
}

/** Read a Zerodha Console ledger workbook. */
export function parseZerodhaLedger(ctx: ParseContext): ZerodhaLedgerParse {
  const empty = (w: string[]): ZerodhaLedgerParse => ({
    rows: [], mtfInterestTotal: 0, unclassified: [], openingBalance: null, from: null, to: null,
    warnings: w, source: "zerodha-ledger", closingBalance: null, balanceBreaks: [], refused: [],
  });

  let found: { rows: string[][]; h: number } | null = null;
  for (const { rows } of sheetMatrices(ctx)) {
    const h = findZerodhaLedgerHeader(rows);
    if (h >= 0) { found = { rows, h }; break; }
  }
  if (!found) {
    return empty(["Could not find the Zerodha ledger header row (Particulars, Posting Date, Cost Center, Voucher Type, Debit, Credit, Net Balance)."]);
  }

  const { rows, h } = found;
  const head = rows[h]!.map(norm);
  const col = (n: string) => head.indexOf(n);
  const cPart = col("particulars"), cDate = col("postingdate"), cCost = col("costcenter");
  const cType = col("vouchertype"), cDebit = col("debit"), cCredit = col("credit"), cBal = col("netbalance");

  let opening: number | null = null;
  let closing: number | null = null;
  const out: LedgerRow[] = [];
  const refused: ZerodhaLedgerParse["refused"] = [];
  const breaks: ZerodhaLedgerParse["balanceBreaks"] = [];
  let running: number | null = null; // rupees, rounded to four decimals

  for (let i = h + 1; i < rows.length; i++) {
    const c = rows[i]!;
    if (c.every((x) => String(x ?? "").trim() === "")) continue;
    const part = String(c[cPart] ?? "").trim();
    if (/^opening balance$/i.test(part)) {
      opening = cellAmount(c[cBal]);
      running = opening != null ? r4(opening) : null;
      continue;
    }
    if (/^closing balance$/i.test(part)) {
      closing = cellAmount(c[cBal]);
      continue;
    }
    const date = parseLedgerDate(String(c[cDate] ?? ""));
    const debit = cellAmount(c[cDebit]);
    const credit = cellAmount(c[cCredit]);
    const balance = cellAmount(c[cBal]);
    if (!date || debit == null || credit == null || balance == null) {
      refused.push({
        line: i + 1,
        reason: !date ? `posting date "${String(c[cDate] ?? "").trim()}" is not a date`
          : `a money cell is not a number (debit "${c[cDebit]}", credit "${c[cCredit]}", net balance "${c[cBal]}")`,
      });
      running = null; // the chain cannot be carried across a row it could not read
      continue;
    }
    const amount = r4(credit - debit);
    if (running != null) {
      running = r4(running + credit - debit);
      if (running !== r4(balance)) {
        breaks.push({ date, narration: part, stated: balance, derived: running });
      }
    }
    const { kind, unclassified } = classifyZerodhaRow(String(c[cType] ?? ""), part, amount);
    const narration = [String(c[cCost] ?? "").trim(), String(c[cType] ?? "").trim(), part].filter(Boolean).join(" · ");
    out.push({ date, narration, amount, kind, unclassified, balance });
  }

  if (out.length === 0) {
    const e = empty([
      refused.length
        ? `The Zerodha ledger header was found, but every entry was refused: ${refused.map((r) => `line ${r.line}: ${r.reason}`).join("; ")}.`
        : "The Zerodha ledger header was found, but no dated entries followed it.",
    ]);
    return { ...e, openingBalance: opening, closingBalance: closing, refused };
  }

  const warnings: string[] = [];
  if (refused.length) {
    warnings.push(`${refused.length} row(s) REFUSED, not read as zero: ${refused.map((r) => `line ${r.line}: ${r.reason}`).join("; ")}.`);
  }
  if (breaks.length) {
    warnings.push(`${breaks.length} row(s) state a Net Balance that opening + credits − debits does not reach (first: ${breaks[0]!.date}, stated Rs${breaks[0]!.stated}, derived Rs${breaks[0]!.derived}) — check the export before committing.`);
  }
  if (opening == null) warnings.push("This export states no Opening Balance row, so the running-balance check could not run.");
  const last = out[out.length - 1]!.balance;
  if (closing != null && last != null && r4(closing) !== r4(last)) {
    warnings.push(`The file's Closing Balance (Rs${closing}) differs from its last entry's Net Balance (Rs${last}).`);
  }
  if (opening != null && closing != null && refused.length === 0) {
    const derived = out.reduce((s, r) => r4(s + r.amount), r4(opening));
    warnings.push(
      derived === r4(closing)
        ? `Reconciled: opening Rs${opening} + ${out.length} entries = closing Rs${closing}, exactly as the file states it.`
        : `Does NOT reconcile: opening Rs${opening} + ${out.length} entries = Rs${derived}, but the file states a closing balance of Rs${closing}.`,
    );
  }

  const unclassified = out.filter((r) => r.unclassified);
  if (unclassified.length) warnings.push(`${unclassified.length} row(s) matched no known narration pattern and are shown for review.`);
  const dates = out.map((r) => r.date).sort();
  const mtfInterestTotal = Math.round(out.filter((r) => r.kind === "mtf_interest").reduce((s, r) => s - Math.min(r.amount, 0), 0) * 100) / 100;
  return {
    rows: out,
    mtfInterestTotal,
    unclassified,
    openingBalance: opening,
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
    warnings,
    source: "zerodha-ledger",
    closingBalance: closing,
    balanceBreaks: breaks,
    refused,
  };
}

/** Dropzone registration: names the file and says where it goes. */
export function parseZerodhaLedgerSource(ctx: ParseContext): ParsedFile {
  const parsed = parseZerodhaLedger(ctx);
  const window = parsed.from ? ` (${parsed.rows.length} entries, ${parsed.from} to ${parsed.to})` : "";
  return {
    sourceId: "zerodha-ledger",
    broker: "zerodha",
    format: "ledger",
    trades: [],
    warnings: [
      `This is a Zerodha Console ledger${window} - cash movements, settlement postings and charges, not trades. Nothing is imported from here: upload it on the Cash & Ledger screen, which previews everything before it writes.`,
      ...parsed.warnings,
    ],
  };
}
