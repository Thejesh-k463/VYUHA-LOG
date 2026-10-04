import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeOpenAlgoStreamUrl, OPENALGO_WS_PORT, openAlgoStreamUrl } from "@/lib/import/api/openalgo";
import { createOpenAlgoProvider, type FeedGateState, type OpenAlgoHealth } from "@/lib/quotes/openalgo";
import {
  quoteFromStreamFrame,
  STREAM_AUTH_TIMEOUT_MS,
  STREAM_BACKOFF_MS,
  STREAM_CLOSE_GRACE_MS,
  STREAM_LOCKOUT_MS,
  STREAM_MODE,
  STREAM_QUIET_MS,
  type StreamSocketCtor,
} from "@/lib/quotes/openalgo-stream";
import type { Quote, QuoteKey, QuoteProvider } from "@/lib/quotes/types";

/**
 * The OpenAlgo WebSocket live feed, server half (v4.7.0 C7).
 *
 * Design `VYUHA/LIVE-DESK-RESEARCH/22-V460-BUILD/C7-DESIGN-2026-10-05.md`:
 * §1 D1–D8, AMENDED by review §5 (R1–R11) and the owner's answers §5b. Every
 * rule the stream module and the provider promise is driven here with a FAKE
 * socket class (the `webSocketImpl` test seam — the registry passes none, see
 * tests/egress-guard.test.ts) and a FAKE clock; the same module over a REAL
 * socket is `tests/openalgo-stream-wire.test.ts`.
 *
 * The last block runs the REAL SSE route (`app/api/live/stream/route.ts`) on
 * the real provider: `transport` per batch (R5), `health.stream` on the
 * snapshot frame, `onEnd` → the route closes (R2), and the route's own
 * unsubscribe at the live window's end (§5b Q4). Its collaborators that read
 * the database are mocked — the route's account scope is held by
 * tests/live-stream-route.test.ts, not here.
 */

/* ─────────────────────────── the route's collaborators ──────────────────── */

const routeStub = vi.hoisted(() => ({ provider: null as unknown, keys: [] as unknown[] }));
vi.mock("@/lib/quotes/registry", () => ({ getLiveFeedProvider: async () => routeStub.provider }));
vi.mock("@/lib/queries/accounts", () => ({ getSelectedAccountId: () => 1 }));
vi.mock("@/lib/queries/trades", () => ({ getTrackerTrades: () => [] }));
vi.mock("@/lib/live/position-keys", () => ({ positionKeys: () => routeStub.keys }));
vi.mock("@/lib/quotes/persist-mark", () => ({ catchUpDailyMark: async () => {} }));

/* ─────────────────────────────── the fake socket ────────────────────────── */

type Ev = { data?: unknown; code?: number; reason?: string };
type Msg = Record<string, unknown> & { action?: string; symbols?: { symbol: string; exchange: string; mode?: number }[] };

class FakeSocket {
  readyState = 0;
  readonly sent: Msg[] = [];
  closedByClient: { code?: number; reason?: string } | null = null;
  private readonly ls = new Map<string, ((ev: Ev) => void)[]>();
  constructor(readonly url: string) {}
  addEventListener(type: string, fn: (ev: Ev) => void) {
    this.ls.set(type, [...(this.ls.get(type) ?? []), fn]);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Msg);
  }
  close(code?: number, reason?: string) {
    this.closedByClient = { code, reason };
    this.readyState = 3;
  }
  private emit(type: string, ev: Ev = {}) {
    for (const fn of this.ls.get(type) ?? []) fn(ev);
  }
  /* the server's side */
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  reply(msg: unknown) {
    this.emit("message", { data: JSON.stringify(msg) });
  }
  authOk() {
    this.reply({ type: "auth", status: "success", message: "Authentication successful" });
  }
  subscribes(): Msg[] {
    return this.sent.filter((m) => m.action === "subscribe");
  }
  ackAll(errors: Record<string, string> = {}) {
    const m = this.subscribes().at(-1)!;
    const subs = (m.symbols ?? []).map((s) =>
      errors[s.symbol] ? { ...s, status: "error", message: errors[s.symbol] } : { ...s, status: "success", mode: "Quote" },
    );
    this.reply({ type: "subscribe", status: Object.keys(errors).length ? "partial" : "success", request_id: m.request_id, subscriptions: subs });
  }
  tick(symbol: string, data: Record<string, unknown>, exchange = "NSE") {
    this.reply({ type: "market_data", symbol, exchange, mode: 2, broker: "upstox", data });
  }
  /** The server (or the network) closed it. */
  drop(code = 1006, reason = "") {
    this.readyState = 3;
    this.emit("error");
    this.emit("close", { code, reason });
  }
  /** open → auth → ack, the happy path. */
  up() {
    this.open();
    this.authOk();
    this.ackAll();
  }
}

function fakeWs() {
  const sockets: FakeSocket[] = [];
  class Impl extends FakeSocket {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  }
  return { Impl: Impl as unknown as StreamSocketCtor, sockets, last: () => sockets[sockets.length - 1] };
}

/* ──────────────────────────────── the harness ───────────────────────────── */

const KEY = "k-123";
const READY: FeedGateState = { state: "ready", creds: { apiKey: KEY, host: "http://127.0.0.1:5000" } };
const DISABLED: FeedGateState = { state: "disabled", reason: "The OpenAlgo integration is off." };
const K = (symbol: string): QuoteKey => ({ symbol, exchange: "NSE" });
const RELIANCE = K("RELIANCE");
const TCS = K("TCS");
const ILLIQ = K("ILLIQ");
const BAD = K("BADSYM");
/** Friday 2026-09-04, 10:30 IST. */
const MARKET_HOURS = new Date("2026-09-04T05:00:00Z");

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

interface Harness {
  p: QuoteProvider;
  ws: ReturnType<typeof fakeWs>;
  gate: FeedGateState;
  window: { open: boolean };
  gateReads: number;
  /** Every /multiquotes request: the symbols it asked for. */
  polls: string[][];
  /** Every request of any kind. */
  requests: string[];
  /** REST answers by symbol (rupees). */
  rest: Record<string, Record<string, unknown>>;
  /** When set, a /multiquotes response waits until `releasePoll()`. */
  holdPolls: boolean;
  releasePoll: () => void;
}

function harness(opts: { refreshSeconds?: number } = {}): Harness {
  const ws = fakeWs();
  const h = {
    ws,
    gate: READY,
    window: { open: true },
    gateReads: 0,
    polls: [],
    requests: [],
    rest: {},
    holdPolls: false,
    releasePoll: () => {},
  } as unknown as Harness;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    h.requests.push(String(url));
    if (!String(url).endsWith("/multiquotes")) return jsonResponse({ status: "success", data: {} });
    const body = JSON.parse(String(init?.body)) as { symbols: { symbol: string }[] };
    h.polls.push(body.symbols.map((s) => s.symbol));
    if (h.holdPolls) await new Promise<void>((r) => (h.releasePoll = r));
    const results = body.symbols
      .filter((s) => h.rest[s.symbol])
      .map((s) => ({ symbol: s.symbol, exchange: "NSE", data: h.rest[s.symbol] }));
    return jsonResponse({ status: "success", results });
  }) as unknown as typeof fetch;
  h.p = createOpenAlgoProvider({
    readGate: async () => {
      h.gateReads += 1;
      return h.gate;
    },
    fetchImpl,
    refreshSeconds: opts.refreshSeconds ?? 1,
    webSocketImpl: ws.Impl,
    isLiveWindow: () => h.window.open,
  });
  return h;
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const streamOf = async (p: QuoteProvider) => ((await p.health()) as OpenAlgoHealth).stream;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(MARKET_HOURS);
});
afterEach(() => {
  vi.useRealTimers();
  routeStub.provider = null;
  routeStub.keys = [];
});

/* ═════════════════════════════ pure: frames → Quote ══════════════════════ */

describe("a market_data frame becomes a Quote (D4, D5, invariants 1 and 6)", () => {
  const AT = Date.parse("2026-09-04T05:00:00Z");

  it("converts rupees to integer paise ONCE, reads `close` as the PREVIOUS close, and labels it a tick", () => {
    const q = quoteFromStreamFrame(RELIANCE, { ltp: 1418.35, open: 1400.1, high: 1425, low: 1398.05, close: 1405.5, volume: 91234 }, AT)!;
    expect(q).toMatchObject({ ltp: 141835, dayOpen: 140010, dayHigh: 142500, dayLow: 139805, prevClose: 140550, volume: 91234 });
    expect(q.staleness).toBe("tick");
    expect(q.source).toBe("openalgo");
  });

  it("reads numeric strings too, and refuses a zero, negative, missing or non-numeric ltp", () => {
    expect(quoteFromStreamFrame(RELIANCE, { ltp: "101.25", volume: "7" }, AT)).toMatchObject({ ltp: 10125, volume: 7 });
    for (const ltp of [0, -3, null, undefined, "", "abc"]) expect(quoteFromStreamFrame(RELIANCE, { ltp }, AT)).toBeNull();
    expect(quoteFromStreamFrame(RELIANCE, null, AT)).toBeNull();
    expect(quoteFromStreamFrame(RELIANCE, { ltp: 10, open: "x" }, AT)!.dayOpen, "an unreadable field is absent, never 0").toBeNull();
  });

  it("asOf is a PLAUSIBLE epoch-ms data.timestamp, else the receipt time", () => {
    const ok = AT - 1500;
    expect(quoteFromStreamFrame(RELIANCE, { ltp: 1, timestamp: ok }, AT)!.asOf).toBe(new Date(ok).toISOString());
    const receipt = new Date(AT).toISOString();
    for (const ts of [AT / 1000 /* seconds */, AT + 6000 /* future */, AT - 90_000_000 /* > 24 h */, "soon", null]) {
      expect(quoteFromStreamFrame(RELIANCE, { ltp: 1, timestamp: ts }, AT)!.asOf, String(ts)).toBe(receipt);
    }
  });
});

/* ═════════════════════════ the address (D2', sequence 11) ═════════════════ */

describe("the streaming address — derived from the saved host, or the user's own (D2', sequence 11)", () => {
  it("defaults to the saved host's HOSTNAME on OpenAlgo's port — never its REST port", () => {
    expect(OPENALGO_WS_PORT).toBe(8765);
    expect(openAlgoStreamUrl("http://127.0.0.1:5000")).toBe("ws://127.0.0.1:8765");
    expect(openAlgoStreamUrl("127.0.0.1:5000")).toBe("ws://127.0.0.1:8765");
    expect(openAlgoStreamUrl("http://192.168.1.20:5000")).toBe("ws://192.168.1.20:8765");
    expect(openAlgoStreamUrl("http://[::1]:5000"), "an IPv6 literal keeps its brackets").toBe("ws://[::1]:8765");
  });

  it("an https bridge with no saved streaming address gets NO stream; a saved one wins", () => {
    expect(openAlgoStreamUrl("https://127.0.0.1")).toBeNull();
    expect(openAlgoStreamUrl("https://127.0.0.1", "wss://127.0.0.1/ws")).toBe("wss://127.0.0.1/ws");
    expect(openAlgoStreamUrl("http://127.0.0.1:5050", "ws://127.0.0.1:4051")).toBe("ws://127.0.0.1:4051");
    expect(openAlgoStreamUrl("http://127.0.0.1:5050", "ws://192.168.1.9:4051"), "a stored address on another machine").toBeNull();
    expect(openAlgoStreamUrl("")).toBeNull();
  });

  it("the save rule: ws:/wss: only, the bridge's own machine only, a missing scheme reads as ws://", () => {
    expect(normalizeOpenAlgoStreamUrl("ws://127.0.0.1:4051/", "http://127.0.0.1:5050")).toBe("ws://127.0.0.1:4051");
    expect(normalizeOpenAlgoStreamUrl("127.0.0.1:4052", "http://127.0.0.1:5051")).toBe("ws://127.0.0.1:4052");
    expect(normalizeOpenAlgoStreamUrl("WSS://LocalHost/ws?x=1", "http://localhost:5000")).toBe("wss://localhost/ws");
    expect(normalizeOpenAlgoStreamUrl("ws://[::1]:4051", "http://[::1]:5000")).toBe("ws://[::1]:4051");
    expect(() => normalizeOpenAlgoStreamUrl("ws://192.168.1.9:4051", "http://127.0.0.1:5000")).toThrow(
      /must be on the same machine as the bridge address/,
    );
    expect(() => normalizeOpenAlgoStreamUrl("http://127.0.0.1:4051", "http://127.0.0.1:5000")).toThrow(/ws:\/\/ or wss:\/\//);
    expect(() => normalizeOpenAlgoStreamUrl("ws://u:p@127.0.0.1:4051", "http://127.0.0.1:5000")).toThrow(/user name or password/);
    expect(() => normalizeOpenAlgoStreamUrl("   ", "http://127.0.0.1:5000")).toThrow(/empty/);
  });
});

/* ═══════════════════════════ lazy, one socket, the key once ═══════════════ */

describe("the socket opens lazily, once, and carries the key once (D1, D3, R9)", () => {
  it("snapshot() and health() never open a socket — only a held subscription does", async () => {
    const h = harness();
    h.rest.RELIANCE = { ltp: 100 };
    await h.p.snapshot([RELIANCE]);
    await h.p.health();
    await advance(10_000);
    expect(h.ws.sockets).toHaveLength(0);
    expect((await streamOf(h.p)).state).toBe("off");
  });

  it("authenticates first, then ONE subscribe for every held key in mode 2 with a request_id; the key in no other message", async () => {
    const h = harness();
    h.p.subscribe([RELIANCE, TCS], () => {});
    await flush();
    expect(h.ws.sockets).toHaveLength(1);
    const s = h.ws.last();
    expect(s.url).toBe("ws://127.0.0.1:8765");
    expect(s.sent, "nothing is sent before the socket opens").toEqual([]);
    s.open();
    expect(s.sent).toEqual([{ action: "authenticate", api_key: KEY }]);
    s.authOk();
    expect(s.subscribes()).toHaveLength(1);
    const sub = s.subscribes()[0];
    expect(sub.mode).toBe(STREAM_MODE);
    expect(typeof sub.request_id).toBe("string");
    expect(sub.symbols).toEqual([
      { symbol: "RELIANCE", exchange: "NSE" },
      { symbol: "TCS", exchange: "NSE" },
    ]);
    expect(JSON.stringify(s.sent.slice(1))).not.toContain(KEY);
  });

  it("a key released before auth is not sent; nothing held at auth → no subscribe at all (R9)", async () => {
    const h = harness();
    h.p.subscribe([RELIANCE, TCS], () => {});
    const stopB = h.p.subscribe([ILLIQ], () => {});
    await flush();
    const s = h.ws.last();
    s.open();
    stopB();
    s.authOk();
    expect(s.subscribes().map((m) => m.symbols!.map((x) => x.symbol))).toEqual([["RELIANCE", "TCS"]]);

    const h2 = harness();
    const stop = h2.p.subscribe([RELIANCE], () => {});
    await flush();
    const s2 = h2.ws.last();
    s2.open();
    stop();
    s2.authOk();
    expect(s2.subscribes(), "the desk left mid-auth").toEqual([]);
  });

  it("sequence 1 — a second tab on the same 12 keys: refcount 2, NO second subscribe, no second socket", async () => {
    const h = harness();
    const keys = Array.from({ length: 12 }, (_, i) => K(`S${i}`));
    const a: string[] = [];
    const b: string[] = [];
    h.p.subscribe(keys, (q) => a.push(q.key.symbol));
    await flush();
    const s = h.ws.last();
    s.up();
    const sentBefore = s.sent.length;
    h.p.subscribe(keys, (q) => b.push(q.key.symbol));
    await flush();
    expect(s.sent.length, "the second tab sent a message").toBe(sentBefore);
    expect(h.ws.sockets).toHaveLength(1);
    s.tick("S3", { ltp: 10 });
    expect(a).toEqual(["S3"]);
    expect(b).toEqual(["S3"]);
  });

  it("sequence 2 — tab A closes: nothing sent; tab B closes: ONE unsubscribe, then the socket closes after the 30 s grace", async () => {
    const h = harness();
    const stopA = h.p.subscribe([RELIANCE, TCS], () => {});
    const stopB = h.p.subscribe([RELIANCE, TCS], () => {});
    await flush();
    const s = h.ws.last();
    s.up();
    const n = s.sent.length;
    stopA();
    expect(s.sent.length).toBe(n);
    stopB();
    const unsub = s.sent.slice(n);
    expect(unsub).toHaveLength(1);
    expect(unsub[0].action).toBe("unsubscribe");
    expect(unsub[0].mode).toBe(STREAM_MODE);
    expect(typeof unsub[0].request_id).toBe("string");
    expect(unsub[0].symbols).toEqual([
      { symbol: "RELIANCE", exchange: "NSE", mode: STREAM_MODE },
      { symbol: "TCS", exchange: "NSE", mode: STREAM_MODE },
    ]);
    await advance(STREAM_CLOSE_GRACE_MS - 1);
    expect(s.closedByClient).toBeNull();
    await advance(1);
    expect(s.closedByClient).not.toBeNull();
    expect((await streamOf(h.p)).state).toBe("off");
  });

  it("sequence 2 — a reload inside the grace reuses the socket (no fresh authenticate)", async () => {
    const h = harness();
    const stop = h.p.subscribe([RELIANCE], () => {});
    await flush();
    const s = h.ws.last();
    s.up();
    stop();
    await advance(20_000);
    h.p.subscribe([RELIANCE], () => {});
    await flush();
    expect(h.ws.sockets).toHaveLength(1);
    expect(s.subscribes(), "the reload's keys go on the SAME socket").toHaveLength(2);
    expect(s.sent.filter((m) => m.action === "authenticate")).toHaveLength(1);
    await advance(STREAM_CLOSE_GRACE_MS * 2);
    expect(s.closedByClient).toBeNull();
  });

  it("two SSE streams with DIFFERENT key sets each receive only their own keys (§5, sequence 12 as it really occurs)", async () => {
    const h = harness();
    const a: string[] = [];
    const b: string[] = [];
    h.p.subscribe([RELIANCE], (q) => a.push(`${q.key.symbol}:${q.staleness}`));
    h.p.subscribe([TCS], (q) => b.push(`${q.key.symbol}:${q.staleness}`));
    await flush();
    const s = h.ws.last();
    s.up();
    expect(s.subscribes().at(-1)!.symbols!.map((x) => x.symbol).sort(), "one socket, the union").toEqual(["RELIANCE", "TCS"]);
    s.tick("RELIANCE", { ltp: 100 });
    s.tick("TCS", { ltp: 200 });
    expect(a).toEqual(["RELIANCE:tick"]);
    expect(b).toEqual(["TCS:tick"]);
  });
});

/* ═══════════════════════════════ frames and acks ══════════════════════════ */

describe("frames, acks and the quiet set (D3, D6, R4, R9)", () => {
  it("drops a frame for a key no subscription holds; an ltp ≤ 0 frame neither ticks nor makes the key fresh", async () => {
    const h = harness();
    const seen: string[] = [];
    h.p.subscribe([RELIANCE], (q) => seen.push(`${q.key.symbol}:${q.ltp}:${q.staleness}`));
    await flush();
    const s = h.ws.last();
    s.up();
    s.tick("INFY", { ltp: 1500 });
    s.tick("RELIANCE", { ltp: 0, volume: 5 });
    expect(seen).toEqual([]);
    expect((await streamOf(h.p)).state, "any market_data frame proves the feed alive").toBe("streaming");
    h.rest.RELIANCE = { ltp: 101 };
    await advance(1000);
    expect(h.polls, "the zero-ltp frame silenced the key's REST poll").toEqual([["RELIANCE"]]);
    expect(seen).toEqual(["RELIANCE:10100:delayed"]);
  });

  it("sequence 8 — an illiquid key is polled alone and labelled Delayed; the liquid one ticks; all fresh → NO request", async () => {
    const h = harness();
    const seen: string[] = [];
    h.p.subscribe([RELIANCE, ILLIQ], (q) => seen.push(`${q.key.symbol}:${q.staleness}`));
    await flush();
    const s = h.ws.last();
    s.up();
    s.tick("RELIANCE", { ltp: 100 });
    h.rest.ILLIQ = { ltp: 12.5 };
    await advance(1000);
    expect(h.polls).toEqual([["ILLIQ"]]);
    expect(seen).toEqual(["RELIANCE:tick", "ILLIQ:delayed"]);

    s.tick("ILLIQ", { ltp: 12.55 });
    const reads = h.gateReads;
    await advance(5000);
    expect(h.polls, "an empty /multiquotes went out while every key was fresh").toHaveLength(1);
    // R1 a: the gate is still re-read every period with nothing to poll.
    expect(h.gateReads - reads).toBe(5);
    // After STREAM_QUIET_MS of silence the key is polled again.
    await advance(STREAM_QUIET_MS);
    expect(h.polls.length).toBeGreaterThan(1);
  });

  it("R4 — a REST answer is DROPPED for a key whose frame arrived after that poll was sent", async () => {
    const h = harness();
    const seen: string[] = [];
    h.p.subscribe([RELIANCE], (q) => seen.push(`${q.ltp}:${q.staleness}`));
    await flush();
    const s = h.ws.last();
    s.up();
    h.rest.RELIANCE = { ltp: 100 };
    h.holdPolls = true;
    await advance(1000); // the poll is in flight
    expect(h.polls).toEqual([["RELIANCE"]]);
    s.tick("RELIANCE", { ltp: 101 });
    h.releasePoll();
    await flush();
    expect(seen, "an older REST price overwrote a newer streamed one").toEqual(["10100:tick"]);
  });

  it("ONE emit-on-change signature for both paths — a REST price equal to the last frame emits nothing", async () => {
    const h = harness();
    const seen: string[] = [];
    h.p.subscribe([RELIANCE], (q) => seen.push(`${q.ltp}:${q.staleness}`));
    await flush();
    const s = h.ws.last();
    s.up();
    s.tick("RELIANCE", { ltp: 100, high: 101, low: 99, volume: 10 });
    h.rest.RELIANCE = { ltp: 100, high: 101, low: 99, volume: 10 };
    await advance(STREAM_QUIET_MS + 1000);
    expect(h.polls.length).toBeGreaterThan(0);
    expect(seen).toEqual(["10000:tick"]);
  });

  it("an ack for keys released meanwhile is ignored, and their later frames are dropped (R9)", async () => {
    const h = harness();
    const seen: string[] = [];
    h.p.subscribe([TCS], (q) => seen.push(q.key.symbol));
    const stop = h.p.subscribe([RELIANCE], () => {});
    await flush();
    const s = h.ws.last();
    s.open();
    s.authOk();
    stop();
    expect(() => s.ackAll({ RELIANCE: "Symbol RELIANCE not found" })).not.toThrow();
    s.tick("RELIANCE", { ltp: 1 });
    s.tick("TCS", { ltp: 2 });
    expect(seen).toEqual(["TCS"]);
  });
});

/* ════════════════════════ the stall rule — evidence only (R3) ══════════════ */

describe("stall ONLY on evidence (R3) — and sequence 6", () => {
  it("silence is never a stall: a quiet key whose REST price does not move keeps the socket for minutes", async () => {
    const h = harness();
    h.p.subscribe([RELIANCE], () => {});
    await flush();
    const s = h.ws.last();
    s.up();
    s.tick("RELIANCE", { ltp: 100, volume: 10 });
    h.rest.RELIANCE = { ltp: 100, volume: 10 };
    await advance(5 * 60_000);
    expect(h.polls.length, "the quiet key was polled").toBeGreaterThan(200);
    expect(s.closedByClient).toBeNull();
    expect(h.ws.sockets).toHaveLength(1);
  });

  it("sequence 6 — frames stop, REST shows the scrip trading → close, reconnect, fresh auth, the held set resent, REST stops", async () => {
    const h = harness();
    h.p.subscribe([RELIANCE, TCS], () => {});
    await flush();
    const s = h.ws.last();
    s.up();
    s.tick("RELIANCE", { ltp: 100, volume: 10 });
    s.tick("TCS", { ltp: 300, volume: 5 });
    await advance(STREAM_QUIET_MS - 1000);
    expect(h.polls, "a key with a fresh frame was polled").toEqual([]);
    h.rest.RELIANCE = { ltp: 100, volume: 10 };
    h.rest.TCS = { ltp: 300, volume: 5 };
    await advance(2000);
    expect(s.closedByClient, "an unchanged REST price is not evidence").toBeNull();
    h.rest.RELIANCE = { ltp: 101, volume: 12 };
    await advance(1000);
    expect(s.closedByClient, "the scrip traded with no frame — that is the evidence").not.toBeNull();
    expect((await streamOf(h.p)).state).toBe("polling");

    await advance(STREAM_BACKOFF_MS[0]);
    expect(h.ws.sockets).toHaveLength(2);
    const s2 = h.ws.last();
    s2.open();
    expect(s2.sent[0]).toEqual({ action: "authenticate", api_key: KEY });
    s2.authOk();
    expect(s2.subscribes()[0].symbols!.map((x) => x.symbol)).toEqual(["RELIANCE", "TCS"]);
    s2.ackAll();
    s2.tick("RELIANCE", { ltp: 101, volume: 12 });
    s2.tick("TCS", { ltp: 300, volume: 5 });
    const polled = h.polls.length;
    await advance(10_000);
    expect(h.polls.length, "REST kept polling a streaming book").toBe(polled);
  });

  it("a REFUSED key (partial ack) is polled but is never stall evidence", async () => {
    const h = harness();
    h.p.subscribe([BAD], () => {});
    await flush();
    const s = h.ws.last();
    s.open();
    s.authOk();
    s.ackAll({ BADSYM: "Symbol BADSYM not found" });
    for (let i = 0; i < 5; i += 1) {
      h.rest.BADSYM = { ltp: 50 + i, volume: i };
      await advance(1000);
    }
    expect(h.polls).toHaveLength(5);
    expect(s.closedByClient, "a refused key's moving REST price closed the socket").toBeNull();
  });

  it("CONTROL — the same moving REST price on an ACKED key is evidence", async () => {
    const h = harness();
    h.p.subscribe([BAD], () => {});
    await flush();
    const s = h.ws.last();
    s.up();
    for (let i = 0; i < 3; i += 1) {
      h.rest.BADSYM = { ltp: 50 + i, volume: i };
      await advance(1000);
    }
    expect(s.closedByClient).not.toBeNull();
  });
});

/* ═════════════════════════════ backoff and lockouts ══════════════════════ */

describe("reconnects: 2 / 5 / 15 / 30 s then 60 s, reset only by a frame; five frameless connects or a bad key → 15 min (R3, D3)", () => {
  async function socketsAfter(h: Harness, ms: number) {
    await advance(ms);
    return h.ws.sockets.length;
  }

  it("2, 5, 15, 30, 60 s — then the frameless limit waits fifteen minutes", async () => {
    const h = harness();
    h.p.subscribe([RELIANCE], () => {});
    await flush();
    // One connection that DID stream, so the backoff runs past 30 s before the limit.
    h.ws.last().up();
    h.ws.last().tick("RELIANCE", { ltp: 1 });
    h.ws.last().drop();
    let n = 1;
    for (const delay of [2_000, 5_000, 15_000, 30_000, 60_000]) {
      expect(await socketsAfter(h, delay - 1), `before the ${delay} ms step`).toBe(n);
      expect(await socketsAfter(h, 1), `at the ${delay} ms step`).toBe(n + 1);
      n += 1;
      h.ws.last().drop(); // refused: no open, no frame
    }
    expect(STREAM_BACKOFF_MS).toEqual([2_000, 5_000, 15_000, 30_000, 60_000]);
    const h1 = await streamOf(h.p);
    expect(h1.state).toBe("polling");
    expect(h1.reason).toMatch(/15 minutes/);
    expect(await socketsAfter(h, STREAM_LOCKOUT_MS - 2000), "a reconnect inside the 15-minute wait").toBe(n);
    expect(await socketsAfter(h, 3000)).toBe(n + 1);
  });

  it("auth success does NOT reset the backoff; the first market_data frame does", async () => {
    const h = harness();
    h.p.subscribe([RELIANCE], () => {});
    await flush();
    const s1 = h.ws.last();
    s1.open();
    s1.authOk();
    s1.drop(1011, "BROKER_ERROR");
    expect(await socketsAfter(h, 2000)).toBe(2);
    const s2 = h.ws.last();
    s2.open();
    s2.authOk();
    s2.drop();
    expect(await socketsAfter(h, 4999), "auth reset the backoff to 2 s").toBe(2);
    expect(await socketsAfter(h, 1)).toBe(3);
    const s3 = h.ws.last();
    s3.up();
    s3.tick("RELIANCE", { ltp: 5 });
    s3.drop();
    expect(await socketsAfter(h, 2000), "the frame did not reset the backoff").toBe(4);
  });

  it("sequence 5 — AUTHENTICATION_ERROR: we close, say OpenAlgo's words and the URL (never the key), and wait 15 minutes", async () => {
    const h = harness();
    h.p.subscribe([RELIANCE], () => {});
    await flush();
    const s = h.ws.last();
    s.open();
    s.reply({ status: "error", code: "AUTHENTICATION_ERROR", message: "Invalid API key" });
    expect(s.closedByClient).not.toBeNull();
    const st = await streamOf(h.p);
    expect(st.state).toBe("polling");
    expect(st.reason).toContain("Invalid API key");
    expect(st.reason).toContain("ws://127.0.0.1:8765");
    expect(st.reason).not.toContain(KEY);
    expect(await socketsAfter(h, STREAM_LOCKOUT_MS - 1000), "an AUTHENTICATION_ERROR retried inside 15 minutes").toBe(1);
    expect(await socketsAfter(h, 2000)).toBe(2);
  });

  it("our own 10 s auth timer closes a socket that never confirms, and backs off", async () => {
    const h = harness();
    h.p.subscribe([RELIANCE], () => {});
    await flush();
    const s = h.ws.last();
    s.open();
    await advance(STREAM_AUTH_TIMEOUT_MS - 1);
    expect(s.closedByClient).toBeNull();
    await advance(1);
    expect(s.closedByClient).not.toBeNull();
    expect((await streamOf(h.p)).reason).toMatch(/did not confirm the API key/);
    expect(await socketsAfter(h, STREAM_BACKOFF_MS[0])).toBe(2);
  });
});

/* ═════════════════════════ the window, the gate, the address ═════════════ */

describe("never outside the live window; the gate is re-read every period (R3, R1 a)", () => {
  it("outside the window: no socket, today's REST poll for every key; the window opens → it streams; it closes → it stops", async () => {
    const h = harness();
    h.window.open = false;
    h.rest.RELIANCE = { ltp: 100 };
    h.p.subscribe([RELIANCE], () => {});
    await advance(3000);
    expect(h.ws.sockets).toHaveLength(0);
    expect(h.polls).toHaveLength(3);
    expect((await streamOf(h.p)).reason).toMatch(/Outside market hours/);

    h.window.open = true;
    await advance(1000);
    expect(h.ws.sockets).toHaveLength(1);
    h.ws.last().up();
    h.window.open = false;
    await advance(1000);
    expect(h.ws.last().closedByClient, "the socket outlived the window").not.toBeNull();
    await advance(10 * 60_000);
    expect(h.ws.sockets, "a reconnect outside the window").toHaveLength(1);
  });

  it("R1 a — consent revoked mid-stream: closed within one period, no reconnect, no request; restored → it reconnects", async () => {
    const h = harness();
    h.p.subscribe([RELIANCE], () => {});
    await flush();
    h.ws.last().up();
    h.ws.last().tick("RELIANCE", { ltp: 1 });
    h.gate = DISABLED;
    await advance(1000);
    expect(h.ws.last().closedByClient).not.toBeNull();
    const st = await streamOf(h.p);
    expect(st.state).toBe("polling");
    expect(st.reason).toBe(DISABLED.reason);
    const requests = h.requests.length;
    await advance(60_000);
    expect(h.ws.sockets).toHaveLength(1);
    expect(h.requests.length, "a request went out behind a closed gate").toBe(requests);

    h.gate = READY;
    await advance(1000);
    expect(h.ws.sockets).toHaveLength(2);
  });

  it("R1 a — a different (key, streaming address) than the socket authenticated with: closed, and no reconnect while it differs", async () => {
    for (const changed of [
      { apiKey: "k-999", host: "http://127.0.0.1:5000" },
      { apiKey: KEY, host: "http://127.0.0.1:5000", wsUrl: "ws://127.0.0.1:4051" },
    ]) {
      const h = harness();
      h.p.subscribe([RELIANCE], () => {});
      await flush();
      h.ws.last().up();
      h.gate = { state: "ready", creds: changed };
      await advance(1000);
      expect(h.ws.last().closedByClient).not.toBeNull();
      await advance(5 * 60_000);
      expect(h.ws.sockets, JSON.stringify(changed)).toHaveLength(1);
      expect((await streamOf(h.p)).reason).toMatch(/connection changed/);
      h.p.dispose!();
    }
  });

  it("D-C7-1 — the gate names ANOTHER connection (the selection moved, no registry call): every subscription ends once, nothing goes to the new host", async () => {
    const OTHER: FeedGateState = { state: "ready", creds: { apiKey: "k-acct2", host: "http://127.0.0.1:6000" } };
    const h = harness();
    const ends = [0, 0];
    h.p.subscribe([RELIANCE], () => {}, undefined, () => (ends[0] += 1));
    h.p.subscribe([TCS], () => {}, undefined, () => (ends[1] += 1));
    await flush();
    h.ws.last().up();
    h.gate = OTHER;
    await advance(1000);
    expect(ends, "each onEnd exactly once").toEqual([1, 1]);
    expect(h.ws.last().closedByClient).not.toBeNull();
    await advance(60_000);
    expect(ends).toEqual([1, 1]);
    expect(h.requests.filter((u) => u.startsWith("http://127.0.0.1:6000")), "a request went to the new connection").toEqual([]);
    expect(h.polls).toEqual([]);
    expect(h.ws.sockets, "a socket was opened on the new connection").toHaveLength(1);
    expect((await streamOf(h.p)).reason).toMatch(/connection changed/);
    // A late subscribe on the retired instance (a race with the registry) ends at once and asks nothing.
    let late = 0;
    h.p.subscribe([RELIANCE], () => {}, undefined, () => (late += 1));
    await advance(10_000);
    expect(late).toBe(1);
    expect(h.polls).toEqual([]);
    h.p.dispose!();
  });

  it("D-C7-1 — pinned even when NO socket ever opened (an https bridge polls only): a switch ends the subscription before any request", async () => {
    const h = harness();
    h.gate = { state: "ready", creds: { apiKey: KEY, host: "https://127.0.0.1:5000" } };
    let ends = 0;
    h.p.subscribe([RELIANCE], () => {}, undefined, () => (ends += 1));
    await advance(2000);
    expect(h.ws.sockets).toHaveLength(0);
    expect(h.polls.length, "the https bridge is polled (no stream)").toBeGreaterThan(0);
    const before = h.requests.length;
    h.gate = { state: "ready", creds: { apiKey: "k-acct2", host: "https://127.0.0.1:6000" } };
    await advance(60_000);
    expect(ends).toBe(1);
    expect(h.requests.slice(before), "a request after the switch").toEqual([]);
    expect(h.ws.sockets).toHaveLength(0);
    h.p.dispose!();
  });

  it("a saved streaming address is used as is; an https bridge without one never opens a socket (sequence 11)", async () => {
    const h = harness();
    h.gate = { state: "ready", creds: { apiKey: KEY, host: "http://127.0.0.1:5050", wsUrl: "ws://127.0.0.1:4051" } };
    h.p.subscribe([RELIANCE], () => {});
    await flush();
    expect(h.ws.last().url).toBe("ws://127.0.0.1:4051");

    const h2 = harness();
    h2.gate = { state: "ready", creds: { apiKey: KEY, host: "https://127.0.0.1" } };
    h2.p.subscribe([RELIANCE], () => {});
    await advance(3000);
    expect(h2.ws.sockets).toHaveLength(0);
    expect((await streamOf(h2.p)).reason).toMatch(/https/);
    expect(h2.polls, "no stream → today's poll").toHaveLength(3);
  });
});

/* ═════════════════════════════ dispose and the process ═══════════════════ */

describe("dispose (D8, R2) and ONE socket per process (R8)", () => {
  it("R2 — dispose while subscribed: socket closed, each onEnd EXACTLY once, then NO request of any kind", async () => {
    const h = harness();
    const ends = { a: 0, b: 0 };
    const stopA = h.p.subscribe([RELIANCE], () => {}, undefined, () => (ends.a += 1));
    h.p.subscribe([TCS], () => {}, undefined, () => (ends.b += 1));
    await flush();
    const s = h.ws.last();
    s.up();
    h.rest.RELIANCE = { ltp: 1 };
    await advance(3000);
    const requests = h.requests.length;
    const reads = h.gateReads;

    h.p.dispose!();
    expect(s.closedByClient).not.toBeNull();
    expect(ends).toEqual({ a: 1, b: 1 });
    expect(() => stopA()).not.toThrow();
    h.p.dispose!();
    expect(ends, "a second dispose ended them again").toEqual({ a: 1, b: 1 });

    await advance(10 * 60_000);
    expect(h.requests.length, "a disposed instance made a request").toBe(requests);
    expect(h.gateReads).toBe(reads);
    expect(h.ws.sockets).toHaveLength(1);
    await expect(h.p.snapshot([RELIANCE])).rejects.toThrow(/replaced/);
    expect(((await h.p.health()) as OpenAlgoHealth).stream.state).toBe("off");
    expect(h.requests.length).toBe(requests);

    // Handed the disposed instance by a race: ended at once, nothing opened.
    let late = 0;
    h.p.subscribe([RELIANCE], () => {}, undefined, () => (late += 1));
    await flush();
    expect(late).toBe(1);
    expect(h.ws.sockets).toHaveLength(1);
  });

  it("R8 — a second instance's socket closes the first's, which polls and never reconnects; the slot is on globalThis", async () => {
    const one = harness();
    one.p.subscribe([RELIANCE], () => {});
    await flush();
    const s1 = one.ws.last();
    s1.up();
    const two = harness();
    two.p.subscribe([RELIANCE], () => {});
    await flush();
    const s2 = two.ws.last();
    expect(s1.closedByClient, "two sockets in one process").not.toBeNull();
    const slot = () => (globalThis as { __vyuhaOpenAlgoSocket?: { socket: unknown } }).__vyuhaOpenAlgoSocket;
    expect(slot()?.socket).toBe(s2);
    expect((await streamOf(one.p)).reason).toMatch(/took over the stream/);
    await advance(10 * 60_000);
    expect(one.ws.sockets, "the superseded instance fought back").toHaveLength(1);
    two.p.dispose!();
    expect(slot()).toBeUndefined();
    one.p.dispose!();
  });

  it("health().stream: off → connecting → (auth) connecting → (first frame) streaming → polling, with `since` per change", async () => {
    const h = harness();
    expect(await streamOf(h.p)).toEqual({ state: "off", reason: null, since: null });
    h.p.subscribe([RELIANCE], () => {});
    await flush();
    const c = await streamOf(h.p);
    expect(c.state).toBe("connecting");
    expect(c.since).toBe(MARKET_HOURS.toISOString());
    const s = h.ws.last();
    s.open();
    s.authOk();
    s.ackAll();
    await advance(500);
    expect((await streamOf(h.p)).state, "streaming before any price arrived").toBe("connecting");
    s.tick("RELIANCE", { ltp: 1 });
    const st = await streamOf(h.p);
    expect(st.state).toBe("streaming");
    expect(st.reason).toBe("Streaming from ws://127.0.0.1:8765.");
    expect(st.since).toBe(new Date(MARKET_HOURS.getTime() + 500).toISOString());
    s.drop();
    expect((await streamOf(h.p)).state).toBe("polling");
  });

  it("the stream module writes nothing and reads no database", () => {
    const src = readFileSync(path.join(process.cwd(), "lib/quotes/openalgo-stream.ts"), "utf8");
    expect(src).not.toMatch(/@\/lib\/db|\.insert\(|\.update\(|writeFile|appendFile/);
  });
});

/* ═════════════════════════════════ the SSE route ═════════════════════════ */

/** Drain an SSE body in the background. */
function reading(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const state = { text: "", done: false };
  void (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        state.text += decoder.decode(chunk.value, { stream: true });
      }
    } catch {
      /* cancelled */
    }
    state.done = true;
  })();
  return state;
}
const frames = (text: string, event: string) =>
  [...text.matchAll(new RegExp(`event: ${event}\\ndata: (.*)\\n\\n`, "g"))].map((m) => JSON.parse(m[1]) as Record<string, unknown>);

async function openRoute() {
  const route = await import("@/app/api/live/stream/route");
  const res = await route.GET(new Request("http://127.0.0.1:3011/api/live/stream", { headers: { host: "127.0.0.1:3011" } }));
  return reading(res);
}

describe("the SSE route on the real provider (R5, R2, §5b Q4)", () => {
  it("the snapshot frame's health carries `stream`; each tick frame says which path priced its BATCH", async () => {
    const h = harness();
    routeStub.provider = h.p;
    routeStub.keys = [RELIANCE, ILLIQ];
    h.rest.RELIANCE = { ltp: 100 };
    h.rest.ILLIQ = { ltp: 10 };
    const sse = await openRoute();
    await flush();
    const snap = frames(sse.text, "snapshot")[0];
    expect((snap.health as OpenAlgoHealth).stream, "the snapshot frame lost health.stream").toBeDefined();
    // The route reads health() BEFORE it subscribes, so a fresh desk's
    // snapshot frame reports the stream as it was then: nobody had asked yet.
    expect((snap.health as OpenAlgoHealth).stream).toEqual({ state: "off", reason: null, since: null });
    expect(h.ws.sockets, "the subscription the route started opened the socket").toHaveLength(1);

    const s = h.ws.last();
    s.up();
    s.tick("RELIANCE", { ltp: 101 });
    await advance(250);
    expect(frames(sse.text, "tick").map((f) => f.transport)).toEqual(["stream"]);
    await advance(750); // the 1 s period: ILLIQ is quiet → REST
    await advance(250);
    const ticks = frames(sse.text, "tick");
    expect(ticks.map((f) => f.transport)).toEqual(["stream", "poll"]);
    expect((ticks[1].quotes as Quote[]).map((q) => q.key.symbol)).toEqual(["ILLIQ"]);
    h.p.dispose!();
  });

  it("R2 — the provider ending the subscription (dispose) closes the SSE stream", async () => {
    const h = harness();
    routeStub.provider = h.p;
    routeStub.keys = [RELIANCE];
    h.rest.RELIANCE = { ltp: 100 };
    const sse = await openRoute();
    await flush();
    expect(sse.done).toBe(false);
    h.p.dispose!();
    await flush();
    expect(sse.done, "the stream outlived its disposed instance").toBe(true);
  });

  it("§5b Q4 — the route unsubscribes itself at the live window's end; heartbeats only after it", async () => {
    vi.setSystemTime(new Date("2026-09-04T10:15:30Z")); // 15:45:30 IST, the window's last minute
    let push: ((q: Quote) => void) | null = null;
    const unsubscribe = vi.fn();
    const quote = (ltp: number): Quote => ({
      key: RELIANCE,
      ltp,
      prevClose: null,
      dayOpen: null,
      dayHigh: null,
      dayLow: null,
      volume: null,
      asOf: new Date().toISOString(),
      staleness: "tick",
      source: "openalgo",
    });
    routeStub.provider = {
      id: "openalgo",
      capabilities: { streaming: true },
      snapshot: async () => new Map(),
      health: async () => ({ ok: true }),
      subscribe: (_k: unknown, onTick: (q: Quote) => void) => {
        push = onTick;
        return unsubscribe;
      },
    };
    routeStub.keys = [RELIANCE];
    const sse = await openRoute();
    await flush();
    expect(push).not.toBeNull();
    push!(quote(100));
    await advance(250);
    expect(frames(sse.text, "tick")).toHaveLength(1);
    await advance(29_000);
    expect(unsubscribe).not.toHaveBeenCalled();
    push!(quote(101)); // inside the window, flushed at its end
    await advance(1000);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(frames(sse.text, "tick")).toHaveLength(2);
    push!(quote(102)); // after the end: never forwarded
    await advance(30_000);
    expect(frames(sse.text, "tick"), "a tick crossed the window's end").toHaveLength(2);
    expect(frames(sse.text, "heartbeat").length).toBeGreaterThan(0);
    expect(sse.done).toBe(false);
  });
});
