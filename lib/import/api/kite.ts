// P2.1 — Zerodha Kite Connect ApiImportSource (the first "api" implementation
// of the ImportSource seam). Kite's GET /trades returns TODAY's executions
// only (historical tradebooks stay on the CSV path), so this is the daily
// auto-pull: fetch → normalize → the unchanged classify→charges→dedup→commit
// pipeline. normalizeKiteTrades is pure and unit-tested; the fetch wrapper is
// a thin authenticated GET.

import type { NormalizedTrade, ProductHint } from "@/lib/engine/types";
import type { Exchange } from "@/lib/domain/constants";
import type { ApiImportSource, ParsedFile } from "@/lib/import/types";

/** One execution row from Kite GET /trades (fields we consume). */
export interface KiteTradeRow {
  tradingsymbol: string;
  exchange: string; // NSE | BSE | NFO | BFO | CDS | MCX
  product: string; // CNC | MIS | NRML | MTF
  transaction_type: string; // BUY | SELL
  quantity: number;
  average_price: number;
  fill_timestamp?: string | null; // "2026-07-11 10:02:31"
  order_timestamp?: string | null;
}

function productHintOf(product: string): ProductHint {
  const p = product.toUpperCase();
  if (p === "MIS") return "intraday";
  if (p === "CNC") return "delivery";
  if (p === "MTF") return "mtf";
  return null; // NRML (F&O/commodity) — the classifier decides from the symbol
}

function exchangeOf(exchange: string): Exchange | null {
  const e = exchange.toUpperCase();
  if (e === "NSE" || e === "NFO" || e === "CDS") return "NSE";
  if (e === "BSE" || e === "BFO") return "BSE";
  if (e === "MCX") return "MCX";
  return null;
}

function dateOf(row: KiteTradeRow): string | null {
  const ts = row.fill_timestamp ?? row.order_timestamp ?? null;
  if (!ts) return null;
  const d = ts.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Aggregate raw executions into one NormalizedTrade per tradingsymbol+product,
 * keeping the EARLIEST buy execution date and the LATEST sell execution date
 * (per-leg dates — the lesson from the tradebook parser).
 */
export function normalizeKiteTrades(rows: KiteTradeRow[]): NormalizedTrade[] {
  interface Agg {
    symbol: string;
    product: string;
    exchange: Exchange | null;
    buyQty: number;
    buyValue: number;
    sellQty: number;
    sellValue: number;
    buyDate: string | null;
    sellDate: string | null;
  }
  const groups = new Map<string, Agg>();
  for (const row of rows) {
    if (!row.tradingsymbol || !(row.quantity > 0)) continue;
    const key = `${row.tradingsymbol}|${row.product}`;
    const g =
      groups.get(key) ??
      ({
        symbol: row.tradingsymbol,
        product: row.product,
        exchange: exchangeOf(row.exchange),
        buyQty: 0,
        buyValue: 0,
        sellQty: 0,
        sellValue: 0,
        buyDate: null,
        sellDate: null,
      } as Agg);
    const value = row.quantity * row.average_price;
    const date = dateOf(row);
    if (row.transaction_type.toUpperCase() === "BUY") {
      g.buyQty += row.quantity;
      g.buyValue += value;
      if (date && (g.buyDate == null || date < g.buyDate)) g.buyDate = date;
    } else {
      g.sellQty += row.quantity;
      g.sellValue += value;
      if (date && (g.sellDate == null || date > g.sellDate)) g.sellDate = date;
    }
    groups.set(key, g);
  }

  return [...groups.values()].map((g) => {
    const closedQty = Math.min(g.buyQty, g.sellQty);
    const gross =
      closedQty > 0 && g.buyQty > 0 && g.sellQty > 0
        ? r2((g.sellValue / g.sellQty - g.buyValue / g.buyQty) * closedQty)
        : 0;
    return {
      broker: "zerodha" as const,
      tradingsymbol: g.symbol,
      isin: null,
      buyQty: g.buyQty,
      avgBuyPrice: g.buyQty > 0 ? r2(g.buyValue / g.buyQty) : 0,
      buyValue: r2(g.buyValue),
      sellQty: g.sellQty,
      avgSellPrice: g.sellQty > 0 ? r2(g.sellValue / g.sellQty) : 0,
      sellValue: r2(g.sellValue),
      closingPrice: null,
      grossPnl: gross,
      unrealisedPnl: 0,
      buyDate: g.buyDate,
      sellDate: g.sellDate,
      productHint: productHintOf(g.product),
      exchangeHint: g.exchange,
      sourceFile: "kite-api",
    };
  });
}

export interface KiteCredentials {
  apiKey: string;
  accessToken: string;
}

/** Authenticated GET against the Kite Connect REST API. */
export async function fetchKiteTrades(creds: KiteCredentials): Promise<KiteTradeRow[]> {
  const res = await fetch("https://api.kite.trade/trades", {
    headers: {
      "X-Kite-Version": "3",
      Authorization: `token ${creds.apiKey}:${creds.accessToken}`,
    },
    cache: "no-store",
  });
  const json = (await res.json().catch(() => null)) as
    | { status?: string; data?: KiteTradeRow[]; message?: string }
    | null;
  if (!res.ok || !json || json.status !== "success" || !Array.isArray(json.data)) {
    const why = json?.message ?? `HTTP ${res.status}`;
    throw new Error(`Kite API: ${why}${res.status === 403 ? " (access token expired? Tokens last one trading day.)" : ""}`);
  }
  return json.data;
}

export function kiteImportSource(creds: KiteCredentials): ApiImportSource {
  return {
    id: "kite-api",
    label: "Zerodha Kite Connect (today's executions)",
    broker: "zerodha",
    kind: "api",
    async fetchTrades() {
      return normalizeKiteTrades(await fetchKiteTrades(creds));
    },
  };
}

/** Wrap an API pull in the ParsedFile shape the preview/commit pipeline expects. */
export function toParsedFile(trades: NormalizedTrade[]): ParsedFile {
  return {
    sourceId: "kite-api",
    broker: "zerodha",
    format: "api",
    trades,
    warnings:
      trades.length === 0
        ? ["Kite returned no executions for today — the /trades endpoint only covers the current trading day."]
        : [],
  };
}
