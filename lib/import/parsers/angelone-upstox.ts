// Angel One + Upstox importers (T1.1). Together with Groww/Zerodha/Dhan this
// covers the brokers holding the large majority of India's active retail
// accounts (Groww ~29%, Zerodha, Angel One ~15%, Upstox — NSE active-client
// data, mid-2026).
//
// Both brokers export two broad shapes, and both are handled here:
//   - TRADEBOOK  — one row per execution with a buy/sell side column; rows are
//                  aggregated per tradingsymbol+product into round-trips.
//   - P&L / holdings report — already aggregated per scrip.
// Header naming differs between the two brokers (and between their own report
// versions), so every column is resolved through a candidate list rather than a
// fixed index — the same resilient approach the Zerodha parser uses.

import Papa from "papaparse";
import * as XLSX from "xlsx";
import type { Execution, NormalizedTrade, ProductHint } from "@/lib/engine/types";
import type { Broker, Exchange } from "@/lib/domain/constants";
import type { ParseContext, ParsedFile } from "../types";

const toNum = (v: unknown): number => {
  if (v == null) return 0;
  const x = Number(String(v).replace(/[,₹\s]/g, "").trim());
  return Number.isFinite(x) ? x : 0;
};

const norm = (s: string) => s.toLowerCase().replace(/[\s_.\-()]/g, "");

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

/** Header row = the first row carrying a symbol-ish column (reports often have
 *  several banner/summary rows above it). */
function findHeader(rows: string[][]): number {
  const wanted = ["symbol", "tradingsymbol", "scrip", "scripname", "instrument", "stockname", "company"];
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const cells = rows[i].map(norm);
    if (wanted.some((w) => cells.includes(w))) return i;
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
    // Fall back to a contains-match so "Buy Value (₹)" still resolves.
    for (const c of cands) {
      const i = idx.findIndex((h) => h.includes(norm(c)));
      if (i >= 0) return i;
    }
    return -1;
  };
}

function exchangeFrom(raw: string): Exchange | null {
  const s = norm(raw);
  if (!s) return null;
  if (s.startsWith("mcx")) return "MCX";
  if (s.startsWith("bse") || s.startsWith("bfo")) return "BSE";
  if (s.startsWith("nse") || s.startsWith("nfo") || s.startsWith("cds")) return "NSE";
  return null;
}

/** Product codes: Angel One uses DELIVERY/INTRADAY/MARGIN/CARRYFORWARD,
 *  Upstox uses D/I/CO/OCO plus the long names. */
function productHint(raw: string): ProductHint {
  const s = norm(raw);
  if (!s) return null;
  if (s.startsWith("deliv") || s === "cnc" || s === "d") return "delivery";
  if (s.startsWith("intra") || s === "mis" || s === "i") return "intraday";
  if (s.startsWith("mtf") || s.startsWith("margin")) return "mtf";
  return null; // NRML / carryforward → let the classifier decide from the name
}

function detectFor(broker: Broker, nameRe: RegExp, ctx: ParseContext): number {
  let score = 0;
  if (nameRe.test(ctx.filename)) score += 0.4;
  const rows = toMatrix(ctx);
  const h = findHeader(rows);
  if (h < 0) return score > 0 ? Math.min(score, 0.3) : 0;
  const cells = rows[h].map(norm);
  const hasSymbol = cells.some((c) => ["symbol", "tradingsymbol", "scrip", "scripname", "instrument"].includes(c));
  if (hasSymbol) score += 0.2;
  // Side column (tradebook) or an aggregated buy/sell pair (P&L report).
  if (cells.some((c) => ["buysell", "tradetype", "transactiontype", "side", "ordertype"].includes(c))) score += 0.25;
  if (cells.some((c) => c.includes("buyvalue")) && cells.some((c) => c.includes("sellvalue"))) score += 0.25;
  // Broker fingerprints seen in their own exports.
  if (broker === "angelone" && cells.some((c) => c.includes("angel") || c === "clientcode")) score += 0.1;
  if (broker === "upstox" && cells.some((c) => c.includes("upstox") || c === "clientid")) score += 0.1;
  return Math.min(1, score);
}

function parseFor(broker: Broker, ctx: ParseContext): ParsedFile {
  const label = broker === "angelone" ? "Angel One" : "Upstox";
  const rows = toMatrix(ctx);
  const h = findHeader(rows);
  if (h < 0) {
    return {
      sourceId: broker,
      broker,
      format: "unknown",
      trades: [],
      warnings: [`Could not find a recognizable header row in the ${label} file.`],
    };
  }
  const header = rows[h];
  const find = colFinder(header);
  const dataRows = rows.slice(h + 1).filter((r) => r.some((c) => c.trim() !== ""));

  const cSymbol = find("tradingsymbol", "symbol", "scrip name", "scrip", "instrument", "stock name", "company");
  const cIsin = find("isin");
  const cSide = find("buy/sell", "trade type", "transaction type", "side", "order type", "type");
  const cQty = find("quantity", "qty", "traded quantity", "filled quantity");
  const cPrice = find("price", "trade price", "average price", "avg price", "executed price");
  const cProduct = find("product", "product type", "producttype");
  const cExch = find("exchange", "exch", "segment");
  const cDate = find("trade date", "order execution time", "date", "trade time", "executed on");
  const warnings: string[] = [];

  if (cSide >= 0 && cQty >= 0) {
    // ---- Tradebook: aggregate executions per tradingsymbol + product ----
    type Acc = {
      symbol: string; isin: string | null; product: string; exch: string;
      buyDate: string | null; sellDate: string | null;
      buyQty: number; buyVal: number; sellQty: number; sellVal: number;
      executions: Execution[];
    };
    const groups = new Map<string, Acc>();
    for (const r of dataRows) {
      const symbol = (r[cSymbol] ?? "").trim();
      if (!symbol) continue;
      const product = cProduct >= 0 ? r[cProduct] : "";
      const key = `${symbol}|${product}`;
      const acc = groups.get(key) ?? {
        symbol,
        isin: cIsin >= 0 ? r[cIsin] || null : null,
        product,
        exch: cExch >= 0 ? r[cExch] : "",
        buyDate: null,
        sellDate: null,
        buyQty: 0, buyVal: 0, sellQty: 0, sellVal: 0,
        executions: [],
      };
      const qty = toNum(r[cQty]);
      const price = toNum(r[cPrice]);
      const date = cDate >= 0 ? (r[cDate] || null) : null;
      const side = norm(r[cSide]);
      if (side.startsWith("b")) {
        acc.buyQty += qty;
        acc.buyVal += qty * price;
        if (!acc.buyDate) acc.buyDate = date;
      } else {
        acc.sellQty += qty;
        acc.sellVal += qty * price;
        if (!acc.sellDate) acc.sellDate = date;
      }
      // Keep the fill itself, not just its contribution to the average — this
      // is what the staged-position ladder is rebuilt from.
      if (qty > 0) acc.executions.push({ side: side.startsWith("b") ? "buy" : "sell", qty, price, date });
      groups.set(key, acc);
    }
    const trades: NormalizedTrade[] = [];
    for (const a of groups.values()) {
      trades.push({
        broker,
        tradingsymbol: a.symbol,
        isin: a.isin,
        buyQty: a.buyQty,
        avgBuyPrice: a.buyQty ? a.buyVal / a.buyQty : 0,
        buyValue: a.buyVal,
        sellQty: a.sellQty,
        avgSellPrice: a.sellQty ? a.sellVal / a.sellQty : 0,
        sellValue: a.sellVal,
        closingPrice: null,
        grossPnl: a.buyQty > 0 && a.sellQty > 0 ? a.sellVal - a.buyVal : 0,
        unrealisedPnl: 0,
        buyDate: a.buyDate,
        sellDate: a.sellDate,
        productHint: productHint(a.product),
        exchangeHint: exchangeFrom(a.exch),
        sourceFile: ctx.filename,
        executions: a.executions,
      });
    }
    warnings.push(`${label} tradebook aggregated per tradingsymbol+product; verify F&O classification and re-tag MTF rows once (overrides persist).`);
    return { sourceId: broker, broker, format: "tradebook", trades, warnings };
  }

  // ---- Aggregated P&L / holdings report ----
  const cBuyQty = find("buy quantity", "buy qty", "quantity bought");
  const cSellQty = find("sell quantity", "sell qty", "quantity sold");
  const cBuyVal = find("buy value", "buy amount", "total buy value");
  const cSellVal = find("sell value", "sell amount", "total sell value");
  const cBuyAvg = find("buy average", "buy avg", "average buy price", "buy price", "buy rate");
  const cSellAvg = find("sell average", "sell avg", "average sell price", "sell price", "sell rate");
  const cPnl = find("realized p&l", "realised p&l", "realized pnl", "realised pnl", "profit/loss", "net p&l", "pnl", "profit");

  const trades: NormalizedTrade[] = [];
  for (const r of dataRows) {
    const symbol = cSymbol >= 0 ? (r[cSymbol] ?? "").trim() : "";
    if (!symbol) continue;
    const qty = cQty >= 0 ? toNum(r[cQty]) : 0;
    const buyQty = cBuyQty >= 0 ? toNum(r[cBuyQty]) : qty;
    const sellQty = cSellQty >= 0 ? toNum(r[cSellQty]) : qty;
    const buyAvg = cBuyAvg >= 0 ? toNum(r[cBuyAvg]) : 0;
    const sellAvg = cSellAvg >= 0 ? toNum(r[cSellAvg]) : 0;
    const buyVal = cBuyVal >= 0 ? toNum(r[cBuyVal]) : buyQty * buyAvg;
    const sellVal = cSellVal >= 0 ? toNum(r[cSellVal]) : sellQty * sellAvg;
    if (buyQty <= 0 && sellQty <= 0) continue;
    trades.push({
      broker,
      tradingsymbol: symbol,
      isin: cIsin >= 0 ? r[cIsin] || null : null,
      buyQty,
      avgBuyPrice: buyAvg || (buyQty ? buyVal / buyQty : 0),
      buyValue: buyVal,
      sellQty,
      avgSellPrice: sellAvg || (sellQty ? sellVal / sellQty : 0),
      sellValue: sellVal,
      closingPrice: null,
      grossPnl: cPnl >= 0 ? toNum(r[cPnl]) : sellVal - buyVal,
      unrealisedPnl: 0,
      buyDate: cDate >= 0 ? r[cDate] || null : null,
      sellDate: null,
      productHint: cProduct >= 0 ? productHint(r[cProduct]) : null,
      exchangeHint: cExch >= 0 ? exchangeFrom(r[cExch]) : null,
      sourceFile: ctx.filename,
    });
  }
  warnings.push(`${label} P&L report is aggregated per scrip; segment/MTF may need re-tagging (overrides persist across re-imports).`);
  return { sourceId: broker, broker, format: "pnl-report", trades, warnings };
}

export const detectAngelOne = (ctx: ParseContext) => detectFor("angelone", /angel|angelone|angelbroking/i, ctx);
export const parseAngelOne = (ctx: ParseContext) => parseFor("angelone", ctx);

export const detectUpstox = (ctx: ParseContext) => detectFor("upstox", /upstox|rksv/i, ctx);
export const parseUpstox = (ctx: ParseContext) => parseFor("upstox", ctx);
