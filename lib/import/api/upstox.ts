// Upstox ApiImportSource — the fourth native puller, and the first built on a
// LONG-LIVED read-only credential.
//
// ── Why this one is different ───────────────────────────────────────────────
//
// Upstox's "Analytics token" is a 1-year, read-only token (it cannot place,
// modify or cancel orders even in principle — write APIs reject it), so the
// connection is paste-once-per-year instead of Kite's paste-daily. The price
// of that convenience is Upstox's Static-IP gate: account APIs answer ONLY
// from the IPv4 address registered at account.upstox.com → Apps → Static IPs.
//
// TWO TRAPS, both found on the first live pull (2026-08-28) and coded around:
//
// 1. api.upstox.com is dual-stack (Cloudflare AAAA records), and Node prefers
//    IPv6 — so a request from a dual-stack machine arrives from the IPv6
//    address, never matches the registered IPv4, and 401s. The fetch below
//    goes through node:https with `family: 4` for exactly this reason; a
//    plain fetch() here would break every dual-stack user.
// 2. `exchange_timestamp` is NOT the fill time — the live payload showed
//    17:26:42 for an 11:56:42 IST fill (an extra +05:30). `order_timestamp`
//    carries the honest IST time and is what entry/exit times read.
//
// What the row STATES: exchange (NSE/BSE/NFO/BFO/…), product ("D"/"I"/"MTF" —
// and a real MTF trade really arrives as the literal string "MTF"), quantity,
// average_price, order_timestamp, and — equity only — the ISIN inside
// `instrument_token` ("NSE_EQ|INE372C01037"). What it does NOT state: strike,
// expiry or option type. The derivative FACT comes from the exchange; the
// contract details are parsed from Upstox's compact weekly symbol
// (`NIFTY2690124350CE` = NIFTY, 2026, month 9, day 01, 24350 CE — verified
// against three live contracts). Monthly-format symbols (YYMMM) do not state
// the expiry DAY at all, so they keep their raw name WITH A WARNING rather
// than guess an exchange calendar — same for futures; both get their fix the
// day a real payload carries one.

import { request as httpsRequest } from "node:https";
import type { NormalizedTrade, ProductHint, Execution } from "@/lib/engine/types";
import type { Exchange } from "@/lib/domain/constants";
import type { ApiImportSource, ParsedFile } from "@/lib/import/types";

/** One execution from GET /v2/order/trades/get-trades-for-day (VERIFIED
 *  against a live response, 2026-08-28 — 11 fills across NSE/NFO/BFO). */
export interface UpstoxTradeRow {
  exchange?: string; // NSE | BSE | NFO | BFO | MCX …
  product?: string; // "D" | "I" | "MTF"
  tradingsymbol?: string;
  trading_symbol?: string; // the same value; both appear in the live payload
  instrument_token?: string; // "NSE_EQ|INE372C01037" (equity carries the ISIN)
  transaction_type?: string; // BUY | SELL
  quantity?: number | string;
  average_price?: number | string;
  order_timestamp?: string; // "2026-08-28 11:56:42" — IST, the honest time
  exchange_timestamp?: string; // NOT a fill time — see header trap #2
  trade_id?: string | number;
  order_id?: string;
}

export interface UpstoxCredentials {
  /** The Analytics token (account.upstox.com → Apps → Analytics). */
  accessToken: string;
}

/** "D"→delivery, "I"→intraday, "MTF"→mtf — for EQUITY rows. Derivative rows
 *  always hint null: Upstox labels an option carry "D", and the classifier's
 *  option branch decides the segment itself. */
export function productHintOf(product: string | undefined, isDerivative: boolean): ProductHint {
  if (isDerivative) return null;
  switch (String(product ?? "").toUpperCase()) {
    case "D": return "delivery";
    case "I": return "intraday";
    case "MTF": return "mtf";
    default: return null;
  }
}

export function exchangeOf(exchange: string | undefined): Exchange | null {
  const e = String(exchange ?? "").toUpperCase();
  if (e === "NSE" || e === "NFO" || e === "CDS") return "NSE";
  if (e === "BSE" || e === "BFO") return "BSE";
  if (e.startsWith("MCX")) return "MCX";
  return null;
}

/** A derivative exchange as Upstox names it. Currency deliberately excluded —
 *  Vyuha has no currency segment vocabulary (same rule as every adapter). */
export function isDerivativeExchange(exchange: string | undefined): boolean {
  const e = String(exchange ?? "").toUpperCase();
  return e === "NFO" || e === "BFO" || e.startsWith("MCX");
}

/** "NSE_EQ|INE372C01037" → "INE372C01037"; null when the token holds a
 *  numeric F&O id instead of an ISIN. */
export function isinOf(instrumentToken: string | undefined): string | null {
  const part = String(instrumentToken ?? "").split("|")[1] ?? "";
  return /^IN[A-Z0-9]{10}$/.test(part) ? part : null;
}

/** NSE series suffix on equity symbols ("EBGNG-EQ") → bare ticker, so Upstox
 *  trades line up with every other source's symbols. */
export function stripSeriesSuffix(symbol: string): string {
  return symbol.replace(/-(EQ|BE|BZ|BL|GS|SM|ST)$/i, "");
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Upstox weekly month codes: 1–9 for Jan–Sep, then O, N, D. */
const WEEKLY_MONTH: Record<string, number> = {
  "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
  O: 10, N: 11, D: 12,
};

/**
 * Canonicalise a derivative name from Upstox's compact WEEKLY option symbol.
 *
 * `NIFTY2690124350CE` → `OPT NIFTY 01 Sep 2026 24350 CE` — [BASE][YY][M][DD]
 * [STRIKE][CE|PE], month a single code (1–9, O, N, D). Verified against three
 * live contracts (NIFTY 01 Sep ×2, SENSEX 03 Sep). Monthly symbols (YYMMM,
 * e.g. `NIFTY26SEP24000CE`) carry NO expiry day, and inventing one from an
 * exchange calendar is exactly the guessing this codebase refuses — they
 * return null and the caller says so. Futures likewise, until a real payload
 * shows one.
 */
export function canonicalUpstoxSymbol(symbol: string, exchange: string | undefined): string | null {
  if (!isDerivativeExchange(exchange)) return null;
  const s = String(symbol ?? "").trim().toUpperCase();
  const m = /^([A-Z][A-Z0-9&-]*?)(\d{2})([1-9OND])(\d{2})(\d+(?:\.\d+)?)(CE|PE)$/.exec(s);
  if (!m) return null;
  const month = WEEKLY_MONTH[m[3]!];
  if (!month) return null;
  return `OPT ${m[1]} ${m[4]} ${MON[month - 1]} 20${m[2]} ${String(Number(m[5]))} ${m[6]}`;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown): number => {
  const x = Number(String(v ?? "").trim());
  return Number.isFinite(x) ? x : 0;
};
/** "2026-08-28 11:56:42" → "11:56" — from order_timestamp ONLY (trap #2). */
const hhmm = (v: string | undefined): string | null => {
  const m = /\s(\d{1,2}):(\d{2})/.exec(String(v ?? ""));
  return m ? `${m[1]!.padStart(2, "0")}:${m[2]}` : null;
};

/**
 * Today's fills → normalized trades, aggregated per symbol + product with
 * executions preserved — the same shape as the Kite/Angel tradebook paths.
 * A row without a readable side, quantity or price is REFUSED and counted.
 */
export function normalizeUpstoxTrades(
  rows: UpstoxTradeRow[],
  today: string,
): { trades: NormalizedTrade[]; refused: number; notes: string[] } {
  type Acc = {
    symbol: string; canonical: string | null; notes: string[]; isin: string | null;
    product: string; exch: string | undefined;
    buyQty: number; buyVal: number; sellQty: number; sellVal: number;
    executions: Execution[];
  };
  const groups = new Map<string, Acc>();
  let refused = 0;

  for (const r of Array.isArray(rows) ? rows : []) {
    const symbol = String(r.tradingsymbol ?? r.trading_symbol ?? "").trim();
    const qty = num(r.quantity);
    const price = num(r.average_price);
    const rawSide = String(r.transaction_type ?? "").toUpperCase();
    const side = rawSide.startsWith("B") ? "buy" : rawSide.startsWith("S") ? "sell" : null;
    if (!symbol || !side || qty <= 0 || price <= 0) {
      refused++;
      continue;
    }

    const product = String(r.product ?? "");
    const key = `${symbol}|${product}`;
    let acc = groups.get(key);
    if (!acc) {
      const canonical = canonicalUpstoxSymbol(symbol, r.exchange);
      const notes: string[] = [];
      if (!canonical && isDerivativeExchange(r.exchange)) {
        notes.push(
          `${symbol} arrived on ${String(r.exchange).toUpperCase()} (a derivative exchange) but does not parse as a weekly option — monthly and futures symbols state no expiry day, so it keeps its raw name; check its segment, and expect this to classify correctly once a stated-fields source covers it.`,
        );
      }
      acc = {
        symbol: canonical ?? stripSeriesSuffix(symbol),
        canonical, notes,
        isin: isinOf(r.instrument_token),
        product, exch: r.exchange,
        buyQty: 0, buyVal: 0, sellQty: 0, sellVal: 0, executions: [],
      };
    }
    if (side === "buy") { acc.buyQty += qty; acc.buyVal += qty * price; }
    else { acc.sellQty += qty; acc.sellVal += qty * price; }
    acc.executions.push({ side, qty, price, date: today, time: hhmm(r.order_timestamp) });
    groups.set(key, acc);
  }

  const trades: NormalizedTrade[] = [];
  for (const a of groups.values()) {
    const closed = a.sellQty > 0 && a.buyQty === a.sellQty;
    trades.push({
      broker: "upstox",
      tradingsymbol: a.symbol,
      isin: a.isin,
      buyQty: a.buyQty,
      avgBuyPrice: a.buyQty ? r2(a.buyVal / a.buyQty) : 0,
      buyValue: r2(a.buyVal),
      sellQty: a.sellQty,
      avgSellPrice: a.sellQty ? r2(a.sellVal / a.sellQty) : 0,
      sellValue: r2(a.sellVal),
      closingPrice: null,
      grossPnl: closed ? r2(a.sellVal - a.buyVal) : 0,
      unrealisedPnl: 0,
      buyDate: a.buyQty > 0 ? today : null,
      sellDate: closed ? today : null,
      entryTime: a.executions.find((e) => e.side === "buy")?.time ?? null,
      exitTime: [...a.executions].reverse().find((e) => e.side === "sell")?.time ?? null,
      productHint: productHintOf(a.product, isDerivativeExchange(a.exch)),
      exchangeHint: exchangeOf(a.exch),
      sourceFile: "upstox-api",
      executions: a.executions,
      importNotes: a.notes.length ? a.notes : null,
    });
  }
  return { trades, refused, notes: [...groups.values()].flatMap((g) => g.notes) };
}

/**
 * GET over node:https with `family: 4` — NOT fetch(). api.upstox.com is
 * dual-stack and the Static-IP gate matches the registered IPv4 only; a
 * default fetch egresses over IPv6 on dual-stack machines and every call
 * 401s (found live, 2026-08-28 — see the header).
 */
function upstoxGet<T>(path: string, token: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: "api.upstox.com",
        path,
        method: "GET",
        family: 4,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          let json: { status?: string; data?: unknown; errors?: { message?: string }[] } | null = null;
          try { json = JSON.parse(body); } catch { /* HTML error page etc. */ }
          if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new Error(
              "Upstox refused the token (401). The Analytics token needs your Static IP registered at account.upstox.com → Apps → Static IPs — and it must be your current IPv4 address (search \"what is my IP\"). Home connections can get a new address; re-register it if pulls stop working.",
            ));
            return;
          }
          if (!json || json.status !== "success") {
            reject(new Error(`Upstox ${path.split("?")[0]}: ${json?.errors?.[0]?.message ?? `HTTP ${res.statusCode}`}`));
            return;
          }
          resolve(json.data as T);
        });
      },
    );
    req.on("error", (e) => reject(new Error(`Cannot reach Upstox: ${e.message}`)));
    req.end();
  });
}

/** GET /v2/order/trades/get-trades-for-day — today's executions. */
export async function fetchUpstoxTrades(creds: UpstoxCredentials): Promise<UpstoxTradeRow[]> {
  const data = await upstoxGet<UpstoxTradeRow[] | null>("/v2/order/trades/get-trades-for-day", creds.accessToken);
  return Array.isArray(data) ? data : [];
}

export function upstoxImportSource(creds: UpstoxCredentials): ApiImportSource {
  return {
    id: "upstox-api",
    label: "Upstox (today's fills, year-long read-only Analytics token)",
    broker: "upstox",
    kind: "api",
    async fetchTrades() {
      const today = new Date().toISOString().slice(0, 10);
      return normalizeUpstoxTrades(await fetchUpstoxTrades(creds), today).trades;
    },
  };
}

/** Wrap a pull in the ParsedFile shape the preview/commit pipeline expects. */
export function toParsedFile(result: { trades: NormalizedTrade[]; refused: number; notes: string[] }): ParsedFile {
  const warnings: string[] = [];
  if (result.trades.length === 0) {
    warnings.push(
      "Upstox returned no fills — the trade book covers only the CURRENT trading day, so it is empty on a day you did not trade.",
    );
  } else {
    warnings.push(
      "Trades are today's fills from the Upstox trade book, aggregated per symbol + product (field mapping verified against a live trade book on 2026-08-28). Charges are computed from your rate card — the API states none.",
    );
  }
  if (result.refused > 0) {
    warnings.push(`${result.refused} fill${result.refused === 1 ? "" : "s"} had no readable side, quantity or price and ${result.refused === 1 ? "was" : "were"} refused rather than guessed.`);
  }
  warnings.push(...result.notes);
  return { sourceId: "upstox-api", broker: "upstox", format: "api", trades: result.trades, warnings };
}
