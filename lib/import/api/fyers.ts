/**
 * Fyers API v3 — a native READ-ONLY pull of today's trade book (v4.7.0 wave C6,
 * design D3/D3a, owner answers Q1/Q2/Q4).
 *
 * ── The login (the Kite precedent) ──────────────────────────────────────────
 * App ID + App Secret are saved once. On a pull day the user opens
 * `fyersLoginUrl` in THEIR browser, logs in on Fyers' own page, and pastes back
 * the redirected URL (or the bare `auth_code`); `extractFyersAuthCode` takes the
 * code BY NAME. `exchangeFyersAuthCode` swaps it server-side for the day's
 * access token (POST validate-authcode, `appIdHash = sha256("<appId>:<secret>")`
 * — F-A5). The token dies at the end of the trading day (F-A10); the route
 * caches it until then. No refresh token, no stored PIN (Q2).
 *
 * ── What is VERIFIED vs DOCUMENTED ──────────────────────────────────────────
 * Hosts, headers, the login body and the trade-book envelope are Fyers' own
 * SDK + Postman (R10 §2). The trade-book ROW values are not: no source shows a
 * real `symbol`, and `orderDateTime` has no stated format (R10 §3). So the
 * symbol goes through B1's `fyersTradingsymbol` (null → refused, counted), the
 * time is read only in the shapes pinned in tests/fyers-api.test.ts (else
 * null), and every pulled trade says it is documented, not yet verified (Q4).
 *
 * ── Read-only BY SURFACE ────────────────────────────────────────────────────
 * Login, profile, trade book and pure mapping — nothing else. No order, modify
 * or funds call; tests/fyers-api.test.ts pins the export list.
 */

import { createHash } from "node:crypto";
import pkg from "@/package.json";
import { todayIstIso } from "@/lib/domain/trading-day";
import { PULL_UNVERIFIED_LABEL } from "@/lib/domain/broker-pull-disclosure";
import type { Exchange } from "@/lib/domain/constants";
import type { Execution, NormalizedTrade, ProductHint } from "@/lib/engine/types";
import type { ApiImportSource, ParsedFile } from "@/lib/import/types";
import { FYERS_NUVAMA_EQUITY_UNVERIFIED, isFyersMirrorRow } from "@/lib/import/parsers/fyers-tradebook";
import { fyersTradingsymbol, fyersUnpricedRow, unpricedRefusalNote } from "@/lib/import/pull-symbols";
import { BrokerAuthExpired } from "./broker-auth-error";

/** The ONE Fyers host this app calls (F-A1). The browser login is on the same host. */
export const FYERS_API = "https://api-t1.fyers.in/api/v3";

/** Fyers' edge answers a bare 403 to a default library User-Agent (F-A12), so
 *  every call names the app and its version. */
const USER_AGENT = `Vyuha/${pkg.version}`;

function fyersHeaders(appId: string, accessToken?: string): Record<string, string> {
  return {
    ...(accessToken ? { Authorization: `${appId}:${accessToken}` } : {}),
    version: "3",
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };
}

/** Where the user's daily browser login happens (F-A2/A3). Shown as a link —
 *  the app never fetches it. */
export function fyersLoginUrl(args: { appId: string; redirectUri: string; state: string }): string {
  const q = new URLSearchParams({
    client_id: args.appId,
    redirect_uri: args.redirectUri,
    response_type: "code",
    state: args.state,
  });
  return `${FYERS_API}/generate-authcode?${q.toString()}`;
}

/** A bare code: a JWT-ish token, no spaces, no URL punctuation. */
const BARE_CODE = /^[A-Za-z0-9._~-]{8,}$/;

/**
 * The `auth_code` from what the user pasted: the whole redirected URL
 * (`https://127.0.0.1/?s=ok&code=200&auth_code=…&state=…`, F-A4), a bare query
 * string, or the bare code. Taken BY NAME — never "the longest parameter".
 * Null when nothing usable is there (the route answers with the instruction).
 */
export function extractFyersAuthCode(pasted: string): string | null {
  const s = String(pasted ?? "").trim();
  if (!s) return null;
  if (s.includes("=") || s.includes("?") || s.includes("://")) {
    const q = s.includes("?") ? s.slice(s.indexOf("?") + 1) : s;
    const code = new URLSearchParams(q.split("#")[0]).get("auth_code")?.trim() ?? "";
    return BARE_CODE.test(code) ? code : null;
  }
  return BARE_CODE.test(s) ? s : null;
}

/** sha256 hex of `"<appId>:<secret>"` — the documented appIdHash (F-A5). */
export function fyersAppIdHash(appId: string, secret: string): string {
  return createHash("sha256").update(`${appId}:${secret}`).digest("hex");
}

/** The codes Fyers states for a dead or invalid token (F-D2). */
const TOKEN_ERROR_CODES = new Set([-8, -15, -16, -17]);

interface FyersEnvelope {
  s?: string;
  code?: number;
  message?: string;
}

/** Throw the typed error on a stated token failure; a plain Error on any other refusal. */
function fyersRefusal(what: string, status: number, json: FyersEnvelope | null): Error {
  const code = typeof json?.code === "number" ? json.code : Number(json?.code);
  const msg = json?.message || `HTTP ${status}`;
  if (status === 401 || (json?.s === "error" && TOKEN_ERROR_CODES.has(code))) {
    return new BrokerAuthExpired(
      "fyers",
      "needsAuthCode",
      `Fyers ${what}: ${msg} — the Fyers session has ended (tokens last until the end of the trading day). Log in again at your Fyers login link and paste the new address.`,
    );
  }
  const hint =
    status === 403 && !json
      ? " (Fyers' edge refused the request with no body — report this; it refuses unrecognised clients.)"
      : status === 429
        ? " (Fyers' rate limit — wait a minute before pulling again.)"
        : "";
  return new Error(`Fyers ${what}: ${msg}${hint}`);
}

async function readJson(res: Response): Promise<FyersEnvelope | null> {
  const json = (await res.json().catch(() => null)) as unknown;
  return json && typeof json === "object" ? (json as FyersEnvelope) : null;
}

/**
 * Exchange the pasted auth_code for the day's access token (F-A5/A6). The SDK
 * sends no Authorization header on this call, and neither does Vyuha.
 */
export async function exchangeFyersAuthCode(args: { appId: string; secret: string; code: string }): Promise<{ accessToken: string }> {
  const res = await fetch(`${FYERS_API}/validate-authcode`, {
    method: "POST",
    headers: { ...fyersHeaders(args.appId), "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", appIdHash: fyersAppIdHash(args.appId, args.secret), code: args.code }),
    cache: "no-store",
  });
  const json = (await readJson(res)) as (FyersEnvelope & { access_token?: string }) | null;
  if (res.status !== 200 || json?.s !== "ok" || typeof json.access_token !== "string" || !json.access_token) {
    const err = fyersRefusal("login", res.status, json);
    if (err instanceof BrokerAuthExpired) throw err;
    throw new Error(`${err.message} (an auth_code is single-use and expires within minutes of the login — log in again and paste a fresh one; also check the App ID and App Secret.)`);
  }
  return { accessToken: json.access_token };
}

/**
 * WHOSE session this is: `data.fy_id` from GET /profile (the SDK's
 * `get_profile`). The shape is the SDK's and UNVERIFIED with a live account —
 * null when the field is absent, so the caller can tell "unstated" from an id.
 */
export async function fetchFyersProfileId(appId: string, accessToken: string): Promise<string | null> {
  const res = await fetch(`${FYERS_API}/profile`, { method: "GET", headers: fyersHeaders(appId, accessToken), cache: "no-store" });
  const json = (await readJson(res)) as (FyersEnvelope & { data?: { fy_id?: unknown } }) | null;
  if (res.status !== 200 || json?.s !== "ok") throw fyersRefusal("profile", res.status, json);
  const id = json.data?.fy_id;
  const s = typeof id === "string" || typeof id === "number" ? String(id).trim() : "";
  return s || null;
}

/** One row of GET /tradebook (F-B3 — the Go SDK's typed struct). */
export interface FyersTradeRow {
  symbol?: string;
  /** 1 = buy, −1 = sell. */
  side?: number | string;
  tradedQty?: number | string;
  tradePrice?: number | string;
  tradeValue?: number | string;
  productType?: string;
  /** 10 NSE, 11 MCX, 12 BSE. */
  exchange?: number | string;
  segment?: number | string;
  orderDateTime?: string;
  orderNumber?: string;
  tradeNumber?: string;
  exchangeOrderNo?: string;
  clientId?: string;
  fyToken?: string;
  orderTag?: string;
}

/** GET /tradebook → `tradeBook[]` (today only, F-B4). */
export async function fetchFyersTradeBook(appId: string, accessToken: string): Promise<FyersTradeRow[]> {
  const res = await fetch(`${FYERS_API}/tradebook`, { method: "GET", headers: fyersHeaders(appId, accessToken), cache: "no-store" });
  const json = (await readJson(res)) as (FyersEnvelope & { tradeBook?: unknown }) | null;
  if (res.status !== 200 || json?.s !== "ok") throw fyersRefusal("trade book", res.status, json);
  return Array.isArray(json.tradeBook) ? (json.tradeBook as FyersTradeRow[]) : [];
}

/**
 * The Fyers FILE's product rule (`legProductOf` in parsers/fyers-tradebook.ts,
 * replicated — that file is not edited) plus MTF: CNC / MARGIN / overnight →
 * delivery, INTRADAY → intraday, MTF → mtf, anything else → null (the
 * classifier decides from the symbol).
 */
function productHintOf(raw: string | undefined): ProductHint {
  const p = String(raw ?? "").trim().toLowerCase();
  if (p === "overnight" || p === "cnc" || p === "margin") return "delivery";
  if (p === "intraday") return "intraday";
  if (p === "mtf") return "mtf";
  return null;
}

/** Fyers exchange ints (F-B3): 10 NSE, 11 MCX, 12 BSE. */
function exchangeOf(v: number | string | undefined): Exchange | null {
  const n = Number(v);
  return n === 10 ? "NSE" : n === 11 ? "MCX" : n === 12 ? "BSE" : null;
}

/** A number the row STATES — a finite number, or a plain numeric string. Null
 *  for anything else (never coerced to 0). */
function stated(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/,/g, "").trim();
  return /^-?\d+(?:\.\d+)?$/.test(s) ? Number(s) : null;
}

/**
 * `orderDateTime` has no stated format (R10 §3). HH:MM is read ONLY from the
 * two shapes pinned in tests — `04-Oct-2026 10:15:33` and `2026-10-04 10:15:33`
 * (or `T`) — 24-hour; anything else is null (the date is the pull's day anyway).
 */
function hhmmOf(v: string | undefined): string | null {
  const s = String(v ?? "").trim();
  const m =
    /^\d{1,2}-[A-Za-z]{3}-\d{4} (\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s) ??
    /^\d{4}-\d{2}-\d{2}[ T](\d{2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? `${String(h).padStart(2, "0")}:${m[2]}` : null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * Today's fills → normalized trades, aggregated per tradingsymbol + product with
 * the executions preserved (the Angel One shape). A row is REFUSED and counted
 * when its side, quantity, price or symbol cannot be read — never coerced. An
 * NDIR mirror row (the file's full three-part signature on `exchangeOrderNo`,
 * review R11) is skipped and counted in `notes`. `clientId` is the rows' own
 * `clientId` when every row that states one agrees, else null.
 */
export function normalizeFyersTrades(
  rows: FyersTradeRow[],
  today: string,
): { trades: NormalizedTrade[]; refused: number; notes: string[]; clientId: string | null } {
  type Acc = {
    symbol: string; notes: string[]; product: string; exch: Exchange | null;
    buyQty: number; buyVal: number; sellQty: number; sellVal: number; executions: Execution[];
  };
  const groups = new Map<string, Acc>();
  let refused = 0;
  let mirrors = 0;
  let unnamed = 0;
  let unpriced = 0;
  const clientIds = new Set<string>();

  for (const r of rows) {
    const cid = typeof r.clientId === "string" ? r.clientId.trim() : "";
    if (cid) clientIds.add(cid);
    if (isFyersMirrorRow(String(r.productType ?? ""), String(r.exchangeOrderNo ?? ""), String(r.orderDateTime ?? ""))) {
      mirrors++;
      continue;
    }
    // Segment 12 (CD) or a currency / NCDEX prefix — refused and counted, as Kotak's cde_fo is (seam D-C6-2).
    if (fyersUnpricedRow(r.segment, r.symbol)) {
      unpriced++;
      refused++;
      continue;
    }
    const sideN = stated(r.side);
    const side = sideN === 1 ? "buy" : sideN === -1 ? "sell" : null;
    const qty = stated(r.tradedQty);
    const price = stated(r.tradePrice);
    const named = fyersTradingsymbol(String(r.symbol ?? ""));
    if (!side || qty == null || !(qty > 0) || !Number.isInteger(qty) || price == null || !(price > 0) || !named) {
      if (side && qty != null && qty > 0 && price != null && price > 0 && !named) unnamed++;
      refused++;
      continue;
    }
    const product = String(r.productType ?? "").trim();
    const key = `${named.tradingsymbol}|${product.toUpperCase()}`;
    let acc = groups.get(key);
    if (!acc) {
      const notes = [`Fyers pull: ${PULL_UNVERIFIED_LABEL}.`];
      const equity = named.series != null || Number(r.segment) === 10;
      if (named.series) notes.push(`Fyers series ${named.series} (${String(r.symbol).trim()}).`);
      if (equity) notes.push(`${FYERS_NUVAMA_EQUITY_UNVERIFIED}.`);
      acc = {
        symbol: named.tradingsymbol, notes, product, exch: exchangeOf(r.exchange),
        buyQty: 0, buyVal: 0, sellQty: 0, sellVal: 0, executions: [],
      };
      groups.set(key, acc);
    }
    if (side === "buy") { acc.buyQty += qty; acc.buyVal += qty * price; }
    else { acc.sellQty += qty; acc.sellVal += qty * price; }
    acc.executions.push({ side, qty, price, date: today, time: hhmmOf(r.orderDateTime) });
  }

  const trades: NormalizedTrade[] = [];
  for (const a of groups.values()) {
    const closed = a.sellQty > 0 && a.buyQty === a.sellQty;
    // Sold today out of a holding the trade book cannot see — Angel One's QS-AO shape.
    const sellOnly = a.sellQty > 0 && a.buyQty === 0;
    trades.push({
      broker: "fyers",
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
      buyDate: a.buyQty > 0 ? today : null,
      sellDate: closed || sellOnly ? today : null,
      ...(sellOnly ? { basisUnknown: true } : {}),
      entryTime: a.executions.find((e) => e.side === "buy")?.time ?? null,
      exitTime: [...a.executions].reverse().find((e) => e.side === "sell")?.time ?? null,
      productHint: productHintOf(a.product),
      exchangeHint: a.exch,
      sourceFile: "fyers-api",
      executions: a.executions,
      importNotes: a.notes,
    });
  }

  const notes: string[] = [];
  if (mirrors > 0) {
    notes.push(
      `${mirrors} mirror row${plural(mirrors, " was", "s were")} skipped: product "-", a 12:00:00 AM stamp and a non-numeric exchange order id — the carried-over copy Fyers prints, not a trade.`,
    );
  }
  if (unnamed > 0) {
    notes.push(`${unnamed} fill${plural(unnamed, "'s", "s'")} symbol could not be read as a Fyers instrument and ${plural(unnamed, "was", "were")} refused rather than guessed.`);
  }
  if (unpriced > 0) notes.push(unpricedRefusalNote(unpriced));
  return { trades, refused, notes, clientId: clientIds.size === 1 ? [...clientIds][0]! : null };
}

export interface FyersCredentials {
  appId: string;
  /** The day's access token (from `exchangeFyersAuthCode`). */
  accessToken: string;
}

export function fyersImportSource(creds: FyersCredentials): ApiImportSource {
  return {
    id: "fyers-api",
    label: "Fyers API v3 (today's trade book, one browser login per pull day)",
    broker: "fyers",
    kind: "api",
    async fetchTrades() {
      return normalizeFyersTrades(await fetchFyersTradeBook(creds.appId, creds.accessToken), todayIstIso()).trades;
    },
  };
}

/** Wrap a pull in the ParsedFile shape the preview/commit pipeline expects. */
export function toParsedFile(trades: NormalizedTrade[], refused = 0, notes: string[] = []): ParsedFile {
  const warnings: string[] = [
    `Fyers' trade-book response shape is ${PULL_UNVERIFIED_LABEL} — check these trades against your contract note before relying on them.`,
  ];
  warnings.push(
    trades.length === 0
      ? "Fyers returned no fills — the trade book covers only the CURRENT trading day, so it is empty on a day you did not trade."
      : "Trades are today's fills from the Fyers trade book, aggregated per symbol + product. Charges are computed from your rate card — the API states none.",
  );
  if (refused > 0) {
    warnings.push(`${refused} fill${plural(refused, "", "s")} had no readable side, quantity, price or symbol and ${plural(refused, "was", "were")} refused rather than guessed.`);
  }
  warnings.push(...notes);
  return { sourceId: "fyers-api", broker: "fyers", format: "api", trades, warnings };
}
