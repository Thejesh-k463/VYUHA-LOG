/**
 * Dhan **Demat Holding** summary (`Dhan_Demat_Holding_dd-mm-yyyy.xlsx`) —
 * what the depository says you actually own on one date.
 *
 * ZERO DB and ZERO React imports; pure functions over plain data.
 *
 * ── Verified on a real export, 2026-09-04 ────────────────────────────────
 *
 * One sheet, `Dhan_Demat_Holding` — the broker's name is IN THE SHEET NAME,
 * which is the in-content fingerprint AGENTS.md requires; the cells never say
 * "Dhan" anywhere else. Row 2 states the date in a single cell,
 * `Holding summary | For 01-07-2026`, beside the account identity labels.
 * Row 6 is the header
 *
 *   `Scrip Name | ISIN Code | Free Holding | Locked In | Safe Keep |
 *    MTF Pledge | Margin Pledge | CUSA Pledge | Closing Price | Valuation`
 *
 * then one row per scrip, a blank, and the footer `Valuation <total>` /
 * `Total Number of Securities <n>` / `NOTE : This sheet was downloaded at …`.
 *
 * ── The statement date ───────────────────────────────────────────────────
 *
 * Taken from the `For dd-mm-yyyy` DATE CELL in the title row — the file states
 * it, so it is read rather than inferred. The filename's `_dd-mm-yyyy` is the
 * fallback for a renamed or re-saved copy, and the two are checked against
 * each other: a disagreement is a warning, never a silent pick. Both are
 * day-first (Indian convention); a value whose month exceeds 12 while its day
 * could be a month is genuinely ambiguous and is REFUSED rather than guessed.
 *
 * ── What it emits ────────────────────────────────────────────────────────
 *
 * `reference` rows only, scope `holding`, keyed by ISIN and dated with the
 * statement date. NO trades and NO ledger: a holding is a position statement,
 * not a transaction, and inventing entries from it would double-count the
 * buys that are already in the tradebook.
 *
 * `figures.qty` is the TOTAL quantity in the demat account:
 *
 *     qty = Free Holding + Locked In + Safe Keep + MTF Pledge
 *           + Margin Pledge + CUSA Pledge
 *
 * — every bucket the depository prints, because pledged and locked stock is
 * still owned. `freeQty` and `mtfPledgeQty` are carried separately so the
 * reconciliation screen can show what is actually sellable, and the formula
 * is repeated in each row's `note` so nobody has to guess later.
 */

import * as XLSX from "xlsx";
import type { ParseContext, ParsedFile, ReferenceRow } from "../types";
import { workbookOf } from "../types";
import { parseTextMoney } from "./dhan-realised-pnl";

const SHEET_NAME = /dhan/i;

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z]/g, "");

const HEADER_FIELDS: Record<string, string> = {
  scripname: "scrip",
  isincode: "isin",
  freeholding: "free",
  lockedin: "locked",
  safekeep: "safeKeep",
  mtfpledge: "mtfPledge",
  marginpledge: "marginPledge",
  cusapledge: "cusaPledge",
  closingprice: "closingPrice",
  valuation: "valuation",
};

export type HoldingCols = Record<string, number>;

/** The header row, or null. Every one of the ten columns must be present. */
export function findHoldingHeader(rows: string[][]): { at: number; cols: HoldingCols } | null {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const c = rows[i]!.map(norm);
    const cols: HoldingCols = {};
    for (const [head, field] of Object.entries(HEADER_FIELDS)) cols[field] = c.indexOf(head);
    if (Object.values(cols).every((v) => v >= 0)) return { at: i, cols };
  }
  return null;
}

/**
 * `dd-mm-yyyy` → ISO, day-first.
 *
 * Refuses only the case that is genuinely ambiguous under the other reading:
 * a month above 12 whose day could itself be a month (`13-07` is fine — 13 can
 * only be a day; `07-13` is refused because 07-13 could be July the 13th).
 */
export function parseHoldingDate(raw: string): string | null {
  const m = /(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(String(raw ?? ""));
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]);
  if (mo > 12 && d <= 12) return null; // ambiguous: the file means the other order
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[3]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function sheetRows(ws: XLSX.WorkSheet): string[][] {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "" }) as unknown[][];
  return rows.map((r) => r.map((c) => String(c ?? "")));
}

function holdingSheet(ctx: ParseContext): { name: string; rows: string[][] } | null {
  if (ctx.text != null) return null;
  if (!ctx.buffer || !/\.xlsx?$/i.test(ctx.filename)) return null;
  let wb: XLSX.WorkBook;
  try {
    wb = workbookOf(ctx);
  } catch {
    return null;
  }
  for (const name of wb.SheetNames) {
    if (!SHEET_NAME.test(name)) continue;
    return { name, rows: sheetRows(wb.Sheets[name]!) };
  }
  return null;
}

/**
 * Detection. The sheet name names the broker (identity) and the ten-column
 * header is the format — both required for 0.9. `Holding summary` in the
 * title and "holding" in the filename add 0.05 each.
 */
export function detectDhanHoldings(ctx: ParseContext): number {
  const sheet = holdingSheet(ctx);
  if (!sheet) return 0;
  const found = findHoldingHeader(sheet.rows);
  if (!found) return 0;
  let score = 0.9;
  if (sheet.rows.slice(0, found.at).some((r) => r.some((c) => /holding\s*summary/i.test(c)))) score += 0.05;
  if (/holding/i.test(ctx.filename)) score += 0.05;
  return Math.min(1, score);
}

export interface ParsedHoldings {
  reference: ReferenceRow[];
  /** ISO statement date, or null when neither the cell nor the name states one. */
  asOf: string | null;
  /** Where the date came from — reported, never assumed. */
  asOfSource: "cell" | "filename" | null;
  /** Σ of the rows' valuation, rounded to the paisa. */
  valuation: number;
  /** The footer's own `Valuation` and `Total Number of Securities`. */
  statedValuation: number | null;
  statedCount: number | null;
  warnings: string[];
}

const empty = (warnings: string[]): ParsedHoldings => ({
  reference: [], asOf: null, asOfSource: null, valuation: 0, statedValuation: null, statedCount: null, warnings,
});

/** Read the Dhan demat holding summary. */
export function parseDhanHoldingsWorkbook(ctx: ParseContext): ParsedHoldings {
  const sheet = holdingSheet(ctx);
  if (!sheet) return empty(["This is not a Dhan demat holding workbook (no Dhan-named sheet)."]);
  const found = findHoldingHeader(sheet.rows);
  if (!found) {
    return empty(["Could not find the holdings header row (Scrip Name, ISIN Code, Free Holding, Locked In, Safe Keep, MTF Pledge, Margin Pledge, CUSA Pledge, Closing Price, Valuation)."]);
  }
  const { at, cols } = found;
  const warnings: string[] = [];

  // ── The statement date ────────────────────────────────────────────────
  let fromCell: string | null = null;
  for (const r of sheet.rows.slice(0, at)) {
    for (const c of r) {
      const m = /\bfor\b\s*([0-9]{1,2}[-/.][0-9]{1,2}[-/.][0-9]{4})/i.exec(c);
      if (m) { fromCell = parseHoldingDate(m[1]!); break; }
    }
    if (fromCell) break;
  }
  const nameMatch = /_(\d{2}[-/.]\d{2}[-/.]\d{4})/.exec(ctx.filename);
  const fromName = nameMatch ? parseHoldingDate(nameMatch[1]!) : null;
  const asOf = fromCell ?? fromName;
  const asOfSource: ParsedHoldings["asOfSource"] = fromCell ? "cell" : fromName ? "filename" : null;
  if (fromCell && fromName && fromCell !== fromName) {
    warnings.push(`The sheet says it is dated ${fromCell} but the filename says ${fromName}. The sheet's own date is used; check which copy this is.`);
  }
  if (!asOf) {
    warnings.push("This holding statement states no date, in the sheet or in its filename, so the figures are stored undated — they cannot be compared against a particular day's book.");
  }

  const reference: ReferenceRow[] = [];
  let statedValuation: number | null = null;
  let statedCount: number | null = null;

  for (let i = at + 1; i < sheet.rows.length; i++) {
    const r = sheet.rows[i]!;
    const cell = (n: number) => String(r[n] ?? "").trim();
    const first = cell(0);

    if (/^valuation$/i.test(first)) { statedValuation = parseTextMoney(cell(1)); continue; }
    if (/^total number of securities$/i.test(first)) { statedCount = parseTextMoney(cell(1)); continue; }
    if (/^note\b/i.test(first)) continue;

    const isin = cell(cols.isin!);
    const scrip = cell(cols.scrip!);
    if (!isin && !scrip) continue;

    const free = parseTextMoney(cell(cols.free!));
    const locked = parseTextMoney(cell(cols.locked!));
    const safeKeep = parseTextMoney(cell(cols.safeKeep!));
    const mtfPledge = parseTextMoney(cell(cols.mtfPledge!));
    const marginPledge = parseTextMoney(cell(cols.marginPledge!));
    const cusaPledge = parseTextMoney(cell(cols.cusaPledge!));
    const qty = Math.round((free + locked + safeKeep + mtfPledge + marginPledge + cusaPledge) * 1000) / 1000;

    reference.push({
      scope: "holding",
      key: isin || scrip,
      isin: isin || null,
      symbol: scrip || null,
      asOf,
      figures: {
        qty,
        freeQty: free,
        mtfPledgeQty: mtfPledge,
        closingPrice: parseTextMoney(cell(cols.closingPrice!)),
        valuation: Math.round(parseTextMoney(cell(cols.valuation!)) * 100) / 100,
      },
      note: "qty = free + locked-in + safe keep + MTF pledge + margin pledge + CUSA pledge",
    });
  }

  const valuation = Math.round(reference.reduce((s, r) => s + (r.figures.valuation ?? 0), 0) * 100) / 100;
  if (statedValuation !== null && Math.abs(valuation - statedValuation) >= 0.005) {
    warnings.push(
      `The rows are worth ₹${valuation.toFixed(2)} but the file's own Valuation says ₹${statedValuation.toFixed(2)} — a difference of ₹${(valuation - statedValuation).toFixed(2)}. Both figures are shown as stated; neither was adjusted.`,
    );
  }
  if (statedCount !== null && statedCount !== reference.length) {
    warnings.push(`The file says it holds ${statedCount} securities but ${reference.length} row${reference.length === 1 ? "" : "s"} could be read.`);
  }
  if (reference.length === 0) warnings.push("No holdings were found in this file.");

  return { reference, asOf, asOfSource, valuation, statedValuation, statedCount, warnings };
}

/** The registered import source. Reference figures only — never a trade. */
export function parseDhanHoldings(ctx: ParseContext): ParsedFile {
  const parsed = parseDhanHoldingsWorkbook(ctx);
  return {
    sourceId: "dhan-holdings",
    broker: "dhan",
    format: "holdings",
    trades: [],
    sourceRows: parsed.reference.length,
    reported: {
      valuation: parsed.valuation,
      ...(parsed.statedValuation !== null ? { statedValuation: parsed.statedValuation } : {}),
      ...(parsed.statedCount !== null ? { statedSecurities: parsed.statedCount } : {}),
    },
    reference: parsed.reference,
    warnings: [
      `This is a Dhan demat holding summary${parsed.asOf ? ` as at ${parsed.asOf}` : ""} — ${parsed.reference.length} securit${parsed.reference.length === 1 ? "y" : "ies"} the depository says you hold. It states positions, not transactions, so no trade is created: the figures are kept beside Vyuha's own for reconciliation.`,
      ...parsed.warnings,
    ],
  };
}
