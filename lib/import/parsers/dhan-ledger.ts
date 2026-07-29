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

  const long = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,})[\s-](\d{4})/);
  if (long) {
    const mm = MONTHS[long[2].toLowerCase().slice(0, 3)];
    if (!mm) return null;
    return `${long[3]}-${mm}-${long[1].padStart(2, "0")}`;
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
  debit: number;
  credit: number;
  amount: number;
  balance: number;
}

export function findColumns(header: string[]): Cols | null {
  const idx = (...keys: string[]) =>
    header.findIndex((h) => {
      const x = h.toLowerCase().replace(/[^a-z]/g, "");
      return keys.some((k) => x.includes(k));
    });

  const cols: Cols = {
    date: idx("date"),
    narration: idx("narration", "particular", "description", "voucher", "remark"),
    debit: idx("debit", "dr"),
    credit: idx("credit", "cr"),
    amount: idx("amount", "net"),
    balance: idx("balance", "running"),
  };
  // A ledger needs at minimum a date, something to read, and a money column.
  if (cols.date < 0 || cols.narration < 0) return null;
  if (cols.debit < 0 && cols.credit < 0 && cols.amount < 0) return null;
  return cols;
}

export function detectDhanLedger(text: string): number {
  if (!text) return 0;
  const lines = text.split(/\r?\n/).slice(0, 40);
  const hasHeader = lines.some((l) => {
    const c = splitCsvLine(l);
    return c.length >= 3 && findColumns(c) != null;
  });
  if (!hasHeader) return 0;
  const looksLedger = /ledger|running balance|opening balance/i.test(text);
  return looksLedger ? 0.9 : 0.5;
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

    // A balance marker is not an entry; capture it and move on.
    if (isBalanceMarker(narration)) {
      if (openingBalance == null && cols.balance >= 0) openingBalance = num(c[cols.balance]);
      continue;
    }

    const { kind, unclassified } = classifyNarration(narration);
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
