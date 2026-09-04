/**
 * Upstox ledger (`ledger_<from>_To_<to>_<wallet>_<code>.xlsx`, sheet LEDGER_V3).
 *
 * VERIFIED against a real owner export, 2026-09-04: 4 data rows over
 * 2025-07-19 -> 2026-09-04, redacted to
 * `tests/fixtures/redacted/upstox-ledger-2025-07-19_2026-09-04.xlsx`.
 *
 * -- Layout --------------------------------------------------------------
 *   r0   UPSTOX SECURITIES PRIVATE LIMITED        <- the in-content NAME
 *   r1   (Formerly EPX Uptech Private Limited)
 *   r2   Dealing Office: ...
 *   r4-7 UCC / Name / PAN / Wallet label block
 *   r9   Wallet | Trade Date | Settlement Date | Exchange | Segment | Type |
 *        Narration | Debit | Credit | Closing Balance
 *   r10+ data rows
 *   r14  (blank) | ... | Total | SUM(debit) | SUM(credit) | closing
 *   r21  "From 19-Jul-2025, our Broking operations were transitioned from
 *        RKSV Commodities India Pvt. Ltd. to Upstox Securities Pvt. Ltd."
 *
 * -- Why the claim is legitimate (AGENTS.md: NAME before SHAPE) -----------
 * Upstox's filenames name nobody (`ledger_...`, `trade_...`,
 * `realizedPnL_...`), so the claim is carried entirely by CONTENT: the
 * legal-entity banner in the first rows (the same fingerprint
 * `angelone-upstox.ts` uses) or the sheet name `LEDGER_V3`, which no other
 * examined broker emits. A ledger shape alone claims nothing.
 *
 * -- Why a missing header row means "no claim" ---------------------------
 * `tests/fixtures/redacted/upstox-ledger.xlsx` is the same export with zero
 * data rows AND no header row at all. It carries the banner, so a
 * banner-only rule would claim a file this parser cannot read a single row
 * from. The header is therefore mandatory: the detector claims what it can
 * actually read, and the empty sample keeps falling to the column mapper.
 *
 * -- Money and dates -----------------------------------------------------
 * Amounts are FORMATTED text (`Rs2,500.00`) with an EN DASH for "no value" --
 * not a blank and not a zero. Debit and credit are collapsed into one signed
 * rupee amount (money out is negative), exactly as the Dhan ledger does, so
 * no downstream consumer re-derives the sign.
 *
 * Dates are `dd-mm-yyyy`. That is asserted, not assumed: `dateFormatEvidence`
 * reads every date in the file and REFUSES a file whose second component
 * exceeds 12 while no first component does (that file is month-first and this
 * parser would silently transpose it). When every day in the window happens
 * to be <= 12 the question is undetectable by construction, and the parser
 * says so in a warning rather than pretending it checked.
 */
import type { ParseContext, ParsedFile } from "../types";
import { workbookOf } from "../types";
import * as XLSX from "xlsx";
import {
  classifyNarration, parseLedgerDate,
  type LedgerKind, type LedgerRow, type ParsedLedger,
} from "./dhan-ledger";

/** `ParsedLedger`, minus the Dhan-only `source` union. Widened here rather
 *  than in `dhan-ledger.ts`, whose union is that file's own contract. */
export type ParsedCashFile = Omit<ParsedLedger, "source"> & { source?: string };

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * A formatted rupee cell. An EN DASH, an EM DASH, a hyphen and a blank all
 * mean "this side of the entry is empty" -- NOT zero-with-a-value, though all
 * parse to 0 here because the sign is carried by WHICH column the figure is in.
 */
export function money(raw: unknown): number {
  const s = String(raw ?? "").trim();
  if (!s || /^[-–—]$/.test(s)) return 0;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s);
  const n = Number(s.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n)) return 0;
  return neg ? -n : n;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

const HEADER_MUST = ["wallet", "tradedate", "narration", "debit", "credit", "closingbalance"];

export function sheetMatrices(ctx: ParseContext): { name: string; rows: string[][] }[] {
  try {
    const wb = workbookOf(ctx);
    return wb.SheetNames.map((name) => ({
      name,
      rows: (XLSX.utils.sheet_to_json(wb.Sheets[name]!, { header: 1, raw: false, defval: "" }) as unknown[][])
        .map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? "").trim()) : [])),
    }));
  } catch {
    return [];
  }
}

/** Index of the ledger header row in a sheet, or -1. */
export function findUpstoxLedgerHeader(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const cells = rows[i]!.map(norm);
    if (HEADER_MUST.every((h) => cells.includes(h))) return i;
  }
  return -1;
}

const BANNER = /upstox|rksv/i;

/** The banner rows above the header, where Upstox names its legal entity. */
const hasBanner = (rows: string[][], upto: number) =>
  rows.slice(0, Math.max(0, Math.min(14, upto))).some((r) => r.some((c) => BANNER.test(c)));

/**
 * Confidence this workbook is an Upstox ledger.
 *
 * BINARY container only: the real export is `.xlsx`, and `buildContext`
 * decodes `ctx.text` for `.csv`/`.txt` alone -- so refusing a text context
 * outright makes every score below content-decided rather than
 * extension-decided (the container rule, tests/import-detection-matrix.test.ts).
 */
export function detectUpstoxLedger(ctx: ParseContext): number {
  if (ctx.text != null) return 0;
  if (!ctx.buffer) return 0;
  for (const { name, rows } of sheetMatrices(ctx)) {
    const h = findUpstoxLedgerHeader(rows);
    if (h < 0) continue;
    const fingerprint = hasBanner(rows, h) || norm(name) === "ledgerv3";
    if (!fingerprint) continue; // shape without a name is never a claim
    let score = 0.9;
    if (BANNER.test(ctx.filename)) score += 0.05;
    if (/ledger/i.test(ctx.filename)) score += 0.05;
    return Math.min(1, score);
  }
  return 0;
}

/**
 * Which way round are `dd` and `mm`?
 *
 * Returns a refusal when the file is provably NOT day-first, and -- the
 * honest case -- a warning saying the question is undetectable when every day
 * in the window is <= 12.
 */
export function dateFormatEvidence(raws: string[]): { refusal: string | null; warning: string } {
  let dayFirst = 0, monthFirst = 0;
  for (const raw of raws) {
    const m = String(raw ?? "").trim().match(/^(\d{1,2})[-/](\d{1,2})[-/]\d{4}/);
    if (!m) continue;
    if (Number(m[1]) > 12) dayFirst++;
    if (Number(m[2]) > 12) monthFirst++;
  }
  if (monthFirst > 0 && dayFirst === 0) {
    return {
      refusal: `This ledger's dates are month-first: ${monthFirst} row(s) have a second component above 12 and none has a first component above 12. Vyuha reads Indian ledgers day-first, so reading this file would silently transpose every date. Refusing rather than guessing.`,
      warning: "",
    };
  }
  if (dayFirst > 0 && monthFirst > 0) {
    return {
      refusal: `This ledger's dates cannot be one format: ${dayFirst} row(s) have a first component above 12 and ${monthFirst} row(s) have a second component above 12. Refusing rather than guessing.`,
      warning: "",
    };
  }
  if (dayFirst > 0) {
    return { refusal: null, warning: `Dates read as dd-mm-yyyy, confirmed by ${dayFirst} row(s) whose day exceeds 12.` };
  }
  return {
    refusal: null,
    warning: "Every date in this file has a day of 12 or less, so day-first vs month-first is undetectable by construction. Read as dd-mm-yyyy, which is what Upstox's export uses -- but this file does not prove it.",
  };
}

/**
 * Upstox states a `Type` for every line, so the narration is not the only
 * evidence. Type is read FIRST because one narration here is a trap:
 * "Transferred amount to MTF account" is a wallet transfer, and
 * `classifyNarration` would read the word MTF and book it as MTF INTEREST --
 * a financing cost the account never paid.
 */
export function classifyUpstoxRow(type: string, narration: string, amount: number): { kind: LedgerKind; unclassified: boolean } {
  const t = norm(type);
  const n = String(narration ?? "").toLowerCase();

  if (t === "fundtransfer") {
    return { kind: amount >= 0 ? "deposit" : "withdrawal", unclassified: false };
  }
  if (t === "journalvoucher") {
    // An internal move between the trading and MTF/collateral wallets. Not a
    // charge, not a deposit -- the money never left the account.
    return { kind: "adjustment", unclassified: false };
  }
  if (t === "order") {
    if (/charge|brokerage|\bstt\b|\bgst\b|stamp|sebi|ipft/.test(n)) return { kind: "charge", unclassified: false };
    // "BILL POSTING" is the settlement obligation for the day's contracts.
    return { kind: "realised_pnl", unclassified: false };
  }
  if (/charge|brokerage|penalty|\bamc\b|\bdp\b|pledge/.test(`${t} ${n}`)) {
    return { kind: "charge", unclassified: false };
  }
  if (/dividend/.test(`${t} ${n}`)) return { kind: "dividend", unclassified: false };
  return classifyNarration(narration);
}

/** Read an Upstox ledger workbook. */
export function parseUpstoxLedger(ctx: ParseContext): ParsedCashFile {
  const warnings: string[] = [];
  const empty = (w: string[]): ParsedCashFile => ({
    rows: [], mtfInterestTotal: 0, unclassified: [], openingBalance: null,
    from: null, to: null, warnings: w, source: "upstox-ledger",
  });

  let found: { rows: string[][]; h: number } | null = null;
  for (const { rows } of sheetMatrices(ctx)) {
    const h = findUpstoxLedgerHeader(rows);
    if (h >= 0) { found = { rows, h }; break; }
  }
  if (!found) {
    return empty(["Could not find the Upstox ledger header row (Wallet, Trade Date, Settlement Date, Exchange, Segment, Type, Narration, Debit, Credit, Closing Balance)."]);
  }

  const { rows, h } = found;
  const head = rows[h]!.map(norm);
  const col = (...names: string[]) => {
    for (const nm of names) { const i = head.indexOf(nm); if (i >= 0) return i; }
    return -1;
  };
  const cWallet = col("wallet"), cDate = col("tradedate");
  const cExch = col("exchange"), cSeg = col("segment"), cType = col("type"), cNarr = col("narration");
  const cDebit = col("debit"), cCredit = col("credit"), cBal = col("closingbalance");

  // The `Total` row (narration column) is the file's own conservation
  // statement, not an entry. It is skipped and then checked against the rows.
  let statedDebit: number | null = null, statedCredit: number | null = null, statedBalance: number | null = null;
  const rawDates: string[] = [];
  const out: LedgerRow[] = [];

  for (let i = h + 1; i < rows.length; i++) {
    const c = rows[i]!;
    if (c.every((x) => x === "")) continue;
    if (/^total$/i.test((c[cNarr] ?? "").trim())) {
      statedDebit = money(c[cDebit]);
      statedCredit = money(c[cCredit]);
      statedBalance = money(c[cBal]);
      continue;
    }
    const rawDate = (c[cDate] ?? "").trim();
    // Collected BEFORE the parse: a month-first date (`08-28-2026`) fails
    // `parseLedgerDate` outright, so gathering these only from rows that
    // parsed would have hidden exactly the file the evidence check exists for.
    if (/^\d{1,2}[-/]\d{1,2}[-/]\d{4}/.test(rawDate)) rawDates.push(rawDate);
    const date = parseLedgerDate(rawDate);
    if (!date) continue;

    const debit = money(c[cDebit]), credit = money(c[cCredit]);
    const amount = r2(credit - debit);
    const narration = [
      cExch >= 0 ? c[cExch] : "", cSeg >= 0 ? c[cSeg] : "",
      cType >= 0 ? c[cType] : "", cNarr >= 0 ? c[cNarr] : "",
    ].map((x) => String(x ?? "").trim()).filter(Boolean).join(" · ");
    const { kind, unclassified } = classifyUpstoxRow(c[cType] ?? "", c[cNarr] ?? "", amount);
    out.push({
      date,
      narration: cWallet >= 0 && c[cWallet] ? `${c[cWallet]} · ${narration}` : narration,
      amount,
      kind,
      unclassified,
      balance: cBal >= 0 ? money(c[cBal]) : null,
    });
  }

  const evidence = dateFormatEvidence(rawDates);
  if (evidence.refusal) return empty([evidence.refusal]);
  if (out.length === 0) return empty(["The Upstox ledger header was found, but no dated rows followed it."]);
  warnings.push(evidence.warning);

  // -- Conservation against the file's own Total row ------------------------
  const sumDebit = r2(out.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0));
  const sumCredit = r2(out.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0));
  if (statedDebit != null && Math.abs(statedDebit - sumDebit) > 0.005) {
    warnings.push(`The file's Total row states Rs${statedDebit} debited but its rows sum to Rs${sumDebit} - check the export before committing.`);
  }
  if (statedCredit != null && Math.abs(statedCredit - sumCredit) > 0.005) {
    warnings.push(`The file's Total row states Rs${statedCredit} credited but its rows sum to Rs${sumCredit} - check the export before committing.`);
  }
  const lastBalance = out[out.length - 1]!.balance;
  if (statedBalance != null && lastBalance != null && Math.abs(statedBalance - lastBalance) > 0.005) {
    warnings.push(`The file's Total row states a closing balance of Rs${statedBalance} but the last row closes at Rs${lastBalance}.`);
  }
  if (statedDebit == null && statedCredit == null) {
    warnings.push("This export carries no Total row, so the debit/credit conservation check could not run.");
  }

  const unclassified = out.filter((r) => r.unclassified);
  const dates = out.map((r) => r.date).sort();
  const mtfInterestTotal = r2(out.filter((r) => r.kind === "mtf_interest").reduce((s, r) => s - Math.min(r.amount, 0), 0));
  warnings.push(`${out.length} ledger row(s) read (Rs${sumCredit} in, Rs${sumDebit} out).`);
  if (unclassified.length) warnings.push(`${unclassified.length} row(s) matched no known narration pattern and are shown for review.`);

  return {
    rows: out,
    mtfInterestTotal,
    unclassified,
    openingBalance: null,
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
    warnings,
    source: "upstox-ledger",
  };
}

/** Dropzone registration: says what the file is and where it goes. */
export function parseUpstoxLedgerSource(ctx: ParseContext): ParsedFile {
  const parsed = parseUpstoxLedger(ctx);
  const window = parsed.from ? ` (${parsed.rows.length} entries, ${parsed.from} to ${parsed.to})` : "";
  return {
    sourceId: "upstox-ledger",
    broker: "upstox",
    format: "ledger",
    trades: [],
    warnings: [
      `This is an Upstox ledger${window} - cash movements, settlement postings and charges, not trades. Nothing is imported from here: upload it on the Cash & Ledger screen, which previews everything before it writes.`,
      ...parsed.warnings,
    ],
  };
}
