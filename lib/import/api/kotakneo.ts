/**
 * Kotak Neo Trade API — a native READ-ONLY pull of today's trade book (v4.7.0
 * wave C6, design D4/D4a, owner answers Q3/Q5). DOCUMENTED, NOT YET VERIFIED
 * WITH A REAL ACCOUNT (ruling B2): the owner has no Kotak account, so every
 * field below is Kotak's own docs + SDK (R10 §2) and the first live pull is the
 * check.
 *
 * ── The login (the Angel One precedent: TOTP on EVERY pull, nothing cached) ──
 * Saved once, vault-encrypted, under the consent sheet: the dashboard access
 * token, mobile number, UCC, MPIN and TOTP secret (Q3). Each pull:
 *   1. POST mis.kotaksecurities.com/login/1.0/tradeApiLogin {mobileNumber, ucc,
 *      totp} → the VIEW token + sid (K-A1…A4);
 *   2. POST …/tradeApiValidate {mpin} with `sid`/`Auth` = the view pair → the
 *      TRADE token + sid + `baseUrl` (K-A5/A6);
 *   3. GET {baseUrl}/quick/user/trades (K-B1/B2).
 *
 * ── The baseUrl is the server's word, so it is CHECKED (review R10) ─────────
 * The trade-book host comes from the login answer at runtime; the egress guard
 * cannot read it. `assertKotakBaseUrl` refuses anything that is not `https:` on
 * kotaksecurities.com or a subdomain of it, so a hostile or corrupted answer can
 * never steer the Auth/Sid headers to another host. It runs at login AND again
 * before the fetch.
 *
 * ── Read-only BY SURFACE ────────────────────────────────────────────────────
 * Login, trade book and pure mapping — no order, modify or funds call;
 * tests/kotakneo-api.test.ts pins the export list.
 */

import { todayIstIso } from "@/lib/domain/trading-day";
import { KOTAK_TRADE_API_BROKERAGE_NOTE, PULL_UNVERIFIED_LABEL } from "@/lib/domain/broker-pull-disclosure";
import type { Exchange } from "@/lib/domain/constants";
import type { Execution, NormalizedTrade, ProductHint } from "@/lib/engine/types";
import type { ApiImportSource, ParsedFile } from "@/lib/import/types";
import { kotakTradingsymbol, kotakUnpricedSegment, unpricedRefusalNote } from "@/lib/import/pull-symbols";
import { totp } from "@/lib/totp";
import { BrokerAuthExpired } from "./broker-auth-error";

/** Kotak's login host + path (K-A1). */
export const KOTAK_LOGIN_BASE = "https://mis.kotaksecurities.com/login/1.0";

/** The SDK's own fallback when the validate answer names no `baseUrl` (K-A8). */
const KOTAK_DEFAULT_BASE = "https://mis.kotaksecurities.com";

const NEO_FIN_KEY = "neotradeapi";

/**
 * The runtime pin on the session's `baseUrl` (review R10): `https:` only, the
 * hostname `kotaksecurities.com` itself or one ending `.kotaksecurities.com`
 * (the leading dot matters — `evilkotaksecurities.com` is someone else), no
 * credentials in the URL. Throws on anything else; returns the parsed URL.
 */
export function assertKotakBaseUrl(u: string): URL {
  let url: URL;
  try {
    url = new URL(String(u ?? "").trim());
  } catch {
    throw new Error("Kotak Neo named a session address that is not a URL — refused.");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    !(host === "kotaksecurities.com" || host.endsWith(".kotaksecurities.com"))
  ) {
    throw new Error(`Kotak Neo named a session address outside kotaksecurities.com over HTTPS (${url.protocol}//${host}) — refused; nothing was sent to it.`);
  }
  return url;
}

/** `https://cis.kotaksecurities.com/` → `https://cis.kotaksecurities.com` (no trailing slash, no query). */
function baseOf(u: string): string {
  const url = assertKotakBaseUrl(u);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export interface KotakCredentials {
  /** The access token from the Neo app → Trade API dashboard (sent plain, K-A2). */
  accessToken: string;
  /** Registered mobile WITH the ISD code (K-A3); a bare 10-digit number gains `+91`. */
  mobileNumber: string;
  ucc: string;
  mpin: string;
  /** The base32 TOTP SECRET from enrolment — not a 6-digit code. */
  totpSecret: string;
}

export interface KotakSession {
  token: string;
  sid: string;
  baseUrl: string;
}

/** K-A3 says "with ISD"; an Indian 10-digit number typed bare is given +91. */
function mobileWithIsd(m: string): string {
  const s = String(m ?? "").replace(/[\s-]/g, "");
  return /^\d{10}$/.test(s) ? `+91${s}` : s;
}

interface KotakLoginBody {
  data?: { token?: string; sid?: string; baseUrl?: string } | null;
  status?: string;
  message?: string;
  errorCode?: string | number;
}

/**
 * v4.7.0 audit G-A1 (review R8). Every Kotak fetch is sent with
 * `redirect: "manual"`, so a 3xx is never FOLLOWED (a followed redirect would
 * carry the Authorization / Auth / Sid headers, the MPIN or the TOTP body to a
 * host `assertKotakBaseUrl` never saw) — and it is refused HERE in a plain
 * sentence rather than read as a login or trade-book answer. Kotak documents
 * no redirect on any of the three calls (R10 §2).
 */
function refuseRedirect(what: string, res: Response): void {
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    throw new Error(
      `Kotak Neo ${what} answered with a redirect (HTTP ${res.status}) — refused; Vyuha does not follow a broker's redirect, so nothing was sent to the address it named.`,
    );
  }
}

async function kotakLoginStep(step: string, res: Response): Promise<{ token: string; sid: string; baseUrl?: string }> {
  refuseRedirect(step, res);
  const json = (await res.json().catch(() => null)) as KotakLoginBody | null;
  const token = json?.data?.token;
  const sid = json?.data?.sid;
  if (res.status !== 200 || !json || json.status === "error" || typeof token !== "string" || !token || typeof sid !== "string" || !sid) {
    const msg = json?.message || `HTTP ${res.status}`;
    const hint = /totp/i.test(msg)
      ? " (TOTP rejected — check the enrolled secret and that this machine's clock is right.)"
      : /mpin|pin/i.test(msg)
        ? " (MPIN rejected — the 6-digit MPIN, not the account password.)"
        : res.status === 401
          ? " (Kotak refused the login — check the Trade API access token in the Neo app; resetting it there ends every session.)"
          : "";
    throw new Error(`Kotak Neo ${step}: ${msg}${hint}`);
  }
  return { token, sid, baseUrl: json.data?.baseUrl };
}

/**
 * The two-step login (K-A1…A7). The TOTP code is minted HERE, at call time,
 * by the same helper Angel One's login uses. Nothing is cached (D4).
 */
export async function kotakLogin(creds: KotakCredentials): Promise<KotakSession> {
  const common = {
    Authorization: creds.accessToken,
    "neo-fin-key": NEO_FIN_KEY,
    "Content-Type": "application/json",
    accept: "application/json",
  };
  const view = await kotakLoginStep(
    "login",
    await fetch(`${KOTAK_LOGIN_BASE}/tradeApiLogin`, {
      method: "POST",
      headers: common,
      body: JSON.stringify({ mobileNumber: mobileWithIsd(creds.mobileNumber), ucc: creds.ucc, totp: totp(creds.totpSecret) }),
      cache: "no-store",
      redirect: "manual",
    }),
  );
  const trade = await kotakLoginStep(
    "MPIN validation",
    await fetch(`${KOTAK_LOGIN_BASE}/tradeApiValidate`, {
      method: "POST",
      headers: { ...common, sid: view.sid, Auth: view.token },
      body: JSON.stringify({ mpin: creds.mpin }),
      cache: "no-store",
      redirect: "manual",
    }),
  );
  const raw = typeof trade.baseUrl === "string" && trade.baseUrl.trim() ? trade.baseUrl : KOTAK_DEFAULT_BASE;
  return { token: trade.token, sid: trade.sid, baseUrl: baseOf(raw) };
}

/** One row of GET {baseUrl}/quick/user/trades (K-B5/B6 — the SDK doc's full sample). */
export interface KotakTradeRow {
  trdSym?: string;
  sym?: string | null;
  exSeg?: string;
  optTp?: string | null;
  expDt?: string | null;
  stkPrc?: string | number | null;
  /** "B" | "S". */
  trnsTp?: string;
  /** int. */
  fldQty?: number | string;
  /** STRING ("9.39"). */
  avgPrc?: string | number;
  /** "22-Jan-2025". */
  flDt?: string;
  /** "14:28:16". */
  flTm?: string;
  /** CNC | MIS | NRML | MTF … */
  prod?: string;
  nOrdNo?: string;
}

/**
 * The trade book. HTTP 401/403 or `stCode 1003` ("Invalid session", K-D1/D2)
 * → `BrokerAuthExpired("needsLogin")`; `stat` is compared case-insensitively
 * (`"Ok"` in the docs repo, `"ok"` in the SDK doc — R10 §4.1). The session's
 * `baseUrl` is re-checked before a byte is sent.
 */
export async function fetchKotakTrades(session: KotakSession): Promise<KotakTradeRow[]> {
  const url = `${baseOf(session.baseUrl)}/quick/user/trades`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Auth: session.token, Sid: session.sid, "neo-fin-key": NEO_FIN_KEY, accept: "application/json" },
    cache: "no-store",
    redirect: "manual",
  });
  refuseRedirect("trade book", res);
  const json = (await res.json().catch(() => null)) as
    | { stat?: string; stCode?: number | string; emsg?: string; errMsg?: string; data?: unknown }
    | null;
  if (res.status === 401 || res.status === 403 || Number(json?.stCode) === 1003) {
    throw new BrokerAuthExpired(
      "kotakneo",
      "needsLogin",
      `Kotak Neo trade book: ${json?.emsg || `HTTP ${res.status}`} — the Kotak session has ended; the next pull logs in again.`,
    );
  }
  if (res.status !== 200 || !json || String(json.stat ?? "").toLowerCase() !== "ok") {
    throw new Error(`Kotak Neo trade book: ${json?.emsg || json?.errMsg || `HTTP ${res.status}`}`);
  }
  return Array.isArray(json.data) ? (json.data as KotakTradeRow[]) : [];
}

/** CNC → delivery, MTF → mtf, MIS → intraday; NRML (the F&O carry product) and
 *  anything else → null, so the classifier decides from the contract — exactly
 *  how kite.ts maps NRML and angelone.ts maps CARRYFORWARD. */
function productHintOf(prod: string | undefined): ProductHint {
  switch (String(prod ?? "").trim().toUpperCase()) {
    case "CNC": return "delivery";
    case "MTF": return "mtf";
    case "MIS": return "intraday";
    default: return null;
  }
}

function exchangeOf(exSeg: string | undefined): Exchange | null {
  const s = String(exSeg ?? "").trim().toLowerCase();
  if (s.startsWith("nse") || s.startsWith("cde")) return "NSE";
  if (s.startsWith("bse")) return "BSE";
  if (s.startsWith("mcx")) return "MCX";
  return null;
}

function stated(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/,/g, "").trim();
  return /^-?\d+(?:\.\d+)?$/.test(s) ? Number(s) : null;
}

/** `flTm` "14:28:16" (K-B6) → "14:28"; anything else → null. */
function hhmmOf(v: string | undefined): string | null {
  const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(String(v ?? "").trim());
  return m && Number(m[1]) <= 23 && Number(m[2]) <= 59 ? `${m[1]}:${m[2]}` : null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * Today's fills → normalized trades, aggregated per tradingsymbol + product,
 * executions preserved (the Angel One shape). A row whose side, quantity, price
 * or instrument cannot be read is REFUSED and counted — never coerced, never a
 * guessed contract. Every trade carries the Q5 brokerage sentence and the
 * unverified label.
 */
export function normalizeKotakTrades(rows: KotakTradeRow[], today: string): { trades: NormalizedTrade[]; refused: number; notes: string[] } {
  type Acc = {
    symbol: string; product: string; exch: Exchange | null;
    buyQty: number; buyVal: number; sellQty: number; sellVal: number; executions: Execution[];
  };
  const groups = new Map<string, Acc>();
  let refused = 0;
  let unnamed = 0;
  let unpriced = 0;

  for (const r of rows) {
    // D-C6-2 (seam pass): one rule across the three pulls — a currency fill is
    // refused and NAMED as such, not lumped in with the unreadable ones.
    if (kotakUnpricedSegment(r.exSeg)) { unpriced++; refused++; continue; }
    const t = String(r.trnsTp ?? "").trim().toUpperCase();
    const side = t === "B" || t === "BUY" ? "buy" : t === "S" || t === "SELL" ? "sell" : null;
    const qty = stated(r.fldQty);
    const price = stated(r.avgPrc);
    const symbol = kotakTradingsymbol({
      trdSym: String(r.trdSym ?? ""), sym: r.sym, exSeg: String(r.exSeg ?? ""), optTp: r.optTp, expDt: r.expDt, stkPrc: r.stkPrc,
    });
    if (!side || qty == null || !(qty > 0) || !Number.isInteger(qty) || price == null || !(price > 0) || !symbol) {
      if (side && qty != null && qty > 0 && price != null && price > 0 && !symbol) unnamed++;
      refused++;
      continue;
    }
    const product = String(r.prod ?? "").trim().toUpperCase();
    const key = `${symbol}|${product}`;
    let acc = groups.get(key);
    if (!acc) {
      acc = { symbol, product, exch: exchangeOf(r.exSeg), buyQty: 0, buyVal: 0, sellQty: 0, sellVal: 0, executions: [] };
      groups.set(key, acc);
    }
    if (side === "buy") { acc.buyQty += qty; acc.buyVal += qty * price; }
    else { acc.sellQty += qty; acc.sellVal += qty * price; }
    acc.executions.push({ side, qty, price, date: today, time: hhmmOf(r.flTm) });
  }

  const trades: NormalizedTrade[] = [];
  for (const a of groups.values()) {
    const closed = a.sellQty > 0 && a.buyQty === a.sellQty;
    const sellOnly = a.sellQty > 0 && a.buyQty === 0;
    trades.push({
      broker: "kotakneo",
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
      sourceFile: "kotakneo-api",
      executions: a.executions,
      importNotes: [KOTAK_TRADE_API_BROKERAGE_NOTE, `Kotak Neo pull: ${PULL_UNVERIFIED_LABEL}.`],
    });
  }

  const notes: string[] = [];
  if (unnamed > 0) {
    notes.push(
      `${unnamed} fill${plural(unnamed, "", "s")} named no instrument Vyuha can read from Kotak's stated fields (segment, expiry, strike, option type) and ${plural(unnamed, "was", "were")} refused rather than guessed.`,
    );
  }
  if (unpriced > 0) notes.push(unpricedRefusalNote(unpriced));
  return { trades, refused, notes };
}

export function kotakImportSource(creds: KotakCredentials): ApiImportSource {
  return {
    id: "kotakneo-api",
    label: "Kotak Neo Trade API (today's trade book, unattended TOTP login)",
    broker: "kotakneo",
    kind: "api",
    async fetchTrades() {
      const session = await kotakLogin(creds);
      return normalizeKotakTrades(await fetchKotakTrades(session), todayIstIso()).trades;
    },
  };
}

/** Wrap a pull in the ParsedFile shape the preview/commit pipeline expects. */
export function toParsedFile(trades: NormalizedTrade[], refused = 0, notes: string[] = []): ParsedFile {
  const warnings: string[] = [
    `Kotak Neo's trade-book response shape is ${PULL_UNVERIFIED_LABEL} — check these trades against your contract note before relying on them.`,
  ];
  warnings.push(
    trades.length === 0
      ? "Kotak Neo returned no fills — the trade book covers only the CURRENT trading day, so it is empty on a day you did not trade."
      : `Trades are today's fills from the Kotak Neo trade book, aggregated per symbol + product. Charges are computed from your plan's rate card. ${KOTAK_TRADE_API_BROKERAGE_NOTE}`,
  );
  if (refused > 0) {
    warnings.push(`${refused} fill${plural(refused, "", "s")} had no readable side, quantity, price or instrument and ${plural(refused, "was", "were")} refused rather than guessed.`);
  }
  warnings.push(...notes);
  return { sourceId: "kotakneo-api", broker: "kotakneo", format: "api", trades, warnings };
}
