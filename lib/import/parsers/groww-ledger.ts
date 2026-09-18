/**
 * Groww balance statement — the client FUND LEDGER (Groww → Reports →
 * Transactions → Groww Balance statement, downloaded as
 * `Groww_Balance_Statement_<ucc>_<from>_<to>.xlsx`).
 *
 * VERIFIED against a real owner export, 2026-09-16: 447 entries, 02-01-2025 →
 * 14-01-2026, 18 segment types, redacted to
 * `tests/fixtures/redacted/groww-ledger-2025-01-01_2026-01-30.xlsx`.
 * ZERO DB and ZERO React imports; pure functions over the workbook.
 *
 * ── Layout ────────────────────────────────────────────────────────────────
 *   sheet `Client Fund Ledger`
 *   r1-4  Client Name / Unique Client Code / Backoffice Client Code / PAN
 *   r6    Statement of Accounts of Funds for the period from dd/mm/yyyy to …
 *   r8    Transaction Date | Settlement Date | Clearing Corporation/Clearing
 *         Member | Segment Type | Settlement No. | Bill/Chq No. | Transaction
 *         Type | Particulars / Narration | Voucher No. | Debit (Rs.) |
 *         Credit (Rs.) | Balance (Rs.)
 *   r9+   entries, NEWEST SETTLEMENT DATE FIRST, dd-mm-yyyy dates, numeric money
 *   last  "Note - The client shall bring any dispute …"
 *
 * `Balance (Rs.)` is the balance AFTER the entry, in Groww's POSTING order —
 * settlement date by settlement date, and within a day in an order the file
 * does not display (see `postingOrder`). Every entry's balance is the
 * previous posting's plus its credit less its debit: that is the conservation
 * this parser asserts, and each entry is dated by its settlement date. The
 * file states no opening row; the balance before its first entry is the
 * first balance less the first movement (Rs81.52 on the real export),
 * reported, not invented.
 *
 * ── Why the claim is legitimate (AGENTS.md: NAME before SHAPE) ─────────────
 * `Particulars / Narration` is `N/A` on every row and no cell names the
 * broker in prose. The name is in the Segment Type column — Groww labels its
 * own money movements `GROWW_UPI` and `GROWW_WITHDRAW` — or in the filename
 * (`Groww_Balance_Statement_…`). Either qualifies; the header shape alone
 * never does.
 *
 * ── Classification ────────────────────────────────────────────────────────
 * Groww states a machine-readable Segment Type per entry, so it is read
 * FIRST (the narration is `N/A`). The MTF funding mechanics — funding
 * provided, turnover collected/released, collateral and M2M blocks — move
 * money between the trading ledger and the MTF account; they are neither
 * deposits nor charges nor P&L, so they land as `adjustment`. MTF INTEREST is
 * its own type (`INTEREST_ACCRUED`). `DELAYED_PAYMENT_CHARGES` is interest on
 * a debit balance in the trading ledger, not MTF financing, so it is a
 * `charge` — counting it as MTF interest would inflate the one figure this
 * screen exists to reconcile. An unseen type is surfaced as unclassified.
 */
import type { ParseContext, ParsedFile } from "../types";
import { classifyNarration, parseLedgerDate, type LedgerKind, type LedgerRow } from "./dhan-ledger";
import { dateFormatEvidence, sheetMatrices, type ParsedCashFile } from "./upstox-ledger";

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

const HEADER = ["transactiondate", "settlementdate", "segmenttype", "transactiontype", "voucherno", "debitrs", "creditrs", "balancers"];

/** Index of the ledger header row, or -1. */
export function findGrowwLedgerHeader(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const cells = rows[i]!.map(norm);
    if (HEADER.every((h) => cells.includes(h))) return i;
  }
  return -1;
}

/** Groww's own name on its money movements: `GROWW_UPI`, `GROWW_WITHDRAW`. */
const NAMED_SEGMENT = /^GROWW_/i;
const NAMED_FILE = /groww/i;

/** Confidence this workbook is a Groww fund ledger. Binary container only. */
export function detectGrowwLedger(ctx: ParseContext): number {
  if (ctx.text != null || !ctx.buffer) return 0;
  const named = NAMED_FILE.test(ctx.filename);
  for (const { rows } of sheetMatrices(ctx)) {
    const h = findGrowwLedgerHeader(rows);
    if (h < 0) continue;
    const cSeg = rows[h]!.map(norm).indexOf("segmenttype");
    const contentNamed = rows.slice(h + 1).some((r) => NAMED_SEGMENT.test(String(r[cSeg] ?? "").trim()));
    if (!contentNamed && !named) continue; // shape without a name is never a claim
    return contentNamed && named ? 1 : 0.9;
  }
  return 0;
}

/**
 * Segment Type → ledger kind, for every type seen on the real export.
 * Deposit/withdrawal types take their DIRECTION from the sign.
 */
const SEGMENT_KIND: Record<string, LedgerKind | "cash"> = {
  STOCKS_SETTLEMENT: "realised_pnl",
  GROWW_WITHDRAW: "cash",
  STOCK_PAYOUT: "cash",
  UPI: "cash",
  GROWW_UPI: "cash",
  PAYU_DEPOSIT: "cash",
  DIRECT_NETBANKING: "cash",
  STOCKS_PLEDGE_UNPLEDGE_CHARGES: "charge",
  STOCKS_MIS: "charge",
  DELAYED_PAYMENT_CHARGES: "charge",
  INTEREST_ACCRUED: "mtf_interest",
  FUNDING_PROVIDED: "adjustment",
  TURNOVER_COLLECTED: "adjustment",
  TURNOVER_RELEASED: "adjustment",
  CC_RELEASED: "adjustment",
  CHANGE_IN_CC: "adjustment",
  M2M_BLOCKED: "adjustment",
  M2M_RELEASED: "adjustment",
};

export function classifyGrowwRow(segment: string, amount: number): { kind: LedgerKind; unclassified: boolean } {
  const k = SEGMENT_KIND[String(segment ?? "").trim().toUpperCase()];
  if (k === "cash") return { kind: amount >= 0 ? "deposit" : "withdrawal", unclassified: false };
  if (k) return { kind: k, unclassified: false };
  const guess = classifyNarration(String(segment ?? "").replace(/_/g, " "));
  return { kind: guess.kind, unclassified: true };
}

/** A money cell: blank or a number. Anything else is unreadable → null. */
function cellAmount(raw: unknown): number | null {
  const s = String(raw ?? "").trim().replace(/,/g, "");
  if (s === "") return 0;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/** Round RUPEES to the paisa Groww states — a rounding, never a unit change. */
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface GrowwLedgerParse extends ParsedCashFile {
  /** The balance BEFORE the oldest entry: its stated balance less its movement. */
  derivedOpening: number | null;
  /** The newest entry's stated balance. */
  closingBalance: number | null;
  /** Rows whose stated balance ≠ the previous balance + credit − debit. */
  balanceBreaks: { date: string; narration: string; stated: number; derived: number }[];
  refused: { line: number; reason: string }[];
}

/**
 * The file's rows (newest settlement first) in the order Groww POSTED them.
 *
 * Measured on the real export (2026-09-18): the file is sorted by SETTLEMENT
 * date, newest first, without exception — but WITHIN one settlement day its
 * display order is not the posting order (33 rows sit out of transaction-date
 * order, and reading the file bottom-up breaks the balance chain at 102 rows).
 * The Balance column itself says which order is right: within each settlement
 * day the entries are placed so that each one starts from the balance the
 * previous one ended on. Across all 214 settlement days of the real file that
 * placement leaves ZERO breaks. A row no placement can chain is a break — kept
 * where the file put it and reported, never forced.
 *
 * The opening balance is the first entry's balance less its movement, where
 * the first entry is the one on the first day whose starting balance is no
 * other entry's balance that day.
 */
export function postingOrder(fileRows: LedgerRow[]): {
  rows: LedgerRow[];
  derivedOpening: number | null;
  breaks: GrowwLedgerParse["balanceBreaks"];
} {
  // Oldest settlement day first; within a day, bottom-of-file first.
  const chrono = fileRows.map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.date === b.r.date ? b.i - a.i : a.r.date < b.r.date ? -1 : 1))
    .map((x) => x.r);
  const days: LedgerRow[][] = [];
  for (const r of chrono) {
    const last = days[days.length - 1];
    if (last && last[0]!.date === r.date) last.push(r);
    else days.push([r]);
  }
  if (days.length === 0) return { rows: [], derivedOpening: null, breaks: [] };
  const startOf = (r: LedgerRow) => r2(r.balance! - r.amount);
  const firstDayBalances = new Set(days[0]!.map((r) => r2(r.balance!)));
  const first = days[0]!.find((r) => !firstDayBalances.has(startOf(r))) ?? days[0]![0]!;
  const derivedOpening = startOf(first);

  const out: LedgerRow[] = [];
  const breaks: GrowwLedgerParse["balanceBreaks"] = [];
  let running = derivedOpening;
  for (const day of days) {
    const pool = [...day];
    while (pool.length) {
      let at = pool.findIndex((r) => startOf(r) === running);
      if (at < 0) {
        at = 0;
        breaks.push({ date: pool[0]!.date, narration: pool[0]!.narration, stated: pool[0]!.balance!, derived: r2(running + pool[0]!.amount) });
      }
      const [next] = pool.splice(at, 1);
      out.push(next!);
      running = r2(next!.balance!);
    }
  }
  return { rows: out, derivedOpening, breaks };
}

/** Read a Groww fund ledger workbook. Rows come back in POSTING order, oldest first. */
export function parseGrowwLedger(ctx: ParseContext): GrowwLedgerParse {
  const empty = (w: string[]): GrowwLedgerParse => ({
    rows: [], mtfInterestTotal: 0, unclassified: [], openingBalance: null, from: null, to: null,
    warnings: w, source: "groww-ledger", derivedOpening: null, closingBalance: null, balanceBreaks: [], refused: [],
  });

  let found: { rows: string[][]; h: number } | null = null;
  for (const { rows } of sheetMatrices(ctx)) {
    const h = findGrowwLedgerHeader(rows);
    if (h >= 0) { found = { rows, h }; break; }
  }
  if (!found) {
    return empty(["Could not find the Groww fund-ledger header row (Transaction Date, Segment Type, Transaction Type, Voucher No., Debit (Rs.), Credit (Rs.), Balance (Rs.))."]);
  }

  const { rows, h } = found;
  const head = rows[h]!.map(norm);
  const col = (n: string) => head.indexOf(n);
  const cTxn = col("transactiondate"), cSettle = col("settlementdate"), cSeg = col("segmenttype"), cType = col("transactiontype");
  const cPart = col("particularsnarration"), cVoucher = col("voucherno"), cBill = col("billchqno");
  const cDebit = col("debitrs"), cCredit = col("creditrs"), cBal = col("balancers");

  type Read = { row: LedgerRow; line: number };
  const read: Read[] = [];
  const refused: GrowwLedgerParse["refused"] = [];
  const rawDates: string[] = [];

  for (let i = h + 1; i < rows.length; i++) {
    const c = rows[i]!;
    if (c.every((x) => String(x ?? "").trim() === "")) continue;
    const rawTxn = String(c[cTxn] ?? "").trim();
    const rawSettle = String(c[cSettle] ?? "").trim();
    // The trailing dispute note is one long sentence in column A — not a row.
    if (!/^\d/.test(rawTxn) && String(c[cVoucher] ?? "").trim() === "" && String(c[cSeg] ?? "").trim() === "") continue;
    for (const d of [rawTxn, rawSettle]) if (/^\d{1,2}[-/]\d{1,2}[-/]\d{4}/.test(d)) rawDates.push(d);
    const txn = parseLedgerDate(rawTxn);
    const settle = parseLedgerDate(rawSettle);
    const debit = cellAmount(c[cDebit]);
    const credit = cellAmount(c[cCredit]);
    const balance = cellAmount(c[cBal]);
    if (!txn || !settle || debit == null || credit == null || balance == null) {
      refused.push({
        line: i + 1,
        reason: !txn || !settle ? `a date is not a date (transaction "${rawTxn}", settlement "${rawSettle}")`
          : `a money cell is not a number (debit "${c[cDebit]}", credit "${c[cCredit]}", balance "${c[cBal]}")`,
      });
      continue;
    }
    const amount = r2(credit - debit);
    const segment = String(c[cSeg] ?? "").trim();
    const part = String(c[cPart] ?? "").trim();
    const bill = String(c[cBill] ?? "").trim();
    // The entry is dated by its SETTLEMENT date: that is the day Groww posts
    // it — the file is sorted by it and the Balance column chains in it. A
    // bill traded earlier says so in the narration, after the voucher number
    // (the Cash & Ledger dedup key reads the first 60 characters).
    const narration = [
      segment, String(c[cVoucher] ?? "").trim(), String(c[cType] ?? "").trim(),
      txn !== settle ? `traded ${txn}` : "",
      /^n\/?a$/i.test(part) ? "" : part, /^n\/?a$/i.test(bill) ? "" : bill,
    ].filter(Boolean).join(" · ");
    const { kind, unclassified } = classifyGrowwRow(segment, amount);
    read.push({ row: { date: settle, narration, amount, kind, unclassified, balance }, line: i + 1 });
  }

  const evidence = dateFormatEvidence(rawDates);
  if (evidence.refusal) return empty([evidence.refusal]);
  if (read.length === 0) {
    const e = empty([
      refused.length
        ? `The Groww fund-ledger header was found, but every entry was refused: ${refused.map((r) => `line ${r.line}: ${r.reason}`).join("; ")}.`
        : "The Groww fund-ledger header was found, but no dated entries followed it.",
    ]);
    return { ...e, refused };
  }

  const { rows: out, derivedOpening, breaks } = postingOrder(read.map((r) => r.row));
  const closingBalance = out[out.length - 1]!.balance;

  const warnings: string[] = [evidence.warning];
  if (refused.length) {
    warnings.push(`${refused.length} row(s) REFUSED, not read as zero: ${refused.map((r) => `line ${r.line}: ${r.reason}`).join("; ")}.`);
  }
  warnings.push(
    breaks.length === 0 && refused.length === 0
      ? `Reconciled: all ${out.length} entries carry the statement's own running balance, entry to entry in posting order (Rs${derivedOpening} before the first entry, Rs${closingBalance} after the last).`
      : `Does NOT reconcile: ${breaks.length} entr${breaks.length === 1 ? "y states" : "ies state"} a balance that the previous balance + credit − debit does not reach${breaks[0] ? ` (first: ${breaks[0].date}, stated Rs${breaks[0].stated}, derived Rs${breaks[0].derived})` : ""}${refused.length ? `, with ${refused.length} row(s) refused` : ""} — check the export before committing.`,
  );
  const unclassified = out.filter((r) => r.unclassified);
  if (unclassified.length) warnings.push(`${unclassified.length} row(s) carry a Segment Type this parser has not seen and are shown for review.`);
  const dates = out.map((r) => r.date).sort();
  const mtfInterestTotal = r2(out.filter((r) => r.kind === "mtf_interest").reduce((s, r) => s - Math.min(r.amount, 0), 0));

  return {
    rows: out,
    mtfInterestTotal,
    unclassified,
    // The file states no opening row; the derived figure travels separately.
    openingBalance: null,
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
    warnings,
    source: "groww-ledger",
    derivedOpening,
    closingBalance,
    balanceBreaks: breaks,
    refused,
  };
}

/** Dropzone registration: names the file and says where it goes. */
export function parseGrowwLedgerSource(ctx: ParseContext): ParsedFile {
  const parsed = parseGrowwLedger(ctx);
  const window = parsed.from ? ` (${parsed.rows.length} entries, ${parsed.from} to ${parsed.to})` : "";
  return {
    sourceId: "groww-ledger",
    broker: "groww",
    format: "ledger",
    trades: [],
    warnings: [
      `This is a Groww fund ledger${window} - cash movements, settlement postings, MTF interest and charges, not trades. Nothing is imported from here: upload it on the Cash & Ledger screen, which previews everything before it writes.`,
      ...parsed.warnings,
    ],
  };
}
