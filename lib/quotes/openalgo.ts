import "server-only";
import { isAckCurrent, openAlgoGate } from "@/lib/domain/openalgo-disclosure";
import { normalizeHost, OPENALGO_WS_PORT, openAlgoFeedVersionWarning, readOpenAlgoVersion } from "@/lib/import/api/openalgo";
import { createOpenAlgoStream, num, type OpenAlgoStreamHealth, type OpenAlgoStreamOptions } from "./openalgo-stream";
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
 * OpenAlgoProvider — live prices from the bridge the user already runs
 * (03D §1.3 phase 2, owner answers Q20/Q21).
 *
 * WHY THIS ONE AND NOT A BROKER API: OpenAlgo is a server the USER installs on
 * their own machine and connects to their own broker. Vyuha stores an OpenAlgo
 * key and host — never a broker token — and the request goes to 127.0.0.1. So
 * the live feed adds NO new remote host (Q58): `docs/client/PRIVACY.md` item 3
 * already names "the OpenAlgo bridge you run on your own machine", and
 * `tests/quotes-egress-guard.test.ts` holds that line in the file.
 *
 * NEVER NSE `quote-equity`, NEVER Yahoo (Q22). Both are undisclosed-ToS
 * scraping of a third party the user has no relationship with; neither is
 * reachable from this file or any other in `lib/quotes`.
 *
 * FOUR PROPERTIES THIS FILE IS RESPONSIBLE FOR
 * --------------------------------------------
 * 1. PAISE AT THE EDGE (invariant 1). OpenAlgo speaks rupees; every price is
 *    converted exactly once, here, by `toPaise()`. Nothing downstream sees a
 *    float rupee.
 * 2. TICKS LIVE IN MEMORY ONLY (Q25). There is not one write in this file —
 *    no `db`, no insert, no cache table. The single persisted number of the
 *    day is written by `lib/quotes/persist-mark.ts`, once, and only from the
 *    day's LAST snapshot.
 * 3. ON-SCREEN REFRESH IS 1–5 s (Q25), clamped here and again in the route, so
 *    a hand-edited settings row cannot turn the desk into a request loop.
 * 4. A RATE-LIMIT GUARD OF 10 req/s. OpenAlgo's own documented ceiling is 50
 *    req/s; Vyuha caps itself at a fifth of it. The guard REFUSES rather than
 *    queues: a refusal is one visible error on one poll, while a queue would
 *    silently hand the desk prices from a minute ago and call them live.
 *
 * DEVIATION, stated because `lib/quotes/types.ts` says the opposite in prose:
 * `capabilities.streaming` is TRUE while `subscribe()` is a POLL. The flag's
 * contract in this codebase is "subscribe() really emits" — the SSE route
 * starts a subscription only when it is set — and this provider really does.
 * The honesty the prose was protecting is carried by `staleness: "delayed"`,
 * which is what the desk renders: a 3-second poll of an LTP is not a tick
 * stream and must never be labelled one.
 */

/** Owner answer Q25 — on-screen refresh, in seconds. */
export const REFRESH_SECONDS_MIN = 1;
export const REFRESH_SECONDS_MAX = 5;
export const REFRESH_SECONDS_DEFAULT = 3;

/** Vyuha's self-imposed ceiling. OpenAlgo's own limit is 50 req/s. */
export const RATE_LIMIT_PER_SECOND = 10;

/** PURE. Anything outside 1–5 (or not a number at all) becomes the default. */
export function clampRefreshSeconds(raw: unknown): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return REFRESH_SECONDS_DEFAULT;
  return Math.min(REFRESH_SECONDS_MAX, Math.max(REFRESH_SECONDS_MIN, n));
}

export const OPENALGO_CAPABILITIES: ProviderCapabilities = {
  id: "openalgo",
  label: "OpenAlgo bridge (your own, on this machine)",
  streaming: true,
  // OpenAlgo's /multiquotes takes a batch; the desk caps its own subscription
  // set at 500 in the SSE route, and this is the ceiling below that.
  maxSubscriptions: 500,
  minSnapshotIntervalMs: REFRESH_SECONDS_MIN * 1000,
  depth: 0,
  segments: ["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"],
  // A poll of an LTP, not a push. See the deviation note above.
  staleness: "delayed",
  // The broker's API session behind OpenAlgo expires every day and has to be
  // signed in again — the BROKER's rule, not Vyuha's and not OpenAlgo's. NO
  // REGULATOR IS NAMED, here or on screen: an earlier wording blamed the
  // exchanges and the market regulator, and no circular saying so is cited
  // anywhere in this tree. The sentence the user reads is
  // `LIVE_FEED_COPY.dailyReauth` (components/settings/live-feed-card.tsx),
  // pinned verbatim by tests/live-feed-copy.test.ts; this comment must keep
  // matching it. The desk says it once a day (Q24).
  requiresDailyAuth: true,
  // v4.7.0 C7 (design D12): the stream goes to the SAME machine, on OpenAlgo's
  // streaming port — the constant, never a second spelling of the number.
  egressDescription: `None beyond your own machine by default: requests go to your own OpenAlgo bridge on 127.0.0.1, and while the Live Desk is open in market hours a price stream on its streaming port ${OPENALGO_WS_PORT} (or the host you configured in Settings → Integrations, which is your choice and may be another machine on your network).`,
};

/** What the provider needs before it may make a single request. */
export interface OpenAlgoFeedCredentials {
  apiKey: string;
  /** Base URL as the user saved it, e.g. http://127.0.0.1:5000 */
  host: string;
  /**
   * v4.7.0 C7 (owner answer D2'): the instance's own streaming address, when
   * the user saved one (vault `authJson.wsUrl`). Absent → the default derived
   * from `host` by `openAlgoStreamUrl()`.
   */
  wsUrl?: string | null;
}

export type FeedGateState =
  /** The OpenAlgo integration is off, or its disclosure was never accepted. */
  | { state: "disabled"; reason: string }
  /** Consent is in place but no OpenAlgo connection is saved. */
  | { state: "no-key"; reason: string }
  | { state: "ready"; creds: OpenAlgoFeedCredentials };

/** Injected in tests; the default reads settings + broker_connections. */
export type FeedGateReader = () => Promise<FeedGateState>;

export interface OpenAlgoHealth extends ProviderHealth {
  state: "disabled" | "no-key" | "unreachable" | "ok";
  /** Round-trip of the reachability probe, in ms. `null` unless state is ok. */
  latencyMs: number | null;
  /**
   * v4.6.0 W8: set when the bridge answered but its version is below
   * `OPENALGO_MIN_VERSION` or unreadable — the feed still works, the pull
   * refuses, and the card says so beside "Feed OK". Null otherwise.
   */
  warning?: string | null;
  /**
   * v4.7.0 C7 (design D11, review R5): the WebSocket stream's state — REPORTED
   * from memory, never probed (`health()` opens no socket).
   */
  stream: OpenAlgoStreamHealth;
}

export interface OpenAlgoProviderOptions {
  readGate?: FeedGateReader;
  /** On-screen refresh; clamped to 1–5 s whatever is passed. Since C7, the FALLBACK poll's interval. */
  refreshSeconds?: number;
  /** Injected in tests so the rate-limit window is deterministic. */
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Injected in tests; the default is the market calendar's live window. */
  isLiveWindow?: (now: Date) => boolean;
  /** TEST SEAM ONLY — the registry passes none (tests/egress-guard.test.ts). */
  webSocketImpl?: OpenAlgoStreamOptions["webSocketImpl"];
}

/* ────────────────────────── the default gate reader ─────────────────────── */

/**
 * Reads the SAME storage the import path uses (05-live-desk-seams §7): the
 * consent pair on `settings`, and the OpenAlgo key/host on
 * `broker_connections` (`openalgo:<underlying>` rows, both fields vault
 * ciphertext). Nothing new is stored for the live feed — a second copy of a
 * credential is a second thing to leak.
 *
 * `@/lib/db` is imported LAZILY, like every other provider in this folder: a
 * static import would bind the SQLite connection at module-import time and
 * break `tests/helpers/temp-db.ts` for anything that touches the registry.
 *
 * ACCOUNT SCOPE (invariant 8): the connection is read through the selected
 * account when one is selected. In the All-accounts view (id 0, a view that
 * never receives a write — invariant 9) the most recently updated OpenAlgo
 * connection wins, because a feed for "every book at once" has no single owner
 * and refusing outright would make the desk useless in the default view.
 */
async function readGateFromDb(): Promise<FeedGateState> {
  const { db } = await import("@/lib/db");
  const { settings, brokerConnections } = await import("@/lib/db/schema");
  const { readSecret } = await import("@/lib/vault");
  const { getSelectedAccountId } = await import("@/lib/queries/accounts");
  const { desc, like, sql } = await import("drizzle-orm");

  const s = db
    .select({ enabled: settings.openalgoEnabled, ackVersion: settings.openalgoAckVersion })
    .from(settings)
    .limit(1)
    .all()[0];
  const gate = openAlgoGate({ enabled: s?.enabled ?? false, ackVersion: s?.ackVersion ?? null });
  if (!gate.allowed) return { state: "disabled", reason: gate.reason ?? "The OpenAlgo integration is off." };

  const accountId = getSelectedAccountId();
  const rows = db
    .select({
      accountId: brokerConnections.accountId,
      apiKey: brokerConnections.apiKey,
      authJson: brokerConnections.authJson,
    })
    .from(brokerConnections)
    .where(like(brokerConnections.broker, "openalgo%"))
    // D-C7-3: "most recently updated" by INSTANT, not by text. An insert used
    // to stamp SQLite's "YYYY-MM-DD HH:MM:SS" and an update a JS ISO string,
    // and "T" sorts above " " — an older re-saved row outranked a newer one.
    // julianday() reads both (and keeps the milliseconds datetime() drops), so
    // rows already stored in mixed formats order correctly with no migration.
    .orderBy(desc(sql`julianday(${brokerConnections.updatedAt})`), desc(brokerConnections.id))
    .all();
  const scoped = accountId > 0 ? rows.filter((r) => r.accountId === accountId) : rows;

  for (const row of scoped) {
    const key = readSecret(row.apiKey);
    if (!key.ok || !key.value) continue;
    let host: string | null = null;
    let wsUrl: string | null = null;
    const auth = readSecret(row.authJson);
    if (auth.ok && auth.value) {
      try {
        const parsed = JSON.parse(auth.value) as { host?: string; wsUrl?: unknown };
        host = parsed.host ?? null;
        wsUrl = typeof parsed.wsUrl === "string" && parsed.wsUrl ? parsed.wsUrl : null;
      } catch {
        host = null;
      }
    }
    if (!host) continue;
    return { state: "ready", creds: { apiKey: key.value, host, wsUrl } };
  }
  return {
    state: "no-key",
    // The route the sentence names is the route the app has (fix wave 3). It
    // said "Import → OpenAlgo", which is the LAST step and not reachable until
    // the first: the Import screen grows its OpenAlgo section only once the
    // integration is switched on in Settings → Integrations (advanced), the
    // same breadcrumb `OPENALGO_CAPABILITIES.egressDescription` and every other
    // 4.1 surface uses. Both steps are named, in the order they have to happen.
    reason:
      "No OpenAlgo connection is saved yet. Connect your feed — 20 seconds: switch OpenAlgo on in Settings → Integrations (advanced), then paste the API key from your OpenAlgo settings on the Import screen and confirm the host.",
  };
}

/* ─────────────────────────── the wire, and its shapes ───────────────────── */

/**
 * One instrument's numbers as OpenAlgo returns them. Every field is optional
 * on purpose: the payload is broker-plugin dependent (the import adapter is
 * scarred by exactly this — a documented sample with `quantity: 0.0`), and a
 * missing field must become `null`, never a zero that renders as a price.
 */
interface OpenAlgoQuoteFields {
  ltp?: number | string | null;
  open?: number | string | null;
  high?: number | string | null;
  low?: number | string | null;
  prev_close?: number | string | null;
  volume?: number | string | null;
  timestamp?: number | string | null;
}

interface OpenAlgoQuoteRow extends OpenAlgoQuoteFields {
  symbol?: string;
  exchange?: string;
  status?: string;
  data?: OpenAlgoQuoteFields | null;
}

// `num()` lives in `./openalgo-stream` since C7 — ONE tolerance rule for the
// REST rows and the streamed frames (design D4).

function paiseOrNull(v: unknown): Paise | null {
  const n = num(v);
  return n == null ? null : toPaise(n);
}

/**
 * `/multiquotes` → `results[]` (04-external-inputs §D). Two shapes are
 * accepted because the field placement is plugin-dependent: the numbers nested
 * under `data`, and the numbers flat on the row. Anything else yields NO quote
 * for that key — an absent mark is a state the desk already renders, and a
 * guessed one is not recoverable.
 */
function rowFields(row: OpenAlgoQuoteRow): OpenAlgoQuoteFields {
  return row.data && typeof row.data === "object" ? row.data : row;
}

/** Provider row → Quote. Returns null when there is no usable last price. */
export function quoteFromOpenAlgo(key: QuoteKey, row: OpenAlgoQuoteRow, receivedAtIso: string): Quote | null {
  const f = rowFields(row);
  const ltp = num(f.ltp);
  // A zero or negative last price is not a price. Refuse it rather than mark a
  // position to zero and print a -100 % day (invariant 6).
  if (ltp == null || ltp <= 0) return null;
  return {
    key,
    ltp: toPaise(ltp),
    prevClose: paiseOrNull(f.prev_close),
    dayOpen: paiseOrNull(f.open),
    dayHigh: paiseOrNull(f.high),
    dayLow: paiseOrNull(f.low),
    volume: num(f.volume),
    // OpenAlgo's quote payload carries no source timestamp, so `asOf` is
    // RECEIPT time and is documented as such here rather than dressed up as
    // exchange time. The staleness floor ("delayed") is what the desk labels.
    asOf: receivedAtIso,
    staleness: "delayed",
    source: "openalgo",
  };
}

/** Match a response row back to the key that asked for it. */
function indexRows(rows: OpenAlgoQuoteRow[]): Map<string, OpenAlgoQuoteRow> {
  const out = new Map<string, OpenAlgoQuoteRow>();
  for (const row of rows) {
    const symbol = (row.symbol ?? "").trim().toUpperCase();
    if (!symbol) continue;
    const exchange = (row.exchange ?? "NSE").trim().toUpperCase();
    out.set(`${exchange}:${symbol}`, row);
  }
  return out;
}

/** The scrip name OpenAlgo knows: the traded contract when there is one. */
function wireSymbol(key: QuoteKey): string {
  return (key.tradingsymbol ?? key.symbol).trim().toUpperCase();
}

/* ─────────────────────────────── rate guard ─────────────────────────────── */

/**
 * A rolling one-second window. Refuses the 11th request, never queues it.
 *
 * MOVED in v4.2 to `lib/quotes/rate-guard.ts` and re-exported here so every
 * existing importer (and `tests/quotes-openalgo.test.ts`) keeps working: the
 * Upstox adapter applies the identical rule at 5 req/s, and a second copy of a
 * refusal policy is how one of the two quietly becomes a queue. Its default is
 * still 10 — `DEFAULT_RATE_LIMIT_PER_SECOND` there is this file's
 * `RATE_LIMIT_PER_SECOND`.
 */
export { createRateGuard };

/* ──────────────────────────────── provider ──────────────────────────────── */

export function createOpenAlgoProvider(opts: OpenAlgoProviderOptions = {}): QuoteProvider {
  const readGate = opts.readGate ?? readGateFromDb;
  const now = opts.now ?? (() => Date.now());
  const doFetch = opts.fetchImpl ?? fetch;
  const periodMs = clampRefreshSeconds(opts.refreshSeconds ?? REFRESH_SECONDS_DEFAULT) * 1000;
  const guard = createRateGuard();

  /**
   * v4.7.0 C7 — every live subscription on this instance. ONE poll and ONE
   * socket serve them all; each keeps its OWN emit-on-change signatures, so a
   * desk receives only its own keys (and a second desk on the same keys gets
   * its own first tick).
   */
  interface Held {
    keys: Map<string, QuoteKey>;
    onTick: TickListener;
    lastSig: Map<string, string>;
    /** End it from the provider's side: release, then `onEnd` — at most once. */
    end: () => void;
  }
  let subs: Held[] = [];
  let pumpTimer: ReturnType<typeof setInterval> | null = null;
  let pumping = false;
  let disposed = false;

  /**
   * v4.7.0 C7 fix D-C7-1 (invariant 8): the CREDENTIAL identity this instance
   * serves — (apiKey, host, wsUrl) of the row its FIRST ready gate read
   * returned, pinned whether or not a socket ever opened (an https bridge or a
   * desk outside the window never opens one, so the stream's own identity
   * check alone cannot see a switch). The gate follows the SELECTED account,
   * and an instance's subscriptions hold the keys of the account they were
   * opened for: a later gate read naming another connection — the selection
   * switched in another tab, or before the desk's refresh re-keys the registry
   * — must not poll those keys with that connection. The instance RETIRES its
   * subscriptions instead: each ends exactly once (`onEnd`, as `dispose()`
   * does), the route closes the SSE, and the desk reconnects onto the current
   * account and the current instance. One-shot `snapshot()` / `health()` keep
   * reading the current gate — their keys are the CALLER's (the Telegram job
   * peeks this instance by design, registry.ts `peekLiveFeedProvider`).
   */
  let identity: OpenAlgoFeedCredentials | null = null;
  let retired = false;

  /** True when `gate` is this instance's connection (pinning it on first sight); false → retired. */
  function owns(gate: Extract<FeedGateState, { state: "ready" }>): boolean {
    const c = gate.creds;
    if (!identity) {
      identity = { apiKey: c.apiKey, host: c.host, wsUrl: c.wsUrl ?? null };
      return true;
    }
    if (identity.apiKey === c.apiKey && identity.host === c.host && (identity.wsUrl ?? null) === (c.wsUrl ?? null)) {
      return true;
    }
    retire();
    return false;
  }

  /** End every held subscription — each `onEnd` exactly once — and accept no new one. */
  function retire(): void {
    if (retired) return;
    retired = true;
    if (pumpTimer) clearInterval(pumpTimer);
    pumpTimer = null;
    stream.setTarget(null, CONNECTION_CHANGED);
    const ending = subs;
    subs = [];
    for (const sub of ending) sub.end();
  }

  /** The stream's health, with the retirement's reason once the instance has retired. */
  function streamHealth(): OpenAlgoStreamHealth {
    const h = stream.health();
    return retired ? { ...h, reason: CONNECTION_CHANGED } : h;
  }

  /** Change = the numbers a desk renders; receipt time alone is not a change. ONE rule for both paths. */
  const signatureOf = (q: Quote) => `${q.ltp}|${q.dayHigh}|${q.dayLow}|${q.volume}`;

  function deliver(id: string, quote: Quote): void {
    for (const sub of subs) {
      if (!sub.keys.has(id)) continue;
      const sig = signatureOf(quote);
      if (sub.lastSig.get(id) === sig) continue;
      sub.lastSig.set(id, sig);
      sub.onTick(quote);
    }
  }

  const stream = createOpenAlgoStream({
    onQuote: deliver,
    now,
    isLiveWindow: opts.isLiveWindow,
    webSocketImpl: opts.webSocketImpl,
  });

  async function post(creds: OpenAlgoFeedCredentials, path: string, extra: Record<string, unknown>, signal?: AbortSignal) {
    if (!guard.take(now())) {
      throw new Error(
        `Vyuha's own rate guard stopped this request: at most ${RATE_LIMIT_PER_SECOND} requests per second go to OpenAlgo. Nothing was sent.`,
      );
    }
    const base = normalizeHost(creds.host);
    let res: Response;
    try {
      res = await doFetch(`${base}/api/v1/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The key travels in the JSON BODY, not a header — OpenAlgo's own
        // contract (04-external-inputs §D).
        body: JSON.stringify({ apikey: creds.apiKey, ...extra }),
        cache: "no-store",
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      throw new Error(
        `Cannot reach OpenAlgo at ${base} (${(e as Error).message}). Start your OpenAlgo instance, then reconnect the feed.`,
      );
    }
    if (res.status === 429) {
      throw new Error("OpenAlgo answered 429 (its own rate limit). Raise the refresh interval and try again.");
    }
    const json = (await res.json().catch(() => null)) as
      | { status?: string; message?: string; data?: unknown; results?: unknown }
      | null;
    if (!res.ok || !json || (json.status != null && json.status !== "success")) {
      const why = json?.message ?? `HTTP ${res.status}`;
      const hint =
        res.status === 401 || res.status === 403
          ? " (wrong API key? Copy it again from OpenAlgo → API Key.)"
          : "";
      throw new Error(`OpenAlgo /${path}: ${why}${hint}`);
    }
    return json;
  }

  async function snapshot(keys: readonly QuoteKey[], signal?: AbortSignal): Promise<QuoteMap> {
    if (keys.length === 0) return new Map();
    // A disposed instance makes NO request of any kind (review R2).
    if (disposed) throw new Error(REPLACED_INSTANCE);
    const gate = await readGate();
    if (gate.state !== "ready") throw new Error(gate.reason);
    // D-C7-1: a different connection retires the held subscriptions; this
    // one-shot request still goes, with the CALLER's keys on the current gate.
    owns(gate);
    return snapshotWith(gate, keys, signal);
  }

  /** The one `/multiquotes` request, for a gate already read. */
  async function snapshotWith(
    gate: Extract<FeedGateState, { state: "ready" }>,
    keys: readonly QuoteKey[],
    signal?: AbortSignal,
  ): Promise<QuoteMap> {
    const out: QuoteMap = new Map();
    const symbols = keys.slice(0, OPENALGO_CAPABILITIES.maxSubscriptions).map((k) => ({
      symbol: wireSymbol(k),
      exchange: k.exchange,
    }));
    const json = await post(gate.creds, "multiquotes", { symbols }, signal);
    const raw = Array.isArray(json.results)
      ? (json.results as OpenAlgoQuoteRow[])
      : Array.isArray(json.data)
        ? (json.data as OpenAlgoQuoteRow[])
        : [];
    const byKey = indexRows(raw);
    const receivedAt = new Date(now()).toISOString();
    for (const key of keys) {
      const row = byKey.get(`${key.exchange}:${wireSymbol(key)}`);
      if (!row) continue;
      const quote = quoteFromOpenAlgo(key, row, receivedAt);
      if (quote) out.set(quoteKeyId(key), quote);
    }
    return out;
  }

  return {
    id: "openalgo",
    capabilities: OPENALGO_CAPABILITIES,
    snapshot,

    /**
     * Stream what OpenAlgo pushes; poll over REST, every 1–5 s, ONLY the keys
     * with no fresh streamed price (design D6 as amended by R3/R4); emit ONLY
     * what changed, by ONE signature shared between both paths.
     *
     * There is no first REST poll on subscribe: the SSE route sends a snapshot
     * on connect, and a poll here would repeat it as a tick a moment later.
     * The gate IS read at once (a database read, not a request) so the socket
     * can open, and again EVERY period (review R1 a) — even when no key is
     * quiet — so a revoked consent or a changed connection closes the socket
     * within one period. When every key is fresh the period sends NOTHING (no
     * empty `/multiquotes`). A failed poll is swallowed — the desk keeps its
     * last price and `health()` explains. Nothing here writes anything.
     */
    subscribe(keys: readonly QuoteKey[], onTick: TickListener, signal?: AbortSignal, onEnd?: () => void): Unsubscribe {
      if (disposed || retired) {
        // Handed a replaced (or retired, D-C7-1) instance — a race with the registry: end at once,
        // on a later turn so the caller has finished wiring its teardown.
        if (onEnd) queueMicrotask(onEnd);
        return () => {};
      }
      if (keys.length === 0 || signal?.aborted) return () => {};
      const own = new Map<string, QuoteKey>();
      for (const k of keys) if (!own.has(quoteKeyId(k))) own.set(quoteKeyId(k), k);
      const release = stream.hold([...own].map(([id, key]) => ({ id, key, symbol: wireSymbol(key), exchange: key.exchange })));

      let stopped = false;
      const stop: Unsubscribe = () => {
        if (stopped) return; // idempotent, by contract
        stopped = true;
        subs = subs.filter((s) => s !== sub);
        release();
        signal?.removeEventListener("abort", stop);
        if (subs.length === 0 && pumpTimer) {
          clearInterval(pumpTimer);
          pumpTimer = null;
        }
      };
      const sub: Held = {
        keys: own,
        onTick,
        lastSig: new Map(),
        end: () => {
          if (stopped) return;
          stop();
          try {
            onEnd?.();
          } catch {
            /* the caller's teardown must not stop the others' */
          }
        },
      };
      subs = [...subs, sub];
      signal?.addEventListener("abort", stop);
      if (!pumpTimer) {
        pumpTimer = setInterval(() => void pump(true), periodMs);
        void pump(false);
      }
      return stop;
    },

    /**
     * v4.7.0 C7 (design D8, review R2). Closes the socket and forbids another;
     * ENDS every subscription still held — each `onEnd` exactly once — and from
     * then on makes NO request of any kind. Idempotent.
     */
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (pumpTimer) clearInterval(pumpTimer);
      pumpTimer = null;
      stream.dispose();
      const ending = subs;
      subs = [];
      for (const sub of ending) sub.end();
    },

    /** NEVER throws — the pill needs a reason, not a crash. Never opens the socket. */
    async health(): Promise<OpenAlgoHealth> {
      if (disposed) {
        return { ok: false, state: "unreachable", latencyMs: null, reason: REPLACED_INSTANCE, stream: streamHealth() };
      }
      let gate: FeedGateState;
      try {
        gate = await readGate();
      } catch (e) {
        return {
          ok: false,
          state: "disabled",
          latencyMs: null,
          reason: e instanceof Error ? e.message : "The OpenAlgo settings could not be read.",
          stream: streamHealth(),
        };
      }
      if (gate.state === "disabled") {
        return { ok: false, state: "disabled", latencyMs: null, reason: gate.reason, stream: streamHealth() };
      }
      if (gate.state === "no-key") {
        return { ok: false, state: "no-key", latencyMs: null, reason: gate.reason, stream: streamHealth() };
      }
      owns(gate); // D-C7-1: pin, or retire the subscriptions of another connection

      const started = now();
      try {
        // `/funds` is the cheapest call that proves BOTH the host and the key.
        // Only the feed makes it: saving an import connection makes no network
        // call (the import adapter's unused `/funds` check was removed in W8).
        await post(gate.creds, "funds", {});
      } catch (e) {
        return {
          ok: false,
          state: "unreachable",
          latencyMs: null,
          reason: e instanceof Error ? e.message : "OpenAlgo could not be reached.",
          stream: streamHealth(),
        };
      }
      const latencyMs = Math.max(0, now() - started);
      // W8: one keyless GET /auth/app-info on the same host, AFTER the probe
      // (so its time is not in latencyMs). Under the rate guard like every
      // other request; a refused take skips the check rather than failing.
      const warning = guard.take(now())
        ? openAlgoFeedVersionWarning(await readOpenAlgoVersion(gate.creds.host, doFetch))
        : null;
      return {
        ok: true,
        state: "ok",
        latencyMs,
        reason: `OpenAlgo answered in ${latencyMs} ms.`,
        warning,
        stream: streamHealth(),
      };
    },
  };

  /**
   * One period of the live subscriptions (v4.7.0 C7). `withPoll` false is the
   * gate-only read made at subscribe time so the socket can open at once.
   *
   * 1. Re-read the gate EVERY period (review R1 a) and hand it to the stream:
   *    not ready, or a different (key, streaming address) than the socket
   *    authenticated with → the stream closes and says why.
   * 2. Ask `/multiquotes` for the QUIET keys only — none quiet, no request.
   * 3. Drop a REST result for any key whose streamed frame arrived after this
   *    poll was sent (review R4): an older REST price never overwrites a newer
   *    streamed one. What survives is the stall evidence (review R3) and then
   *    a tick, through the shared signature.
   */
  async function pump(withPoll: boolean): Promise<void> {
    if (disposed || retired || pumping) return;
    pumping = true;
    try {
      let gate: FeedGateState;
      try {
        gate = await readGate();
      } catch (e) {
        gate = { state: "disabled", reason: e instanceof Error ? e.message : "The OpenAlgo settings could not be read." };
      }
      if (disposed || retired || subs.length === 0) return;
      if (gate.state !== "ready") {
        stream.setTarget(null, gate.reason);
        return;
      }
      // D-C7-1: another connection behind the gate (the selection moved) →
      // every subscription ends here, BEFORE any request; nothing is polled.
      if (!owns(gate)) return;
      stream.setTarget(gate.creds);
      if (!withPoll) return;

      const quiet = new Map<string, QuoteKey>();
      for (const sub of subs) {
        for (const [id, key] of sub.keys) if (!quiet.has(id) && stream.isQuiet(id)) quiet.set(id, key);
      }
      if (quiet.size === 0) return;
      const sentAt = now();
      const map = await snapshotWith(gate, [...quiet.values()]);
      if (disposed) return;
      for (const [id, quote] of map) {
        if (stream.framedSince(id, sentAt)) continue;
        stream.observePoll(id, quote);
        deliver(id, quote);
      }
    } catch {
      /* one failed poll is not the end of the subscription */
    } finally {
      pumping = false;
    }
  }
}

/** Why a replaced (disposed) instance answers without asking anything (review R2). */
const REPLACED_INSTANCE = "This OpenAlgo feed instance was replaced; the desk reconnects to the current one.";

/** Why a retired instance's subscriptions ended (D-C7-1). */
const CONNECTION_CHANGED =
  "The OpenAlgo connection changed since this desk subscribed (another account was selected, or the connection was re-saved); the desk reconnects to the current one.";

/** True when the stored acknowledgement covers the disclosure as it reads today. */
export const isOpenAlgoAckCurrent = isAckCurrent;
