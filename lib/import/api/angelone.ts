/**
 * Angel One SmartAPI — the first UNATTENDED broker sync.
 *
 * ── Why Angel One goes first (docs/DECISIONS.md, 2026-08-12) ───────────────
 *
 * Free (SmartAPI has no subscription), and its second factor is a standard
 * TOTP — so with the enrolled secret in the v2.99.80 vault, the daily login
 * needs no human. Zerodha needs a browser redirect a human must click; Groww
 * charges ₹499/month; Upstox's year token is static-IP-gated. Angel One is
 * the one broker where "connect once, pull daily" is honest. It is also the
 * broker whose Tax P&L file this app already parses — so the first live pull
 * can be reconciled against a known import path.
 *
 * ── Read-only BY SURFACE ────────────────────────────────────────────────────
 *
 * This module exports login + trade-book + the pure mapping helpers, and
 * nothing else. No order placement, no modification, no fund calls — a
 * compromise of this code path cannot trade. tests/angelone-api.test.ts pins
 * the export list so an order method cannot be added without failing CI.
 *
 * ── What is VERIFIED vs INFERRED ────────────────────────────────────────────
 *
 * The login contract (endpoint, clientcode/password/totp body, jwt response)
 * is verified against Angel One's published docs. The TRADE-BOOK row shape is
 * INFERRED from those docs' examples and mapped defensively (candidate field
 * names, refuse-don't-coerce) — the first live pull should be previewed and
 * reconciled against a contract note before trusting values, and the preview
 * step the import pipeline already forces is exactly that check.
 *
 * The trade book covers the CURRENT DAY only. A daily pull after close builds
 * the journal forward; history still arrives by file (the Tax P&L importer).
 */

import { todayIstIso } from "@/lib/domain/trading-day";
import type { Execution, NormalizedTrade, ProductHint } from "@/lib/engine/types";
import type { Exchange } from "@/lib/domain/constants";
import type { ApiImportSource, ParsedFile } from "@/lib/import/types";
import { totp } from "@/lib/totp";

export interface AngelOneCredentials {
  /** SmartAPI app key (X-PrivateKey). */
  apiKey: string;
  clientCode: string;
  pin: string;
  /** The base32 TOTP SECRET from SmartAPI 2FA enrollment — not a 6-digit code. */
  totpSecret: string;
}

const BASE = "https://apiconnect.angelone.in";

/**
 * SmartAPI demands client-environment headers on every call. The values are
 * self-descriptions, not authentication: the loopback address and a null MAC
 * are honest for a desktop app that does not go collecting identifiers it
 * has no other use for (the machine-id module namespaces its own use).
 */
function smartApiHeaders(apiKey: string, jwt?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-UserType": "USER",
    "X-SourceID": "WEB",
    "X-ClientLocalIP": "127.0.0.1",
    "X-ClientPublicIP": "127.0.0.1",
    "X-MACAddress": "00:00:00:00:00:00",
    "X-PrivateKey": apiKey,
    ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
  };
}

interface SmartApiEnvelope<T> {
  status: boolean;
  message?: string;
  errorcode?: string;
  data?: T | null;
}

async function smartApiJson<T>(res: Response, what: string): Promise<T | null> {
  const json = (await res.json().catch(() => null)) as SmartApiEnvelope<T> | null;
  if (!res.ok || !json || json.status === false) {
    const msg = json?.message || `HTTP ${res.status}`;
    const hint = /totp/i.test(msg)
      ? " (TOTP rejected — check the enrolled secret and that this machine's clock is right; a drifted clock produces valid-looking wrong codes.)"
      : /password|pin/i.test(msg)
        ? " (PIN rejected — the login PIN, not the account password.)"
        : "";
    throw new Error(`Angel One ${what}: ${msg}${hint}`);
  }
  return json.data ?? null;
}

/** Login for a to-midnight session. The TOTP code is minted here, at call time. */
export async function angelOneLogin(creds: AngelOneCredentials): Promise<{ jwtToken: string }> {
  const res = await fetch(`${BASE}/rest/auth/angelbroking/user/v1/loginByPassword`, {
    method: "POST",
    headers: smartApiHeaders(creds.apiKey),
    body: JSON.stringify({ clientcode: creds.clientCode, password: creds.pin, totp: totp(creds.totpSecret) }),
    cache: "no-store",
  });
  const data = await smartApiJson<{ jwtToken?: string }>(res, "login");
  if (!data?.jwtToken) throw new Error("Angel One login: no session token in the response.");
  return { jwtToken: data.jwtToken };
}

/** One row of GET …/order/v1/getTradeBook.
 *
 *  Shape VERIFIED against a live response on 2026-08-27 (11 real fills across
 *  NFO/BFO/NSE/BSE, all four products) — the candidate-name fallbacks are kept
 *  because older docs showed camelCase variants. The verified row STATES the
 *  derivative facts outright: `instrumenttype` (OPTSTK/OPTIDX/FUT…, "" for
 *  equity), `strikeprice` (−1 for equity), `optiontype` ("CE"/"PE"/""),
 *  `expirydate` ("29SEP2026", "" for equity). */
export interface AngelTradeRow {
  tradingsymbol?: string;
  tradingSymbol?: string;
  exchange?: string;
  producttype?: string;
  productType?: string;
  transactiontype?: string;
  transactionType?: string;
  instrumenttype?: string;
  strikeprice?: string | number;
  optiontype?: string;
  expirydate?: string;
  marketlot?: string | number;
  fillsize?: string | number;
  fillSize?: string | number;
  tradedqty?: string | number;
  fillprice?: string | number;
  fillPrice?: string | number;
  tradedprice?: string | number;
  filltime?: string;
  fillTime?: string;
  tradetime?: string;
}

export async function fetchAngelTradeBook(creds: AngelOneCredentials, jwtToken: string): Promise<AngelTradeRow[]> {
  const res = await fetch(`${BASE}/rest/secure/angelbroking/order/v1/getTradeBook`, {
    method: "GET",
    headers: smartApiHeaders(creds.apiKey, jwtToken),
    cache: "no-store",
  });
  const data = await smartApiJson<AngelTradeRow[]>(res, "trade book");
  return Array.isArray(data) ? data : [];
}

/** DELIVERY→delivery, intraday flavours→intraday, MARGIN→mtf,
 *  CARRYFORWARD→null (the F&O carry product — the classifier decides).
 *
 *  MARGIN is Angel One's MTF product on EQUITY rows — verified against a live
 *  trade book on 2026-08-27, where a real MTF trade arrived as
 *  `producttype: "MARGIN"` on an NSE equity row while every F&O row carried
 *  CARRYFORWARD. The old mapping sent MARGIN→null on the assumption it was an
 *  F&O carry product; it is not. */
export function productHintOf(productType: string | undefined): ProductHint {
  switch (String(productType ?? "").toUpperCase()) {
    case "DELIVERY": return "delivery";
    case "MTF":
    case "MARGIN": return "mtf";
    case "INTRADAY":
    case "BO":
    case "CO": return "intraday";
    default: return null;
  }
}

export function exchangeOf(exchange: string | undefined): Exchange | null {
  const s = String(exchange ?? "").toUpperCase();
  if (s.startsWith("NSE") || s.startsWith("NFO") || s.startsWith("CDS")) return "NSE";
  if (s.startsWith("BSE") || s.startsWith("BFO")) return "BSE";
  if (s.startsWith("MCX")) return "MCX";
  return null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown): number => {
  const x = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(x) ? x : 0;
};
const hhmm = (v: string | undefined): string | null => {
  const m = String(v ?? "").match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
};

const MON: Record<string, string> = {
  JAN: "Jan", FEB: "Feb", MAR: "Mar", APR: "Apr", MAY: "May", JUN: "Jun",
  JUL: "Jul", AUG: "Aug", SEP: "Sep", OCT: "Oct", NOV: "Nov", DEC: "Dec",
};

/** "29SEP2026" → "29 Sep 2026". Null for the equity sentinel "" or junk. */
function expiryPretty(v: string | undefined): string | null {
  const m = /^(\d{1,2})([A-Z]{3})(\d{4})$/.exec(String(v ?? "").trim().toUpperCase());
  if (!m || !MON[m[2]!]) return null;
  return `${m[1]} ${MON[m[2]!]} ${m[3]}`;
}

/**
 * Canonicalise a derivative name from Angel One's STATED fields.
 *
 * The trade book states everything — `instrumenttype`, `strikeprice`,
 * `optiontype`, `expirydate` — and the live payload (2026-08-27) proved the
 * symbol cannot be trusted for dates: `SENSEX26AUG77600CE` carried a stated
 * expiry of 27AUG2026. So the canonical `OPT <SYM> <DD Mon YYYY> <STRIKE>
 * <CE|PE>` / `FUT <SYM> <DD Mon YYYY>` name is BUILT from the stated fields;
 * only the UNDERLYING is recovered from the symbol, by stripping the stated
 * strike+type suffix and then a trailing date-like token.
 *
 * Returns null for a non-derivative row or when the stated facts are
 * incomplete (the caller keeps the raw name and SAYS SO).
 */
export function canonicalAngelName(r: AngelTradeRow): string | null {
  const it = String(r.instrumenttype ?? "").toUpperCase();
  const isOpt = it.startsWith("OPT");
  const isFut = it.startsWith("FUT");
  if (!isOpt && !isFut) return null;
  const date = expiryPretty(r.expirydate);
  if (!date) return null;
  let u = String(r.tradingsymbol ?? r.tradingSymbol ?? "").trim().toUpperCase();

  if (isOpt) {
    const ot = String(r.optiontype ?? "").toUpperCase();
    const strike = num(r.strikeprice);
    if ((ot !== "CE" && ot !== "PE") || !(strike > 0)) return null;
    const suffix = `${String(strike)}${ot}`;
    if (u.endsWith(suffix)) u = u.slice(0, -suffix.length);
    u = u.replace(/\d{1,2}[A-Z]{3}\d{0,4}$/, "");
    if (!u) return null;
    return `OPT ${u} ${date} ${String(strike)} ${ot}`;
  }
  if (u.endsWith("FUT")) u = u.slice(0, -3);
  u = u.replace(/\d{1,2}[A-Z]{3}\d{0,4}$/, "");
  if (!u) return null;
  return `FUT ${u} ${date}`;
}

/** NSE series suffix on equity symbols ("HFCL-EQ", "X-BE") → bare ticker, so
 *  Angel API trades line up with every other source's symbols. */
export function stripSeriesSuffix(symbol: string): string {
  return symbol.replace(/-(EQ|BE|BZ|BL|GS|SM|ST)$/i, "");
}

/**
 * Today's fills → normalized trades, aggregated per symbol + product with the
 * executions preserved — the same round-trip shape the Zerodha and Paytm
 * tradebook paths produce, so staged ladders and dedup behave identically.
 * A row without a readable side, quantity or price is REFUSED and counted,
 * never coerced (a zero-share trade is worse than no trade).
 */
export function normalizeAngelTrades(rows: AngelTradeRow[], today: string): { trades: NormalizedTrade[]; refused: number } {
  type Acc = {
    symbol: string; canonical: string | null; notes: string[];
    product: string; exch: string | undefined;
    buyQty: number; buyVal: number; sellQty: number; sellVal: number;
    executions: Execution[];
  };
  const groups = new Map<string, Acc>();
  let refused = 0;

  for (const r of rows) {
    const symbol = String(r.tradingsymbol ?? r.tradingSymbol ?? "").trim();
    const qty = num(r.fillsize ?? r.fillSize ?? r.tradedqty);
    const price = num(r.fillprice ?? r.fillPrice ?? r.tradedprice);
    const rawSide = String(r.transactiontype ?? r.transactionType ?? "").toUpperCase();
    const side = rawSide.startsWith("B") ? "buy" : rawSide.startsWith("S") ? "sell" : null;
    if (!symbol || !side || qty <= 0 || price <= 0) {
      refused++;
      continue;
    }

    const product = String(r.producttype ?? r.productType ?? "");
    const key = `${symbol}|${product}`;
    let acc = groups.get(key);
    if (!acc) {
      // Derivative names come from the STATED fields (instrumenttype, strike,
      // option type, expiry) — the live payload proved the symbol's own date
      // token can disagree with the stated expiry. An F&O row whose stated
      // facts are incomplete keeps its raw name and SAYS SO. Equity symbols
      // lose their NSE series suffix so they line up with every other source.
      const canonical = canonicalAngelName(r);
      const notes: string[] = [];
      if (!canonical && String(r.instrumenttype ?? "").trim() !== "") {
        notes.push(
          `${symbol} is ${String(r.instrumenttype)} per Angel One but stated no usable expiry/strike/option type — imported with its raw name; check its segment.`,
        );
      }
      acc = {
        symbol: canonical ?? stripSeriesSuffix(symbol),
        canonical, notes,
        product, exch: r.exchange,
        buyQty: 0, buyVal: 0, sellQty: 0, sellVal: 0, executions: [],
      };
    }
    if (side === "buy") { acc.buyQty += qty; acc.buyVal += qty * price; }
    else { acc.sellQty += qty; acc.sellVal += qty * price; }
    acc.executions.push({ side, qty, price, date: today, time: hhmm(r.filltime ?? r.fillTime ?? r.tradetime) });
    groups.set(key, acc);
  }

  const trades: NormalizedTrade[] = [];
  for (const a of groups.values()) {
    const closed = a.sellQty > 0 && a.buyQty === a.sellQty;
    trades.push({
      broker: "angelone",
      tradingsymbol: a.symbol,
      isin: null,
      buyQty: a.buyQty,
      avgBuyPrice: a.buyQty ? r2(a.buyVal / a.buyQty) : 0,
      buyValue: r2(a.buyVal),
      sellQty: a.sellQty,
      avgSellPrice: a.sellQty ? r2(a.sellVal / a.sellQty) : 0,
      sellValue: r2(a.sellVal),
      closingPrice: null,
      grossPnl: closed ? r2(a.sellVal - a.buyVal) : 0,
      unrealisedPnl: 0,
      // The trade book is the CURRENT day's fills, so today is the honest date.
      buyDate: a.buyQty > 0 ? today : null,
      sellDate: closed ? today : null,
      entryTime: a.executions.find((e) => e.side === "buy")?.time ?? null,
      exitTime: [...a.executions].reverse().find((e) => e.side === "sell")?.time ?? null,
      productHint: productHintOf(a.product),
      exchangeHint: exchangeOf(a.exch),
      sourceFile: "angelone-api",
      executions: a.executions,
      importNotes: a.notes.length ? a.notes : null,
    });
  }
  return { trades, refused };
}

export function angelOneImportSource(creds: AngelOneCredentials): ApiImportSource {
  return {
    id: "angelone-api",
    label: "Angel One SmartAPI (today's trade book, unattended TOTP login)",
    broker: "angelone",
    kind: "api",
    async fetchTrades() {
      const { jwtToken } = await angelOneLogin(creds);
      const today = todayIstIso();
      return normalizeAngelTrades(await fetchAngelTradeBook(creds, jwtToken), today).trades;
    },
  };
}

/** Wrap a pull in the ParsedFile shape the preview/commit pipeline expects. */
export function toParsedFile(trades: NormalizedTrade[], refused = 0): ParsedFile {
  const warnings: string[] = [];
  if (trades.length === 0) {
    warnings.push(
      "Angel One returned no fills — the trade book covers only the CURRENT trading day, so it is empty on a day you did not trade. Pull after market close on trading days; re-pulls are de-duplicated.",
    );
  } else {
    warnings.push(
      "Trades are today's fills from the SmartAPI trade book, aggregated per symbol + product; F&O contracts are named from the fields Angel One states (the field mapping was verified against a live trade book on 2026-08-27). Charges are computed from your rate card — the API states none.",
    );
  }
  if (refused > 0) {
    warnings.push(`${refused} fill${refused === 1 ? "" : "s"} had no readable side, quantity or price and ${refused === 1 ? "was" : "were"} refused rather than guessed.`);
  }
  return { sourceId: "angelone-api", broker: "angelone", format: "api", trades, warnings };
}
