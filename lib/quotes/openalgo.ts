import "server-only";
import { isAckCurrent, openAlgoGate } from "@/lib/domain/openalgo-disclosure";
import { normalizeHost } from "@/lib/import/api/openalgo";
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
  // The broker session behind OpenAlgo dies daily — an exchange/SEBI rule, not
  // Vyuha's and not OpenAlgo's. The desk says so once a day (Q24).
  requiresDailyAuth: true,
  egressDescription:
    "None beyond your own machine by default: requests go to your own OpenAlgo bridge on 127.0.0.1 (or the host you configured in Import → OpenAlgo, which is your choice and may be another machine on your network).",
};

/** What the provider needs before it may make a single request. */
export interface OpenAlgoFeedCredentials {
  apiKey: string;
  /** Base URL as the user saved it, e.g. http://127.0.0.1:5000 */
  host: string;
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
}

export interface OpenAlgoProviderOptions {
  readGate?: FeedGateReader;
  /** On-screen refresh; clamped to 1–5 s whatever is passed. */
  refreshSeconds?: number;
  /** Injected in tests so the rate-limit window is deterministic. */
  now?: () => number;
  fetchImpl?: typeof fetch;
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
  const { desc, like } = await import("drizzle-orm");

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
    .orderBy(desc(brokerConnections.updatedAt))
    .all();
  const scoped = accountId > 0 ? rows.filter((r) => r.accountId === accountId) : rows;

  for (const row of scoped) {
    const key = readSecret(row.apiKey);
    if (!key.ok || !key.value) continue;
    let host: string | null = null;
    const auth = readSecret(row.authJson);
    if (auth.ok && auth.value) {
      try {
        host = (JSON.parse(auth.value) as { host?: string }).host ?? null;
      } catch {
        host = null;
      }
    }
    if (!host) continue;
    return { state: "ready", creds: { apiKey: key.value, host } };
  }
  return {
    state: "no-key",
    reason:
      "No OpenAlgo connection is saved yet. Connect your feed — 20 seconds: Import → OpenAlgo, paste the API key from your OpenAlgo settings, and confirm the host.",
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

/** A rolling one-second window. Refuses the 11th request, never queues it. */
export function createRateGuard(limit = RATE_LIMIT_PER_SECOND) {
  const stamps: number[] = [];
  return {
    take(now: number): boolean {
      while (stamps.length > 0 && now - stamps[0] >= 1000) stamps.shift();
      if (stamps.length >= limit) return false;
      stamps.push(now);
      return true;
    },
  };
}

/* ──────────────────────────────── provider ──────────────────────────────── */

export function createOpenAlgoProvider(opts: OpenAlgoProviderOptions = {}): QuoteProvider {
  const readGate = opts.readGate ?? readGateFromDb;
  const now = opts.now ?? (() => Date.now());
  const doFetch = opts.fetchImpl ?? fetch;
  const periodMs = clampRefreshSeconds(opts.refreshSeconds ?? REFRESH_SECONDS_DEFAULT) * 1000;
  const guard = createRateGuard();

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
    const out: QuoteMap = new Map();
    if (keys.length === 0) return out;
    const gate = await readGate();
    if (gate.state !== "ready") throw new Error(gate.reason);

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
     * Poll `snapshot()` every 1–5 s and emit ONLY what changed.
     *
     * There is no first poll on subscribe: the SSE route sends a snapshot on
     * connect, and a poll here would repeat it as a tick a moment later. A
     * poll that fails is swallowed — the desk keeps the last price it had, and
     * `health()` is what explains a bridge that went away. Nothing here writes
     * anything anywhere; the ticks exist only in the listener's memory.
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

    /** NEVER throws — the pill needs a reason, not a crash. */
    async health(): Promise<OpenAlgoHealth> {
      let gate: FeedGateState;
      try {
        gate = await readGate();
      } catch (e) {
        return {
          ok: false,
          state: "disabled",
          latencyMs: null,
          reason: e instanceof Error ? e.message : "The OpenAlgo settings could not be read.",
        };
      }
      if (gate.state === "disabled") return { ok: false, state: "disabled", latencyMs: null, reason: gate.reason };
      if (gate.state === "no-key") return { ok: false, state: "no-key", latencyMs: null, reason: gate.reason };

      const started = now();
      try {
        // `/funds` is the cheapest call that proves BOTH the host and the key,
        // and it is the same probe the import path's save step uses.
        await post(gate.creds, "funds", {});
      } catch (e) {
        return {
          ok: false,
          state: "unreachable",
          latencyMs: null,
          reason: e instanceof Error ? e.message : "OpenAlgo could not be reached.",
        };
      }
      const latencyMs = Math.max(0, now() - started);
      return { ok: true, state: "ok", latencyMs, reason: `OpenAlgo answered in ${latencyMs} ms.` };
    },
  };
}

/** True when the stored acknowledgement covers the disclosure as it reads today. */
export const isOpenAlgoAckCurrent = isAckCurrent;
