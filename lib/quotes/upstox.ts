import "server-only";
import { isFeedAckCurrent } from "@/lib/domain/live-feed-disclosure";
import { upstoxGet } from "@/lib/import/api/upstox";
import { bundledIsinBySymbol } from "@/lib/import/isin-symbol";
import { isCashKey } from "./mapping";
import { clampRefreshSeconds, REFRESH_SECONDS_DEFAULT, REFRESH_SECONDS_MIN } from "./openalgo";
import { createRateGuard } from "./rate-guard";
import {
  quoteKeyId,
  toPaise,
  type Paise,
  type ProviderCapabilities,
  type ProviderHealth,
  type Quote,
  type QuoteKey,
  type QuoteMap,
  type QuoteProvider,
  type TickListener,
  type Unsubscribe,
} from "./types";

/**
 * UpstoxProvider — live last-traded prices from the user's OWN Upstox account
 * (v4.2, owner rulings 4.2-1…4.2-8).
 *
 * THE FIRST FEED THAT TALKS TO A BROKER'S SERVER. OpenAlgo's adapter could
 * truthfully say "this computer talking to itself"; this one reaches
 * api.upstox.com, so it ships with its own consent sheet
 * (`UPSTOX_FEED_ITEMS`), its own versioned acknowledgement
 * (`settings.live_feed_ack_json`, migration 0069) and its own PRIVACY line. No
 * other host is reachable from this file.
 *
 * NO NEW CREDENTIAL. The token is the year-long, READ-ONLY Analytics token the
 * user already saved for imports — the vault ciphertext in
 * `broker_connections.api_key` for `broker = 'upstox'`. Upstox's own contract
 * makes that token incapable of placing, changing or cancelling an order, and
 * Vyuha never asks for one that can.
 *
 * SIX PROPERTIES THIS FILE IS RESPONSIBLE FOR
 * -------------------------------------------
 * 1. PAISE AT THE EDGE (invariant 1). Upstox speaks rupees; `toPaise()` is
 *    applied exactly once, here, and nothing downstream sees a float rupee.
 * 2. NOT ONE WRITE. No `db` insert, no cache table; ticks exist only in the
 *    listener's memory. The single persisted number of the day is written by
 *    `lib/quotes/persist-mark.ts`.
 * 3. EQUITIES ONLY (ruling 4.2-8). A derivative key is never SENT — not sent
 *    and refused, not sent and ignored: `planUpstoxKeys()` drops it before the
 *    request is built, and the desk labels those rows itself. A symbol with no
 *    ISIN is skipped and COUNTED (`diagnostics()`), never zero-filled.
 * 4. 1–5 s ON SCREEN, clamped by the same `clampRefreshSeconds()` the OpenAlgo
 *    adapter uses and again by the route.
 * 5. A SELF-IMPOSED 5 req/s CEILING that REFUSES rather than queues. Upstox
 *    documents 50/s, 500/min and 2,000 per 30 min; at the 3 s default this
 *    adapter makes 600 LTP calls per 30 minutes plus at most 30 OHLC calls —
 *    under a third of the smallest published budget. A refusal is one visible
 *    error on one poll; a queue would hand the desk a minute-old price and let
 *    the UI call it live.
 * 6. NO SOURCE TIME IS INVENTED. The LTP payload carries no timestamp, so
 *    `asOf` is RECEIPT time and `staleness` is "delayed". Outside market hours
 *    Upstox answers with the previous session's last traded price and says
 *    nothing about when it was true — so neither does this file.
 *
 * DEVIATION, the same one OpenAlgo records: `capabilities.streaming` is TRUE
 * while `subscribe()` is a POLL. The flag's contract in this codebase is
 * "subscribe() really emits", and the SSE route starts a subscription only when
 * it is set. The honesty the prose was protecting is carried by
 * `staleness: "delayed"`, which is what the desk renders.
 */

/** Vyuha's self-imposed ceiling. Upstox's own is 50 req/s (also 500/min, 2,000/30 min). */
export const UPSTOX_RATE_LIMIT_PER_SECOND = 5;

/** Upstox's documented maximum instrument keys in one market-quote request. */
export const UPSTOX_MAX_KEYS = 500;

/**
 * Day open/high/low come from a SECOND endpoint, and it is called at most once
 * a minute — not once a poll. Those three numbers move slowly and the LTP is
 * what the desk re-renders; polling them at 3 s would triple the request budget
 * to refresh a figure that changes a handful of times an hour.
 */
export const UPSTOX_OHLC_MIN_INTERVAL_MS = 60_000;

export const UPSTOX_LTP_PATH = "/v3/market-quote/ltp";
export const UPSTOX_OHLC_PATH = "/v3/market-quote/ohlc";

export const UPSTOX_CAPABILITIES: ProviderCapabilities = {
  id: "upstox",
  label: "Upstox (your own account, read-only Analytics token)",
  // A poll that really emits — see the deviation note in the header.
  streaming: true,
  maxSubscriptions: UPSTOX_MAX_KEYS,
  minSnapshotIntervalMs: REFRESH_SECONDS_MIN * 1000,
  depth: 0,
  // Equities only in this release (ruling 4.2-8): NFO/BFO/MCX/CDS keys are
  // never sent, so they are not claimed here either.
  segments: ["NSE", "BSE"],
  staleness: "delayed",
  // The Analytics token is valid for about a year, not a day — that is the
  // whole reason this integration exists in the shape it does.
  requiresDailyAuth: false,
  egressDescription:
    "Requests go to api.upstox.com — your own Upstox account, using the read-only Analytics token you already saved for imports. Nothing but the instrument keys of your open equity positions is sent, and no other host is contacted for prices.",
};

/* ─────────────────────────────── credentials ────────────────────────────── */

export interface UpstoxFeedCredentials {
  /** The read-only Analytics token, decrypted from the vault at use time. */
  accessToken: string;
}

export type UpstoxGateState =
  /** The Upstox feed disclosure was never accepted, or was accepted at an older version. */
  | { state: "disabled"; reason: string }
  /** Consent is in place but no Upstox connection is saved for this account. */
  | { state: "no-key"; reason: string }
  | { state: "ready"; creds: UpstoxFeedCredentials };

/** Injected in tests; the default reads settings + broker_connections. */
export type UpstoxGateReader = () => Promise<UpstoxGateState>;

/** Symbol → ISIN. The default is the bundled listing snapshot (pure, no DB). */
export type IsinResolver = (symbol: string) => string | null;

/** The `family: 4` GET, injected in tests so no test ever opens a socket. */
export type UpstoxGetter = <T>(path: string, token: string) => Promise<T>;

export interface UpstoxHealth extends ProviderHealth {
  state: "disabled" | "no-key" | "unreachable" | "ok";
  /** Positions the feed cannot price, and why — never silently zero-filled. */
  skippedDerivatives: number;
  skippedNoIsin: number;
}

export interface UpstoxProviderOptions {
  readGate?: UpstoxGateReader;
  /** On-screen refresh; clamped to 1–5 s whatever is passed. */
  refreshSeconds?: number;
  /** Injected in tests so the rate-limit window and the OHLC throttle are deterministic. */
  now?: () => number;
  getImpl?: UpstoxGetter;
  isinOf?: IsinResolver;
}

/* ────────────────────────── the default gate reader ─────────────────────── */

/**
 * Reads the SAME storage the import path uses: the per-provider acknowledgement
 * on `settings` (migration 0069) and the Analytics token on
 * `broker_connections` (`broker = 'upstox'`, `api_key` = vault ciphertext).
 * Nothing new is stored for the live feed — a second copy of a credential is a
 * second thing to leak.
 *
 * `@/lib/db` is imported LAZILY, like every other provider in this folder: a
 * static import would bind the SQLite connection at module-import time and
 * break `tests/helpers/temp-db.ts` for anything that touches the registry.
 *
 * ACCOUNT SCOPE (invariant 8): the connection is read through the selected
 * account when one is selected. In the All-accounts view (id 0, a view that
 * never receives a write — invariant 9) the most recently updated Upstox
 * connection wins, because a feed for "every book at once" has no single owner
 * and refusing outright would make the desk useless in the default view.
 */
async function readGateFromDb(): Promise<UpstoxGateState> {
  const { db } = await import("@/lib/db");
  const { settings, brokerConnections } = await import("@/lib/db/schema");
  const { readSecret } = await import("@/lib/vault");
  const { getSelectedAccountId } = await import("@/lib/queries/accounts");
  const { desc, eq } = await import("drizzle-orm");

  const s = db.select({ ack: settings.liveFeedAckJson }).from(settings).limit(1).all()[0];
  if (!isFeedAckCurrent(s?.ack ?? null, "upstox")) {
    return {
      state: "disabled",
      reason:
        "The Upstox live-price disclosure has not been accepted on this machine. Open Settings → Live feed, read what the feed sends, and accept it to continue.",
    };
  }

  const accountId = getSelectedAccountId();
  const rows = db
    .select({ accountId: brokerConnections.accountId, apiKey: brokerConnections.apiKey })
    .from(brokerConnections)
    .where(eq(brokerConnections.broker, "upstox"))
    .orderBy(desc(brokerConnections.updatedAt))
    .all();
  const scoped = accountId > 0 ? rows.filter((r) => r.accountId === accountId) : rows;

  for (const row of scoped) {
    const token = readSecret(row.apiKey);
    if (!token.ok || !token.value) continue;
    return { state: "ready", creds: { accessToken: token.value } };
  }
  return {
    state: "no-key",
    reason:
      "No Upstox connection is saved for this account. Paste your read-only Analytics token under Import → Connect broker, then pick Upstox in Settings → Live feed.",
  };
}

/* ──────────────────────────── instrument keys ───────────────────────────── */

/** An ISIN is two letters and ten alphanumerics — 12 characters, no more. */
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{10}$/;

/** The segment prefix Upstox uses for a cash scrip on each exchange. */
const CASH_SEGMENT: Partial<Record<QuoteKey["exchange"], string>> = {
  NSE: "NSE_EQ",
  BSE: "BSE_EQ",
};

/**
 * PURE. `QuoteKey` → the instrument key Upstox understands, or null.
 *
 * `"NSE_EQ|INE002A01018"` — SEGMENT then the ISIN, which is why this release
 * prices EQUITIES ONLY (ruling 4.2-8): a futures or options contract is keyed
 * by an Upstox instrument id that no bundled file in this repo carries, and
 * GUESSING one would price a contract at something that is not it. A derivative
 * key therefore returns null and is never sent; the desk labels those rows.
 *
 * `key.token` is honoured when it already holds a full instrument key, which is
 * what `QuoteKey.token` is for ("provider-native instrument id, resolved by the
 * provider itself") — a caller that knows the ISIN of the trade row can hand it
 * over and skip the lookup entirely.
 */
export function upstoxInstrumentKey(key: QuoteKey, isinOf: IsinResolver = bundledIsinBySymbol): string | null {
  const segment = CASH_SEGMENT[key.exchange];
  if (!segment) return null;
  const token = (key.token ?? "").trim().toUpperCase();
  if (/^(?:NSE|BSE)_EQ\|[A-Z]{2}[A-Z0-9]{10}$/.test(token)) return token;
  // A decorated or contract tradingsymbol is NOT a cash scrip — the same test
  // `lib/quotes/mapping.ts` applies before it lets a bhavcopy price a key.
  if (!isCashKey(key)) return null;
  const fromToken = ISIN_RE.test(token) ? token : null;
  const isin = (fromToken ?? isinOf(key.symbol.trim().toUpperCase()) ?? "").trim().toUpperCase();
  if (!ISIN_RE.test(isin)) return null;
  return `${segment}|${isin}`;
}

export interface UpstoxKeyPlan {
  /** What actually goes on the wire, capped at `UPSTOX_MAX_KEYS`. */
  instrumentKeys: string[];
  /** instrument key → the QuoteKey that asked for it. */
  byInstrumentKey: Map<string, QuoteKey>;
  /** Futures/options keys, dropped before the request (ruling 4.2-8). */
  skippedDerivatives: QuoteKey[];
  /** Cash keys whose ISIN no source in this build knows. Counted, never faked. */
  skippedNoIsin: QuoteKey[];
  /** Keys beyond Upstox's 500 cap, dropped rather than sent and rejected. */
  droppedOverCap: number;
}

/**
 * PURE. The key set the desk asked for → the request Upstox will accept.
 *
 * The cap is applied HERE rather than left to the API: over 500 keys Upstox
 * answers UDAPI100043 and prices NOTHING, so one position too many would blank
 * the whole desk. Dropping the tail prices 500 of them and says how many were
 * dropped.
 */
export function planUpstoxKeys(
  keys: readonly QuoteKey[],
  isinOf: IsinResolver = bundledIsinBySymbol,
): UpstoxKeyPlan {
  const plan: UpstoxKeyPlan = {
    instrumentKeys: [],
    byInstrumentKey: new Map(),
    skippedDerivatives: [],
    skippedNoIsin: [],
    droppedOverCap: 0,
  };
  for (const key of keys) {
    const instrumentKey = upstoxInstrumentKey(key, isinOf);
    if (!instrumentKey) {
      if (isCashKey(key) && CASH_SEGMENT[key.exchange]) plan.skippedNoIsin.push(key);
      else plan.skippedDerivatives.push(key);
      continue;
    }
    if (plan.byInstrumentKey.has(instrumentKey)) continue;
    if (plan.instrumentKeys.length >= UPSTOX_MAX_KEYS) {
      plan.droppedOverCap += 1;
      continue;
    }
    plan.instrumentKeys.push(instrumentKey);
    plan.byInstrumentKey.set(instrumentKey, key);
  }
  return plan;
}

/* ─────────────────────────── the wire, and its shapes ───────────────────── */

/**
 * One instrument's LTP block. Every field is optional on purpose: a missing
 * field must become `null`, never a zero that renders as a price.
 *
 * THE MAP IS NOT KEYED BY WHAT YOU SENT. `/v3/market-quote/ltp` answers with an
 * object keyed by `SEGMENT:TRADINGSYMBOL` — `"NSE_EQ:RELIANCE"` — while the
 * request carried `"NSE_EQ|INE002A01018"`. Matching on the response's OWN key
 * would need a symbol → tradingsymbol table this app does not have, and a near
 * match would put one company's price on another company's row. Each value
 * repeats the key you sent in `instrument_token`, and THAT is what this file
 * indexes on.
 */
export interface UpstoxLtpValue {
  last_price?: number | string | null;
  /** The instrument key AS SENT — the only reliable way back to the QuoteKey. */
  instrument_token?: string | null;
  volume?: number | string | null;
  /** Previous close ("close price"). Absent on some rows; then prevClose is null. */
  cp?: number | string | null;
}

/** `/v3/market-quote/ohlc?interval=1d` — the same indexing rule applies. */
export interface UpstoxOhlcValue {
  instrument_token?: string | null;
  live_ohlc?: { open?: number | string | null; high?: number | string | null; low?: number | string | null } | null;
}

export type UpstoxLtpData = Record<string, UpstoxLtpValue>;
export type UpstoxOhlcData = Record<string, UpstoxOhlcValue>;

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function paiseOrNull(v: unknown): Paise | null {
  const n = num(v);
  return n == null ? null : toPaise(n);
}

/**
 * PURE. Response map → `instrument_token` → value.
 *
 * Rows without an `instrument_token` are DROPPED rather than matched by their
 * `SEGMENT:TRADINGSYMBOL` map key: a row we cannot attribute with certainty is
 * an absent mark, which the desk already renders, and a guessed one is not
 * recoverable (invariant 6).
 */
export function indexByInstrumentToken<T extends { instrument_token?: string | null }>(
  data: Record<string, T> | null | undefined,
): Map<string, T> {
  const out = new Map<string, T>();
  if (!data || typeof data !== "object") return out;
  for (const value of Object.values(data)) {
    const token = (value?.instrument_token ?? "").toString().trim().toUpperCase();
    if (!token) continue;
    out.set(token, value);
  }
  return out;
}

/**
 * PURE. Provider rows → `Quote`. Returns null when there is no usable last price.
 *
 * A zero or negative last price is not a price: refuse it rather than mark a
 * position to zero and print a −100 % day (invariant 6). `asOf` is RECEIPT time
 * because the payload states no source time — see property 6 in the header.
 */
export function quoteFromUpstox(
  key: QuoteKey,
  ltp: UpstoxLtpValue,
  ohlc: UpstoxOhlcValue | null,
  receivedAtIso: string,
): Quote | null {
  const last = num(ltp.last_price);
  if (last == null || last <= 0) return null;
  const day = ohlc?.live_ohlc ?? null;
  return {
    key,
    ltp: toPaise(last),
    prevClose: paiseOrNull(ltp.cp),
    dayOpen: paiseOrNull(day?.open),
    dayHigh: paiseOrNull(day?.high),
    dayLow: paiseOrNull(day?.low),
    volume: num(ltp.volume),
    asOf: receivedAtIso,
    staleness: "delayed",
    source: "upstox",
  };
}

/**
 * PURE. An Upstox failure → the sentence the desk shows.
 *
 * The import path's own 401 message names the Static-IP registration, which is
 * the right answer while SAVING a connection and the wrong one on a desk that
 * was pricing a book a minute ago. Here the user is told which credential died
 * and where to replace it.
 */
export function upstoxFeedErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/UDAPI100043/i.test(raw)) {
    return `Upstox refused the request because it carried too many instrument keys (UDAPI100043). Vyuha sends at most ${UPSTOX_MAX_KEYS} at a time; nothing was priced on this poll.`;
  }
  if (/UDAPI100050|401|403|refused the token|invalid token|expired/i.test(raw)) {
    return "Upstox refused the Analytics token (UDAPI100050 — invalid or expired). Paste a fresh read-only Analytics token under Import → Connect broker; prices stop arriving until you do, and the desk keeps the last mark it had.";
  }
  return raw;
}

/* ──────────────────────────────── provider ──────────────────────────────── */

export function createUpstoxProvider(opts: UpstoxProviderOptions = {}): QuoteProvider {
  const readGate = opts.readGate ?? readGateFromDb;
  const now = opts.now ?? (() => Date.now());
  const doGet: UpstoxGetter = opts.getImpl ?? upstoxGet;
  const isinOf = opts.isinOf ?? bundledIsinBySymbol;
  const periodMs = clampRefreshSeconds(opts.refreshSeconds ?? REFRESH_SECONDS_DEFAULT) * 1000;
  const guard = createRateGuard(UPSTOX_RATE_LIMIT_PER_SECOND);

  /** Day OHLC is fetched at most once a minute and reused in between. */
  let ohlcAt: number | null = null;
  let ohlcByToken = new Map<string, UpstoxOhlcValue>();
  /** What the last snapshot could not price, for `health()`. */
  let lastPlan: UpstoxKeyPlan | null = null;
  let lastError: string | null = null;

  async function get<T>(path: string, token: string): Promise<T> {
    if (!guard.take(now())) {
      throw new Error(
        `Vyuha's own rate guard stopped this request: at most ${UPSTOX_RATE_LIMIT_PER_SECOND} requests per second go to Upstox. Nothing was sent.`,
      );
    }
    return doGet<T>(path, token);
  }

  function query(path: string, instrumentKeys: readonly string[], extra = ""): string {
    // Upstox takes a comma list. Encoded because an instrument key carries a
    // `|`, which is not legal in a URL query unescaped.
    return `${path}?${extra}instrument_key=${instrumentKeys.map(encodeURIComponent).join(",")}`;
  }

  async function snapshot(keys: readonly QuoteKey[], _signal?: AbortSignal): Promise<QuoteMap> {
    const out: QuoteMap = new Map();
    if (keys.length === 0) return out;
    const gate = await readGate();
    if (gate.state !== "ready") throw new Error(gate.reason);

    const plan = planUpstoxKeys(keys, isinOf);
    lastPlan = plan;
    if (plan.instrumentKeys.length === 0) return out;

    let ltpByToken: Map<string, UpstoxLtpValue>;
    try {
      const data = await get<UpstoxLtpData>(query(UPSTOX_LTP_PATH, plan.instrumentKeys), gate.creds.accessToken);
      ltpByToken = indexByInstrumentToken(data);
      lastError = null;
    } catch (e) {
      lastError = upstoxFeedErrorMessage(e);
      throw new Error(lastError);
    }

    // Day open/high/low: a SECOND endpoint, at most once a minute. A failure
    // here costs the three day figures and never the last traded price — the
    // number the desk exists to show is already in hand.
    if (ohlcAt == null || now() - ohlcAt >= UPSTOX_OHLC_MIN_INTERVAL_MS) {
      try {
        const data = await get<UpstoxOhlcData>(
          query(UPSTOX_OHLC_PATH, plan.instrumentKeys, "interval=1d&"),
          gate.creds.accessToken,
        );
        ohlcByToken = indexByInstrumentToken(data);
        ohlcAt = now();
      } catch {
        /* the day figures stay as they were; the LTP is unaffected */
      }
    }

    const receivedAt = new Date(now()).toISOString();
    for (const [instrumentKey, key] of plan.byInstrumentKey) {
      const row = ltpByToken.get(instrumentKey);
      if (!row) continue;
      const quote = quoteFromUpstox(key, row, ohlcByToken.get(instrumentKey) ?? null, receivedAt);
      if (quote) out.set(quoteKeyId(key), quote);
    }
    return out;
  }

  return {
    id: "upstox",
    capabilities: UPSTOX_CAPABILITIES,
    snapshot,

    /**
     * Poll `snapshot()` every 1–5 s and emit ONLY what changed.
     *
     * There is no first poll on subscribe: the SSE route sends a snapshot on
     * connect, and a poll here would repeat it as a tick a moment later. A poll
     * that fails is swallowed — the desk keeps the last price it had, and
     * `health()` is what explains a token that expired. Nothing here writes
     * anything anywhere.
     */
    subscribe(keys: readonly QuoteKey[], onTick: TickListener, signal?: AbortSignal): Unsubscribe {
      if (keys.length === 0 || signal?.aborted) return () => {};
      let stopped = false;
      let inFlight = false;
      const lastSeen = new Map<string, string>();

      const poll = async () => {
        if (stopped || inFlight) return;
        inFlight = true;
        try {
          const map = await snapshot(keys, signal);
          if (stopped) return;
          for (const [id, q] of map) {
            // Change = the numbers a desk renders. Receipt time alone is not a
            // change; emitting on it would push a frame every poll forever.
            const sig = `${q.ltp}|${q.dayHigh}|${q.dayLow}|${q.volume}`;
            if (lastSeen.get(id) === sig) continue;
            lastSeen.set(id, sig);
            onTick(q);
          }
        } catch {
          /* one failed poll is not the end of the subscription */
        } finally {
          inFlight = false;
        }
      };

      const timer = setInterval(() => void poll(), periodMs);
      const stop: Unsubscribe = () => {
        if (stopped) return; // idempotent, by contract
        stopped = true;
        clearInterval(timer);
        signal?.removeEventListener("abort", stop);
      };
      signal?.addEventListener("abort", stop);
      return stop;
    },

    /**
     * NEVER throws — the pill needs a reason, not a crash.
     *
     * AND IT MAKES NO REQUEST OF ITS OWN. The consent sheet names exactly one
     * kind of request (the last traded prices of your open positions); a probe
     * call would be a second one nobody was told about. What health() reports
     * is the gate, the last poll's outcome, and how many positions this feed
     * cannot price — which is the number a user needs when a row shows no mark.
     */
    async health(): Promise<UpstoxHealth> {
      const skipped = {
        skippedDerivatives: lastPlan?.skippedDerivatives.length ?? 0,
        skippedNoIsin: lastPlan?.skippedNoIsin.length ?? 0,
      };
      let gate: UpstoxGateState;
      try {
        gate = await readGate();
      } catch (e) {
        return {
          ok: false,
          state: "disabled",
          ...skipped,
          reason: e instanceof Error ? e.message : "The Upstox feed settings could not be read.",
        };
      }
      if (gate.state === "disabled") return { ok: false, state: "disabled", ...skipped, reason: gate.reason };
      if (gate.state === "no-key") return { ok: false, state: "no-key", ...skipped, reason: gate.reason };
      if (lastError) return { ok: false, state: "unreachable", ...skipped, reason: lastError };

      const notPriced = skipped.skippedDerivatives + skipped.skippedNoIsin;
      return {
        ok: true,
        state: "ok",
        ...skipped,
        reason:
          notPriced === 0
            ? "Upstox is connected with your read-only Analytics token."
            : `Upstox is connected with your read-only Analytics token. ${notPriced} position(s) are not priced by this feed — ${skipped.skippedDerivatives} futures/options and ${skipped.skippedNoIsin} without a known ISIN — and keep their last stored mark.`,
      };
    },
  };
}
