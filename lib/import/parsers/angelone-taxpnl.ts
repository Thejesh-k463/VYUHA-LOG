/**
 * Angel One **Tax P&L** (XLSX, 5 sheets) — the richest Angel One export.
 *
 * ── Provenance (docs/BROKER_FORMATS.md, 2026-08-12) ─────────────────────────
 *
 * Sheet layout and every section's columns VERIFIED against a real export.
 * The fingerprint is `Angel One Limited` in `Summary!A1` — in-content, so a
 * renamed file still routes here and a file that merely shares column shape
 * cannot. The sample carried ZERO data rows: mapping is verified, value
 * behaviour (date formats, charge-column semantics) is INFERRED and coded
 * defensively.
 *
 * ── Why a section SCANNER rather than a header row ──────────────────────────
 *
 * The `Equity+Bonds+SGB Trade Details` sheet holds SEVEN independently-headed
 * sub-tables (Intraday, Delivery, Buyback, Transfer, Open Sell, Open
 * Holdings, Qty Breakup), each preceded by its own title row. A single-header
 * assumption reads one of them and silently drops the rest — so this walks
 * the sheet finding title rows, and each section is mapped by ITS OWN header.
 *
 * ── What is deliberately refused ────────────────────────────────────────────
 *
 *   - **Transfer Transactions.** A transferred-in scrip's "Transfer Price" is
 *     a valuation, not an acquisition this journal can price honestly; the
 *     rows are counted and reported, never imported.
 *   - Dividends and non-trade charges — cashflows, not trades. The ledger
 *     import owns those.
 *
 * ── MTF ─────────────────────────────────────────────────────────────────────
 *
 * `Qty Breakup` carries an explicit **MTF Qty** per ISIN — the only broker
 * examined that states MTF directly. Where MTF Qty covers a row's whole
 * quantity the row is tagged MTF outright; a partial figure becomes a note,
 * because splitting one row into two on a ratio would invent trades.
 */

import * as XLSX from "xlsx";
import type { NormalizedTrade, ProductHint } from "@/lib/engine/types";
import type { ParseContext, ParsedFile } from "../types";

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[\s_.&+/()-]/g, "");

const toNum = (v: unknown): number => {
  const x = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(x) ? x : 0;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NO: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** Tolerant date reader: ISO, dd-mm-yyyy, dd/mm/yyyy, dd Mon yyyy → ISO. */
export function flexDate(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{4})/);
  if (m) {
    const mm = MONTH_NO[m[2].toLowerCase().slice(0, 3)];
    if (mm) return `${m[3]}-${mm}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

/** ISO date → `dd Mon yyyy`, the grammar lib/engine/classify.ts parses. */
function toClassifierDate(iso: string): string {
  const [y, mo, d] = iso.split("-");
  return `${d} ${MONTHS[Number(mo) - 1]} ${y}`;
}

function sheetMatrix(wb: XLSX.WorkBook, name: string): string[][] {
  const ws = wb.Sheets[name];
  if (!ws) return [];
  return (XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "" }) as unknown[][]).map(
    (r) => r.map((c) => String(c ?? "")),
  );
}

export function detectAngelOneTaxPnl(ctx: ParseContext): number {
  if (!ctx.buffer) return 0;
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(ctx.buffer, { type: "buffer" });
  } catch {
    return 0;
  }
  const summary = wb.Sheets["Summary"];
  const a1 = summary ? String((summary["A1"] as { v?: unknown } | undefined)?.v ?? "") : "";
  // The fingerprint: the broker names ITSELF in the first cell.
  if (/angel\s*one\s*limited/i.test(a1)) return 0.95;
  // Fallback: the sheet set is distinctive even without the Summary sheet.
  if (wb.SheetNames.includes("Equity+Bonds+SGB Trade Details") && wb.SheetNames.includes("Derivatives Trade Details")) return 0.7;
  return 0;
}

interface Section {
  title: string;
  header: string[];
  rows: string[][];
}

/** Known section-title matchers, in the vocabulary the real export uses. */
const SECTION_TITLES: { key: string; re: RegExp }[] = [
  { key: "intraday", re: /^intraday\s*\(speculation\)/i },
  { key: "delivery", re: /^delivery\s*p&l/i },
  { key: "buyback", re: /^buyback\s*transactions/i },
  { key: "transfer", re: /^transfer\s*transactions/i },
  { key: "openSell", re: /^open\s*sell/i },
  { key: "openHoldings", re: /^open\s*holdings/i },
  { key: "qtyBreakup", re: /^qty\s*breakup/i },
  { key: "futures", re: /^futures$/i },
  { key: "options", re: /^options$/i },
];

/**
 * Walk a sheet, cutting it into titled sections.
 *
 * A section = a title row (matched above), then its own header row (the next
 * non-empty row), then data until a blank row, the next title, or the sheet
 * ends. Everything before the first title (the summary block) is skipped.
 */
export function scanSections(matrix: string[][]): Map<string, Section> {
  const out = new Map<string, Section>();
  let i = 0;
  while (i < matrix.length) {
    const first = (matrix[i][0] ?? "").trim();
    const hit = SECTION_TITLES.find((t) => t.re.test(first));
    if (!hit) { i++; continue; }

    // Header: next row with ≥2 filled cells.
    let h = i + 1;
    while (h < matrix.length && matrix[h].filter((c) => c.trim() !== "").length < 2) h++;
    if (h >= matrix.length) break;

    const header = matrix[h];
    const rows: string[][] = [];
    let j = h + 1;
    for (; j < matrix.length; j++) {
      const row = matrix[j];
      const firstCell = (row[0] ?? "").trim();
      if (SECTION_TITLES.some((t) => t.re.test(firstCell))) break;
      if (row.every((c) => c.trim() === "")) break;
      if (/^total$/i.test(firstCell)) continue; // footer rows are not trades
      rows.push(row);
    }
    if (!out.has(hit.key)) out.set(hit.key, { title: first, header, rows });
    i = j;
  }
  return out;
}

function colFinder(header: string[]) {
  const idx = header.map(norm);
  return (...cands: string[]): number => {
    for (const c of cands) {
      const i = idx.indexOf(norm(c));
      if (i >= 0) return i;
    }
    // contains-match fallback — Angel titles run long ("Closing Price(31/03/2026)").
    for (const c of cands) {
      const i = idx.findIndex((x) => x.includes(norm(c)));
      if (i >= 0) return i;
    }
    return -1;
  };
}

export function parseAngelOneTaxPnl(ctx: ParseContext): ParsedFile {
  const warnings: string[] = [];
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(ctx.buffer!, { type: "buffer" });
  } catch {
    return { sourceId: "angelone-taxpnl", broker: "angelone", format: "pnl", trades: [], warnings: ["Could not read this file as a workbook."] };
  }

  const equity = scanSections(sheetMatrix(wb, "Equity+Bonds+SGB Trade Details"));
  const deriv = scanSections(sheetMatrix(wb, "Derivatives Trade Details"));
  const trades: NormalizedTrade[] = [];

  // ── MTF map from Qty Breakup: isin → { mtf, total } ───────────────────────
  const mtfByIsin = new Map<string, { mtf: number; total: number }>();
  const qb = equity.get("qtyBreakup");
  if (qb) {
    const f = colFinder(qb.header);
    const cIsin = f("ISIN");
    const cTotal = f("Total Qty");
    const cMtf = f("MTF Qty");
    if (cIsin >= 0 && cMtf >= 0) {
      for (const r of qb.rows) {
        const isin = (r[cIsin] ?? "").trim();
        if (!isin) continue;
        mtfByIsin.set(isin, { mtf: toNum(r[cMtf]), total: cTotal >= 0 ? toNum(r[cTotal]) : 0 });
      }
    }
  }

  /** MTF verdict for one row. Full cover → hint; partial → note. */
  function mtfFor(isin: string | null, qty: number): { hint: boolean; note: string | null } {
    if (!isin) return { hint: false, note: null };
    const m = mtfByIsin.get(isin);
    if (!m || m.mtf <= 0) return { hint: false, note: null };
    if (m.mtf >= qty) return { hint: true, note: null };
    return { hint: false, note: `Qty Breakup shows ${m.mtf} of ${qty} as MTF — part of this position is broker-funded.` };
  }

  /** Angel states charges per row; STT is a separate column beside them. */
  function charges(cs: number, stt: number) {
    return { sttCtt: r2(stt), total: r2(cs + stt) };
  }

  const push = (t: NormalizedTrade) => {
    if (t.buyQty <= 0 && t.sellQty <= 0) return; // nothing traded, nothing to keep
    trades.push(t);
  };

  // ── Equity closed sections ─────────────────────────────────────────────────
  for (const [key, hint, dateCols] of [
    ["intraday", "intraday", { buy: ["Transaction Date"], sell: ["Transaction Date"] }],
    ["delivery", "delivery", { buy: ["Buy Date"], sell: ["Sell Date"] }],
    ["buyback", "delivery", { buy: ["Buy Date"], sell: ["Buyback Date"] }],
  ] as const) {
    const s = equity.get(key);
    if (!s) continue;
    const f = colFinder(s.header);
    const cIsin = f("ISIN"), cName = f("Scrip Name"), cQty = f("Qty", "Quantity");
    const cBuyP = f("Avg Buy Price"), cBuyV = f("Buy Value");
    const cSellP = f("Avg Sell Price", "Buyback Price"), cSellV = f("Sell Value", "Buyback Value");
    const cBuyD = f(...dateCols.buy), cSellD = f(...dateCols.sell);
    const cCs = f("Charges and Statutory"), cStt = f("STT");

    for (const r of s.rows) {
      const name = (r[cName] ?? "").trim();
      if (!name) continue;
      const qty = toNum(r[cQty]);
      const isin = cIsin >= 0 ? (r[cIsin] || null) : null;
      const mtf = mtfFor(isin, qty);
      const notes: string[] = [];
      if (key === "buyback") notes.push("Buyback — exited via the company's buyback, not a market sale.");
      if (mtf.note) notes.push(mtf.note);
      push({
        broker: "angelone",
        tradingsymbol: name,
        isin,
        buyQty: qty,
        avgBuyPrice: toNum(r[cBuyP]),
        buyValue: toNum(r[cBuyV]),
        sellQty: qty,
        avgSellPrice: toNum(r[cSellP]),
        sellValue: toNum(r[cSellV]),
        closingPrice: null,
        grossPnl: r2(toNum(r[cSellV]) - toNum(r[cBuyV])),
        unrealisedPnl: 0,
        buyDate: flexDate(r[cBuyD]),
        sellDate: flexDate(r[cSellD]),
        productHint: (mtf.hint ? "mtf" : hint) as ProductHint,
        exchangeHint: null,
        sourceFile: ctx.filename,
        reportedCharges: charges(toNum(r[cCs]), toNum(r[cStt])),
        importNotes: notes.length ? notes : null,
      });
    }
  }

  // ── Open Sell: sold with no purchase in the report — basis unknowable ─────
  const os = equity.get("openSell");
  if (os) {
    const f = colFinder(os.header);
    const cName = f("Scrip Name"), cIsin = f("ISIN"), cQty = f("Quantity", "Qty");
    const cSellP = f("Avg Sell Price"), cSellV = f("Sell Value"), cSellD = f("Sell Date");
    const cCs = f("Charges and Statutory"), cStt = f("STT");
    for (const r of os.rows) {
      const name = (r[cName] ?? "").trim();
      if (!name) continue;
      push({
        broker: "angelone",
        tradingsymbol: name,
        isin: cIsin >= 0 ? r[cIsin] || null : null,
        buyQty: 0, avgBuyPrice: 0, buyValue: 0,
        sellQty: toNum(r[cQty]),
        avgSellPrice: toNum(r[cSellP]),
        sellValue: toNum(r[cSellV]),
        closingPrice: null,
        grossPnl: 0,
        unrealisedPnl: 0,
        buyDate: null,
        sellDate: flexDate(r[cSellD]),
        productHint: "delivery",
        exchangeHint: null,
        sourceFile: ctx.filename,
        reportedCharges: charges(toNum(r[cCs]), toNum(r[cStt])),
        basisUnknown: true,
      });
    }
  }

  // ── Open Holdings: live positions with the report's own closing rate ──────
  const oh = equity.get("openHoldings");
  if (oh) {
    const f = colFinder(oh.header);
    const cName = f("Scrip Name"), cIsin = f("ISIN"), cQty = f("Quantity", "Qty");
    const cBuyP = f("Avg Buy Price"), cBuyV = f("Buy Value"), cClose = f("Closing rate");
    const cCs = f("Charges and Statutory"), cStt = f("STT");
    for (const r of oh.rows) {
      const name = (r[cName] ?? "").trim();
      if (!name) continue;
      const qty = toNum(r[cQty]);
      const isin = cIsin >= 0 ? (r[cIsin] || null) : null;
      const close = toNum(r[cClose]);
      const mtf = mtfFor(isin, qty);
      push({
        broker: "angelone",
        tradingsymbol: name,
        isin,
        buyQty: qty,
        avgBuyPrice: toNum(r[cBuyP]),
        buyValue: toNum(r[cBuyV]),
        sellQty: 0, avgSellPrice: 0, sellValue: 0,
        closingPrice: close > 0 ? close : null,
        grossPnl: 0,
        unrealisedPnl: close > 0 ? r2(qty * close - toNum(r[cBuyV])) : 0,
        buyDate: null, // the holdings table states no acquisition date
        sellDate: null,
        productHint: mtf.hint ? "mtf" : "delivery",
        exchangeHint: null,
        sourceFile: ctx.filename,
        reportedCharges: charges(toNum(r[cCs]), toNum(r[cStt])),
        importNotes: mtf.note ? [mtf.note] : null,
      });
    }
  }

  // ── Derivatives: synthesize the classifier's own grammar ──────────────────
  for (const [key, isOption] of [["futures", false], ["options", true]] as const) {
    const s = deriv.get(key);
    if (!s) continue;
    const f = colFinder(s.header);
    const cSym = f("Symbol Name"), cExp = f("Expiry date"), cQty = f("Qty", "Quantity");
    const cStrike = f("Strike Price"), cOt = f("Option Type");
    const cBuyD = f("Buy Date"), cSellD = f("Sell date", "Sell Date");
    const cBuyP = f("Avg Buy Price"), cBuyV = f("Buy Value");
    const cSellP = f("Avg Sell Price"), cSellV = f("Sell Value");
    const cCs = f("Total Charges and Statutory", "Charges and Statutory"), cStt = f("STT");

    for (const r of s.rows) {
      const sym = (r[cSym] ?? "").trim();
      if (!sym) continue;
      const expiry = flexDate(r[cExp]);
      // `OPT NIFTY 26 Jun 2026 24500 CE` / `FUT NIFTY 26 Jun 2026` — the exact
      // grammar lib/engine/classify.ts documents, so segment, strike and expiry
      // classify without a parallel path. An unparseable expiry falls back to
      // the plain name and says so.
      let tradingsymbol = sym;
      const notes: string[] = [];
      if (expiry) {
        tradingsymbol = isOption
          ? `OPT ${sym} ${toClassifierDate(expiry)} ${toNum(r[cStrike])} ${(r[cOt] ?? "").trim().toUpperCase() || "CE"}`
          : `FUT ${sym} ${toClassifierDate(expiry)}`;
      } else {
        notes.push("Expiry date could not be read — classified as equity until re-tagged.");
      }
      push({
        broker: "angelone",
        tradingsymbol,
        isin: null,
        buyQty: toNum(r[cQty]),
        avgBuyPrice: toNum(r[cBuyP]),
        buyValue: toNum(r[cBuyV]),
        sellQty: toNum(r[cQty]),
        avgSellPrice: toNum(r[cSellP]),
        sellValue: toNum(r[cSellV]),
        closingPrice: null,
        grossPnl: r2(toNum(r[cSellV]) - toNum(r[cBuyV])),
        unrealisedPnl: 0,
        buyDate: flexDate(r[cBuyD]),
        sellDate: flexDate(r[cSellD]),
        productHint: null,
        exchangeHint: null,
        sourceFile: ctx.filename,
        reportedCharges: charges(toNum(r[cCs]), toNum(r[cStt])),
        importNotes: notes.length ? notes : null,
      });
    }
  }

  // ── Refusals, counted out loud ────────────────────────────────────────────
  const transfer = equity.get("transfer");
  if (transfer && transfer.rows.some((r) => r.some((c) => c.trim() !== ""))) {
    const n = transfer.rows.filter((r) => (r[1] ?? r[0] ?? "").trim() !== "").length;
    warnings.push(
      `${n} transfer transaction${n === 1 ? "" : "s"} NOT imported: a transfer price is a valuation, not a cost this journal can state honestly. Add ${n === 1 ? "it" : "them"} by hand with the basis you actually have.`,
    );
  }
  warnings.push(
    "Charges are taken from the file's own per-row figures (Charges and Statutory + STT). Whether that split is exhaustive has not been verified against an account with real activity yet — reconcile the first live import against a contract note.",
  );
  warnings.push("Dividends and non-trade charges in this file are cashflows, not trades — import them on the Cash & Ledger screen.");
  if (mtfByIsin.size > 0) {
    warnings.push("MTF quantities are stated by the file's Qty Breakup and were applied directly — the only broker examined that declares MTF.");
  }

  return {
    sourceId: "angelone-taxpnl",
    broker: "angelone",
    format: "pnl",
    trades,
    warnings,
  };
}
