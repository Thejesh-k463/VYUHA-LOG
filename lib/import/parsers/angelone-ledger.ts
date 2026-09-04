/**
 * Angel One account statement (`YourStatement_<code>.xlsx`).
 *
 * VERIFIED against a real owner export, 2026-09-04 (window 2026-08-01 ->
 * 2026-08-31), redacted to
 * `tests/fixtures/redacted/angelone-statement-2026-08-01_2026-08-31.xlsx`;
 * a second, zero-data-row copy of the same layout is
 * `tests/fixtures/redacted/YourStatement_TEST0000.xlsx`.
 *
 * -- Sheet "Broking Ledger" ------------------------------------------------
 *   label block (ClientCode / DateOfDownload / StartDate / EndDate),
 *   "Broking Ledger Balance Summary" -> Opening Balance | x | Closing Balance | y
 *   "Funds Summary" -> Total Credit / Total Debit
 *   "Transaction Details" then the header row
 *     Transaction | Date | Segment | Voucher | Debit | Credit | Running Balance
 *   8 data rows in the verified export, then a trailing `Msg | Ledger Statement`.
 *
 * -- Sheet "Charges": FOUR STACKED TABLES ----------------------------------
 * Each is a `Day wise details` line, a TITLE line, a header row, then its
 * rows. Their row indices differ per export (a table with rows pushes the
 * next one down), so every table is located by its TITLE TEXT and never by a
 * fixed row -- the defect class this codebase has paid for twice.
 *   DP Charges              Scrip Name | ISIN | Date | Quantity sold |
 *                           CDSL charge | Angelone charge | GST | Total charge
 *   Pledge/Unpledge Charges  ... + Pledge/Unpledge | Pledge/Unpledge type
 *   CUSPA Sell-off Charges  Scrip Name | Date | Charges levied | GST | Total charge
 *   Interest Charges        Type of Interest | Date | Interest applicable amount |
 *                           Interest charges
 * In the verified export only the DP table carries a row.
 *
 * -- The claim (AGENTS.md: NAME before SHAPE) ------------------------------
 * `Angelone charge` is a COLUMN HEADER Angel One writes into its own charges
 * sheet; no other examined broker uses that string. That is the in-content
 * name, and it satisfies the name rule on its own (0.9). "Angel" in the
 * filename adds 0.1 -- it never substitutes for the content fingerprint,
 * except at the 0.6 floor where a named file whose Charges sheet is absent
 * still has a readable Broking Ledger.
 *
 * -- Why the CHARGES tables do not become ledger entries -------------------
 * They are a BREAKDOWN of money the Broking Ledger has already posted, not
 * extra money. In the verified export the DP table's single row (Rs23.60 =
 * CDSL 3.50 + Angel 16.50 + GST 3.60) is the same rupees as the Broking
 * Ledger's `DP Charges` line -- and the ledger's running balance chains
 * through that line exactly once. Posting both would debit the account twice
 * for one charge, and the two rows even carry different dates (the charge
 * date vs the posting date), so the importer's date+amount de-duplication
 * would not catch it. The charge tables are therefore returned as
 * `chargeRows` (`LedgerRow`s of kind "charge", for display and for callers
 * that want the breakdown) and as `reference` rows of scope "charge" --
 * broker-stated figures Vyuha does not derive -- and never inside `rows`.
 */
import type { ParseContext, ParsedFile, ReferenceRow } from "../types";
import { classifyNarration, parseLedgerDate, type LedgerKind, type LedgerRow } from "./dhan-ledger";
import { money, sheetMatrices, type ParsedCashFile } from "./upstox-ledger";

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
const r2 = (n: number) => Math.round(n * 100) / 100;

/** The verified Broking Ledger header, as columns. */
const LEDGER_HEADER = ["transaction", "date", "segment", "voucher", "debit", "credit", "runningbalance"];
/** The in-content name: Angel One's own charges-sheet column. */
const ANGEL_COLUMN = "angelonecharge";

export interface AngelChargeTable {
  /** `dp` | `pledge` | `cuspa` | `interest` -- the reference row's `key`. */
  key: string;
  title: string;
  headers: string[];
  rows: string[][];
}

const CHARGE_TABLES: { key: string; title: RegExp }[] = [
  { key: "dp", title: /^dp charges$/i },
  { key: "pledge", title: /^pledge\/unpledge charges$/i },
  { key: "cuspa", title: /^cuspa sell-?off charges$/i },
  { key: "interest", title: /^interest charges$/i },
];

function findHeaderRow(rows: string[][], must: string[]): number {
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i]!.map(norm);
    if (must.every((h) => cells.includes(h))) return i;
  }
  return -1;
}

const sheetNamed = (ctx: ParseContext, re: RegExp) =>
  sheetMatrices(ctx).find((s) => re.test(s.name));

/**
 * Locate each charges table BY ITS TITLE TEXT. The header row is the first
 * non-blank row after the title; the body runs to the next blank row.
 */
export function readChargeTables(rows: string[][]): AngelChargeTable[] {
  const out: AngelChargeTable[] = [];
  for (const { key, title } of CHARGE_TABLES) {
    const t = rows.findIndex((r) => title.test((r[0] ?? "").trim()));
    if (t < 0) continue;
    let h = t + 1;
    while (h < rows.length && rows[h]!.every((c) => c === "")) h++;
    if (h >= rows.length) continue;
    const headers = rows[h]!.map((c) => c.trim());
    const body: string[][] = [];
    for (let i = h + 1; i < rows.length; i++) {
      if (rows[i]!.every((c) => c === "")) break;
      body.push(rows[i]!);
    }
    out.push({ key, title: headers.length ? (rows[t]![0] ?? "").trim() : "", headers, rows: body });
  }
  return out;
}

/**
 * Confidence this workbook is an Angel One account statement.
 *
 * BINARY container only (see `detectUpstoxLedger` for why).
 */
export function detectAngelOneLedger(ctx: ParseContext): number {
  if (ctx.text != null) return 0;
  if (!ctx.buffer) return 0;
  const sheets = sheetMatrices(ctx);
  if (sheets.length === 0) return 0;

  const ledger = sheets.find((s) => findHeaderRow(s.rows, LEDGER_HEADER) >= 0);
  if (!ledger) return 0;

  const namesAngel = sheets.some((s) => s.rows.some((r) => r.some((c) => norm(c) === ANGEL_COLUMN)));
  const named = /angel/i.test(ctx.filename);
  if (!namesAngel) return named ? 0.6 : 0; // shape without a name is never a claim
  return Math.min(1, 0.9 + (named ? 0.1 : 0));
}

/** Angel One states a transaction TYPE, so the kind is read from it first. */
export function classifyAngelRow(transaction: string, amount: number): { kind: LedgerKind; unclassified: boolean } {
  const t = String(transaction ?? "").toLowerCase();
  if (/funds?\s+added|funds?\s+receiv/.test(t)) return { kind: "deposit", unclassified: false };
  if (/funds?\s+withdraw|payout|funds?\s+transferred\s+out/.test(t)) return { kind: "withdrawal", unclassified: false };
  if (/trades?\s+executed/.test(t)) return { kind: "realised_pnl", unclassified: false };
  if (/interest/.test(t) && /margin|mtf|funding/.test(t)) return { kind: "mtf_interest", unclassified: false };
  if (/charge/.test(t)) return { kind: "charge", unclassified: false };
  void amount;
  return classifyNarration(transaction);
}

export interface ParsedAngelStatement extends ParsedCashFile {
  /** Charge-table detail rows. NOT part of `rows` -- see the file header. */
  chargeRows: LedgerRow[];
  /** Broker-stated charge figures, scope "charge", keyed by table. */
  reference: ReferenceRow[];
}

const FY = (iso: string | null): string | null => {
  if (!iso) return null;
  const [y, m] = iso.split("-").map(Number);
  if (!y || !m) return null;
  return m >= 4 ? `${y}-${String((y + 1) % 100).padStart(2, "0")}` : `${y - 1}-${String(y % 100).padStart(2, "0")}`;
};

export function parseAngelOneLedger(ctx: ParseContext): ParsedAngelStatement {
  const warnings: string[] = [];
  const empty = (w: string[]): ParsedAngelStatement => ({
    rows: [], chargeRows: [], reference: [], mtfInterestTotal: 0, unclassified: [],
    openingBalance: null, from: null, to: null, warnings: w, source: "angelone-ledger",
  });

  const sheets = sheetMatrices(ctx);
  const ledgerSheet = sheets.find((s) => findHeaderRow(s.rows, LEDGER_HEADER) >= 0);
  if (!ledgerSheet) {
    return empty(["Could not find the Angel One Broking Ledger header row (Transaction, Date, Segment, Voucher, Debit, Credit, Running Balance)."]);
  }
  const rows = ledgerSheet.rows;
  const h = findHeaderRow(rows, LEDGER_HEADER);
  const head = rows[h]!.map(norm);
  const col = (n: string) => head.indexOf(n);
  const cTxn = col("transaction"), cDate = col("date"), cSeg = col("segment"),
    cVou = col("voucher"), cDebit = col("debit"), cCredit = col("credit"), cBal = col("runningbalance");

  // The label block above the header states the account's own opening balance.
  let openingBalance: number | null = null;
  let statedCredit: number | null = null, statedDebit: number | null = null, statedClosing: number | null = null;
  for (const r of rows.slice(0, h)) {
    const cells = r.map((c) => c.trim());
    for (let i = 0; i < cells.length; i++) {
      const k = norm(cells[i]);
      if (k === "openingbalance" && cells[i + 1]) openingBalance = money(cells[i + 1]);
      if (k === "closingbalance" && cells[i + 1]) statedClosing = money(cells[i + 1]);
      if (k === "totalcredit" && cells[i + 1]) statedCredit = money(cells[i + 1]);
      if (k === "totaldebit" && cells[i + 1]) statedDebit = money(cells[i + 1]);
    }
  }

  const out: LedgerRow[] = [];
  for (let i = h + 1; i < rows.length; i++) {
    const c = rows[i]!;
    if (c.every((x) => x === "")) continue;
    if (/^msg$/i.test((c[0] ?? "").trim())) continue;
    const date = parseLedgerDate((c[cDate] ?? "").trim());
    if (!date) continue;
    const amount = r2(money(c[cCredit]) - money(c[cDebit]));
    const txn = (c[cTxn] ?? "").trim();
    const narration = [txn, cSeg >= 0 ? c[cSeg] : "", cVou >= 0 && c[cVou] ? `voucher ${c[cVou]}` : ""]
      .map((x) => String(x ?? "").trim()).filter(Boolean).join(" · ");
    const { kind, unclassified } = classifyAngelRow(txn, amount);
    out.push({ date, narration, amount, kind, unclassified, balance: cBal >= 0 && c[cBal] !== "" ? money(c[cBal]) : null });
  }

  // -- Conservation: the running balance must chain --------------------------
  let prev = openingBalance ?? 0;
  let broke = false;
  for (const r of out) {
    const expected = r2(prev + r.amount);
    if (r.balance != null) {
      if (!broke && Math.abs(r.balance - expected) > 0.005) {
        warnings.push(`The running balance breaks first at ${r.date} (${r.narration}): Rs${prev} ${r.amount < 0 ? "-" : "+"} Rs${Math.abs(r.amount)} should close at Rs${expected} but the file states Rs${r.balance}. Check the export before committing.`);
        broke = true;
      }
      prev = r.balance;
    } else {
      prev = expected;
    }
  }
  if (out.length && !broke) warnings.push(`The running balance chains through all ${out.length} rows from the stated opening balance of Rs${openingBalance ?? 0}.`);

  const sumCredit = r2(out.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0));
  const sumDebit = r2(out.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0));
  if (statedCredit != null && out.length && Math.abs(statedCredit - sumCredit) > 0.005) {
    warnings.push(`The Funds Summary states Total Credit Rs${statedCredit} but the rows sum to Rs${sumCredit}.`);
  }
  if (statedDebit != null && out.length && Math.abs(statedDebit - sumDebit) > 0.005) {
    warnings.push(`The Funds Summary states Total Debit Rs${statedDebit} but the rows sum to Rs${sumDebit}.`);
  }
  const lastBalance = out.length ? out[out.length - 1]!.balance : null;
  if (statedClosing != null && lastBalance != null && Math.abs(statedClosing - lastBalance) > 0.005) {
    warnings.push(`The summary states a closing balance of Rs${statedClosing} but the last row closes at Rs${lastBalance}.`);
  }

  // -- The Charges sheet: four stacked tables, located by title --------------
  const chargeRows: LedgerRow[] = [];
  const reference: ReferenceRow[] = [];
  const charges = sheetNamed(ctx, /^charges$/i);
  if (charges) {
    for (const table of readChargeTables(charges.rows)) {
      const hd = table.headers.map(norm);
      const at = (...names: string[]) => {
        for (const n of names) { const i = hd.indexOf(n); if (i >= 0) return i; }
        return -1;
      };
      const iDate = at("date");
      const iTotal = at("totalcharge", "interestcharges");
      const iScrip = at("scripname", "typeofinterest");
      const iIsin = at("isin");
      const iQty = at("quantitysold");
      const iGst = at("gst");
      const iCdsl = at("cdslcharge");
      const iBroker = at("angelonecharge");
      const iLevied = at("chargeslevied", "interestapplicableamount");
      for (const row of table.rows) {
        const date = iDate >= 0 ? parseLedgerDate((row[iDate] ?? "").trim()) : null;
        const total = iTotal >= 0 ? r2(money(row[iTotal])) : 0;
        const scrip = iScrip >= 0 ? (row[iScrip] ?? "").trim() : "";
        if (!date && !total && !scrip) continue;
        const figures: Record<string, number> = { amount: total };
        if (iQty >= 0 && row[iQty]) figures.qty = money(row[iQty]);
        if (iGst >= 0 && row[iGst] !== undefined && row[iGst] !== "") figures.gst = r2(money(row[iGst]));
        if (iCdsl >= 0 && row[iCdsl] !== undefined && row[iCdsl] !== "") figures.depositoryCharge = r2(money(row[iCdsl]));
        if (iBroker >= 0 && row[iBroker] !== undefined && row[iBroker] !== "") figures.brokerCharge = r2(money(row[iBroker]));
        if (iLevied >= 0 && row[iLevied] !== undefined && row[iLevied] !== "") figures.chargesLevied = r2(money(row[iLevied]));
        reference.push({
          scope: "charge",
          key: table.key,
          isin: iIsin >= 0 && row[iIsin] ? (row[iIsin] ?? "").trim() : null,
          symbol: scrip || null,
          fy: FY(date),
          asOf: date,
          figures,
          note: table.title || table.key,
        });
        chargeRows.push({
          date: date ?? (out[0]?.date ?? ""),
          narration: [table.title || table.key, scrip].filter(Boolean).join(" · "),
          amount: r2(-total),
          kind: "charge",
          unclassified: false,
          balance: null,
        });
      }
    }
  } else {
    warnings.push("This statement carries no Charges sheet, so no charge breakdown was read.");
  }

  if (chargeRows.length) {
    const total = r2(chargeRows.reduce((s, r) => s - r.amount, 0));
    warnings.push(`The Charges sheet details Rs${total} across ${chargeRows.length} charge row(s). These are a BREAKDOWN of charges the Broking Ledger has already posted, so they are reported as broker-stated reference figures and are NOT added to the ledger entries -- posting both would debit the account twice for one charge.`);
  }

  const unclassified = out.filter((r) => r.unclassified);
  if (unclassified.length) warnings.push(`${unclassified.length} row(s) matched no known transaction type and are shown for review.`);
  const dates = out.map((r) => r.date).sort();
  if (out.length === 0) warnings.push("The Broking Ledger header was found, but no dated rows followed it.");

  return {
    rows: out,
    chargeRows,
    reference,
    mtfInterestTotal: r2(out.filter((r) => r.kind === "mtf_interest").reduce((s, r) => s - Math.min(r.amount, 0), 0)),
    unclassified,
    openingBalance,
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
    warnings,
    source: "angelone-ledger",
  };
}

/** Dropzone registration. */
export function parseAngelOneLedgerSource(ctx: ParseContext): ParsedFile {
  const parsed = parseAngelOneLedger(ctx);
  const window = parsed.from ? ` (${parsed.rows.length} entries, ${parsed.from} to ${parsed.to})` : "";
  return {
    sourceId: "angelone-ledger",
    broker: "angelone",
    format: "ledger",
    trades: [],
    reference: parsed.reference,
    warnings: [
      `This is an Angel One account statement${window} - cash movements and a charges breakdown, not trades. Nothing is imported from here: upload it on the Cash & Ledger screen, which previews everything before it writes.`,
      ...parsed.warnings,
    ],
  };
}
