import Papa from "papaparse";
import * as XLSX from "xlsx";
import { extractTime } from "../time-parse";
import type { Execution, NormalizedTrade, ProductHint } from "@/lib/engine/types";
import type { Exchange } from "@/lib/domain/constants";
import type { ParseContext, ParsedFile } from "../types";

const toNum = (v: unknown): number => {
  if (v == null) return 0;
  const x = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(x) ? x : 0;
};

const norm = (s: string) => s.toLowerCase().replace(/[\s_.]/g, "");

/** Convert a CSV/XLSX file into a matrix of rows. */
function toMatrix(ctx: ParseContext): string[][] {
  if (ctx.text != null) {
    return (Papa.parse<string[]>(ctx.text, { skipEmptyLines: true }).data ?? []).map((r) =>
      r.map((c) => String(c ?? "")),
    );
  }
  if (ctx.buffer) {
    const wb = XLSX.read(ctx.buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]!];
    return (XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "" }) as unknown[][]).map(
      (r) => r.map((c) => String(c ?? "")),
    );
  }
  return [];
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
 */
export function detectZerodha(ctx: ParseContext): number {
  // Only strings that actually name the broker. "tradebook" and "console" are
  // generic English — Paytm's export is literally called "… - Tradebook.xlsx".
  const named = /zerodha|kite/i.test(ctx.filename);
  const rows = toMatrix(ctx);
  const h = findHeader(rows);
  if (h < 0) {
    // A named file with no readable table still routes here so the parser can
    // say "no recognizable header" by name, rather than the mapper offering
    // columns that do not exist.
    return named ? 0.3 : 0;
  }
  const cells = rows[h].map(norm);

  const tradebookFp =
    cells.includes("auction") || (cells.includes("tradeid") && cells.includes("orderid"));
  // The "- Z" heads live in the charges block, one per ROW ("Brokerage - Z" /
  // "Central GST - Z" / …), not in the trade-table header — so this counts
  // across the sheet, bounded. Two are required: one "- Z"-suffixed label
  // could be anyone's abbreviation; a column of them is Zerodha's Console.
  const consoleFp =
    rows
      .slice(0, 100)
      .flat()
      .filter((c) => /\s-\s?Z$/.test(String(c).trim())).length >= 2;

  if (!named && !tradebookFp && !consoleFp) return 0; // No name, no fingerprint, no claim.

  let score = named ? 0.35 : 0;
  if (tradebookFp) score += 0.4;
  if (consoleFp) score += 0.4;
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
 *  - Tradebook (granular, one row per execution with Trade Type buy/sell + product) →
 *    aggregated per tradingsymbol+product into round-trips. Best for segment/MTF.
 *  - Console P&L (already aggregated) → mapped directly.
 *
 * Note: Zerodha F&O tradingsymbols (e.g. NIFTY26JUN24500CE) are not Dhan-style; the
 * classifier will treat unrecognized symbols as equity — re-tag F&O in Trades until a
 * real Zerodha F&O sample is available to pin the exact symbol grammar.
 */
export function parseZerodha(ctx: ParseContext): ParsedFile {
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

  const warnings: string[] = [];

  if (cTradeType >= 0) {
    // ---- Tradebook: aggregate per tradingsymbol + product ----
    type Acc = {
      symbol: string; isin: string | null; product: string; exch: string; date: string | null;
      buyQty: number; buyVal: number; sellQty: number; sellVal: number;
      executions: Execution[];
    };
    const groups = new Map<string, Acc>();
    for (const r of dataRows) {
      const symbol = r[cSymbol] ?? "";
      if (!symbol) continue;
      const product = cProduct >= 0 ? r[cProduct] : "";
      const key = `${symbol}|${product}`;
      const acc = groups.get(key) ?? {
        symbol, isin: cIsin >= 0 ? r[cIsin] || null : null, product,
        exch: cExch >= 0 ? r[cExch] : "", date: cDate >= 0 ? r[cDate] || null : null,
        buyQty: 0, buyVal: 0, sellQty: 0, sellVal: 0, executions: [],
      };
      const qty = toNum(r[cQty]);
      const price = toNum(r[cPrice]);
      const side = norm(r[cTradeType]);
      if (side.startsWith("b")) { acc.buyQty += qty; acc.buyVal += qty * price; }
      else { acc.sellQty += qty; acc.sellVal += qty * price; }
      // Keep the fill itself — the staged ladder is rebuilt from these.
      if (qty > 0) {
        const rawWhen = cDate >= 0 ? r[cDate] || null : acc.date;
        // Date and time are pulled independently — the same column may hold a
        // bare date or a full timestamp depending on the export.
        acc.executions.push({
          side: side.startsWith("b") ? "buy" : "sell",
          qty,
          price,
          date: rawWhen,
          time: extractTime(rawWhen),
        });
      }
      groups.set(key, acc);
    }
    const trades: NormalizedTrade[] = [];
    for (const a of groups.values()) {
      trades.push({
        broker: "zerodha",
        tradingsymbol: a.symbol,
        isin: a.isin,
        buyQty: a.buyQty,
        avgBuyPrice: a.buyQty ? a.buyVal / a.buyQty : 0,
        buyValue: a.buyVal,
        sellQty: a.sellQty,
        avgSellPrice: a.sellQty ? a.sellVal / a.sellQty : 0,
        sellValue: a.sellVal,
        closingPrice: null,
        grossPnl: a.sellQty > 0 ? a.sellVal - a.buyVal : 0,
        unrealisedPnl: 0,
        buyDate: a.date,
        sellDate: a.sellQty > 0 ? a.date : null,
        // First buy fill opens a long; last sell fill closes it. Times come
        // from the executions so they survive aggregation.
        entryTime: a.executions.find((e) => e.side === "buy")?.time ?? null,
        exitTime: [...a.executions].reverse().find((e) => e.side === "sell")?.time ?? null,
        productHint: productHint(a.product),
        exchangeHint: exchangeFrom(a.exch),
        sourceFile: ctx.filename,
        executions: a.executions,
      });
    }
    warnings.push("Zerodha tradebook aggregated per tradingsymbol+product; verify F&O classification.");
    return { sourceId: "zerodha", broker: "zerodha", format: "tradebook", trades, warnings };
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
  return { sourceId: "zerodha", broker: "zerodha", format: "console", trades, warnings };
}
