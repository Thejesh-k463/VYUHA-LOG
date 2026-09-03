/**
 * Dhan **Ledger** import — where MTF interest actually lives.
 *
 * ZERO DB and ZERO React imports; pure functions over plain data.
 *
 * ── Why the ledger and not a contract note ────────────────────────────────
 *
 * MTF interest is not a transaction charge. Dhan calculates it daily and posts
 * it WEEKLY to the ledger as an "MTF charges" entry, which is why it appears
 * nowhere in a P&L export or a Global Transaction Report — those describe
 * trades, and interest is financing. Vyuha has until now had to ESTIMATE it
 * from the funded amount and a day count. This reads the real number.
 *
 * ── Written to be tolerant on purpose ─────────────────────────────────────
 *
 * Dhan does not publish the ledger's column layout, and broker exports change
 * without notice. So columns are found by HEADER KEYWORD rather than position,
 * and any row whose narration cannot be classified is reported as unclassified
 * instead of being quietly filed as an "adjustment". A ledger importer that
 * silently mislabels a debit is worse than one that admits it is unsure — the
 * running balance is the user's money.
 */

import type { ParseContext, ParsedFile } from "../types";

export type LedgerKind =
  | "mtf_interest"
  | "charge"
  | "deposit"
  | "withdrawal"
  | "dividend"
  | "realised_pnl"
  | "adjustment";

export interface LedgerRow {
  date: string; // ISO
  narration: string;
  /** Signed rupees: money OUT of the account is negative. */
  amount: number;
  kind: LedgerKind;
  /** True when the narration matched no known pattern. */
  unclassified: boolean;
  balance: number | null;
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** Parse the date shapes Indian brokers actually emit. Day-first for ambiguous
 *  forms, matching the rest of Vyuha and Indian convention. */
export function parseLedgerDate(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;

  const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (dmy) {
    const d = Number(dmy[1]), m = Number(dmy[2]);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return `${dmy[3]}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  // Year may be two digits: the Dhan dividend payout report writes
  // "18-Feb-26" (real export, 2026-09-04). Two digits are read as 20YY.
  const long = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,})[\s-](\d{4}|\d{2})(?!\d)/);
  if (long) {
    const mm = MONTHS[long[2].toLowerCase().slice(0, 3)];
    if (!mm) return null;
    const yyyy = long[3].length === 2 ? `20${long[3]}` : long[3];
    return `${yyyy}-${mm}-${long[1].padStart(2, "0")}`;
  }
  return null;
}

/**
 * Opening/closing balance rows. Not transactions — the ledger's own statement
 * of where the account stood. Excluded from the entry list so the capital is
 * never counted as a deposit.
 */
const BALANCE_MARKER =
  /(?:opening|closing|brought forward|carried forward|b\/f|c\/f)\s*balance|^balance\b/;

export function isBalanceMarker(narration: string): boolean {
  return BALANCE_MARKER.test(
    String(narration ?? "").toLowerCase(),
  );
}

/**
 * Classify a ledger narration.
 *
 * MTF is checked FIRST and on its own, because it is the entry this importer
 * exists for and because a generic "interest" or "charges" rule would swallow
 * it. Ordering here is meaning, not style.
 */
export function classifyNarration(narration: string): { kind: LedgerKind; unclassified: boolean } {
  const n = String(narration ?? "").toLowerCase();
  if (!n.trim()) return { kind: "adjustment", unclassified: true };

  // Balance markers are ASSERTIONS about the account, not movements of money.
  // Treated as entries they would double-count the opening capital; treated as
  // unclassified they would cry wolf on every single import.
  if (isBalanceMarker(n)) return { kind: "adjustment", unclassified: false };

  // MTF financing, in the several ways brokers word it.
  if (/\bmtf\b|margin trading facility|margin funding/.test(n)) {
    return { kind: "mtf_interest", unclassified: false };
  }
  if (/delayed payment|dpc charges|funding interest/.test(n)) {
    return { kind: "mtf_interest", unclassified: false };
  }

  if (/dividend/.test(n)) return { kind: "dividend", unclassified: false };

  if (/payin|deposit|received from|fund transfer in|upi|neft|imps|rtgs/.test(n)) {
    return { kind: "deposit", unclassified: false };
  }
  if (/payout|withdraw|transfer out|paid to/.test(n)) {
    return { kind: "withdrawal", unclassified: false };
  }

  if (/brokerage|stt|gst|stamp|sebi|exchange|transaction charge|dp charge|pledge|call ?& ?trade|amc|penalty|charges?\b/.test(n)) {
    return { kind: "charge", unclassified: false };
  }
  if (/bill|settlement|trade|obligation|net obligation/.test(n)) {
    return { kind: "realised_pnl", unclassified: false };
  }

  return { kind: "adjustment", unclassified: true };
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (const ch of line) {
    if (ch === '"') { q = !q; continue; }
    if (ch === "," && !q) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const num = (s: string | undefined): number => {
  const v = Number(String(s ?? "").replace(/[₹,\s]/g, ""));
  return Number.isFinite(v) ? v : 0;
};

/** Column indices found by header keyword, so a reordered export still parses. */
interface Cols {
  date: number;
  narration: number;
  /** A second free-text column ("Description" beside "Narration" on the real
   *  Dhan export), read for classification only; -1 when there is none. */
  description: number;
  debit: number;
  credit: number;
  amount: number;
  balance: number;
}

export function findColumns(header: string[]): Cols | null {
  const flat = header.map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));
  // Keys are tried IN ORDER, so the first key that matches any header wins.
  // The real Dhan ledger carries both `Description` ("Funds Deposited") and
  // `Narration` ("Money added to your Trading Account"); a positional scan
  // took whichever column came first and stored the terse one.
  const idx = (...keys: string[]) => {
    for (const k of keys) {
      const i = flat.findIndex((x) => x.includes(k));
      if (i >= 0) return i;
    }
    return -1;
  };

  const balance = idx("balance", "running");
  const narration = idx("narration", "particular", "description", "voucher", "remark");
  const description = idx("description");
  const cols: Cols = {
    date: idx("date"),
    narration,
    description: description >= 0 && description !== narration ? description : -1,
    debit: idx("debit", "dr"),
    credit: idx("credit", "cr"),
    // `Net Balance` contains "net"; the running balance is never the amount.
    amount: [idx("amount"), idx("net")].find((i) => i >= 0 && i !== balance) ?? -1,
    balance,
  };
  // A ledger needs at minimum a date, something to read, and a money column.
  if (cols.date < 0 || cols.narration < 0) return null;
  if (cols.debit < 0 && cols.credit < 0 && cols.amount < 0) return null;
  return cols;
}

/**
 * The OTHER Dhan CSVs, by their verified header lines (docs/BROKER_FORMATS.md).
 * Every Dhan detector stands down explicitly on its siblings' headers rather
 * than relying on the sibling simply scoring higher: a Global Transaction
 * Report has a `Date` column and a `Scrip Name`, and a ledger detector that
 * merely looked for "a date and something to read" would find both.
 */
const GTR_HEADER_RE = /Date\s*,\s*Scrip Name\s*,\s*Exchange\s*,\s*Bill No\./i;
const PNL_HEADER_RE = /Scrip Name\s*,\s*Buy Qty\.?\s*,\s*Avg\.? Buy Price/i;
/** Verified on a real export 2026-09-04: header on line 7 after a 5-line
 *  identity preamble and a blank line. `Posting reference` is phrasing no
 *  other examined broker uses — it is the in-content fingerprint. */
const LEDGER_HEADER_RE = /Posting Date\s*,\s*Posting reference\s*,\s*Description\s*,\s*Narration\s*,\s*Credit\s*,\s*Debit\s*,\s*Net Balance/i;
/** Verified on a real export 2026-09-04: same preamble shape, header on line 7. */
const DIVIDEND_HEADER_RE = /Date\s*,\s*Scrip Name\s*,\s*Dividend Per Share\s*,\s*Quantity\s*,\s*Dividend Paid/i;

export const isDhanGtrText = (text: string) => GTR_HEADER_RE.test(text);
export const isDhanPnlText = (text: string) => PNL_HEADER_RE.test(text);
export const isDhanLedgerText = (text: string) => LEDGER_HEADER_RE.test(text);
export const isDhanDividendText = (text: string) => DIVIDEND_HEADER_RE.test(text);

/** Generic ledger-shaped text (any broker): a header with a date, a narration
 *  and a money column. Used by the Cash & Ledger uploader, which asks the user
 *  for the file and so needs no broker name. */
export function detectDhanLedger(text: string): number {
  if (!text) return 0;
  if (isDhanGtrText(text) || isDhanPnlText(text) || isDhanDividendText(text)) return 0;
  const lines = text.split(/\r?\n/).slice(0, 40);
  const hasHeader = lines.some((l) => {
    const c = splitCsvLine(l);
    return c.length >= 3 && findColumns(c) != null;
  });
  if (!hasHeader) return 0;
  const looksLedger = /ledger|running balance|opening balance/i.test(text);
  return looksLedger ? 0.9 : 0.5;
}

/**
 * The DROPZONE detector for the Dhan ledger (registered as `dhan-ledger`).
 *
 * Unlike `detectDhanLedger`, this one claims a file nobody has vouched for, so
 * it follows the house rule: the Dhan header fingerprint carries the claim;
 * a generic ledger shape earns one only under a Dhan-named file. A ledger
 * from another broker belongs to the column mapper's question, not here.
 */
export function detectDhanLedgerFile(ctx: { filename: string; text?: string }): number {
  const text = ctx.text ?? "";
  if (!text) return 0;
  if (isDhanGtrText(text) || isDhanPnlText(text) || isDhanDividendText(text)) return 0;
  const named = /dhan/i.test(ctx.filename);
  if (isDhanLedgerText(text)) {
    let score = 0.9;
    if (/^Ledger Statement/im.test(text)) score += 0.05;
    if (named) score += 0.05;
    return Math.min(1, score);
  }
  return named && detectDhanLedger(text) > 0 ? 0.6 : 0;
}

/** The dropzone detector for the Dhan dividend payout CSV (`dhan-dividend`). */
export function detectDhanDividend(ctx: { filename: string; text?: string }): number {
  const text = ctx.text ?? "";
  if (!text) return 0;
  if (isDhanGtrText(text) || isDhanPnlText(text) || isDhanLedgerText(text)) return 0;
  if (!isDhanDividendText(text)) return 0;
  let score = 0.9;
  if (/^Dividend payout report/im.test(text)) score += 0.05;
  if (/dhan/i.test(ctx.filename)) score += 0.05;
  return Math.min(1, score);
}

export interface ParsedLedger {
  rows: LedgerRow[];
  /** Real MTF interest charged over the file's window, as a positive rupee cost. */
  mtfInterestTotal: number;
  /** Rows the classifier could not read — surfaced, never hidden. */
  unclassified: LedgerRow[];
  /** The ledger's own opening balance, when it states one. Not an entry. */
  openingBalance: number | null;
  from: string | null;
  to: string | null;
  warnings: string[];
  /** Which Dhan cash file this came from — the ledger route stores it as the
   *  entries' `source`. */
  source?: "dhan-ledger" | "dhan-dividend";
}

/**
 * Read a Dhan ledger export.
 *
 * Debit/credit are collapsed into ONE signed amount, negative for money leaving
 * the account, because a ledger that keeps two columns forces every downstream
 * consumer to re-derive the sign and eventually one of them gets it backwards.
 */
export function parseDhanLedger(text: string): ParsedLedger {
  const lines = text.split(/\r?\n/);
  let cols: Cols | null = null;
  let headerAt = -1;

  for (let i = 0; i < Math.min(lines.length, 60); i++) {
    const c = splitCsvLine(lines[i]);
    const found = findColumns(c);
    if (found) { cols = found; headerAt = i; break; }
  }

  const warnings: string[] = [];
  if (!cols) {
    return {
      rows: [], mtfInterestTotal: 0, unclassified: [], openingBalance: null, from: null, to: null,
      warnings: ["Could not find a ledger header row (needs a date column, a narration/particulars column and a debit/credit or amount column)."],
    };
  }

  const rows: LedgerRow[] = [];
  let openingBalance: number | null = null;
  for (let i = headerAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const c = splitCsvLine(line);
    // The footer `Opening Balance,<v>,Closing Balance,<v>` (real Dhan export,
    // 2026-09-04) is the ledger's own statement and outranks the marker row.
    if (/^opening balance$/i.test(c[0] ?? "") && c[1] !== undefined && c[1] !== "") {
      openingBalance = num(c[1]);
      continue;
    }
    const date = parseLedgerDate(c[cols.date] ?? "");
    if (!date) continue; // totals rows, footers, blank separators

    const narration = c[cols.narration] ?? "";
    const debit = cols.debit >= 0 ? num(c[cols.debit]) : 0;
    const credit = cols.credit >= 0 ? num(c[cols.credit]) : 0;
    // Prefer explicit debit/credit; fall back to a single signed amount column.
    const amount =
      debit || credit
        ? Math.round((credit - debit) * 100) / 100
        : cols.amount >= 0
          ? Math.round(num(c[cols.amount]) * 100) / 100
          : 0;

    // A balance marker is not an entry; capture it and move on. This is also
    // where Dhan's OPENING BALANCE row lands — pinned to the top out of date
    // order, and on one real account dated 01-01-1970 (the epoch): a marker
    // row is never emitted, so that date can never become the window's start.
    // Dhan puts the opening figure in the CREDIT column and leaves Net Balance
    // at 0, so the balance column is only trusted when it says something.
    if (isBalanceMarker(narration)) {
      if (openingBalance == null && /opening|brought forward|b\/f/i.test(narration)) {
        const stated = cols.balance >= 0 ? num(c[cols.balance]) : 0;
        openingBalance = stated !== 0 ? stated : Math.round((credit - debit) * 100) / 100;
      }
      continue;
    }

    // Classify on BOTH free-text columns: Dhan's Narration reads "Money added
    // to your Trading Account" while its Description says "Funds Deposited" —
    // either alone can miss a rule the other satisfies.
    const description = cols.description >= 0 ? (c[cols.description] ?? "") : "";
    const { kind, unclassified } = classifyNarration(description ? `${narration} | ${description}` : narration);
    rows.push({
      date,
      narration,
      amount,
      kind,
      unclassified,
      balance: cols.balance >= 0 ? num(c[cols.balance]) : null,
    });
  }

  const mtf = rows.filter((r) => r.kind === "mtf_interest");
  // Interest is a cost; report it positive so it reads as a charge everywhere.
  const mtfInterestTotal = Math.round(mtf.reduce((s, r) => s + Math.abs(r.amount), 0) * 100) / 100;
  const unclassifiedRows = rows.filter((r) => r.unclassified);
  const dates = rows.map((r) => r.date).sort();

  if (rows.length === 0) warnings.push("Header found, but no dated rows followed it.");
  if (mtf.length > 0) {
    warnings.push(
      `${mtf.length} MTF financing entr${mtf.length === 1 ? "y" : "ies"} totalling ₹${mtfInterestTotal.toLocaleString("en-IN")} — this is what you were ACTUALLY charged, not an estimate.`,
    );
  } else {
    warnings.push("No MTF entries in this ledger. Dhan posts MTF interest weekly, so a short window can legitimately contain none.");
  }
  if (unclassifiedRows.length > 0) {
    warnings.push(
      `${unclassifiedRows.length} row${unclassifiedRows.length === 1 ? "" : "s"} could not be classified from the narration and ${unclassifiedRows.length === 1 ? "is" : "are"} listed for review rather than filed under a guess.`,
    );
  }

  return {
    rows,
    mtfInterestTotal,
    unclassified: unclassifiedRows,
    openingBalance,
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
    warnings,
    source: "dhan-ledger",
  };
}

export interface MtfReconciliation {
  /** What the broker actually charged, from the ledger. */
  actual: number;
  /** What Vyuha estimated across its MTF trades. */
  estimated: number;
  delta: number;
  deltaPct: number | null;
}

/**
 * Compare the real interest against Vyuha's estimate.
 *
 * Deliberately a COMPARISON, not a correction. Ledger interest is a weekly
 * account-level posting; splitting it back across individual positions would
 * mean inventing a per-trade allocation the broker never stated — the exact
 * class of fabrication this codebase refuses elsewhere. Showing both numbers
 * lets the trader see whether the estimate is trustworthy, which is the honest
 * thing the data supports.
 */
export function reconcileMtfInterest(actual: number, estimated: number): MtfReconciliation {
  const delta = Math.round((actual - estimated) * 100) / 100;
  return {
    actual: Math.round(actual * 100) / 100,
    estimated: Math.round(estimated * 100) / 100,
    delta,
    deltaPct: estimated > 0 ? Math.round((delta / estimated) * 10000) / 100 : null,
  };
}

// ── Dividend payout CSV ──────────────────────────────────────────────────────
//
// Verified on a real export 2026-09-04: `Dividend payout report,From … to …`,
// a 4-line identity preamble, a blank line, then
// `Date, Scrip Name, Dividend Per Share, Quantity, Dividend Paid`, a blank
// line, `Total Stocks Count,<n>,Total Dividend Earned,<₹>` and the download
// note. Dates are `dd-Mon-yy`. It is a CASH file: every row is money that
// reached the account, so it becomes ledger rows of the dividend kind — the
// same table the ledger import writes, never a trade.

/**
 * Read a Dhan dividend payout report into ledger rows (kind `dividend`,
 * amount positive — money in). The file's own `Total Dividend Earned` is
 * checked against the rows and a mismatch is reported, not hidden.
 */
export function parseDhanDividend(text: string): ParsedLedger {
  const lines = text.split(/\r?\n/);
  const headerAt = lines.findIndex((l) => DIVIDEND_HEADER_RE.test(l));
  const empty = (warnings: string[]): ParsedLedger => ({
    rows: [], mtfInterestTotal: 0, unclassified: [], openingBalance: null, from: null, to: null,
    warnings, source: "dhan-dividend",
  });
  if (headerAt < 0) {
    return empty(["Could not find the dividend header row (Date, Scrip Name, Dividend Per Share, Quantity, Dividend Paid)."]);
  }
  const header = splitCsvLine(lines[headerAt]).map((h) => h.toLowerCase());
  const col = (k: string) => header.findIndex((h) => h.includes(k));
  const cDate = col("date"), cScrip = col("scrip"), cDps = col("per share"), cQty = col("quantity"), cPaid = col("dividend paid");

  const rows: LedgerRow[] = [];
  let statedTotal: number | null = null;
  for (let i = headerAt + 1; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    if (/^total stocks count$/i.test(c[0] ?? "")) {
      const t = c.findIndex((x) => /^total dividend earned$/i.test(x));
      if (t >= 0) statedTotal = num(c[t + 1]);
      continue;
    }
    const date = parseLedgerDate(c[cDate] ?? "");
    if (!date) continue;
    const scrip = (c[cScrip] ?? "").trim();
    const paid = Math.round(num(c[cPaid]) * 100) / 100;
    if (!scrip && paid === 0) continue;
    const qty = cQty >= 0 ? c[cQty] : "";
    const dps = cDps >= 0 ? c[cDps] : "";
    rows.push({
      date,
      narration: `Dividend ${scrip}${qty ? ` — ${qty} × ₹${dps}` : ""}`.trim(),
      amount: paid,
      kind: "dividend",
      unclassified: false,
      balance: null,
    });
  }

  const warnings: string[] = [];
  const total = Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100;
  if (rows.length === 0) warnings.push("Header found, but no dated dividend rows followed it.");
  else warnings.push(`${rows.length} dividend credit${rows.length === 1 ? "" : "s"} totalling ₹${total.toLocaleString("en-IN")}.`);
  if (statedTotal != null && Math.abs(statedTotal - total) > 0.005) {
    warnings.push(`The file states Total Dividend Earned ₹${statedTotal.toLocaleString("en-IN")} but its rows sum to ₹${total.toLocaleString("en-IN")} — check the export before committing.`);
  }
  const dates = rows.map((r) => r.date).sort();
  return {
    rows, mtfInterestTotal: 0, unclassified: [], openingBalance: null,
    from: dates[0] ?? null, to: dates[dates.length - 1] ?? null, warnings, source: "dhan-dividend",
  };
}

/** What the Cash & Ledger uploader calls: the dividend report and the ledger
 *  share one door, told apart by their verified headers. */
export function parseDhanCashFile(text: string): ParsedLedger {
  return isDhanDividendText(text) ? parseDhanDividend(text) : parseDhanLedger(text);
}

// ── Dropzone registration ────────────────────────────────────────────────────
//
// Both cash files are REGISTERED import sources so the dropzone can name them
// (the PDF pattern in registry-meta.ts): before 2026-09-04 neither was, and
// `dhan-csv` claimed both at 0.30 on the word "dhan" in the FILENAME alone —
// the misclaim class AGENTS.md forbids. Neither produces trades; the parse
// says what the file is and where it goes.

export function parseDhanLedgerSource(ctx: ParseContext): ParsedFile {
  const parsed = parseDhanLedger(ctx.text ?? "");
  const window = parsed.from ? ` (${parsed.rows.length} entries, ${parsed.from} → ${parsed.to})` : "";
  return {
    sourceId: "dhan-ledger",
    broker: "dhan",
    format: "ledger",
    trades: [],
    warnings: [
      `This is a Dhan ledger${window} — cash movements, charges and the weekly MTF interest postings, not trades. Nothing is imported from here: upload it on the Cash & Ledger screen, which previews the MTF reconciliation before it writes anything.`,
      ...parsed.warnings,
    ],
  };
}

export function parseDhanDividendSource(ctx: ParseContext): ParsedFile {
  const parsed = parseDhanDividend(ctx.text ?? "");
  return {
    sourceId: "dhan-dividend",
    broker: "dhan",
    format: "ledger",
    trades: [],
    warnings: [
      "This is a Dhan dividend payout report — money credited to the account, not trades. Nothing is imported from here: upload it on the Cash & Ledger screen and it lands as dividend entries.",
      ...parsed.warnings,
    ],
  };
}
