import "server-only";
import { normalizeHost, openAlgoStreamUrl } from "@/lib/import/api/openalgo";
import { isWithinLiveWindow } from "./mapping";
import { toPaise, type Paise, type Quote, type QuoteKey } from "./types";

/**
 * OpenAlgo's WebSocket quote stream — the socket half of the OpenAlgo live feed
 * (v4.7.0 C7; design `C7-DESIGN-2026-10-05.md` §1 D1–D8 as amended by review
 * R1–R11 and the owner's answers §5b; wire facts from OpenAlgo's own
 * `websocket_proxy/server.py`, research R11).
 *
 * ONE SOCKET PER PROCESS (review R8). The handle lives on
 * `globalThis.__vyuhaOpenAlgoSocket`, not in a module `let`: a dev re-evaluation
 * (or the RSC copy of the registry) is a second module instance, and opening a
 * socket from one closes the predecessor the other recorded. The superseded
 * manager polls from then on and never reconnects, so two copies cannot take
 * turns closing each other.
 *
 * WHAT TRAVELS (disclosure "5", amended): the API key ONCE PER CONNECTION in the
 * `authenticate` message, then `subscribe` / `unsubscribe` messages carrying
 * the same `{symbol, exchange}` pairs the REST poll sends — nothing about the
 * book. Ticks live in memory only: there is no write of any kind in this file.
 *
 * THE RULES, each pinned in `tests/openalgo-stream.test.ts`:
 * - LAZY: nothing opens until a subscription holds a key AND the gate has
 *   handed over a target; `snapshot()` / `health()` never reach this module's
 *   socket. Never outside `isWithinLiveWindow(now)` (R3), and closed at its end.
 * - REFCOUNT per key id; one `subscribe` / `unsubscribe` message per batch, each
 *   with a `request_id` (error replies carry no `type`, R11 A4). Keys held
 *   before auth are not queued one by one: the CURRENT held set is sent on auth
 *   (empty when the desk left mid-auth, R9).
 * - A subscribe ack's `status:"error"` entries mark THOSE keys refused (still
 *   polled). Applied only to keys still held.
 * - QUIET = no QUOTE-PRODUCING frame for `STREAM_QUIET_MS` (R4). A quiet key is
 *   polled over REST by the provider (design D6).
 * - STALL ONLY ON EVIDENCE (R3): a REST poll of a quiet, ack-subscribed key
 *   returns an ltp/volume that differs from the last one seen on this
 *   connection while no frame came. Silence alone — pre-open, an illiquid book,
 *   after hours — is never a stall: every close tears down the user's broker
 *   adapter at OpenAlgo (R11 M2), i.e. costs them a broker login.
 * - BACKOFF 2 / 5 / 15 / 30 s, then 60 s; reset ONLY by the first `market_data`
 *   frame after a connect (never by auth — a BROKER_ERROR after auth, R11 A7,
 *   would otherwise reset it forever). `STREAM_FRAMELESS_CONNECT_LIMIT`
 *   connects in a row with no frame, or an AUTHENTICATION_ERROR, → wait
 *   `STREAM_LOCKOUT_MS` (15 minutes).
 * - ZERO KEYS → close after `STREAM_CLOSE_GRACE_MS` (a reload inside it reuses
 *   the socket and skips a fresh authenticate).
 */

/* ───────────────────────────────── constants ────────────────────────────── */

/** A key with no quote-producing frame for this long is polled over REST (D6, R4). */
export const STREAM_QUIET_MS = 30_000;
/** Our own wait for `{"type":"auth","status":"success"}` (D3); OpenAlgo's own grace is 15 s (R11 A6). */
export const STREAM_AUTH_TIMEOUT_MS = 10_000;
/** Zero keys held → the socket closes after this grace (D1). */
export const STREAM_CLOSE_GRACE_MS = 30_000;
/** Reconnect delays after an unexpected close; the last one repeats (D7, R3). */
export const STREAM_BACKOFF_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000, 60_000];
/** Connects in a row that brought no `market_data` frame before streaming waits (R3). */
export const STREAM_FRAMELESS_CONNECT_LIMIT = 5;
/** The wait after an AUTHENTICATION_ERROR or the frameless limit: fifteen minutes. */
export const STREAM_LOCKOUT_MS = 900_000;
/** OpenAlgo's Quote mode as a NUMBER — accepted since the stream existed; strings only case-insensitive from 2.0.1.1 (R11 §5). */
export const STREAM_MODE = 2;

/* ─────────────────────────────────── types ──────────────────────────────── */

export type OpenAlgoStreamState = "off" | "connecting" | "streaming" | "polling";

/**
 * `health().stream` (design D11, review R5). REPORTED, never probed.
 * - `off`        — no subscription holds a key (nothing streams, nothing polls).
 * - `connecting` — a socket is opening, or authenticated and waiting for its
 *                  first price.
 * - `streaming`  — ONLY after the first `market_data` frame since auth (R5).
 * - `polling`    — keys are held and no usable socket: `reason` says why.
 * `since` is when the state last changed (ISO), null before the first change.
 */
export interface OpenAlgoStreamHealth {
  state: OpenAlgoStreamState;
  reason: string | null;
  since: string | null;
}

/** Where the socket goes and what it authenticates with — the gate's creds. */
export interface StreamTarget {
  apiKey: string;
  host: string;
  wsUrl?: string | null;
}

/** One held key: its id (`quoteKeyId`), and the EXACT strings sent on the wire. */
export interface StreamKeyRef {
  id: string;
  key: QuoteKey;
  /** `wireSymbol(key)` — the same string the REST poll sends. */
  symbol: string;
  exchange: string;
}

/** The subset of the WHATWG socket this module uses — the test seam's shape. */
export interface StreamSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown; code?: number; reason?: string }) => void): void;
}
export type StreamSocketCtor = new (url: string) => StreamSocket;

export interface OpenAlgoStreamOptions {
  /** Every quote a frame produced, for a key some subscription holds. */
  onQuote: (id: string, quote: Quote) => void;
  now?: () => number;
  /** Injected in tests; the default is the market calendar's window. */
  isLiveWindow?: (now: Date) => boolean;
  /** TEST SEAM ONLY — the registry passes none (pinned by tests/egress-guard.test.ts). */
  webSocketImpl?: StreamSocketCtor;
}

export interface OpenAlgoStream {
  /** Add one reference per distinct key; returns the (idempotent) release. */
  hold(keys: readonly StreamKeyRef[]): () => void;
  /** The gate's answer, every poll period (R1 a). Null = not ready, with why. */
  setTarget(target: StreamTarget | null, reason?: string): void;
  /** No quote-producing frame within `STREAM_QUIET_MS` (R4). */
  isQuiet(id: string): boolean;
  /** A quote-producing frame for `id` arrived at or after `sinceMs` (R4 drop rule). */
  framedSince(id: string, sinceMs: number): boolean;
  /** A REST result for a quiet key — the stall evidence rule (R3). */
  observePoll(id: string, quote: Quote): void;
  health(): OpenAlgoStreamHealth;
  /** Close the socket and never open another. Idempotent. */
  dispose(): void;
}

/* ─────────────────────────────── frames → Quote ─────────────────────────── */

/** Numbers OR numeric strings (no adapter contract covers every broker, R11); anything else → null. */
export function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function paiseOrNull(v: unknown): Paise | null {
  const n = num(v);
  return n == null ? null : toPaise(n);
}

/** A `data.timestamp` we will print as the price's time: epoch-ms, not >5 s ahead, not >24 h old. */
const TIMESTAMP_FUTURE_SLACK_MS = 5_000;
const TIMESTAMP_MAX_AGE_MS = 86_400_000;

/**
 * One `market_data` frame's `data` → a `Quote` (design D4, R11 F1–F8).
 *
 * Read through `num()`: `ltp` (≤ 0 or missing → NO quote, invariant 6),
 * `open`, `high`, `low`, `close` (OpenAlgo's PREVIOUS close, R11 F6) →
 * `prevClose`, `volume`. Every other field is ignored. Paise ONCE, here
 * (invariant 1).
 *
 * `staleness: "tick"` — a pushed last-traded price ("Last traded" is true of
 * any streamed ltp, review R11). `asOf` is `data.timestamp` when it is a
 * plausible epoch-ms, else the RECEIPT time. SAID PLAINLY (R11 F3/F5): some
 * OpenAlgo adapters stamp their OWN receipt time there (Flattrade always,
 * Zerodha when the broker sends none), not the exchange's — for a push that is
 * sub-second from the trade, and the desk's rows print only the day anyway.
 */
export function quoteFromStreamFrame(key: QuoteKey, data: unknown, receivedMs: number): Quote | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const ltp = num(d.ltp);
  if (ltp == null || ltp <= 0) return null;
  const ts = num(d.timestamp);
  const plausible =
    ts != null && ts > 1e12 && ts <= receivedMs + TIMESTAMP_FUTURE_SLACK_MS && ts >= receivedMs - TIMESTAMP_MAX_AGE_MS;
  return {
    key,
    ltp: toPaise(ltp),
    prevClose: paiseOrNull(d.close),
    dayOpen: paiseOrNull(d.open),
    dayHigh: paiseOrNull(d.high),
    dayLow: paiseOrNull(d.low),
    volume: num(d.volume),
    asOf: new Date(plausible ? ts : receivedMs).toISOString(),
    staleness: "tick",
    source: "openalgo",
  };
}

/* ────────────────────────────── the process slot ────────────────────────── */

interface SocketRecord {
  socket: StreamSocket;
  /** Close that manager's socket and stop it reconnecting. */
  supersede: () => void;
}
const processSlot = globalThis as typeof globalThis & { __vyuhaOpenAlgoSocket?: SocketRecord };

/** The routing key a frame is matched back by: EXACTLY the strings we sent (R11 F9). */
const wireOf = (exchange: string, symbol: string) => `${exchange}\u0000${symbol}`;

const OUTSIDE_WINDOW = "Outside market hours — the stream opens only while the live window is open.";
const REPLACED = "This feed instance was replaced; the desk reconnects to the current one.";
const SUPERSEDED = "Another OpenAlgo feed in this app took over the stream; this one polls.";

/* ────────────────────────────────── manager ─────────────────────────────── */

export function createOpenAlgoStream(opts: OpenAlgoStreamOptions): OpenAlgoStream {
  const now = opts.now ?? (() => Date.now());
  const inWindow = opts.isLiveWindow ?? isWithinLiveWindow;
  const webSocketImpl = opts.webSocketImpl;

  const held = new Map<string, { ref: StreamKeyRef; count: number }>();
  const byWire = new Map<string, string>();
  const acked = new Set<string>();
  const refused = new Map<string, string>();
  const lastQuoteAt = new Map<string, number>();
  /** Last ltp|volume seen for a key on THIS connection, after its ack (R3). */
  const baseline = new Map<string, string>();
  const pendingRequests = new Map<string, string[]>();

  let socket: StreamSocket | null = null;
  let socketUrl = "";
  let authed = false;
  let framesThisConnect = 0;
  let attempt = 0;
  let frameless = 0;
  let nextAttemptAt = 0;
  let lockoutUntil = 0;
  let lockoutReason = "";
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let authTimer: ReturnType<typeof setTimeout> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let target: StreamTarget | null = null;
  let targetReason: string | null = null;
  /** The (apiKey, streamUrl) pair this manager first connected with (R1 a). */
  let identity: { apiKey: string; url: string } | null = null;
  let disposed = false;
  let superseded = false;
  let requestSeq = 0;
  let status: OpenAlgoStreamHealth = { state: "off", reason: null, since: null };

  const iso = () => new Date(now()).toISOString();
  const heldCount = () => held.size;

  function setStatus(state: OpenAlgoStreamState, reason: string | null): void {
    if (status.state !== state) status = { state, reason, since: iso() };
    else status = { ...status, reason };
  }

  function clearTimer(t: ReturnType<typeof setTimeout> | null): null {
    if (t) clearTimeout(t);
    return null;
  }

  function send(payload: Record<string, unknown>): void {
    if (!socket) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      /* a send on a dying socket is followed by its close event */
    }
  }

  function sendSubscription(action: "subscribe" | "unsubscribe", refs: StreamKeyRef[]): void {
    if (refs.length === 0) return;
    requestSeq += 1;
    const requestId = `vyuha-${requestSeq}`;
    if (action === "subscribe") pendingRequests.set(requestId, refs.map((r) => r.id));
    send({
      action,
      // Unsubscribe reads a PER-SYMBOL mode first (R11 A12), so it rides on each.
      symbols: refs.map((r) =>
        action === "unsubscribe" ? { symbol: r.symbol, exchange: r.exchange, mode: STREAM_MODE } : { symbol: r.symbol, exchange: r.exchange },
      ),
      mode: STREAM_MODE,
      request_id: requestId,
    });
  }

  /** Forget everything that belonged to one connection (R9). */
  function resetConnectionState(): void {
    authed = false;
    authTimer = clearTimer(authTimer);
    pendingRequests.clear();
    acked.clear();
    refused.clear();
    baseline.clear();
  }

  /** Close OUR socket on purpose. Its later close event is ignored (it is no longer `socket`). */
  function closeSocket(reason: string): void {
    const s = socket;
    if (!s) return;
    socket = null;
    resetConnectionState();
    if (processSlot.__vyuhaOpenAlgoSocket?.socket === s) processSlot.__vyuhaOpenAlgoSocket = undefined;
    try {
      s.close(1000, reason.slice(0, 100));
    } catch {
      /* already closing */
    }
  }

  function scheduleReconnect(ms: number): void {
    reconnectTimer = clearTimer(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      ensure();
    }, ms);
  }

  /** A connection ended without us wanting it to: back off, or wait out the limit. */
  function connectEnded(why: string): void {
    resetConnectionState();
    if (framesThisConnect === 0) frameless += 1;
    framesThisConnect = 0;
    attempt += 1;
    if (heldCount() === 0) {
      // Closed inside the zero-key grace: nothing to stream, nothing to poll.
      graceTimer = clearTimer(graceTimer);
      setStatus("off", null);
      return;
    }
    if (frameless >= STREAM_FRAMELESS_CONNECT_LIMIT) {
      frameless = 0;
      lockoutUntil = now() + STREAM_LOCKOUT_MS;
      lockoutReason = `${why} ${STREAM_FRAMELESS_CONNECT_LIMIT} connections in a row brought no price, so streaming waits 15 minutes; prices come from polling meanwhile.`;
      setStatus("polling", lockoutReason);
      return;
    }
    const delay = STREAM_BACKOFF_MS[Math.min(attempt - 1, STREAM_BACKOFF_MS.length - 1)];
    nextAttemptAt = now() + delay;
    setStatus("polling", `${why} Reconnecting in ${Math.round(delay / 1000)} s; prices come from polling meanwhile.`);
    scheduleReconnect(delay);
  }

  function noStreamReason(host: string): string {
    let https = false;
    try {
      https = normalizeHost(host).startsWith("https:");
    } catch {
      https = false;
    }
    return https
      ? "Streaming needs OpenAlgo's direct ws:// port; this bridge address is https. Add its streaming address on the Import screen, or prices keep coming from polling."
      : "The saved OpenAlgo address cannot be turned into a streaming address; prices come from polling.";
  }

  /** Open a socket if every condition holds; otherwise say why we are polling. */
  function ensure(): void {
    if (disposed || superseded || socket) return;
    if (heldCount() === 0) return;
    const t = now();
    if (!target) {
      setStatus("polling", targetReason ?? "Waiting for the OpenAlgo connection to be read.");
      return;
    }
    if (!inWindow(new Date(t))) {
      setStatus("polling", OUTSIDE_WINDOW);
      return;
    }
    if (t < lockoutUntil) {
      setStatus("polling", lockoutReason);
      return;
    }
    if (t < nextAttemptAt) {
      if (!reconnectTimer) scheduleReconnect(nextAttemptAt - t);
      return;
    }
    open(target);
  }

  function open(t: StreamTarget): void {
    const streamUrl = openAlgoStreamUrl(t.host, t.wsUrl);
    if (!streamUrl) {
      setStatus("polling", noStreamReason(t.host));
      return;
    }
    if (!identity) identity = { apiKey: t.apiKey, url: streamUrl };

    // ONE socket per process (R8): close whatever another manager recorded.
    const predecessor = processSlot.__vyuhaOpenAlgoSocket;
    if (predecessor) {
      processSlot.__vyuhaOpenAlgoSocket = undefined;
      try {
        predecessor.supersede();
      } catch {
        /* the predecessor's own close must not stop ours */
      }
    }

    reconnectTimer = clearTimer(reconnectTimer);
    resetConnectionState();
    framesThisConnect = 0;
    socketUrl = streamUrl;
    // The ONE construction site, and its URL comes only from openAlgoStreamUrl()
    // above (review R6 b, pinned in tests/egress-guard.test.ts). The local
    // binding is the test seam; production passes no impl and gets Node's own.
    const WebSocket = webSocketImpl ?? (globalThis.WebSocket as unknown as StreamSocketCtor);
    let s: StreamSocket;
    try {
      s = new WebSocket(streamUrl);
    } catch (e) {
      connectEnded(`Cannot open OpenAlgo's stream at ${streamUrl} (${e instanceof Error ? e.message : "refused"}).`);
      return;
    }
    socket = s;
    processSlot.__vyuhaOpenAlgoSocket = { socket: s, supersede: () => supersededBy(s) };
    setStatus("connecting", `Connecting to OpenAlgo's stream at ${streamUrl}.`);
    let opened = false;

    authTimer = setTimeout(() => {
      authTimer = null;
      if (s !== socket || authed) return;
      closeSocket("auth timeout");
      connectEnded(`OpenAlgo's stream at ${streamUrl} did not confirm the API key within ${STREAM_AUTH_TIMEOUT_MS / 1000} s.`);
    }, STREAM_AUTH_TIMEOUT_MS);

    s.addEventListener("open", () => {
      if (s !== socket) return;
      opened = true;
      // The key goes ONCE per connection, in this message and no other (D3).
      send({ action: "authenticate", api_key: t.apiKey });
    });
    s.addEventListener("message", (ev) => {
      if (s !== socket) return;
      onMessage(ev.data);
    });
    s.addEventListener("close", (ev) => {
      if (s !== socket) return; // a close we asked for was handled where we asked
      socket = null;
      if (processSlot.__vyuhaOpenAlgoSocket?.socket === s) processSlot.__vyuhaOpenAlgoSocket = undefined;
      const code = typeof ev.code === "number" ? ev.code : null;
      const why = !opened
        ? `Cannot reach OpenAlgo's stream at ${streamUrl}.`
        : code === 4401
          ? `OpenAlgo closed the stream at ${streamUrl} (4401 auth timeout).`
          : `OpenAlgo's stream at ${streamUrl} closed${code != null ? ` (code ${code}${ev.reason ? `: ${ev.reason}` : ""})` : ""}.`;
      connectEnded(why);
    });
    // `error` is always followed by `close` (WHATWG), which does the work.
    s.addEventListener("error", () => {});
  }

  function supersededBy(s: StreamSocket): void {
    if (s !== socket) return;
    closeSocket("superseded");
    superseded = true;
    reconnectTimer = clearTimer(reconnectTimer);
    setStatus("polling", SUPERSEDED);
  }

  function refsOf(ids: Iterable<string>): StreamKeyRef[] {
    const out: StreamKeyRef[] = [];
    for (const id of ids) {
      const h = held.get(id);
      if (h) out.push(h.ref);
    }
    return out;
  }

  function onMessage(raw: unknown): void {
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(typeof raw === "string" ? raw : String(raw)) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return; // never throws on a frame
    }
    const type = typeof msg.type === "string" ? msg.type : null;

    if (type === "market_data") return onFrame(msg);

    if (type === "auth") {
      if (msg.status === "success") {
        authed = true;
        authTimer = clearTimer(authTimer);
        setStatus("connecting", `Authenticated with OpenAlgo at ${socketUrl}; waiting for the first streamed price.`);
        // The CURRENT held set, not a queue of what was asked meanwhile (R9).
        sendSubscription("subscribe", refsOf(held.keys()));
      } else {
        authFailed(typeof msg.message === "string" ? msg.message : "authentication failed");
      }
      return;
    }

    if (type === "subscribe") return onSubscribeAck(msg);

    // Error replies carry NO `type` (R11 A4).
    if (msg.status === "error" && type == null) {
      const message = typeof msg.message === "string" ? msg.message : String(msg.code ?? "error");
      const requestId = typeof msg.request_id === "string" ? msg.request_id : null;
      const ids = requestId ? pendingRequests.get(requestId) : undefined;
      if (ids) {
        pendingRequests.delete(requestId!);
        for (const id of ids) if (held.has(id)) refuse(id, message);
        return;
      }
      if (!authed || msg.code === "AUTHENTICATION_ERROR") authFailed(message);
    }
    // Anything else (unsubscribe acks, pongs, unknown types) changes nothing.
  }

  function authFailed(message: string): void {
    const url = socketUrl;
    closeSocket("authentication failed");
    framesThisConnect = 0;
    frameless = 0;
    lockoutUntil = now() + STREAM_LOCKOUT_MS;
    reconnectTimer = clearTimer(reconnectTimer);
    // OpenAlgo's own words, and the URL — never the key.
    lockoutReason = `OpenAlgo refused the API key on its stream at ${url}: ${message}. Prices come from polling; streaming retries in 15 minutes, or when the key is saved again.`;
    setStatus("polling", lockoutReason);
  }

  function refuse(id: string, message: string): void {
    refused.set(id, message);
    acked.delete(id);
  }

  function onSubscribeAck(msg: Record<string, unknown>): void {
    const requestId = typeof msg.request_id === "string" ? msg.request_id : null;
    const asked = requestId ? pendingRequests.get(requestId) : undefined;
    if (requestId) pendingRequests.delete(requestId);
    const entries = Array.isArray(msg.subscriptions) ? (msg.subscriptions as Record<string, unknown>[]) : [];
    const errors = new Map<string, string>();
    const oks = new Set<string>();
    for (const e of entries) {
      if (!e || typeof e !== "object") continue;
      const w = wireOf(String(e.exchange ?? ""), String(e.symbol ?? ""));
      if (e.status === "error") errors.set(w, typeof e.message === "string" ? e.message : "Subscription failed");
      else if (e.status === "success") oks.add(w);
    }
    // An OpenAlgo before 2.0.1.1 echoes no request_id: fall back to the entries.
    const ids = asked ?? entries.map((e) => byWire.get(wireOf(String(e?.exchange ?? ""), String(e?.symbol ?? "")))).filter((x): x is string => !!x);
    for (const id of ids) {
      const h = held.get(id);
      if (!h) continue; // applied only to keys still held (R9)
      const w = wireOf(h.ref.exchange, h.ref.symbol);
      if (errors.has(w)) refuse(id, errors.get(w)!);
      else if (msg.status === "success" || oks.has(w)) {
        acked.add(id);
        refused.delete(id);
        baseline.delete(id);
      }
    }
  }

  function onFrame(msg: Record<string, unknown>): void {
    const id = byWire.get(wireOf(String(msg.exchange ?? ""), String(msg.symbol ?? "")));
    if (!id) return; // a key no subscription holds any more (R9)
    const h = held.get(id)!;
    framesThisConnect += 1;
    if (framesThisConnect === 1) {
      // THE ONLY backoff reset (R3): a price arrived on this connection.
      attempt = 0;
      frameless = 0;
    }
    if (status.state !== "streaming") setStatus("streaming", `Streaming from ${socketUrl}.`);
    const at = now();
    const quote = quoteFromStreamFrame(h.ref.key, msg.data, at);
    if (!quote) return; // an ltp ≤ 0 frame does not make the key fresh (R4)
    lastQuoteAt.set(id, at);
    baseline.set(id, `${quote.ltp}|${quote.volume}`);
    opts.onQuote(id, quote);
  }

  function isQuiet(id: string): boolean {
    const at = lastQuoteAt.get(id);
    return at == null || now() - at >= STREAM_QUIET_MS;
  }

  return {
    hold(keys) {
      if (disposed) return () => {};
      graceTimer = clearTimer(graceTimer);
      const mine: string[] = [];
      const fresh: StreamKeyRef[] = [];
      for (const ref of keys) {
        if (mine.includes(ref.id)) continue;
        mine.push(ref.id);
        const h = held.get(ref.id);
        if (h) h.count += 1;
        else {
          held.set(ref.id, { ref, count: 1 });
          byWire.set(wireOf(ref.exchange, ref.symbol), ref.id);
          fresh.push(ref);
        }
      }
      if (socket && authed) sendSubscription("subscribe", fresh);
      else ensure();

      let released = false;
      return () => {
        if (released || disposed) return;
        released = true;
        const gone: StreamKeyRef[] = [];
        for (const id of mine) {
          const h = held.get(id);
          if (!h) continue;
          h.count -= 1;
          if (h.count > 0) continue;
          held.delete(id);
          byWire.delete(wireOf(h.ref.exchange, h.ref.symbol));
          acked.delete(id);
          refused.delete(id);
          lastQuoteAt.delete(id);
          baseline.delete(id);
          gone.push(h.ref);
        }
        if (socket && authed) sendSubscription("unsubscribe", gone);
        if (heldCount() > 0) return;
        reconnectTimer = clearTimer(reconnectTimer);
        if (!socket) {
          setStatus("off", null);
          return;
        }
        graceTimer = setTimeout(() => {
          graceTimer = null;
          if (heldCount() > 0) return;
          closeSocket("idle");
          setStatus("off", null);
        }, STREAM_CLOSE_GRACE_MS);
      };
    },

    setTarget(next, reason) {
      if (disposed) return;
      if (!next) {
        target = null;
        targetReason = reason ?? "The OpenAlgo feed is not ready.";
        closeSocket("gate closed");
        if (heldCount() > 0) setStatus("polling", targetReason);
        return;
      }
      const url = openAlgoStreamUrl(next.host, next.wsUrl);
      if (identity && (identity.apiKey !== next.apiKey || identity.url !== url)) {
        // R1 a: the connection behind the gate is not the one this socket
        // authenticated with. Close, and stay closed until it matches again.
        target = null;
        targetReason = "The OpenAlgo connection changed since the stream opened; the desk reconnects to stream with the new one.";
        closeSocket("connection changed");
        if (heldCount() > 0) setStatus("polling", targetReason);
        return;
      }
      target = next;
      targetReason = null;
      if (socket && !inWindow(new Date(now()))) {
        closeSocket("window closed");
        reconnectTimer = clearTimer(reconnectTimer);
        setStatus("polling", OUTSIDE_WINDOW);
        return;
      }
      ensure();
    },

    isQuiet,

    framedSince(id, sinceMs) {
      const at = lastQuoteAt.get(id);
      return at != null && at >= sinceMs;
    },

    observePoll(id, quote) {
      if (!socket || !authed || !acked.has(id) || refused.has(id) || !isQuiet(id)) return;
      const sig = `${quote.ltp}|${quote.volume}`;
      const prev = baseline.get(id);
      if (prev === undefined) {
        baseline.set(id, sig);
        return;
      }
      if (prev === sig) return;
      // EVIDENCE (R3): the instrument traded, the socket said nothing.
      const url = socketUrl;
      closeSocket("stalled");
      connectEnded(`OpenAlgo's stream at ${url} went silent while ${id} kept trading.`);
    },

    health() {
      return { ...status };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      reconnectTimer = clearTimer(reconnectTimer);
      graceTimer = clearTimer(graceTimer);
      closeSocket("disposed");
      held.clear();
      byWire.clear();
      lastQuoteAt.clear();
      setStatus("off", REPLACED);
    },
  };
}
