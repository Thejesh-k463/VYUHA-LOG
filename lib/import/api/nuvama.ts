/**
 * Nuvama APIConnect — a native READ-ONLY pull of today's trade book (v4.7.0
 * wave C6, design D5/D5a, owner answers Q4/Q7). DOCUMENTED, NOT YET VERIFIED
 * WITH A REAL ACCOUNT (Q4): every field is Nuvama's docs + its 2.0.12 SDK
 * (R10 §2); no real trade-book row has been seen.
 *
 * ── The login (the Kite precedent: a pasted value per session) ──────────────
 * API key + API secret are saved once. When the session has ended the user
 * opens `nuvamaLoginUrl` in THEIR browser and pastes back the redirected URL
 * (or the bare request id); `extractNuvamaRequestId` takes it BY NAME
 * (`requestId` / `reqId` / `request_id` — the parameter's name is unstated,
 * R10 §3). Then, server-side:
 *   1. POST nc.nuvamawealth.com/edelmw-login/login/accounts/loginvendor/<key>/
 *      `{pwd: <api secret>}`, header `Source: <key>` → `msg` (N-A4…A7). The
 *      secret travels as a plain password field over HTTPS, exactly as Nuvama's
 *      own SDK sends it (N-A13) — the consent sheet says so;
 *   2. POST …/accounts/logindata/ `{reqId}`, header `SourceToken: <msg>` →
 *      `data.auth` + `data.lgnData.accs.eqAccID || coAccID` (N-A8…A11);
 *   3. GET nc.nuvamawealth.com/edelmw-eq/eq/tradebook/v1/<userId>/ → `data.trade[]`.
 *
 * ── Two SDK behaviours Vyuha does NOT copy (owner Q7, decided by the session) ─
 * No `X-Forwarded-For`: the SDK learns the public IP from an outside service —
 * a new egress host for a header Nuvama's docs never require. No hard-coded
 * `AppIdKey`: the SDK ships a JWT that presents calls as Nuvama's own SDK and
 * whose `exp` passed on 2026-07-31. Vyuha sends none on the first login call; an
 * `AppIdKey` a RESPONSE carries is echoed on that session's later calls and
 * returned so the route caches it WITH the session (review R11').
 *
 * ── Status codes are read EXPLICITLY, never `res.ok` ────────────────────────
 * 222 is inside 2xx: on the trade book it is an EMPTY book (ETRD0002 — zero
 * trades, not an error, N-B5); on logindata it is an EXPIRED request id
 * (N-A12). 401 / EGN0011 "Session Expired" ends the session (N-D1).
 *
 * ── Read-only BY SURFACE ────────────────────────────────────────────────────
 * Login, trade book and pure mapping — no order, modify or funds call;
 * tests/nuvama-api.test.ts pins the export list.
 */

import { todayIstIso } from "@/lib/domain/trading-day";
import { PULL_UNVERIFIED_LABEL } from "@/lib/domain/broker-pull-disclosure";
import type { Exchange } from "@/lib/domain/constants";
import type { Execution, NormalizedTrade, ProductHint } from "@/lib/engine/types";
import type { ApiImportSource, ParsedFile } from "@/lib/import/types";
import { FYERS_NUVAMA_EQUITY_UNVERIFIED } from "@/lib/import/parsers/fyers-tradebook";
import { nuvamaTradingsymbol, nuvamaUnpricedRow, unpricedRefusalNote } from "@/lib/import/pull-symbols";
import { BrokerAuthExpired } from "./broker-auth-error";

/** Nuvama's production login and equity hosts (N-A3, SDK 2.0.12 constants). */
export const NUVAMA_LOGIN_BASE = "https://nc.nuvamawealth.com/edelmw-login/login/";
export const NUVAMA_EQ_BASE = "https://nc.nuvamawealth.com/edelmw-eq/eq/";

/** The browser login (N-A1). Shown as a link — the app never fetches it. */
export function nuvamaLoginUrl(apiKey: string): string {
  return `https://www.nuvamawealth.com/api-connect/login?api_key=${encodeURIComponent(apiKey)}`;
}

const BARE_ID = /^[A-Za-z0-9._~-]{4,}$/;
const REQUEST_ID_NAMES = ["requestId", "reqId", "request_id"] as const;

/**
 * The request id from what the user pasted: the bare value, or a URL / query
 * string from which `requestId`, `reqId` or `request_id` is taken BY NAME.
 * Null for anything else (the route answers with the instruction).
 */
export function extractNuvamaRequestId(pasted: string): string | null {
  const s = String(pasted ?? "").trim();
  if (!s) return null;
  if (s.includes("=") || s.includes("?") || s.includes("://")) {
    const q = new URLSearchParams((s.includes("?") ? s.slice(s.indexOf("?") + 1) : s).split("#")[0]);
    for (const name of REQUEST_ID_NAMES) {
      const v = q.get(name)?.trim() ?? "";
      if (BARE_ID.test(v)) return v;
    }
    return null;
  }
  return BARE_ID.test(s) ? s : null;
}

export interface NuvamaSession {
  /** `data.auth` — sent as `Authorization` on every later call. */
  auth: string;
  /** The vendor session (`msg` from loginvendor) — sent as `SourceToken`. */
  sourceToken: string;
  /** `eqAccID || coAccID` — the `{userID}` in the trade-book path, and WHOSE book this is. */
  userId: string;
  /** An `AppIdKey` a Nuvama RESPONSE carried, or null — never one Vyuha made up (Q7). */
  appIdKey: string | null;
  /** `lgnData.accTyp` ("EQ" | "CO" | "COMEQ"), or null when unstated. */
  accTyp: string | null;
}

const appIdKeyOf = (res: Response): string | null => {
  const v = res.headers?.get?.("AppIdKey");
  return v && v.trim() ? v.trim() : null;
};

async function readBody(res: Response): Promise<{ text: string; json: unknown }> {
  const text = await res.text().catch(() => "");
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { text, json };
}

/** 401, or a body naming EGN0011 / "Session Expired" (N-D1, and the SDK's own `'Expired' in body` test N-D2). */
const sessionExpired = (status: number, text: string) => status === 401 || /EGN0011|Session Expired/i.test(text);

function nuvamaError(what: string, status: number, json: unknown): Error {
  const j = json as { error?: { errMsg?: string; errCd?: string }; msg?: string; errMsg?: string } | null;
  const msg = j?.error?.errMsg ?? j?.errMsg ?? (typeof j?.msg === "string" ? j.msg : null) ?? `HTTP ${status}`;
  const hint =
    status === 403
      ? " (Nuvama refused the request — its documentation marks a static IP as mandatory; a pull from a home connection may be refused. Vyuha sends no AppIdKey of its own; if Nuvama now requires one, please report this.)"
      : "";
  return new Error(`Nuvama ${what}: ${msg}${hint}`);
}

/** The two-step login (N-A4…A12). Status codes read explicitly. */
export async function nuvamaLogin(args: { apiKey: string; apiSecret: string; reqId: string }): Promise<NuvamaSession> {
  const vendor = await fetch(`${NUVAMA_LOGIN_BASE}accounts/loginvendor/${encodeURIComponent(args.apiKey)}/`, {
    method: "POST",
    headers: { Source: args.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ pwd: args.apiSecret }),
    cache: "no-store",
  });
  const v = await readBody(vendor);
  const msg = (v.json as { msg?: unknown } | null)?.msg;
  if (vendor.status !== 200 || typeof msg !== "string" || !msg.trim()) {
    throw nuvamaError("login (API key / secret)", vendor.status, v.json);
  }
  let appIdKey = appIdKeyOf(vendor);

  const login = await fetch(`${NUVAMA_LOGIN_BASE}accounts/logindata/`, {
    method: "POST",
    headers: { SourceToken: msg, "Content-Type": "application/json", ...(appIdKey ? { AppIdKey: appIdKey } : {}) },
    body: JSON.stringify({ reqId: args.reqId }),
    cache: "no-store",
  });
  const l = await readBody(login);
  if (login.status === 222 || sessionExpired(login.status, l.text)) {
    throw new BrokerAuthExpired(
      "nuvama",
      "needsLogin",
      "Nuvama login: the request id has expired — log in again at your Nuvama login link and paste the new address.",
    );
  }
  const data = (l.json as { data?: { auth?: unknown; lgnData?: { accTyp?: unknown; accs?: { eqAccID?: unknown; coAccID?: unknown } } } } | null)?.data;
  const auth = typeof data?.auth === "string" ? data.auth.trim() : "";
  const accs = data?.lgnData?.accs;
  const userId = [accs?.eqAccID, accs?.coAccID].map((x) => (typeof x === "string" || typeof x === "number" ? String(x).trim() : "")).find((x) => x) ?? "";
  if (login.status !== 200 || !auth || !userId) {
    throw nuvamaError("login (session)", login.status, l.json);
  }
  appIdKey = appIdKeyOf(login) ?? appIdKey;
  const accTyp = typeof data?.lgnData?.accTyp === "string" && data.lgnData.accTyp.trim() ? data.lgnData.accTyp.trim() : null;
  return { auth, sourceToken: msg, userId, appIdKey, accTyp };
}

/** One row of `data.trade[]` (N-B3/B4) — every field a string. */
export interface NuvamaTradeRow {
  trdSym?: string;
  sym?: string;
  exc?: string;
  /** "B" | "S". */
  trsTyp?: string;
  fldQty?: string;
  flQty?: string;
  flPrc?: string;
  prdCode?: string;
  flDt?: string;
  flTim?: string;
  opTyp?: string;
  stkPrc?: string;
  dpExpDt?: string;
  trdID?: string;
  exONo?: string;
}

/**
 * GET the trade book. 200 → `data.trade[]`; 222 → [] (an EMPTY book, not an
 * error); 401 / EGN0011 / "Session Expired" → `BrokerAuthExpired("needsLogin")`;
 * anything else throws. An `AppIdKey` the response carries REPLACES
 * `session.appIdKey` in place (the SDK's behaviour, N-A14) — the caller
 * re-caches the session object after the call.
 */
export async function fetchNuvamaTrades(session: NuvamaSession, apiKey: string): Promise<NuvamaTradeRow[]> {
  const res = await fetch(`${NUVAMA_EQ_BASE}tradebook/v1/${encodeURIComponent(session.userId)}/`, {
    method: "GET",
    headers: {
      Authorization: session.auth,
      Source: apiKey,
      SourceToken: session.sourceToken,
      ...(session.appIdKey ? { AppIdKey: session.appIdKey } : {}),
    },
    cache: "no-store",
  });
  const b = await readBody(res);
  if (sessionExpired(res.status, b.text)) {
    throw new BrokerAuthExpired(
      "nuvama",
      "needsLogin",
      "Nuvama trade book: Session Expired — log in again at your Nuvama login link and paste the new address.",
    );
  }
  const fresh = appIdKeyOf(res);
  if (fresh) session.appIdKey = fresh;
  if (res.status === 222) return [];
  if (res.status !== 200) throw nuvamaError("trade book", res.status, b.json);
  const trade = (b.json as { data?: { trade?: unknown } } | null)?.data?.trade;
  return Array.isArray(trade) ? (trade as NuvamaTradeRow[]) : [];
}

/** CNC → delivery, MTF → mtf, MIS / INTRADAY → intraday; NRML and anything
 *  else → null (the classifier decides — kite.ts' NRML rule). */
function productHintOf(raw: string | undefined): ProductHint {
  switch (String(raw ?? "").trim().toUpperCase()) {
    case "CNC": return "delivery";
    case "MTF": return "mtf";
    case "MIS":
    case "INTRADAY": return "intraday";
    default: return null;
  }
}

function exchangeOf(exc: string | undefined): Exchange | null {
  const e = String(exc ?? "").trim().toUpperCase();
  if (e === "NSE" || e === "NFO" || e === "CDS") return "NSE";
  if (e === "BSE" || e === "BFO" || e === "BCD") return "BSE";
  if (e === "MCX") return "MCX";
  return null;
}

/** Every Nuvama number is a STRING (N-B4): a plain numeric string, else null — never 0. */
function stated(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/,/g, "").trim();
  return /^-?\d+(?:\.\d+)?$/.test(s) ? Number(s) : null;
}

/** `flTim` has no stated format (R10 §3): read `HH:MM:SS` alone or after a date, 24-hour; else null. */
function hhmmOf(v: string | undefined): string | null {
  const m = /(?:^|\s)(\d{2}):(\d{2}):\d{2}$/.exec(String(v ?? "").trim());
  return m && Number(m[1]) <= 23 && Number(m[2]) <= 59 ? `${m[1]}:${m[2]}` : null;
}

const ISIN_SHAPE = /^IN[EF][A-Z0-9]{8}\d$/;
const r2 = (n: number) => Math.round(n * 100) / 100;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * Today's fills → normalized trades, aggregated per tradingsymbol + product.
 * QUANTITY is `fldQty` ONLY: the sample carries both `flQty` and `fldQty`
 * (N-B4) and nothing states which is the fill's own quantity; the brief names
 * `fldQty` and Kotak's trade book uses that same name for its filled quantity
 * (K-B5). A fallback to `flQty` would be a guess between two unexplained
 * fields, so a row without a readable `fldQty` is refused. An ISIN-shaped `trdSym` sets `isin`. Every trade says it is
 * unverified; equity trades also carry `FYERS_NUVAMA_EQUITY_UNVERIFIED`.
 */
export function normalizeNuvamaTrades(rows: NuvamaTradeRow[], today: string): { trades: NormalizedTrade[]; refused: number; notes: string[] } {
  type Acc = {
    symbol: string; isin: string | null; product: string; exch: Exchange | null; equity: boolean;
    buyQty: number; buyVal: number; sellQty: number; sellVal: number; executions: Execution[];
  };
  const groups = new Map<string, Acc>();
  let refused = 0;
  let unnamed = 0;
  let unpriced = 0;

  for (const r of rows) {
    // CDS / BCD / NCDEX — refused and counted, as Kotak's cde_fo is (seam D-C6-2).
    if (nuvamaUnpricedRow({ trdSym: r.trdSym, exc: r.exc })) {
      unpriced++;
      refused++;
      continue;
    }
    const t = String(r.trsTyp ?? "").trim().toUpperCase();
    const side = t === "B" || t === "BUY" ? "buy" : t === "S" || t === "SELL" ? "sell" : null;
    const qty = stated(r.fldQty);
    const price = stated(r.flPrc);
    const symbol = nuvamaTradingsymbol({
      trdSym: String(r.trdSym ?? ""), sym: r.sym, exc: r.exc, opTyp: r.opTyp, stkPrc: r.stkPrc, dpExpDt: r.dpExpDt,
    });
    if (!side || qty == null || !(qty > 0) || !Number.isInteger(qty) || price == null || !(price > 0) || !symbol) {
      if (side && qty != null && qty > 0 && price != null && price > 0 && !symbol) unnamed++;
      refused++;
      continue;
    }
    const product = String(r.prdCode ?? "").trim().toUpperCase();
    const key = `${symbol}|${product}`;
    let acc = groups.get(key);
    if (!acc) {
      const raw = String(r.trdSym ?? "").trim().toUpperCase();
      acc = {
        symbol, isin: ISIN_SHAPE.test(raw) ? raw : null, product, exch: exchangeOf(r.exc),
        equity: !/^(OPT|FUT) /.test(symbol),
        buyQty: 0, buyVal: 0, sellQty: 0, sellVal: 0, executions: [],
      };
      groups.set(key, acc);
    }
    if (side === "buy") { acc.buyQty += qty; acc.buyVal += qty * price; }
    else { acc.sellQty += qty; acc.sellVal += qty * price; }
    acc.executions.push({ side, qty, price, date: today, time: hhmmOf(r.flTim) });
  }

  const trades: NormalizedTrade[] = [];
  for (const a of groups.values()) {
    const closed = a.sellQty > 0 && a.buyQty === a.sellQty;
    const sellOnly = a.sellQty > 0 && a.buyQty === 0;
    trades.push({
      broker: "nuvama",
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
      sellDate: closed || sellOnly ? today : null,
      ...(sellOnly ? { basisUnknown: true } : {}),
      entryTime: a.executions.find((e) => e.side === "buy")?.time ?? null,
      exitTime: [...a.executions].reverse().find((e) => e.side === "sell")?.time ?? null,
      productHint: productHintOf(a.product),
      exchangeHint: a.exch,
      sourceFile: "nuvama-api",
      executions: a.executions,
      importNotes: [`Nuvama pull: ${PULL_UNVERIFIED_LABEL}.`, ...(a.equity ? [`${FYERS_NUVAMA_EQUITY_UNVERIFIED}.`] : [])],
    });
  }

  const notes: string[] = [];
  if (unnamed > 0) {
    notes.push(
      `${unnamed} fill${plural(unnamed, "", "s")} named no instrument Vyuha can read from Nuvama's stated fields (symbol, expiry, strike, option type) and ${plural(unnamed, "was", "were")} refused rather than guessed.`,
    );
  }
  if (unpriced > 0) notes.push(unpricedRefusalNote(unpriced));
  return { trades, refused, notes };
}

export function nuvamaImportSource(args: { apiKey: string; session: NuvamaSession }): ApiImportSource {
  return {
    id: "nuvama-api",
    label: "Nuvama APIConnect (today's trade book, one browser login per session)",
    broker: "nuvama",
    kind: "api",
    async fetchTrades() {
      return normalizeNuvamaTrades(await fetchNuvamaTrades(args.session, args.apiKey), todayIstIso()).trades;
    },
  };
}

/** Wrap a pull in the ParsedFile shape the preview/commit pipeline expects. */
export function toParsedFile(trades: NormalizedTrade[], refused = 0, notes: string[] = []): ParsedFile {
  const warnings: string[] = [
    `Nuvama's trade-book response shape is ${PULL_UNVERIFIED_LABEL} — check these trades against your contract note before relying on them.`,
  ];
  warnings.push(
    trades.length === 0
      ? "Nuvama returned no fills — an empty trade book on a day you did not trade."
      : "Trades are today's fills from the Nuvama trade book, aggregated per symbol + product. Charges are computed from your rate card — the API states none.",
  );
  if (refused > 0) {
    warnings.push(`${refused} fill${plural(refused, "", "s")} had no readable side, quantity, price or instrument and ${plural(refused, "was", "were")} refused rather than guessed.`);
  }
  warnings.push(...notes);
  return { sourceId: "nuvama-api", broker: "nuvama", format: "api", trades, warnings };
}
