/**
 * Angel One P&L statement (`ProfitLoss_Statement_<code>.xlsx`).
 *
 * VERIFIED against a real owner export, 2026-09-04 (window 2026-08-01 ->
 * 2026-08-31), redacted to
 * `tests/fixtures/redacted/angelone-profitloss-2026-08-01_2026-08-31.xlsx`.
 *
 * -- THE NAMED EXCEPTION TO THE NAME RULE ---------------------------------
 * AGENTS.md: "a broker-named parser must SEE the broker's name before it
 * claims a file". This file contains NO broker name anywhere -- not in a
 * banner, not in a column header, not in the disclaimer text, and the real
 * filename (`ProfitLoss_Statement_<client code>.xlsx`) names nobody either.
 *
 * OWNER RULING (2026-09-04): the FORMAT is the fingerprint here, and it is a
 * strong one -- BOTH sheet names `Equity P&L` and `F&O P&L` present in one
 * workbook, AND the two verified header rows (18 columns and 16 columns,
 * listed below) found inside them. That conjunction is worth 0.9; "Angel" or
 * "ProfitLoss_Statement" in the filename adds 0.1. This is the ONLY parser in
 * the repo allowed to claim on format alone, it is recorded here as a
 * deliberate exception rather than a precedent, and `detectAngelOnePnlStatement`
 * scores 0 on Angel's own tax P&L (sheets `Summary` /
 * `Equity+Bonds+SGB Trade Details` / ...), which is a different file.
 *
 * -- Sheet "Equity P&L": TWO STACKED TABLES, located by TITLE TEXT ---------
 * A label block, an `Equity P&L Summary` block (Total Gross PnL, Total
 * Brokerage, Total GST, Total Exchange Service Tax, Total Turnover Tax, Total
 * SEBI Charges, Total Stamp Duty, Total STT, Total Other Charges, Total IPFT
 * Charges, Net PnL, Intraday Net PnL), then:
 *   title `Delivery PnL`, header row, rows, `Total` row
 *   title `Intraday PnL`, header row, rows, `Total` row
 * Both headers are 18 columns; only the last differs (`Net PnL` vs
 * `Intraday PnL`):
 *   Scrip Symbol | Company Name | Quantity | Avg Buy Price | Buy Value |
 *   Avg Sell Price | Sell Value | Gross PnL | Brokerage | GST |
 *   Exchange Service Tax | Turnover Tax | SEBI Charges | Stamp Duty | STT |
 *   Other Charges | IPFT Charges | Net PnL (or Intraday PnL)
 *
 * -- Sheet "F&O P&L": one table, 16 columns --------------------------------
 *   Scrip Symbol | Quantity | Avg Buy Price | Buy price | Avg Sell Price |
 *   Sell Price | Gross PnL | Brokerage | GST | Turnover Tax | SEBI Charges |
 *   Stamp Duty | STT | Other Charges | IPFT Charges | Net PnL
 * `Buy price` / `Sell Price` are TOTALS, not per-unit levels (verified:
 * 65 x 17.65 = 1147.25), so they map to buyValue / sellValue.
 *
 * -- What this file is NOT -------------------------------------------------
 * There is NO ISIN column on either sheet, so every scrip reference is keyed
 * by SYMBOL. There is also NO DATE column of any kind -- no sell date, no
 * close date -- so `asOf` is null on every row and the FY comes from the
 * statement's own `To Date`. Nothing is invented to fill either.
 *
 * The file states P&L; it does not state the trades that produced it. Angel's
 * book remains `Trades_History` (parser `angelone`); this is a REFERENCE
 * source and emits no trades.
 */
import type { ParseContext, ParsedFile, ReferenceRow } from "../types";
import { parseLedgerDate } from "./dhan-ledger";
import { money, sheetMatrices } from "./upstox-ledger";

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
const r2 = (n: number) => Math.round(n * 100) / 100;

const EQUITY_SHEET = /^equity p&l$/i;
const FNO_SHEET = /^f&o p&l$/i;

/** The columns that must be present for a table to be the verified one. */
const EQUITY_MUST = ["scripsymbol", "companyname", "quantity", "buyvalue", "sellvalue", "grosspnl", "stt", "ipftcharges"];
const FNO_MUST = ["scripsymbol", "quantity", "buyprice", "sellprice", "grosspnl", "stt", "ipftcharges"];

/** Charge columns, in the order Angel writes them. Summed into totalCharges. */
const CHARGE_COLUMNS = ["brokerage", "gst", "exchangeservicetax", "turnovertax", "sebicharges", "stampduty", "stt", "othercharges", "ipftcharges"];

function headerRowIn(rows: string[][], must: string[], from = 0): number {
  for (let i = from; i < rows.length; i++) {
    const cells = rows[i]!.map(norm);
    if (must.every((h) => cells.includes(h))) return i;
  }
  return -1;
}

/**
 * Confidence this workbook is an Angel One P&L statement.
 *
 * BINARY container only. See the file header for why FORMAT is allowed to be
 * the whole fingerprint here.
 */
export function detectAngelOnePnlStatement(ctx: ParseContext): number {
  if (ctx.text != null) return 0;
  if (!ctx.buffer) return 0;
  const sheets = sheetMatrices(ctx);
  const equity = sheets.find((s) => EQUITY_SHEET.test(s.name));
  const fno = sheets.find((s) => FNO_SHEET.test(s.name));
  if (!equity || !fno) return 0;                       // both sheet names, or no claim
  if (headerRowIn(equity.rows, EQUITY_MUST) < 0) return 0;
  if (headerRowIn(fno.rows, FNO_MUST) < 0) return 0;
  const named = /angel/i.test(ctx.filename) || /profitloss[_ -]?statement/i.test(ctx.filename);
  return Math.min(1, 0.9 + (named ? 0.1 : 0));
}

/** Indian financial year label for an ISO date: April to March. */
export function fyOf(iso: string | null): string | null {
  if (!iso) return null;
  const [y, m] = iso.split("-").map(Number);
  if (!y || !m) return null;
  return m >= 4 ? `${y}-${String((y + 1) % 100).padStart(2, "0")}` : `${y - 1}-${String(y % 100).padStart(2, "0")}`;
}

/** The statement's own `To Date` (label block), which fixes the FY. */
function toDateOf(rows: string[][]): string | null {
  for (const r of rows.slice(0, 20)) {
    for (let i = 0; i < r.length; i++) {
      if (norm(r[i]) === "todate" && r[i + 1]) return parseLedgerDate(String(r[i + 1]));
    }
  }
  return null;
}

/** A label/value block cell, e.g. `Total Gross PnL | 1.74`. */
function labelled(rows: string[][], label: string, upto: number): number | null {
  for (const r of rows.slice(0, upto)) {
    for (let i = 0; i < r.length; i++) {
      if (norm(r[i]) === norm(label) && r[i + 1] !== undefined && r[i + 1] !== "") return r2(money(r[i + 1]));
    }
  }
  return null;
}

interface Table { note: string; header: number; rows: string[][]; total: string[] | null }

/**
 * Read one titled table out of a sheet: the title text, then the first header
 * row at or after it, its rows, and its `Total` row. Never a fixed row index.
 */
function tableAt(rows: string[][], title: RegExp, must: string[], note: string): Table | null {
  const t = rows.findIndex((r) => title.test((r[0] ?? "").trim()));
  if (t < 0) return null;
  const h = headerRowIn(rows, must, t);
  if (h < 0) return null;
  const body: string[][] = [];
  let total: string[] | null = null;
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i]!;
    // A blank row is SKIPPED, not a terminator: the F&O table puts one
    // between its last row and its Total. A row with only column 0 filled IS
    // a terminator -- that is the next stacked table's title, or the
    // Disclaimer block.
    if (r.every((c) => c === "")) continue;
    if (/^total$/i.test((r[0] ?? "").trim())) { total = r; break; }
    if (r.filter((c) => c !== "").length === 1 && r[0] !== "") break;
    body.push(r);
  }
  return { note, header: h, rows: body, total };
}

export interface ParsedAngelPnlStatement {
  reference: ReferenceRow[];
  fy: string | null;
  warnings: string[];
}

function figuresFrom(header: string[], row: string[], fno: boolean): Record<string, number> {
  const hd = header.map(norm);
  const at = (...names: string[]) => { for (const n of names) { const i = hd.indexOf(n); if (i >= 0) return i; } return -1; };
  const val = (i: number) => (i >= 0 && row[i] !== undefined && row[i] !== "" ? r2(money(row[i])) : null);
  const figures: Record<string, number> = {};
  const put = (k: string, v: number | null) => { if (v != null) figures[k] = v; };
  put("qty", val(at("quantity")));
  put("buyValue", val(fno ? at("buyprice", "buyvalue") : at("buyvalue")));
  put("sellValue", val(fno ? at("sellprice", "sellvalue") : at("sellvalue")));
  put("grossPnl", val(at("grosspnl")));
  put("netPnl", val(at("netpnl", "intradaypnl")));
  let charges = 0, seen = false;
  for (const c of CHARGE_COLUMNS) {
    const v = val(at(c));
    if (v != null) { charges += v; seen = true; }
  }
  if (seen) figures.totalCharges = r2(charges);
  return figures;
}

export function parseAngelOnePnlStatement(ctx: ParseContext): ParsedAngelPnlStatement {
  const warnings: string[] = [
    "Angel's P&L statement is a reference; the book is Trades_History. The figures here are what the broker states, shown beside Vyuha's own - no trades are imported from this file.",
  ];
  const sheets = sheetMatrices(ctx);
  const equity = sheets.find((s) => EQUITY_SHEET.test(s.name));
  const fno = sheets.find((s) => FNO_SHEET.test(s.name));
  if (!equity || !fno) {
    return { reference: [], fy: null, warnings: ["This workbook does not carry both an `Equity P&L` and an `F&O P&L` sheet."] };
  }

  const asOfDate = toDateOf(equity.rows) ?? toDateOf(fno.rows);
  const fy = fyOf(asOfDate);
  if (!asOfDate) warnings.push("The statement states no `To Date`, so no financial year could be attached to its figures.");
  warnings.push("This statement carries no date column on either sheet, so every scrip figure is stated for the whole window rather than for a sell date, and `asOf` is left empty rather than guessed.");
  warnings.push("Neither sheet carries an ISIN column, so scrip references are keyed by SYMBOL.");

  const reference: ReferenceRow[] = [];
  const tables: { table: Table | null; sheet: string[][]; fno: boolean; note: string }[] = [
    { table: tableAt(equity.rows, /^delivery pnl$/i, EQUITY_MUST, "delivery"), sheet: equity.rows, fno: false, note: "delivery" },
    { table: tableAt(equity.rows, /^intraday pnl$/i, EQUITY_MUST, "intraday"), sheet: equity.rows, fno: false, note: "intraday" },
    { table: tableAt(fno.rows, /^derivative p&l summary$/i, FNO_MUST, "fno"), sheet: fno.rows, fno: true, note: "fno" },
  ];

  for (const { table, sheet, fno: isFno, note } of tables) {
    if (!table || table.header < 0) {
      warnings.push(`The ${note} table could not be located by its title text.`);
      continue;
    }
    const header = sheet[table.header]!;
    for (const row of table.rows) {
      const symbol = (row[0] ?? "").trim();
      if (!symbol) continue;
      reference.push({
        scope: "scrip", key: symbol, isin: null, symbol, fy, asOf: null,
        figures: figuresFrom(header, row, isFno), note,
      });
    }
    if (table.total) {
      reference.push({
        scope: "fy", key: fy ?? "unknown", isin: null, symbol: null, fy, asOf: null,
        figures: figuresFrom(header, table.total, isFno), note,
      });
    } else {
      warnings.push(`The ${note} table states no Total row, so its figures could not be reconciled against the statement summary.`);
    }
  }

  // -- Segment rows, from each sheet's own summary block ---------------------
  const segFigures = (rows: string[][], upto: number): Record<string, number> => {
    const f: Record<string, number> = {};
    const put = (k: string, v: number | null) => { if (v != null) f[k] = v; };
    put("grossPnl", labelled(rows, "Total Gross PnL", upto));
    put("netPnl", labelled(rows, "Net PnL", upto));
    let charges = 0, seen = false;
    for (const [label] of [["Total Brokerage"], ["Total GST"], ["Total Exchange Service Tax"], ["Total Turnover Tax"], ["Total SEBI Charges"], ["Total Stamp Duty"], ["Total STT"], ["Total Other Charges"], ["Total IPFT Charges"]]) {
      const v = labelled(rows, label!, upto);
      if (v != null) { charges += v; seen = true; }
    }
    if (seen) f.totalCharges = r2(charges);
    return f;
  };
  const equityHeader = headerRowIn(equity.rows, EQUITY_MUST);
  const fnoHeader = headerRowIn(fno.rows, FNO_MUST);
  reference.push({ scope: "segment", key: "equity", isin: null, symbol: null, fy, asOf: null, figures: segFigures(equity.rows, equityHeader < 0 ? 25 : equityHeader), note: "equity" });
  reference.push({ scope: "segment", key: "fno", isin: null, symbol: null, fy, asOf: null, figures: segFigures(fno.rows, fnoHeader < 0 ? 22 : fnoHeader), note: "fno" });

  // -- Conservation: the tables' Totals must add up to the summary block -----
  const tableSum = (scope: "fy", field: string, notes: string[]) =>
    r2(reference.filter((r) => r.scope === scope && notes.includes(String(r.note))).reduce((s, r) => s + (r.figures[field] ?? 0), 0));
  const eqSummaryGross = labelled(equity.rows, "Total Gross PnL", equityHeader < 0 ? 25 : equityHeader);
  const eqTablesGross = tableSum("fy", "grossPnl", ["delivery", "intraday"]);
  if (eqSummaryGross != null && Math.abs(eqSummaryGross - eqTablesGross) > 0.005) {
    warnings.push(`Equity P&L: the summary states a gross P&L of Rs${eqSummaryGross} but the Delivery and Intraday totals sum to Rs${eqTablesGross}.`);
  }
  const fnoSummaryGross = labelled(fno.rows, "Total Gross PnL", fnoHeader < 0 ? 22 : fnoHeader);
  const fnoTablesGross = tableSum("fy", "grossPnl", ["fno"]);
  if (fnoSummaryGross != null && Math.abs(fnoSummaryGross - fnoTablesGross) > 0.005) {
    warnings.push(`F&O P&L: the summary states a gross P&L of Rs${fnoSummaryGross} but the table total is Rs${fnoTablesGross}.`);
  }

  const scrips = reference.filter((r) => r.scope === "scrip").length;
  warnings.push(`${scrips} scrip figure(s) read across delivery, intraday and F&O${fy ? `, all stated for FY ${fy}` : ""}.`);
  return { reference, fy, warnings };
}

/** Dropzone registration: a reference source, so `trades` is empty. */
export function parseAngelOnePnlStatementSource(ctx: ParseContext): ParsedFile {
  const parsed = parseAngelOnePnlStatement(ctx);
  return {
    sourceId: "angelone-pnl-statement",
    broker: "angelone",
    format: "reference",
    trades: [],
    reference: parsed.reference,
    warnings: parsed.warnings,
  };
}
