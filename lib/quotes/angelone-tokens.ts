import "server-only";
import { BASE, smartApiHeaders, smartApiJson, type AngelOneCredentials } from "@/lib/import/api/angelone";
import { isCashKey } from "./mapping";
import type { QuoteKey } from "./types";

/**
 * ANGEL ONE'S TOKEN RESOLVER — ticker → the exchange token its quote endpoint
 * is keyed on (v4.2, owner ruling 4.2-7).
 *
 * Angel One does not price a symbol. It prices a `symboltoken` — "3045" is
 * SBIN on NSE — and the ONLY way this release is allowed to learn one is
 * `POST /rest/secure/angelbroking/order/v1/searchScrip`, one symbol per
 * request, on the same host the prices come from.
 *
 * FOUR PROPERTIES THIS FILE IS RESPONSIBLE FOR
 * --------------------------------------------
 * 1. NO SCRIP-MASTER DOWNLOAD, EVER. Angel One publishes a whole-market JSON
 *    on a DIFFERENT host. Fetching it would be egress this release never
 *    disclosed and PRIVACY.md never covered, for a file 99.9 % of which is
 *    instruments the user does not hold. So the mapping is discovered a symbol
 *    at a time, lazily, and cached in `angelone_instrument_tokens` (migration
 *    0070) so a restart does not re-ask.
 * 2. THE SERIES IS CHOSEN, NEVER GUESSED. `searchscrip: "SBIN"` answers with
 *    sixteen rows — SBIN-AF, SBIN-BE, SBIN-BL, SBIN-EQ, SBIN-IQ and more —
 *    which are different instruments with the same first five letters. The
 *    trade's own series wins when Vyuha knows it (Angel One's own imports
 *    carry "SBIN-EQ"), then "-EQ", then a lone row; anything else is
 *    UNRESOLVABLE and is labelled as such. Picking "whichever came first"
 *    would price one instrument under another's name, which is invariant 6's
 *    exact failure mode.
 * 3. NOT ONE ORDER PATH. `/order/v1/searchScrip` is a read, but it lives under
 *    Angel One's order namespace and the SAME jwt could place an order — so
 *    this file contains searchScrip and nothing else under that prefix, and
 *    `tests/angelone-api.test.ts` greps this source to keep it that way.
 * 4. IT NEVER PACES ITSELF. The 1 req/s ceiling and the hourly budget belong to
 *    the provider, which owns the clock and the guard; `resolve()` asks
 *    permission through the injected `pace()` before every request and STOPS
 *    when refused. Nothing here sleeps, retries or buffers.
 *
 * PURE HALVES FIRST. `splitAngelSymbol`, `angelCashKey`, `pickAngelScripRow`
 * and `resolvedAngelToken` take no clock, no socket and no database — the same
 * split as `lib/engine/rates.ts` vs `rates-db.ts` (invariant 2). Only the cache
 * and the request touch the outside world, and both are injectable.
 */

/** The two exchanges Angel One's cash quotes are asked for in this release. */
export type AngelExchange = "NSE" | "BSE";

export const ANGELONE_SEARCH_SCRIP_PATH = "/rest/secure/angelbroking/order/v1/searchScrip";

/** The series a cash scrip can wear, and the one this app assumes. */
export const ANGELONE_DEFAULT_SERIES = "EQ";

/**
 * The NSE/BSE series suffixes Angel One decorates a cash tradingsymbol with.
 *
 * A WHITELIST, not `/-[A-Z]+$/`, and that is the whole point: NSE has real
 * tickers with a hyphen in them — BAJAJ-AUTO trades as "BAJAJ-AUTO-EQ" — and a
 * greedy suffix rule would read its series as "AUTO" and its symbol as
 * "BAJAJ", which is a different company's row.
 */
export const ANGELONE_SERIES_SUFFIX = /-(EQ|BE|BZ|BL|GS|SM|ST|AF|IQ|IL|IT|MF|ME|NB)$/;

/** PURE. "SBIN-EQ" → { base: "SBIN", series: "EQ" }; "BAJAJ-AUTO" → series null. */
export function splitAngelSymbol(s: string | null | undefined): { base: string; series: string | null } {
  const v = String(s ?? "").trim().toUpperCase();
  const m = ANGELONE_SERIES_SUFFIX.exec(v);
  if (!m) return { base: v, series: null };
  return { base: v.slice(0, v.length - m[0].length), series: m[1] };
}

/** A cash key Angel One can be asked about, with the series hint it carries. */
export interface AngelCashKey {
  /** Canonical ticker, upper-cased, no series suffix. */
  symbol: string;
  exchange: AngelExchange;
  /** The trade's own series when it states one — the searchScrip tie-breaker. */
  series: string | null;
  /** `${exchange}:${symbol}` — the cache key and the resolver's map key. */
  id: string;
}

/** `${exchange}:${symbol}` — the one key shape the cache and the resolver share. */
export function angelTokenCacheKey(exchange: AngelExchange, symbol: string): string {
  return `${exchange}:${symbol.trim().toUpperCase()}`;
}

/**
 * PURE. `QuoteKey` → the cash scrip Angel One will be asked about, or null.
 *
 * EQUITIES ONLY (ruling 4.2-8, the same rule the Upstox adapter obeys): a
 * futures or options key returns null here and is therefore never SENT — not
 * sent and ignored, not sent and refused. The desk labels those rows itself.
 *
 * The one thing this adds over the shared `isCashKey()` is the SERIES STRIP:
 * an Angel One row reaches Vyuha as "SBIN-EQ", and the shared test — written
 * for a bhavcopy, where a decorated tradingsymbol genuinely might be a contract
 * — would read that as "not the bare symbol" and refuse it. So the known series
 * suffix is removed FIRST and then `isCashKey()` decides, which keeps one
 * definition of "is this a cash scrip" in the codebase instead of two.
 */
export function angelCashKey(key: QuoteKey): AngelCashKey | null {
  if (key.exchange !== "NSE" && key.exchange !== "BSE") return null;
  const symbol = key.symbol.trim().toUpperCase();
  if (!symbol) return null;
  const { base, series } = splitAngelSymbol(key.tradingsymbol);
  if (!isCashKey({ ...key, symbol, tradingsymbol: base === "" ? undefined : base })) return null;
  return { symbol, exchange: key.exchange, series, id: angelTokenCacheKey(key.exchange, symbol) };
}

/* ────────────────────────── searchScrip, and its shapes ─────────────────── */

/** One row of `searchScrip`'s `data` array. Every field optional on purpose. */
export interface AngelScripRow {
  exchange?: string | null;
  tradingsymbol?: string | null;
  symboltoken?: string | null;
}

/** A symbol resolved to Angel One's own instrument identity. */
export interface ResolvedAngelToken {
  exchange: AngelExchange;
  /** Canonical ticker — what Vyuha keys everything else on. */
  symbol: string;
  /** Angel One's decorated name for the row that was chosen ("SBIN-EQ"). */
  tradingsymbol: string;
  /** `symboltoken`, kept as a STRING: an identifier, never a quantity. */
  token: string;
}

/**
 * PURE. Sixteen searchScrip rows → the ONE that is this trade's instrument, or
 * null (ruling 4.2-7).
 *
 * The candidate set is narrowed before anything is chosen: the row must be on
 * the exchange asked for, must carry a numeric token, and its tradingsymbol
 * must reduce to EXACTLY the symbol asked for once its series suffix is
 * removed. "SBINEQ" and "SBIN26SEP800CE" are therefore not candidates for
 * SBIN, however similar they look.
 *
 * Then, in order:
 *   1. the trade's OWN series, when Vyuha knows it — an MTF or BE holding is
 *      not the EQ scrip and must not be priced as one;
 *   2. "-EQ", the ordinary cash series and the honest default;
 *   3. the only row, when there is only one (BSE answers with an undecorated
 *      name for many scrips, and one answer needs no tie-break);
 *   4. NULL — unresolvable. The symbol is then LABELLED, never guessed: a row
 *      with no mark is a state the desk already renders, and a wrong mark is
 *      not recoverable (invariant 6).
 */
export function pickAngelScripRow(
  rows: readonly AngelScripRow[] | null | undefined,
  want: { symbol: string; exchange: AngelExchange; series?: string | null },
): AngelScripRow | null {
  if (!Array.isArray(rows)) return null;
  const symbol = want.symbol.trim().toUpperCase();
  const candidates = rows.filter((r) => {
    if (String(r?.exchange ?? "").trim().toUpperCase() !== want.exchange) return false;
    if (!/^\d+$/.test(String(r?.symboltoken ?? "").trim())) return false;
    const ts = String(r?.tradingsymbol ?? "").trim();
    return ts !== "" && splitAngelSymbol(ts).base === symbol;
  });
  if (candidates.length === 0) return null;
  const withSeries = (s: string) =>
    candidates.find((r) => splitAngelSymbol(r.tradingsymbol).series === s) ?? null;

  const preferred = want.series ? withSeries(want.series) : null;
  if (preferred) return preferred;
  const eq = withSeries(ANGELONE_DEFAULT_SERIES);
  if (eq) return eq;
  if (candidates.length === 1) return candidates[0];
  return null;
}

/** PURE. The chosen row → the cache record, or null when it is not usable. */
export function resolvedAngelToken(
  row: AngelScripRow | null,
  want: { symbol: string; exchange: AngelExchange },
): ResolvedAngelToken | null {
  if (!row) return null;
  const token = String(row.symboltoken ?? "").trim();
  const tradingsymbol = String(row.tradingsymbol ?? "").trim().toUpperCase();
  if (!/^\d+$/.test(token) || tradingsymbol === "") return null;
  return { exchange: want.exchange, symbol: want.symbol.trim().toUpperCase(), tradingsymbol, token };
}

/** The searchScrip request, injected in tests so no test opens a socket. */
export type AngelSearchScrip = (
  creds: AngelOneCredentials,
  jwt: string,
  exchange: AngelExchange,
  searchscrip: string,
) => Promise<AngelScripRow[]>;

/**
 * The ONE request this file makes, on the ONE host this app contacts.
 *
 * The URL is built from `BASE` in `lib/import/api/angelone.ts` rather than from
 * a literal here: one host string in the tree means a second host cannot arrive
 * by a copy-paste that nobody diffed against the capability sentence.
 */
export const angelSearchScrip: AngelSearchScrip = async (creds, jwt, exchange, searchscrip) => {
  const res = await fetch(`${BASE}${ANGELONE_SEARCH_SCRIP_PATH}`, {
    method: "POST",
    headers: smartApiHeaders(creds.apiKey, jwt),
    body: JSON.stringify({ exchange, searchscrip }),
    cache: "no-store",
  });
  const data = await smartApiJson<AngelScripRow[]>(res, "symbol search");
  return Array.isArray(data) ? data : [];
};

/* ───────────────────────────── the cache (0070) ─────────────────────────── */

export interface AngelTokenCache {
  /** Everything already known for these pairs. Never throws for a miss. */
  read(pairs: readonly { exchange: AngelExchange; symbol: string }[]): Promise<Map<string, ResolvedAngelToken>>;
  /** Upsert on (exchange, symbol) — a re-resolution corrects, never appends. */
  write(row: ResolvedAngelToken, resolvedAtIso: string): Promise<void>;
}

/**
 * The default cache: `angelone_instrument_tokens` (migration 0070).
 *
 * `@/lib/db` is imported LAZILY, like every other module in this folder: a
 * static import would bind the SQLite connection at module-import time and
 * break `tests/helpers/temp-db.ts` for anything that touches the registry.
 *
 * `read()` selects the whole table and filters in memory rather than building
 * an `IN` list. The table holds one row per symbol the user has ever held —
 * hundreds, not millions — and a scan of that is cheaper than the query
 * machinery, while a single statement keeps the poll path free of a WHERE
 * clause that could quietly stop matching when a symbol is stored in a
 * different case.
 */
export const angelDbTokenCache: AngelTokenCache = {
  async read(pairs) {
    const out = new Map<string, ResolvedAngelToken>();
    if (pairs.length === 0) return out;
    const wanted = new Set(pairs.map((p) => angelTokenCacheKey(p.exchange, p.symbol)));
    const { db } = await import("@/lib/db");
    const { angeloneInstrumentTokens } = await import("@/lib/db/schema");
    for (const row of db.select().from(angeloneInstrumentTokens).all()) {
      const exchange = String(row.exchange ?? "").trim().toUpperCase();
      if (exchange !== "NSE" && exchange !== "BSE") continue;
      const symbol = String(row.symbol ?? "").trim().toUpperCase();
      const id = angelTokenCacheKey(exchange, symbol);
      if (!wanted.has(id)) continue;
      const resolved = resolvedAngelToken(
        { exchange, tradingsymbol: row.tradingsymbol, symboltoken: row.token },
        { exchange, symbol },
      );
      if (resolved) out.set(id, resolved);
    }
    return out;
  },
  async write(row, resolvedAtIso) {
    const { db } = await import("@/lib/db");
    const { angeloneInstrumentTokens } = await import("@/lib/db/schema");
    db.insert(angeloneInstrumentTokens)
      .values({
        exchange: row.exchange,
        symbol: row.symbol,
        tradingsymbol: row.tradingsymbol,
        token: row.token,
        resolvedAt: resolvedAtIso,
      })
      .onConflictDoUpdate({
        target: [angeloneInstrumentTokens.exchange, angeloneInstrumentTokens.symbol],
        set: { tradingsymbol: row.tradingsymbol, token: row.token, resolvedAt: resolvedAtIso },
      })
      .run();
  },
};

/* ──────────────────────────────── the resolver ──────────────────────────── */

export interface AngelResolveRequest {
  creds: AngelOneCredentials;
  jwt: string;
  /** How many searchScrip calls this poll cycle may make. */
  budget: number;
  /**
   * Asked before EVERY request. `false` means the provider's rate guard or
   * hourly counter refused — stop, and never queue. Nothing is retried here.
   */
  pace?: () => Promise<boolean>;
}

export interface AngelResolveResult {
  /** `${exchange}:${symbol}` → the token, for everything already known. */
  tokens: Map<string, ResolvedAngelToken>;
  /** searchScrip calls actually made on this cycle. */
  lookups: number;
  /** Asked, and Angel One had nothing usable. Labelled, never guessed. */
  unresolved: string[];
  /** Not asked yet — the budget or the rate guard ran out. Next cycle. */
  pending: string[];
  /** Keys this feed never sends: derivatives and non-NSE/BSE (ruling 4.2-8). */
  skipped: QuoteKey[];
  /** The last lookup failure, if any. Never thrown — the cycle still prices. */
  lookupError: string | null;
}

export interface AngelResolverOptions {
  search?: AngelSearchScrip;
  cache?: AngelTokenCache;
  /** Injected in tests so `resolved_at` is deterministic. */
  now?: () => number;
}

export interface AngelTokenResolver {
  resolve(keys: readonly QuoteKey[], req: AngelResolveRequest): Promise<AngelResolveResult>;
  /** Symbols Angel One knows nothing usable for — never re-asked this session. */
  unresolvable(): readonly string[];
  /** Everything resolved so far this session, for `health()`. */
  resolvedCount(): number;
}

/**
 * Lazy, cached, paced resolution.
 *
 * A cycle reads the cache once, hands back everything already known, and then
 * spends its small budget on the symbols still missing. A symbol Angel One has
 * no usable row for is remembered as UNRESOLVABLE and never asked again in this
 * process: re-asking a question with a stable answer would burn the hourly
 * budget the priced symbols need, and the answer the user needs ("this row
 * cannot be priced by this feed") is already on screen.
 *
 * A lookup failure does NOT throw. The cycle keeps whatever it had — the desk
 * pricing 40 of 50 rows is strictly better than pricing none — and the message
 * is handed back so the provider can decide whether the session died and a
 * re-login is due.
 */
export function createAngelTokenResolver(opts: AngelResolverOptions = {}): AngelTokenResolver {
  const search = opts.search ?? angelSearchScrip;
  const cache = opts.cache ?? angelDbTokenCache;
  const now = opts.now ?? (() => Date.now());

  /** Resolved this process. The cache is read once per symbol, not once a poll. */
  const memo = new Map<string, ResolvedAngelToken>();
  const dead = new Set<string>();

  return {
    unresolvable: () => [...dead],
    resolvedCount: () => memo.size,

    async resolve(keys, req): Promise<AngelResolveResult> {
      const result: AngelResolveResult = {
        tokens: new Map(),
        lookups: 0,
        unresolved: [],
        pending: [],
        skipped: [],
        lookupError: null,
      };

      /** De-duplicated cash keys, in the order the caller asked for them. */
      const wanted: AngelCashKey[] = [];
      const seen = new Set<string>();
      for (const key of keys) {
        const cash = angelCashKey(key);
        if (!cash) {
          result.skipped.push(key);
          continue;
        }
        if (seen.has(cash.id)) continue;
        seen.add(cash.id);
        wanted.push(cash);
      }
      if (wanted.length === 0) return result;

      for (const cash of wanted) {
        const hit = memo.get(cash.id);
        if (hit) result.tokens.set(cash.id, hit);
      }

      const missing = wanted.filter((c) => !result.tokens.has(c.id) && !dead.has(c.id));
      if (missing.length > 0) {
        const fromDb = await cache.read(missing);
        for (const cash of missing) {
          const hit = fromDb.get(cash.id);
          if (!hit) continue;
          memo.set(cash.id, hit);
          result.tokens.set(cash.id, hit);
        }
      }

      const toLookUp = wanted.filter((c) => !result.tokens.has(c.id) && !dead.has(c.id));
      for (const cash of toLookUp) {
        if (result.lookups >= Math.max(0, req.budget)) {
          result.pending.push(cash.id);
          continue;
        }
        if (req.pace && !(await req.pace())) {
          result.pending.push(cash.id);
          continue;
        }
        result.lookups += 1;
        let rows: AngelScripRow[];
        try {
          rows = await search(req.creds, req.jwt, cash.exchange, cash.symbol);
        } catch (e) {
          // One failed lookup is not a failed poll — and it is certainly not a
          // reason to mark the symbol unresolvable, which is a statement about
          // Angel One's catalogue and not about this request.
          result.lookupError = e instanceof Error ? e.message : String(e);
          result.pending.push(cash.id);
          break;
        }
        const resolved = resolvedAngelToken(
          pickAngelScripRow(rows, { symbol: cash.symbol, exchange: cash.exchange, series: cash.series }),
          cash,
        );
        if (!resolved) {
          dead.add(cash.id);
          result.unresolved.push(cash.id);
          continue;
        }
        memo.set(cash.id, resolved);
        result.tokens.set(cash.id, resolved);
        try {
          await cache.write(resolved, new Date(now()).toISOString());
        } catch {
          /* an unwritable cache costs a lookup next restart, never a price */
        }
      }

      for (const cash of wanted) {
        if (dead.has(cash.id) && !result.unresolved.includes(cash.id)) result.unresolved.push(cash.id);
      }
      return result;
    },
  };
}
