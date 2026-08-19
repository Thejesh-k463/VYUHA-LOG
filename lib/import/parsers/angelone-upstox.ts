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
import { extractTime } from "../time-parse";
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

/**
 * Confidence that this file is THIS broker's export.
 *
 * ── The naming evidence is mandatory, and that is the whole point ──────────
 *
 * The shape signals below (a symbol column, a side column, a buy/sell value
 * pair) describe *every* Indian broker's tradebook, not Angel One's or
 * Upstox's specifically. Scoring on shape alone, this function used to return
 * 0.2 for any CSV that merely had a column called "Scrip" — enough to win the
 * registry outright. A Kotak Neo, Paytm Money or Sahi tradebook was therefore
 * imported silently AS ANGEL ONE: stamped with the wrong broker, priced with
 * Angel One's charge rates, and reconciling against nothing.
 *
 * So a broker-named parser now has to see the broker's NAME — in the filename
 * or in a fingerprint cell — before it claims anything. Shape only sharpens a
 * claim the name already justified. A file that names no broker falls through
 * to the generic column mapper, where the user says whose it is; that is a
 * question, which is always better than a confident wrong answer.
 */
function detectFor(broker: Broker, nameRe: RegExp, ctx: ParseContext): number {
  const namedInFile = nameRe.test(ctx.filename);
  const rows = toMatrix(ctx);
  const h = findHeader(rows);
  if (h < 0) return namedInFile ? 0.3 : 0;

  const cells = rows[h].map(norm);
  // Only a string that NAMES the broker qualifies as a fingerprint. This used
  // to accept a bare `clientcode`/`clientid` column — generic broker
  // vocabulary that let a no-name file with a Client ID column score 0.8 as
  // Upstox (measured 2026-08-12). Those columns are refinement now, below.
  const namesBroker = (cs: string[]) =>
    broker === "angelone" ? cs.some((c) => c.includes("angel")) : cs.some((c) => c.includes("upstox"));
  const headerFingerprint = namesBroker(cells);

  // Upstox's real reports never repeat the broker name in the HEADER row: it
  // sits in the legal-entity banner above it ("UPSTOX SECURITIES PRIVATE
  // LIMITED", rows 0-2), and the filenames (trade_…, realizedPnL_…, ledger_…)
  // name nobody at all. Reading only the header therefore scored 0 on both
  // real reports, which then fell to the generic mapper — and it picked the
  // wrong header row out of the label block (verified 2026-08-20 against three
  // real exports). The banner IS an in-content fingerprint, so it counts as
  // equivalent to a named file. Angel One is deliberately not given the same
  // treatment: its scoring is unchanged and no evidence asked for it.
  const bannerFingerprint =
    broker === "upstox" && rows.slice(0, Math.min(13, h)).some((r) => namesBroker(r.map(norm)));
  const fingerprint = headerFingerprint || bannerFingerprint;

  // No name, no claim.
  if (!namedInFile && !fingerprint) return 0;

  let score = namedInFile || bannerFingerprint ? 0.4 : 0;
  if (fingerprint) score += 0.1;
  if (cells.includes("clientcode") || cells.includes("clientid")) score += 0.05;
  const hasSymbol = cells.some((c) => ["symbol", "tradingsymbol", "scrip", "scripname", "instrument"].includes(c));
  if (hasSymbol) score += 0.2;
  // Side column (tradebook) or an aggregated buy/sell pair (P&L report).
  if (cells.some((c) => ["buysell", "tradetype", "transactiontype", "side", "ordertype"].includes(c))) score += 0.25;
  const hasPair = (a: string, b: string) =>
    cells.some((c) => c.includes(a)) && cells.some((c) => c.includes(b));
  // "Buy Amt"/"Sell Amt" is Upstox's realised-P&L spelling of the same pair.
  if (hasPair("buyvalue", "sellvalue") || hasPair("buyamt", "sellamt")) score += 0.25;
  return Math.min(1, score);
}

/** Instrument-type values that mean "plain equity" in an Upstox trade report.
 *  Anything else (FUTIDX/OPTSTK/FUT/OPT/CE/PE) is F&O, and this parser has
 *  never seen a real F&O row — so it flags rather than guesses a symbol. */
const EQUITY_INSTRUMENTS = new Set(["eq", "equity", "eqty", "stock", "stocks", "cash"]);
const isEquityInstrument = (raw: string) => {
  const s = norm(raw);
  return !s || EQUITY_INSTRUMENTS.has(s);
};

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
  // Upstox's trade report splits the clock off into its own column ("Trade
  // Time"), so the date cell carries no time at all and entryTime/exitTime came
  // back null for every imported row. Resolved separately; the date cell stays
  // the fallback for the brokers that keep one timestamp.
  const cTime = find("trade time", "order execution time", "execution time", "time");
  const warnings: string[] = [];

  if (cSide >= 0 && cQty >= 0) {
    // ---- Tradebook: aggregate executions per tradingsymbol + product ----
    // Upstox states the instrument type (and strike/expiry) per row. An F&O row
    // is flagged, not decoded: no real Upstox derivatives export has been seen,
    // so its tradingsymbol grammar is unknown and inventing one would silently
    // misclassify the trade AND mis-charge it.
    const cInstrType = broker === "upstox" ? find("instrument type", "instrumenttype") : -1;
    const cStrike = cInstrType >= 0 ? find("strike price", "strike") : -1;
    const cExpiry = cInstrType >= 0 ? find("expiry", "expiry date") : -1;
    type Acc = {
      symbol: string; isin: string | null; product: string; exch: string;
      buyDate: string | null; sellDate: string | null;
      buyQty: number; buyVal: number; sellQty: number; sellVal: number;
      executions: Execution[]; notes: string[];
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
        executions: [], notes: [],
      };
      const qty = toNum(r[cQty]);
      const price = toNum(r[cPrice]);
      const date = cDate >= 0 ? (r[cDate] || null) : null;
      const time = extractTime(cTime >= 0 ? r[cTime] : null) ?? extractTime(date);
      const side = norm(r[cSide]);
      if (cInstrType >= 0 && !isEquityInstrument(r[cInstrType] ?? "")) {
        const note =
          `Upstox F&O row: instrument type ${(r[cInstrType] ?? "").trim() || "—"}, ` +
          `strike ${(cStrike >= 0 ? r[cStrike] : "").trim() || "—"}, ` +
          `expiry ${(cExpiry >= 0 ? r[cExpiry] : "").trim() || "—"} — tradingsymbol grammar ` +
          `unverified against a real row; check the classification`;
        if (!acc.notes.includes(note)) acc.notes.push(note);
      }
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
      if (qty > 0) {
        acc.executions.push({
          side: side.startsWith("b") ? "buy" : "sell",
          qty,
          price,
          date,
          time,
        });
      }
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
        entryTime: a.executions.find((e) => e.side === "buy")?.time ?? null,
        exitTime: [...a.executions].reverse().find((e) => e.side === "sell")?.time ?? null,
        sellDate: a.sellDate,
        productHint: productHint(a.product),
        exchangeHint: exchangeFrom(a.exch),
        sourceFile: ctx.filename,
        executions: a.executions,
        importNotes: a.notes.length ? a.notes : null,
      });
    }
    warnings.push(`${label} tradebook aggregated per tradingsymbol+product; verify F&O classification and re-tag MTF rows once (overrides persist).`);
    return { sourceId: broker, broker, format: "tradebook", trades, warnings };
  }

  // ---- Aggregated P&L / holdings report ----
  const cBuyQty = find("buy quantity", "buy qty", "quantity bought");
  const cSellQty = find("sell quantity", "sell qty", "quantity sold");
  const cBuyVal = find("buy value", "buy amount", "buy amt", "total buy value");
  const cSellVal = find("sell value", "sell amount", "sell amt", "total sell value");
  const cBuyAvg = find("buy average", "buy avg", "average buy price", "buy price", "buy rate");
  const cSellAvg = find("sell average", "sell avg", "average sell price", "sell price", "sell rate");
  const cPnl = find("realized p&l", "realised p&l", "realized pnl", "realised pnl", "profit/loss", "net p&l", "total pl", "total p&l", "total p/l", "pnl", "profit");
  // Upstox's realised-P&L report dates both legs of the round trip.
  const cBuyDate = find("buy date");
  const cSellDate = find("sell date");
  // …and states the tax bucket rather than the product. Speculation is the
  // Income-Tax Act's name for an intraday equity trade; Short/Long Term means
  // it was delivered. That is a DERIVED product, flagged as such — the file
  // never says "MIS" or "CNC".
  const cSpeculation = find("speculation");
  const cShortTerm = find("short term");
  const cLongTerm = find("long term");
  const hasTaxBuckets = cSpeculation >= 0 || cShortTerm >= 0 || cLongTerm >= 0;

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

    let derivedProduct: ProductHint = null;
    let productDerived = false;
    if (cProduct < 0 && hasTaxBuckets) {
      const speculation = cSpeculation >= 0 ? toNum(r[cSpeculation]) : 0;
      const shortTerm = cShortTerm >= 0 ? toNum(r[cShortTerm]) : 0;
      const longTerm = cLongTerm >= 0 ? toNum(r[cLongTerm]) : 0;
      if (speculation !== 0) derivedProduct = "intraday";
      else if (shortTerm !== 0 || longTerm !== 0) derivedProduct = "delivery";
      productDerived = derivedProduct != null;
    }

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
      buyDate: (cBuyDate >= 0 ? r[cBuyDate] : cDate >= 0 ? r[cDate] : "") || null,
      sellDate: (cSellDate >= 0 ? r[cSellDate] : "") || null,
      productHint: cProduct >= 0 ? productHint(r[cProduct]) : derivedProduct,
      exchangeHint: cExch >= 0 ? exchangeFrom(r[cExch]) : null,
      sourceFile: ctx.filename,
      ...(productDerived
        ? {
            productDerived: true,
            importNotes: [
              "Product derived from the Speculation / Short Term / Long Term columns — the file states a tax bucket, not a product code.",
            ],
          }
        : {}),
    });
  }
  warnings.push(`${label} P&L report is aggregated per scrip; segment/MTF may need re-tagging (overrides persist across re-imports).`);
  return { sourceId: broker, broker, format: "pnl-report", trades, warnings };
}

export const detectAngelOne = (ctx: ParseContext) => detectFor("angelone", /angel|angelone|angelbroking/i, ctx);
export const parseAngelOne = (ctx: ParseContext) => parseFor("angelone", ctx);

export const detectUpstox = (ctx: ParseContext) => detectFor("upstox", /upstox|rksv/i, ctx);
export const parseUpstox = (ctx: ParseContext) => parseFor("upstox", ctx);
