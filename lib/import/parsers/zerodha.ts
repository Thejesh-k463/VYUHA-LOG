import Papa from "papaparse";
import * as XLSX from "xlsx";
import { extractDate, extractTime } from "../time-parse";
import { pairLegs, summarisePairing, type Leg } from "../pair-legs";
import type { Execution, NormalizedTrade, ProductHint } from "@/lib/engine/types";
import type { Exchange } from "@/lib/domain/constants";
import type { ParseContext, ParsedFile } from "../types";

const toNum = (v: unknown): number => {
  if (v == null) return 0;
  const x = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(x) ? x : 0;
};

const norm = (s: string) => s.toLowerCase().replace(/[\s_.]/g, "");

/** Convert a CSV/XLSX file into per-sheet matrices of rows.
 *
 *  ALL sheets, not just the first: Zerodha's Console tax P&L puts its trade
 *  table on sheet 0 and its "- Z" charge-head fingerprint on sheet 1, so a
 *  first-sheet-only read left the richest file Zerodha produces scoring 0 and
 *  falling to the generic column mapper (found against a real export,
 *  2026-09-01). A CSV is one "sheet". */
function toMatrices(ctx: ParseContext): string[][][] {
  if (ctx.text != null) {
    return [
      (Papa.parse<string[]>(ctx.text, { skipEmptyLines: true }).data ?? []).map((r) =>
        r.map((c) => String(c ?? "")),
      ),
    ];
  }
  if (ctx.buffer) {
    const wb = XLSX.read(ctx.buffer, { type: "buffer" });
    return wb.SheetNames.map((name) =>
      (XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name]!, { header: 1, raw: false, defval: "" }) as unknown[][]).map(
        (r) => r.map((c) => String(c ?? "")),
      ),
    );
  }
  return [];
}

/** First sheet only — the tradebook/Console P&L formats live there. */
function toMatrix(ctx: ParseContext): string[][] {
  return toMatrices(ctx)[0] ?? [];
}

/** Find the header row index (first row that contains a recognizable column).
 *
 *  Scans 100 rows, not 25: the Console P&L opens with a preamble, a summary
 *  block and the full charges ledger before its trade table, and on a real
 *  export (verified 2026-08-12) the header sits past row 25. At 25 this
 *  function missed it, detection fell into the no-header clamp, and Zerodha's
 *  own P&L was claimed at 0.30 by accident of its filename. */
function findHeader(rows: string[][]): number {
  const wanted = ["symbol", "tradingsymbol", "trade type", "trade_type", "isin", "quantity"];
  for (let i = 0; i < Math.min(rows.length, 100); i++) {
    const cells = rows[i].map(norm);
    if (wanted.some((w) => cells.includes(norm(w)))) return i;
  }
  return -1;
}

function colFinder(header: string[]) {
  const idx = header.map(norm);
  return (...cands: string[]): number => {
    for (const c of cands) {
      const i = idx.indexOf(norm(c));
      if (i >= 0) return i;
    }
    return -1;
  };
}

/**
 * Detection. THE RULE (AGENTS.md): a broker-named parser must see the broker's
 * NAME before it claims a file — in the filename or as an in-content
 * fingerprint no other broker emits. This detector used to score on column
 * SHAPE (`symbol`+`isin` = 0.30, the word "tradebook" in a filename = 0.35),
 * and on 2026-08-12 that claimed a Groww order-history export AND a Paytm
 * Money tradebook as Zerodha, importing one of them priced at Zerodha's
 * rates. Shape is common to every Indian broker; it now only refines a score
 * after the file has qualified.
 *
 * Fingerprints, each verified against a real export (docs/BROKER_FORMATS.md):
 *   - Tradebook: the `Auction` column — no other broker emits it — or the
 *     `Trade ID` + `Order ID` pair.
 *   - Console P&L: charge account heads suffixed "- Z" ("Brokerage - Z",
 *     "Central GST - Z", … 9 heads on a real export).
 *   - Console tax P&L (taxpnl-*.xlsx): a "Tradewise Exits" table (Symbol /
 *     Entry Date / Exit Date / Turnover / Profit) on one sheet, the "- Z"
 *     heads AND an in-content "Zerodha's guide" line on the workbook — the
 *     table shape counts only once the workbook has named the broker.
 */
export function detectZerodha(ctx: ParseContext): number {
  // Only strings that actually name the broker. "tradebook" and "console" are
  // generic English — Paytm's export is literally called "… - Tradebook.xlsx".
  const matrices = toMatrices(ctx);
  const filenameNamed = /zerodha|kite/i.test(ctx.filename);
  // The tax P&L export names no broker in its FILENAME (taxpnl-<name>-<fy>…)
  // but names one in its preamble ("View Zerodha's guide on using tax
  // reports…", verified on a real export 2026-09-01). An in-content name
  // counts ONLY when it looks like a preamble line — a row with at most two
  // non-empty cells in the first 10 rows. A DATA cell saying "Zerodha" (a
  // user's own multi-broker log with a Broker column) sits in a wide row and
  // must NOT qualify the file: that is the 2026-08-12 misclaim class again,
  // and it belongs to the column mapper's question, not to this parser.
  const contentNamed = matrices.some((rows) =>
    rows.slice(0, 10).some((row) => {
      const nonEmpty = row.filter((c) => c.trim() !== "");
      return nonEmpty.length <= 2 && nonEmpty.some((c) => /zerodha/i.test(c));
    }),
  );
  const named = filenameNamed || contentNamed;

  // Fingerprints are scored across EVERY sheet: the tax P&L keeps its trade
  // table and its "- Z" heads on different sheets.
  let h = -1;
  let cells: string[] = [];
  let tradewiseFp = false;
  let consoleFp = false;
  for (const rows of matrices) {
    const hi = findHeader(rows);
    if (hi >= 0) {
      const c = rows[hi].map(norm);
      if (h < 0) {
        h = hi;
        cells = c;
      }
      if (
        c.includes("entrydate") &&
        c.includes("exitdate") &&
        c.includes("turnover") &&
        c.includes("profit")
      )
        tradewiseFp = true;
    }
    // The "- Z" heads live in the charges block, one per ROW ("Brokerage - Z"
    // / "Central GST - Z" / …), not in the trade-table header — so this counts
    // across the sheet, bounded. Two are required: one "- Z"-suffixed label
    // could be anyone's abbreviation; a column of them is Zerodha's Console.
    if (
      rows
        .slice(0, 100)
        .flat()
        .filter((c) => /\s-\s?Z$/.test(String(c).trim())).length >= 2
    )
      consoleFp = true;
  }
  if (h < 0) {
    // A FILENAME-named file with no readable table still routes here so the
    // parser can say "no recognizable header" by name, rather than the mapper
    // offering columns that do not exist. A content mention never earns this
    // routing on its own.
    return filenameNamed ? 0.3 : 0;
  }

  const tradebookFp =
    cells.includes("auction") || (cells.includes("tradeid") && cells.includes("orderid"));
  // The tradewise table SHAPE never claims on its own — entry/exit/turnover
  // columns are conceivable from another broker — it needs the workbook to
  // have named Zerodha or shown the "- Z" heads first (the house rule: a
  // broker-named parser must see the broker's name before it claims a file).
  const taxpnlFp = tradewiseFp && (named || consoleFp);

  // No claim without a filename name or a format fingerprint. A preamble
  // content mention alone (contentNamed) deliberately does NOT qualify: it
  // only ever ADDS to a fingerprint (the taxpnl case), so a stray "zerodha"
  // string in someone else's file can never out-rank the column mapper.
  if (!filenameNamed && !tradebookFp && !consoleFp && !taxpnlFp) return 0;

  // The FINGERPRINT carries the claim on its own — the filename only adds to
  // it. Real Console exports are named "Tradebook_EQ…" / "statement…" and name
  // no broker, so a fingerprint weighted below the 0.7 routing threshold left
  // the real files under-scored (measured 2026-08-20: tradebook 0.65, Console
  // P&L 0.55 under a neutral filename) while their redacted, broker-named
  // copies routed fine. Neither `Auction`/`Trade ID`+`Order ID` nor a column of
  // "- Z" charge heads appears in any other broker's export.
  let score = named ? 0.35 : 0;
  if (tradebookFp) score += 0.5;
  if (consoleFp) score += 0.55;
  if (taxpnlFp) score += 0.5;
  // Shape refines a qualified score; it can no longer create one.
  if (cells.includes("tradingsymbol") || (cells.includes("symbol") && cells.includes("isin")))
    score += 0.15;
  if (cells.includes("tradetype") && cells.includes("orderid")) score += 0.1;
  return Math.min(1, score);
}

function exchangeFrom(raw: string): Exchange | null {
  const s = norm(raw);
  if (!s) return null;
  if (s.startsWith("mcx")) return "MCX";
  if (s.startsWith("bse") || s.startsWith("bfo")) return "BSE";
  if (s.startsWith("nse") || s.startsWith("nfo") || s.startsWith("cds")) return "NSE";
  return null;
}

function productHint(raw: string): ProductHint {
  const s = norm(raw);
  if (s === "cnc") return "delivery";
  if (s === "mis") return "intraday";
  if (s === "mtf") return "mtf";
  return null; // NRML (F&O) → let the classifier decide from the name
}

/**
 * Zerodha importer. Supports:
 *  - Tradebook (granular, one row per execution with Trade Type buy/sell) →
 *    paired FIFO per tradingsymbol+product into positions.
 *  - Console P&L (already aggregated) → mapped directly.
 *
 * ── Why FIFO pairing and not whole-file aggregation (2026-08-20) ────────────
 *
 * This branch used to sum every fill of a symbol into ONE row and set
 * grossPnl = sellValue − buyValue. On a real Console tradebook (1,554 fills,
 * Apr–Jun) that produced 23 rows of which 8 were sell-only — holdings bought
 * before the export window — and each of those was booked as 100 % profit
 * because buyValue was zero. That is the fabrication invariant 6 forbids, and
 * it came to ≈₹31 lakh of invented P&L. Every row also carried the FIRST
 * fill's date as BOTH buyDate and sellDate, so 10 of 23 positions reported a
 * zero-day hold they never had.
 *
 * `pairLegs` (lib/import/pair-legs.ts) is the same FIFO used by the Groww
 * order-history parser: an unmatched sell becomes an `opening-sell` with
 * `basisUnknown` and NO P&L, leftover buys become `open`, and re-entries in
 * one symbol become separate positions with their own real dates.
 *
 * Note: Zerodha F&O tradingsymbols (e.g. NIFTY26JUN24500CE) are not Dhan-style; the
 * classifier will treat unrecognized symbols as equity — re-tag F&O in Trades until a
 * real Zerodha F&O sample is available to pin the exact symbol grammar.
 */
/** Header test for the Console tax P&L's tradewise table. */
function isTradewiseHeader(cells: string[]): boolean {
  return (
    cells.includes("symbol") &&
    cells.includes("entrydate") &&
    cells.includes("exitdate") &&
    cells.includes("turnover") &&
    cells.includes("profit")
  );
}

/**
 * Console tax P&L "Tradewise Exits" sheet — the richest file Zerodha
 * produces: one row per EXIT with entry/exit timestamps, quantity, values,
 * gross profit, and every charge the broker actually levied on that trade.
 *
 * Pinned against two real exports (2026-09-01): the sheet opens with a
 * preamble (client identity, a "Zerodha's guide" link, the FY window), then
 * one or more SECTIONS — a single-cell label row ("F&O", "Currency",
 * "Commodity"), its own header row, then data rows. Sections other than the
 * first can be empty.
 *
 * The honest position unit is the same scrip-day the tradebook branch uses:
 * Zerodha splits one order into a row per execution (six 75-lot rows sharing
 * one entry AND one exit second), so rows are grouped by
 * symbol + entry DAY + exit DAY. A buy consumed by exits on different days
 * stays separate positions — exactly what FIFO pairing of day-legs yields —
 * and every source row survives as an entry+exit execution pair so ladders
 * keep their shape.
 *
 * "Profit" is GROSS (sell − buy; verified: the Turnover column ≡ |Profit| on
 * all 693 real rows). Charges are reported per head; CGST+SGST+IGST fold into
 * the engine's single `gst` head, and the stated figures ride
 * `reportedCharges` so they are stored as the truth (engine figures stay a
 * cross-check).
 */
function parseTradewiseSheet(rows: string[][], ctx: ParseContext): ParsedFile | null {
  const r2 = (n: number) => Math.round(n * 100) / 100;

  let headerAt = -1;
  for (let i = 0; i < rows.length; i++) {
    if (isTradewiseHeader(rows[i].map(norm))) {
      headerAt = i;
      break;
    }
  }
  if (headerAt < 0) return null;

  type ChargeCols = {
    brokerage: number; exchangeTxn: number; ipft: number; sebi: number;
    cgst: number; sgst: number; igst: number; stampDuty: number; stt: number;
  };
  type Cols = ChargeCols & {
    symbol: number; entry: number; exit: number; qty: number; buyVal: number; sellVal: number; profit: number;
  };
  const readHeader = (cells: string[]): Cols => {
    const find = colFinder(cells);
    return {
      symbol: find("symbol"),
      entry: find("entry date"),
      exit: find("exit date"),
      qty: find("quantity", "qty"),
      buyVal: find("buy value"),
      sellVal: find("sell value"),
      profit: find("profit"),
      brokerage: find("brokerage"),
      exchangeTxn: find("exchange transaction charges"),
      ipft: find("ipft"),
      sebi: find("sebi charges"),
      cgst: find("cgst"),
      sgst: find("sgst"),
      igst: find("igst"),
      stampDuty: find("stamp duty"),
      stt: find("stt"),
    };
  };

  type Group = {
    symbol: string;
    section: string | null;
    entryDate: string;
    exitDate: string;
    qty: number;
    buyValue: number;
    sellValue: number;
    profit: number;
    charges: { brokerage: number; exchangeTxn: number; ipft: number; sebi: number; gst: number; stampDuty: number; sttCtt: number };
    /** Keyed side|date|time|price — identical executions (one order split by
     *  the exchange) merge; distinct fills keep the ladder. */
    fills: Map<string, Execution>;
  };
  const groups = new Map<string, Group>();
  const unreadable: string[] = [];
  let cols: Cols | null = null;
  let section: string | null = null;
  let lastSingleton: string | null = null;
  let rowCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const cells = raw.map((c) => c.trim());
    const nonEmpty = cells.filter((c) => c !== "");
    if (nonEmpty.length === 0) continue;
    if (isTradewiseHeader(raw.map(norm))) {
      cols = readHeader(raw);
      section = lastSingleton;
      continue;
    }
    if (nonEmpty.length === 1) {
      lastSingleton = nonEmpty[0];
      continue;
    }
    if (!cols) continue; // preamble (Client ID / Name / PAN rows)

    const symbol = cells[cols.symbol] ?? "";
    if (!symbol) continue;
    const qty = toNum(raw[cols.qty]);
    const entryDate = extractDate(raw[cols.entry]);
    const exitDate = extractDate(raw[cols.exit]);
    // Refuse, never coerce: a row with no readable dates or quantity cannot
    // become a position without inventing one of them.
    if (qty <= 0 || !entryDate || !exitDate) {
      unreadable.push(symbol);
      continue;
    }
    rowCount += 1;

    const buyValue = toNum(raw[cols.buyVal]);
    const sellValue = toNum(raw[cols.sellVal]);
    const key = `${symbol}|${entryDate}|${exitDate}`;
    const g = groups.get(key) ?? {
      symbol,
      section,
      entryDate,
      exitDate,
      qty: 0,
      buyValue: 0,
      sellValue: 0,
      profit: 0,
      charges: { brokerage: 0, exchangeTxn: 0, ipft: 0, sebi: 0, gst: 0, stampDuty: 0, sttCtt: 0 },
      fills: new Map<string, Execution>(),
    };
    g.qty += qty;
    g.buyValue += buyValue;
    g.sellValue += sellValue;
    g.profit += toNum(raw[cols.profit]);
    g.charges.brokerage += toNum(raw[cols.brokerage]);
    g.charges.exchangeTxn += toNum(raw[cols.exchangeTxn]);
    g.charges.ipft += toNum(raw[cols.ipft]);
    g.charges.sebi += toNum(raw[cols.sebi]);
    g.charges.gst += toNum(raw[cols.cgst]) + toNum(raw[cols.sgst]) + toNum(raw[cols.igst]);
    g.charges.stampDuty += toNum(raw[cols.stampDuty]);
    g.charges.sttCtt += toNum(raw[cols.stt]);

    for (const [side, date, cell, value] of [
      ["buy", entryDate, raw[cols.entry], buyValue],
      ["sell", exitDate, raw[cols.exit], sellValue],
    ] as const) {
      const time = extractTime(cell);
      const price = qty > 0 ? value / qty : 0;
      const fk = `${side}|${date}|${time ?? ""}|${price}`;
      const existing = g.fills.get(fk);
      if (existing) existing.qty += qty;
      else g.fills.set(fk, { side, qty, price: r2(price), date, time });
    }
    groups.set(key, g);
  }

  if (rowCount === 0 && unreadable.length === 0) return null;

  const trades: NormalizedTrade[] = [];
  for (const g of groups.values()) {
    // Round each head FIRST and total the rounded heads: the stored heads must
    // sum to the stored total exactly, and rounding them independently of the
    // total leaves a stray paisa between them.
    const heads = {
      brokerage: r2(g.charges.brokerage),
      exchangeTxn: r2(g.charges.exchangeTxn),
      ipft: r2(g.charges.ipft),
      sebi: r2(g.charges.sebi),
      gst: r2(g.charges.gst),
      stampDuty: r2(g.charges.stampDuty),
      sttCtt: r2(g.charges.sttCtt),
    };
    const total = r2(
      heads.brokerage + heads.exchangeTxn + heads.ipft + heads.sebi + heads.gst + heads.stampDuty + heads.sttCtt,
    );
    const fills = [...g.fills.values()];
    const buys = fills.filter((f) => f.side === "buy");
    const sells = fills.filter((f) => f.side === "sell");
    trades.push({
      broker: "zerodha",
      tradingsymbol: g.symbol,
      isin: null,
      buyQty: g.qty,
      avgBuyPrice: g.qty > 0 ? r2(g.buyValue / g.qty) : 0,
      buyValue: r2(g.buyValue),
      sellQty: g.qty,
      avgSellPrice: g.qty > 0 ? r2(g.sellValue / g.qty) : 0,
      sellValue: r2(g.sellValue),
      closingPrice: null,
      grossPnl: r2(g.profit),
      unrealisedPnl: 0,
      buyDate: g.entryDate,
      sellDate: g.exitDate,
      entryTime: buys.map((f) => f.time).filter(Boolean).sort()[0] ?? null,
      exitTime: sells.map((f) => f.time).filter(Boolean).sort().at(-1) ?? null,
      // NRML derivatives state no product; the classifier reads the contract
      // from the symbol itself. Commodity/currency sections hint the venue.
      productHint: null,
      exchangeHint: g.section && /commodit/i.test(g.section) ? "MCX" : null,
      sourceFile: ctx.filename,
      executions: fills.length > 0 ? fills : null,
      reportedCharges: { ...heads, total },
      importNotes: g.section ? [`Tax P&L section: ${g.section}`] : null,
    });
  }

  const warnings: string[] = [
    `${rowCount} exit row${rowCount === 1 ? "" : "s"} → ${trades.length} position${trades.length === 1 ? "" : "s"} (grouped per symbol + entry day + exit day). Charges are Zerodha's own per-trade figures, stored as reported.`,
    // The report states WHEN a position opened and closed but never WHICH SIDE
    // opened it. Sides are recorded on the buy-first assumption; for a short
    // (sold first) the execution ladder and buy/sell dates read inverted while
    // quantity, values, P&L and charges stay exact. Saying so beats silently
    // wearing a derived fact as a reported one.
    "Direction is not stated by this report — sides are recorded as buy-at-entry / sell-at-exit. Values, P&L and charges are exact either way; a short's ladder reads inverted. Re-tag shorts in Trades if the distinction matters to you.",
  ];
  if (unreadable.length > 0) {
    warnings.push(
      `${unreadable.length} row${unreadable.length === 1 ? "" : "s"} had no readable date or quantity and ${unreadable.length === 1 ? "was" : "were"} refused rather than guessed: ${[...new Set(unreadable)].slice(0, 5).join(", ")}.`,
    );
  }

  return {
    sourceId: "zerodha",
    broker: "zerodha",
    format: "taxpnl",
    trades,
    sourceRows: rowCount,
    warnings,
  };
}

export function parseZerodha(ctx: ParseContext): ParsedFile {
  // The tax P&L's tradewise table may sit on any sheet; every other Zerodha
  // format lives on the first. Tradewise wins when present — it is the only
  // format that states real per-trade charges.
  for (const sheet of toMatrices(ctx)) {
    const tw = parseTradewiseSheet(sheet, ctx);
    if (tw) return tw;
  }
  const rows = toMatrix(ctx);
  const h = findHeader(rows);
  if (h < 0) {
    return {
      sourceId: "zerodha",
      broker: "zerodha",
      format: "unknown",
      trades: [],
      warnings: ["Could not find a recognizable header row in the Zerodha file."],
    };
  }
  const header = rows[h];
  const find = colFinder(header);
  const dataRows = rows.slice(h + 1).filter((r) => r.some((c) => c.trim() !== ""));

  const cTradeType = find("trade type", "trade_type", "type");
  const cSymbol = find("tradingsymbol", "symbol", "scrip", "instrument");
  const cIsin = find("isin");
  const cQty = find("quantity", "qty");
  const cPrice = find("price", "trade price", "average price", "avg price");
  const cProduct = find("product", "product type");
  const cExch = find("exchange", "segment");
  const cDate = find("trade date", "order execution time", "date", "trade_date");
  // The fill CLOCK lives in its own column on the real Console export
  // ("Order Execution Time", "2026-04-01 11:14:28"); "Trade Date" there is a
  // bare date, so reading the time off it yields null and loses every fill
  // time in the file. Looked up separately, with the date cell as fallback
  // for exports that put a full timestamp in the date column.
  const cTime = find("order execution time", "trade time", "execution time", "order_execution_time");

  const warnings: string[] = [];

  if (cTradeType >= 0) {
    // ---- Tradebook: FIFO-pair per tradingsymbol + product ----
    const r2 = (n: number) => Math.round(n * 100) / 100;

    // A LEG is a scrip-DAY, not a fill.
    //
    // `pairSymbolLegs` emits one closed position per SELL leg and one open per
    // leftover BUY leg, so feeding it raw fills makes an SME tradebook that
    // fills 11 + 2 + 2 + 3 shares at a time report hundreds of "trades" nobody
    // took (measured 2026-08-20: 1,554 fills → 936 positions). The Dhan GTR
    // parser's legs are per BILL — one scrip-day — and that is the honest unit
    // here too: fills are summed per symbol|product|date|side BEFORE pairing,
    // while every individual fill survives in `executions` for the ladder.
    type Group = {
      symbol: string;
      productRaw: string;
      isin: string | null;
      /** Keyed `date|side` — one leg per scrip-day-side. */
      legs: Map<string, Leg>;
      fills: Execution[];
    };
    const groups = new Map<string, Group>();
    const unreadable: string[] = [];
    let fillCount = 0;

    for (const r of dataRows) {
      const symbol = (r[cSymbol] ?? "").trim();
      if (!symbol) continue;

      const productRaw = cProduct >= 0 ? (r[cProduct] ?? "").trim() : "";
      const key = `${symbol}|${norm(productRaw)}`;

      const dateCell = cDate >= 0 ? r[cDate] || null : null;
      const timeCell = cTime >= 0 ? r[cTime] || null : null;
      const qty = toNum(r[cQty]);
      const price = toNum(r[cPrice]);
      const rawSide = norm(cTradeType >= 0 ? r[cTradeType] : "");
      const side = rawSide.startsWith("b") ? "buy" : rawSide.startsWith("s") ? "sell" : null;
      const date = extractDate(dateCell) ?? extractDate(timeCell);

      // Refuse, never coerce (AGENTS.md): a row with no readable side, date,
      // quantity or price cannot become a fill without inventing one of them.
      if (!side || !date || qty <= 0 || price <= 0) {
        unreadable.push(symbol);
        continue;
      }

      const g = groups.get(key) ?? {
        symbol,
        productRaw,
        isin: cIsin >= 0 ? r[cIsin] || null : null,
        legs: new Map<string, Leg>(),
        fills: [],
      };
      if (!g.isin && cIsin >= 0 && r[cIsin]) g.isin = r[cIsin];

      const p = norm(productRaw);
      // MTF has no counterpart in pairLegs' product union; the group key keeps
      // it separate and the column supplies the hint further down.
      const legProduct: Leg["product"] =
        p === "cnc" ? "delivery" : p === "mis" ? "intraday" : "unknown";

      const legKey = `${date}|${side}`;
      const existing = g.legs.get(legKey);
      if (existing) {
        existing.qty += qty;
        existing.value = r2(existing.value + qty * price);
      } else {
        g.legs.set(legKey, {
          symbol,
          side,
          date,
          qty,
          value: r2(qty * price),
          charges: 0,
          exchange: cExch >= 0 ? (r[cExch] || "").trim() || null : null,
          product: legProduct,
        });
      }
      fillCount += 1;
      g.fills.push({
        side,
        qty,
        price,
        date,
        time: extractTime(timeCell) ?? extractTime(dateCell),
      });
      groups.set(key, g);
    }

    const allLegs: Leg[] = [];
    const allPaired: ReturnType<typeof pairLegs> = [];
    const trades: NormalizedTrade[] = [];

    for (const g of groups.values()) {
      const dayLegs = [...g.legs.values()];
      const paired = pairLegs(dayLegs);
      allLegs.push(...dayLegs);
      allPaired.push(...paired);

      for (const pos of paired) {
        // Product is STATED when the export carries the column; the real
        // Console tradebook does not, so it is derived from the calendar and
        // flagged — a derived fact never wears a reported fact's clothes.
        const stated = cProduct >= 0 ? productHint(g.productRaw) : null;
        const sameDay = pos.kind === "closed" && pos.buyDate != null && pos.buyDate === pos.sellDate;
        const hint: ProductHint = cProduct >= 0 ? stated : sameDay ? "intraday" : "delivery";

        // Each position sees only the fills inside its own window, so a staged
        // ladder is rebuilt from its own executions rather than the symbol's
        // whole history. Approximate for re-entered symbols; totals stay exact.
        const executions = g.fills.filter(
          (e) =>
            (pos.buyDate == null || (e.date ?? "") >= pos.buyDate) &&
            (pos.sellDate == null || (e.date ?? "") <= pos.sellDate),
        );

        trades.push({
          broker: "zerodha",
          tradingsymbol: pos.symbol,
          isin: g.isin,
          buyQty: pos.buyQty,
          avgBuyPrice: pos.buyQty > 0 ? r2(pos.buyValue / pos.buyQty) : 0,
          buyValue: pos.buyValue,
          sellQty: pos.sellQty,
          avgSellPrice: pos.sellQty > 0 ? r2(pos.sellValue / pos.sellQty) : 0,
          sellValue: pos.sellValue,
          closingPrice: null,
          // Only a CLOSED position has a knowable P&L. An opening sell has no
          // purchase price anywhere in the file, so zero is the honest answer
          // and `basisUnknown` says why.
          grossPnl: pos.kind === "closed" ? r2(pos.sellValue - pos.buyValue) : 0,
          unrealisedPnl: 0,
          buyDate: pos.buyDate,
          sellDate: pos.sellDate,
          entryTime: executions.find((e) => e.side === "buy")?.time ?? null,
          exitTime: [...executions].reverse().find((e) => e.side === "sell")?.time ?? null,
          productHint: hint,
          exchangeHint: exchangeFrom(pos.exchange ?? ""),
          sourceFile: ctx.filename,
          executions: executions.length > 0 ? executions : null,
          basisUnknown: pos.basisUnknown,
          ...(cProduct >= 0 ? {} : { productDerived: true }),
          importNotes: pos.notes.length > 0 ? pos.notes : null,
        });
      }
    }

    const check = summarisePairing(allLegs, allPaired);

    warnings.push(
      `${fillCount} fill${fillCount === 1 ? "" : "s"} → ${trades.length} position${trades.length === 1 ? "" : "s"} (FIFO per symbol + day). Verify F&O classification.`,
    );
    if (cProduct < 0) {
      warnings.push(
        "This tradebook has no Product column — delivery vs intraday is DERIVED from same-day round trips, and MTF cannot be identified at all. Confirm any delivery rows that were actually MTF.",
      );
    }
    if (unreadable.length > 0) {
      warnings.push(
        `${unreadable.length} row${unreadable.length === 1 ? "" : "s"} had no readable trade type, date, quantity or price and ${unreadable.length === 1 ? "was" : "were"} refused rather than guessed: ${[...new Set(unreadable)].slice(0, 5).join(", ")}.`,
      );
    }
    if (check.openingSells > 0) {
      warnings.push(
        `${check.openingSells} sell${check.openingSells === 1 ? " had" : "s had"} no matching buy in this file — acquired before the export window; cost basis unknown, P&L left blank until you supply it.`,
      );
    }
    if (!check.conserved) {
      warnings.push(
        `Pairing conservation check FAILED (qty delta ${check.qtyDelta}, value delta ${check.valueDelta} against a ${check.valueTolerance} rounding tolerance) — please report this file.`,
      );
    }

    return {
      sourceId: "zerodha",
      broker: "zerodha",
      format: "tradebook",
      trades,
      sourceRows: fillCount,
      warnings,
    };
  }

  // ---- Console P&L: already aggregated ----
  const cBuyVal = find("buy value", "buy_value", "buyvalue");
  const cSellVal = find("sell value", "sell_value", "sellvalue");
  const cBuyAvg = find("buy average", "buy avg", "buy price", "average buy price");
  const cSellAvg = find("sell average", "sell avg", "sell price", "average sell price");
  const cRealized = find("realized p&l", "realized profit", "realised p&l", "realized pnl", "pnl");
  const cBuyQty = find("buy quantity", "buy qty");
  const cSellQty = find("sell quantity", "sell qty");

  const trades: NormalizedTrade[] = [];
  for (const r of dataRows) {
    const symbol = cSymbol >= 0 ? r[cSymbol] : "";
    if (!symbol) continue;
    const qty = cQty >= 0 ? toNum(r[cQty]) : 0;
    const buyQty = cBuyQty >= 0 ? toNum(r[cBuyQty]) : qty;
    const sellQty = cSellQty >= 0 ? toNum(r[cSellQty]) : qty;
    const buyVal = cBuyVal >= 0 ? toNum(r[cBuyVal]) : 0;
    const sellVal = cSellVal >= 0 ? toNum(r[cSellVal]) : 0;
    // A row with nothing bought, nothing sold and no value on either side is
    // not a trade. The real Console export carries three of them, whose
    // "Symbol" cell holds an ISIN — importing them creates empty positions.
    if (buyQty === 0 && sellQty === 0 && buyVal === 0 && sellVal === 0) continue;
    trades.push({
      broker: "zerodha",
      tradingsymbol: symbol,
      isin: cIsin >= 0 ? r[cIsin] || null : null,
      buyQty,
      avgBuyPrice: cBuyAvg >= 0 ? toNum(r[cBuyAvg]) : buyQty ? buyVal / buyQty : 0,
      buyValue: buyVal,
      sellQty,
      avgSellPrice: cSellAvg >= 0 ? toNum(r[cSellAvg]) : sellQty ? sellVal / sellQty : 0,
      sellValue: sellVal,
      closingPrice: null,
      grossPnl: cRealized >= 0 ? toNum(r[cRealized]) : sellVal - buyVal,
      unrealisedPnl: 0,
      buyDate: cDate >= 0 ? r[cDate] || null : null,
      sellDate: null,
      productHint: cProduct >= 0 ? productHint(r[cProduct]) : null,
      exchangeHint: cExch >= 0 ? exchangeFrom(r[cExch]) : null,
      sourceFile: ctx.filename,
    });
  }
  warnings.push("Zerodha Console P&L is aggregated; segment/MTF may need re-tagging.");
  // The Console P&L states no exit dates at all (and often no dates, full
  // stop). Rows land with "—" in every date column, which reads as a failed
  // import unless the import screen says so up front — inventing a date to
  // make the table look complete is the one thing worse than the dashes.
  const undated = trades.filter((t) => !t.buyDate && !t.sellDate).length;
  if (undated > 0) {
    warnings.push(
      `${undated} row${undated === 1 ? "" : "s"} carry no dates because this report states none — they will show "—" for dates and sit outside FY, holding-period and time-of-day analytics rather than being guessed. The tradebook or tax P&L export carries real dates if you need them.`,
    );
  }
  return { sourceId: "zerodha", broker: "zerodha", format: "console", trades, warnings };
}
