import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { istWallClockIso } from "@/lib/domain/trading-day";
import { istClock, liveWindowOn } from "@/lib/domain/market-calendar";
import { OPENALGO_DISCLOSURE_VERSION, OPENALGO_FEED_ITEMS } from "@/lib/domain/openalgo-disclosure";
import { OPENALGO_WS_PORT } from "@/lib/import/api/openalgo";
import { LIVE_STREAM_COPY } from "@/components/live/desk-copy";
import { LIVE_FEED_COPY, feedStreamLine, type FeedStreamHealth } from "@/components/settings/live-feed-card";
import { openAlgoSaveFields } from "@/components/import/broker-connect";
import { createStreamLink, LINK_IDLE, type LinkState, type StreamSource } from "@/lib/live/stream-link";
import { applyTicks, mergeTicks, type TickMap, type TickableRow } from "@/lib/live/apply-ticks";
import { STREAM_CLOSE_GRACE_MS, STREAM_QUIET_MS, type OpenAlgoStreamHealth } from "@/lib/quotes/openalgo-stream";
import { RATE_LIMIT_PER_SECOND, REFRESH_SECONDS_MAX, REFRESH_SECONDS_MIN } from "@/lib/quotes/openalgo";

/**
 * SEAM PASS — v4.7.0 wave C7 (the OpenAlgo WebSocket live feed). Both real halves of every
 * value that crosses the A (server) / B (UI + copy) boundary, run together over ONE migrated
 * temp database (tests/helpers/temp-db.ts; one per file). Nothing on either side is mocked:
 *  - the provider is the one the REAL registry builds for the REAL stream / feed routes — the
 *    registry passes no `webSocketImpl`, so the socket is `globalThis.WebSocket`, stubbed here
 *    by `FakeWS` (the TRANSPORT, scripted with R11's wire shapes; the real-socket half is
 *    tests/openalgo-stream-wire.test.ts against tests/helpers/fake-openalgo-ws.ts);
 *  - `fetch` is a dispatcher that answers the bridge's REST paths and throws on any other host;
 *  - the SSE bytes the real route writes are split into events (the browser's EventSource
 *    framing — neither builder's code) and handed to the REAL `createStreamLink()`;
 *  - connections are written by the REAL broker route, read back by the REAL gate reader;
 *    selection by the REAL accounts route; the slider / pick by the REAL feed route.
 * `next/cache` is stubbed (revalidatePath throws outside a Next request), as in the C6 seams.
 *
 * ┌───────────────────────────┬────────────────────────────────────────────┬──────────────────────────────────────────────┬────────────────────────┬──────────┐
 * │ crossing value            │ producer (builder) file:line               │ consumer (builder) file:line                 │ unit / type            │ case     │
 * ├───────────────────────────┼────────────────────────────────────────────┼──────────────────────────────────────────────┼────────────────────────┼──────────┤
 * │ Quote.staleness tick|del. │ A openalgo-stream.ts:187 / openalgo.ts:295 │ A route.ts:98-100 transportOf                │ string                 │ S1       │
 * │ tick frame `transport`    │ A app/api/live/stream/route.ts:243         │ B lib/live/stream-link.ts:240-256,415        │ "stream"|"poll", SSE   │ S1       │
 * │ LinkState.transport       │ B stream-link.ts:415-435                   │ B desk-copy.ts:286-289 via tracker:623       │ string|null            │ S1       │
 * │ health().stream           │ A lib/quotes/openalgo.ts:538-591           │ B app/api/live/feed/route.ts:281 → card      │ {state,reason,since}   │ S2       │
 * │ FeedStreamHealth type     │ A openalgo-stream.ts:80-84                 │ B live-feed-card.tsx:108-112,123,144         │ TS type (restated)     │ S2       │
 * │ save body wsUrl           │ B broker-connect.tsx:473-483,1163          │ A app/api/import/broker/route.ts:895-918     │ string|""|absent, JSON │ S3       │
 * │ vault authJson.wsUrl      │ A broker route.ts:918                      │ A openalgo.ts:205-217 readGateFromDb         │ ciphertext JSON        │ S3       │
 * │ GET openalgoWsUrl         │ A broker route.ts:564                      │ B broker-connect.tsx:1069-1072 prefill       │ string|null            │ S3       │
 * │ creds (apiKey,host,wsUrl) │ A openalgo.ts:217                          │ A openalgo-stream.ts:377,426 (socket url/key)│ one row's pair         │ S3, S6   │
 * │ onEnd (dispose)           │ A openalgo.ts:526-535 ← registry.ts:601-606│ A stream route.ts:232-237 shutdown           │ callback, at most once │ S4       │
 * │ peek instance             │ A registry.ts:633-642                      │ A lib/jobs/telegram-alerts.ts:152-170        │ QuoteProvider          │ S4       │
 * │ copy numbers              │ A STREAM_QUIET_MS / GRACE / WS_PORT / RATE │ B disclosure items 2,5; PRIVACY.md item 3;   │ s, port, req/s, IST    │ S5       │
 * │                           │ / REFRESH_MIN,MAX / liveWindowOn end       │ OPENALGO_SETUP_GUIDE.html                    │                        │          │
 * │ selected account          │ accounts route (select)                    │ A gate + registry key + route keys           │ invariant 8            │ S6       │
 * │ ltp (string rupees)       │ A openalgo-stream.ts:180 toPaise           │ B apply-ticks.ts:165-205 via stream-link     │ paise, integer         │ S7       │
 * └───────────────────────────┴────────────────────────────────────────────┴──────────────────────────────────────────────┴────────────────────────┴──────────┘
 *
 * BOUNDARIES WITH NO FULL CASE HERE (named, with why):
 *   - tracker-client.tsx:619-629's strip ternary: a client component whose link state lives in
 *     effects (no DOM under vitest). `stripText()` below restates ONLY its phase ternary; the
 *     C7 value (`link.transport` → `LIVE_STREAM_COPY.live`'s third argument) is the real one.
 *   - broker-connect.tsx's prefill (`setWsUrl` from the GET's `openalgoWsUrl`): React state; S3
 *     asserts the GET's value and the body `openAlgoSaveFields` builds from the box's two states.
 *   - The browser's EventSource reconnect after `onEnd` closes the SSE: S4 asserts the body ENDS
 *     (the route's half); the reconnect itself is stream-link's own unit (tests/live-stream-link).
 *   - A real `ws://` socket through the ROUTE: the transport is FakeWS here; the real Node
 *     WebSocket is exercised against the RFC 6455 stand-in in tests/openalgo-stream-wire.test.ts.
 *   - IST day boundary (18:30–24:00 UTC): nothing in C7 crosses a seam with a date; the stream
 *     opens only inside the live window (03:45–10:16 UTC), so no value is produced there.
 *
 * RECORDED SEAM DEFECTS — ALL THREE FIXED in the C7 fix wave and flipped to `it` (D-C7-1:
 * openalgo.ts pins its credential identity and retires its subscriptions on a change; D-C7-2:
 * the route's post-window heartbeats carry `streaming: false`, the link drops to `connected`;
 * D-C7-3, case in S3: the gates order updated_at by julianday() and the insert stamps ISO):
 *   D-C7-1 (S6, invariant 8) — after the selection switches 1 → 2 and BEFORE any caller re-keys
 *          the registry (another tab switched, or the RSC refresh has not landed), the OLD
 *          instance's pump re-reads the gate, gets account 2's creds, closes the socket (R1 a)
 *          and then POSTs account 1's symbols to account 2's host with account 2's key:
 *          lib/quotes/openalgo.ts:618-631 polls with the NEW gate after setTarget refused it.
 *          Right: when the gate's creds differ from the instance's first identity, the pump
 *          must not poll at all (or end its subscriptions — onEnd — itself).
 *   D-C7-2 (S5 window end, owner answer Q4) — after the route's window-end unsubscribe
 *          (route.ts:254-269) the strip keeps printing `Live · OpenAlgo stream · N s` all
 *          evening: every 25 s heartbeat keeps phase "live" and keeps the last transport
 *          (stream-link.ts:435), and the route sends nothing the link can tell apart.
 *          Right (§5b Q4): `Connected · openalgo · not streaming` once the window has closed.
 */

process.env.VYUHA_VAULT_PROVIDER = "machine";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

/* ─────────────────────────────── fixtures ─────────────────────────────── */

const TODAY = "2026-10-07"; // an ordinary verified Wednesday (the C5 seams' day)
const at = (hhmm: string) => new Date(istWallClockIso(TODAY, hhmm));
const NOW = at("10:42");
const ROOT = path.resolve(__dirname, "..");

const K1 = "oa-key-account-one-1111aaaa";
const K2 = "oa-key-account-two-2222bbbb";
const KU = "oa-key-upstox-inst-uuuu5050";
const KD = "oa-key-dhan-instnc-dddd5051";
const HOST1 = "http://127.0.0.1:5000";
const HOST2 = "http://127.0.0.1:6000";
const DEFAULT_WS = `ws://127.0.0.1:${OPENALGO_WS_PORT}`;

/* ─────────────────────────── the socket transport ─────────────────────────── */

type Msg = Record<string, unknown>;

/** `globalThis.WebSocket` for the provider the REAL registry builds. Scripted per test. */
class FakeWS {
  static all: FakeWS[] = [];
  readyState = 0;
  /** Every send ATTEMPT, open or not — a send after dispose must show up. */
  sent: Msg[] = [];
  closedByClient: { code?: number; reason?: string } | null = null;
  private ls = new Map<string, ((ev: Msg) => void)[]>();
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  addEventListener(type: string, l: (ev: Msg) => void) {
    this.ls.set(type, [...(this.ls.get(type) ?? []), l]);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Msg);
  }
  close(code?: number, reason?: string) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedByClient = { code, reason };
  }
  private emit(type: string, ev: Msg) {
    for (const l of this.ls.get(type) ?? []) l(ev);
  }
  serverOpen() {
    this.readyState = 1;
    this.emit("open", {});
  }
  serverSend(obj: unknown) {
    this.emit("message", { data: JSON.stringify(obj) });
  }
  serverClose(code = 1006) {
    this.readyState = 3;
    this.emit("close", { code, reason: "" });
  }
  frame(symbol: string, exchange: string, data: Msg) {
    this.serverSend({ type: "market_data", symbol, exchange, mode: 2, data });
  }
  get auth(): Msg | undefined {
    return this.sent.find((m) => m.action === "authenticate");
  }
  subscribedSymbols(): string[] {
    return this.sent
      .filter((m) => m.action === "subscribe")
      .flatMap((m) => (m.symbols as { symbol: string }[]).map((s) => s.symbol));
  }
}
const lastWs = () => FakeWS.all[FakeWS.all.length - 1];

/** OpenAlgo's handshake (R11 §1–2): open → authenticate → auth ok → subscribe → ack all. */
async function handshake(ws: FakeWS) {
  ws.serverOpen();
  ws.serverSend({ type: "auth", status: "success" });
  const sub = ws.sent.find((m) => m.action === "subscribe");
  if (sub) {
    ws.serverSend({
      type: "subscribe",
      status: "success",
      request_id: sub.request_id,
      subscriptions: (sub.symbols as Msg[]).map((s) => ({ ...s, status: "success" })),
    });
  }
  await settle();
}

/* ─────────────────────────────── the REST bridge ─────────────────────────────── */

const net = {
  calls: [] as { url: string; body: Msg | null }[],
  rest: new Map<string, Msg>(),
  /** When set, /multiquotes waits for it — to land a REST answer at a chosen instant. */
  hold: null as null | { promise: Promise<void>; release: () => void },
};
const reply = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function dispatcher() {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body ? (JSON.parse(String(init.body)) as Msg) : null;
    net.calls.push({ url, body });
    if (url.endsWith("/api/v1/funds")) return reply({ status: "success", data: { availablecash: "0.00" } });
    if (url.endsWith("/auth/app-info")) return reply({ status: "success", version: "2.0.3.0" });
    if (url.endsWith("/api/v1/multiquotes")) {
      if (net.hold) await net.hold.promise;
      const symbols = (body?.symbols ?? []) as { symbol: string; exchange: string }[];
      const results = symbols
        .filter((s) => net.rest.has(`${s.exchange}:${s.symbol}`))
        .map((s) => ({ symbol: s.symbol, exchange: s.exchange, data: net.rest.get(`${s.exchange}:${s.symbol}`) }));
      return reply({ status: "success", results });
    }
    throw new Error(`TEST GUARD: the C7 seam reached an unexpected host ${url}`);
  };
}
const multiquotes = () => net.calls.filter((c) => c.url.endsWith("/api/v1/multiquotes"));
const symbolsOf = (c: { body: Msg | null }) => ((c.body?.symbols ?? []) as { symbol: string }[]).map((s) => s.symbol);

function holdRest() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  net.hold = { promise, release };
  return () => {
    net.hold = null;
    release();
  };
}

/* ─────────────────────────────── harness ─────────────────────────────── */

let t: TempDb;
let streamRoute: typeof import("@/app/api/live/stream/route");
let feedRoute: typeof import("@/app/api/live/feed/route");
let brokerRoute: typeof import("@/app/api/import/broker/route");
let accountsRoute: typeof import("@/app/api/accounts/route");
let registry: typeof import("@/lib/quotes/registry");
let job: typeof import("@/lib/jobs/telegram-alerts");
let vault: typeof import("@/lib/vault");

function clock(d: Date) {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], now: d });
}

/** Microtasks + real macrotask turns (setImmediate is not faked), no fake time passes. */
async function settle(turns = 25) {
  for (let i = 0; i < turns; i++) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise((r) => setImmediate(r));
  }
}
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

const sameOrigin = { "sec-fetch-site": "same-origin" };

async function saveOa(body: Msg): Promise<{ status: number; json: Msg }> {
  const res = await brokerRoute.POST(
    new Request("http://localhost/api/import/broker", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "save", broker: "openalgo", ...body }),
    }),
  );
  return { status: res.status, json: (await res.json()) as Msg };
}

/** The connection GET's OpenAlgo rows, as the Import card receives them. */
async function oaConnections(): Promise<Msg[]> {
  const json = (await (await brokerRoute.GET()).json()) as { connections: Msg[] };
  return json.connections.filter((c) => String(c.broker).startsWith("openalgo"));
}

async function selectAccount(id: number) {
  const res = await accountsRoute.POST(
    new Request("http://localhost/api/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "select", id }),
    }),
  );
  expect(res.status).toBe(200);
}

async function feedGet(): Promise<{ feed: Msg; health: Msg }> {
  const res = await feedRoute.GET(new Request("http://localhost:3000/api/live/feed", { headers: sameOrigin }));
  return (await res.json()) as { feed: Msg; health: Msg };
}
async function feedPost(body: Msg) {
  const res = await feedRoute.POST(
    new Request("http://localhost:3000/api/live/feed", {
      method: "POST",
      headers: { ...sameOrigin, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status).toBe(200);
}

/** The card's stream line, from a real GET answer, exactly as live-feed-card.tsx:840 derives it. */
function cardStreamLine(g: { feed: Msg; health: Msg }): string | null {
  return feedStreamLine({
    pick: String(g.feed.stored),
    blocked: g.feed.stored !== g.feed.effective,
    health: g.health as { provider?: string; stream?: FeedStreamHealth | null },
    seconds: Number(g.feed.refreshSeconds),
  });
}

function openTrade(accountId: number, symbol: string, over: Msg = {}): number {
  return t.db
    .insert(t.schema.trades)
    .values(
      tradeRow({ symbol, tradingsymbol: symbol, buyQty: 10, avgBuyPrice: 1000, isOpen: true, accountId, ...over }) as typeof t.schema.trades.$inferInsert,
    )
    .returning({ id: t.schema.trades.id })
    .get().id;
}

/** The slice of EventSource stream-link uses, fed by the SSE bytes of the real route. */
class FakeSource implements StreamSource {
  readyState = 1;
  private ls = new Map<string, ((ev: Event) => void)[]>();
  addEventListener(type: string, l: (ev: Event) => void) {
    this.ls.set(type, [...(this.ls.get(type) ?? []), l]);
  }
  close() {
    this.readyState = 2;
  }
  dispatch(type: string, data: string) {
    for (const l of this.ls.get(type) ?? []) l({ data } as unknown as Event);
  }
}

interface Desk {
  ac: AbortController;
  events: { event: string; data: Msg }[];
  ticks: () => TickMap;
  state: () => LinkState;
  closed: () => boolean;
  destroy: () => void;
}

/** One Live Desk: the REAL route's SSE body → event framing → the REAL stream link. */
async function openDesk(): Promise<Desk> {
  const src = new FakeSource();
  const states: LinkState[] = [];
  let ticks: TickMap = new Map();
  let paint = 0;
  const link = createStreamLink<ReturnType<typeof setTimeout>>({
    createSource: () => src,
    isHidden: () => false,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id),
    schedulePaint: (fn) => {
      queueMicrotask(fn);
      return ++paint;
    },
    cancelPaint: () => {},
    random: () => 0,
    onState: (s) => states.push(s),
    onQuotes: (qs) => {
      ticks = mergeTicks(ticks, qs);
    },
  });
  link.open();

  const ac = new AbortController();
  const res = await streamRoute.GET(
    new Request("http://localhost:3000/api/live/stream", { headers: sameOrigin, signal: ac.signal }),
  );
  const events: { event: string; data: Msg }[] = [];
  let closed = false;
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        closed = true;
        return;
      }
      buf += dec.decode(value, { stream: true });
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data.push(line.slice(6));
        }
        if (data.length === 0) continue; // the `retry:` hint
        const text = data.join("\n");
        events.push({ event, data: JSON.parse(text) as Msg });
        src.dispatch(event, text);
      }
    }
  })().catch(() => {
    closed = true;
  });
  await settle();
  return {
    ac,
    events,
    ticks: () => ticks,
    state: () => states[states.length - 1] ?? LINK_IDLE,
    closed: () => closed,
    destroy: () => {
      link.destroy();
      ac.abort();
    },
  };
}
const ticksOf = (d: Desk) => d.events.filter((e) => e.event === "tick");
const lastTick = (d: Desk) => ticksOf(d)[ticksOf(d).length - 1]?.data;

/** tracker-client.tsx:619-629's phase ternary (a component), with the REAL C7 value passed through. */
function stripText(providerId: string, s: LinkState): string {
  const age = s.at === null ? null : Math.max(0, Math.round((Date.now() - s.at) / 1000));
  if (s.phase === "live" && age !== null) return LIVE_STREAM_COPY.live(providerId, age, s.transport);
  if (s.phase === "connected") return LIVE_STREAM_COPY.connected(providerId);
  return `<${s.phase}>`;
}

let desks: Desk[] = [];
async function desk(): Promise<Desk> {
  const d = await openDesk();
  desks.push(d);
  return d;
}

/* ─────────────────────────────── lifecycle ─────────────────────────────── */

beforeAll(async () => {
  t = await openTempDb("seams-v47-c7", { seed: true });
  streamRoute = await import("@/app/api/live/stream/route");
  feedRoute = await import("@/app/api/live/feed/route");
  brokerRoute = await import("@/app/api/import/broker/route");
  accountsRoute = await import("@/app/api/accounts/route");
  registry = await import("@/lib/quotes/registry");
  job = await import("@/lib/jobs/telegram-alerts");
  vault = await import("@/lib/vault");
  t.db.insert(t.schema.accounts).values({ id: 2, name: "Seam second book", isDefault: false }).run();
});
beforeAll(async () => {
  // Warm every lazy import path once, in a hook, so no `it` pays for a first import.
  clock(NOW);
  vi.stubGlobal("fetch", dispatcher());
  vi.stubGlobal("WebSocket", FakeWS);
  resetSettings();
  await saveOa({ accountId: 1, apiKey: K1, host: HOST1, underlyingBroker: "upstox" });
  openTrade(1, "INFY");
  const d = await openDesk();
  await feedGet();
  d.destroy();
  await settle();
  registry.resetLiveFeedProviderCache();
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  t?.cleanup();
});

function resetSettings() {
  t.sqlite
    .prepare(
      `UPDATE settings SET live_feed_provider = 'openalgo', openalgo_enabled = 1, openalgo_ack_version = ?,
       live_feed_refresh_seconds = 3, selected_account_id = 1, live_feed_ack_json = NULL, last_live_mark_date = NULL,
       telegram_enabled = 0, telegram_alerts_enabled = 0`,
    )
    .run(OPENALGO_DISCLOSURE_VERSION);
}

beforeEach(() => {
  clock(NOW);
  vi.stubGlobal("fetch", dispatcher());
  vi.stubGlobal("WebSocket", FakeWS);
  delete process.env.VYUHA_QUOTE_PROVIDER;
  for (const tbl of ["trades", "broker_connections", "telegram_alerts_sent", "daily_marks"]) {
    try {
      t.sqlite.prepare(`DELETE FROM ${tbl}`).run();
    } catch {
      /* a table this schema does not have */
    }
  }
  resetSettings();
  registry.resetLiveFeedProviderCache();
  delete (globalThis as { __vyuhaOpenAlgoSocket?: unknown }).__vyuhaOpenAlgoSocket;
  FakeWS.all = [];
  net.calls = [];
  net.rest = new Map([
    ["NSE:INFY", { ltp: 1500.5, open: 1490, high: 1510, low: 1488, prev_close: 1495, volume: 120000 }],
    ["NSE:TCS", { ltp: 3400, open: 3390, high: 3410, low: 3380, prev_close: 3395, volume: 50000 }],
    ["NSE:RELIANCE", { ltp: 2900, open: 2890, high: 2910, low: 2880, prev_close: 2895, volume: 80000 }],
  ]);
  net.hold = null;
  desks = [];
});
afterEach(async () => {
  for (const d of desks) d.destroy();
  await settle(5);
  registry.resetLiveFeedProviderCache();
  delete process.env.VYUHA_QUOTE_PROVIDER;
  vi.useRealTimers();
});

/* ═══════════ S1 — route `transport` → SSE → stream-link → strip text ═══════════ */

describe("S1 — which path priced the batch reaches the strip (route transportOf → LinkState.transport → LIVE_STREAM_COPY.live)", () => {
  it("a pushed frame priced the batch → tick transport 'stream' → `Live · OpenAlgo stream · 0 s`", async () => {
    await saveOa({ accountId: 1, apiKey: K1, host: HOST1, underlyingBroker: "upstox" });
    openTrade(1, "INFY");
    const d = await desk();
    expect(d.events[0]?.event).toBe("snapshot");
    const ws = lastWs();
    await handshake(ws);
    ws.frame("INFY", "NSE", { ltp: 1501.25, high: 1510, low: 1488, close: 1495, volume: 120100 });
    await advance(250);
    expect(lastTick(d)?.transport).toBe("stream");
    expect(d.state().transport).toBe("stream");
    expect(stripText("openalgo", d.state())).toBe("Live · OpenAlgo stream · 0 s");
  });

  it("only the REST fallback priced the batch → tick transport 'poll' → `Live · OpenAlgo poll · 0 s`", async () => {
    await saveOa({ accountId: 1, apiKey: K1, host: HOST1, underlyingBroker: "upstox" });
    openTrade(1, "INFY");
    const d = await desk();
    // The socket never opens: every key is quiet, so the slider-interval poll prices it.
    net.rest.set("NSE:INFY", { ltp: 1502, high: 1511, low: 1488, prev_close: 1495, volume: 121000 });
    await advance(3_000);
    await advance(250);
    const tick = lastTick(d);
    expect((tick?.quotes as Msg[]).map((q) => q.staleness)).toEqual(["delayed"]);
    expect(tick?.transport).toBe("poll");
    expect(stripText("openalgo", d.state())).toBe("Live · OpenAlgo poll · 0 s");
  });

  it("a MIXED batch (one pushed, one polled, same 250 ms flush) → 'stream'", async () => {
    await saveOa({ accountId: 1, apiKey: K1, host: HOST1, underlyingBroker: "upstox" });
    openTrade(1, "INFY");
    openTrade(1, "TCS");
    const d = await desk();
    const ws = lastWs();
    await handshake(ws);
    net.rest.set("NSE:TCS", { ltp: 3405, high: 3410, low: 3380, prev_close: 3395, volume: 50500 });
    const release = holdRest();
    await advance(3_000); // the pump asks /multiquotes for both quiet keys — held
    await advance(250); // a flush with nothing pending
    const before = ticksOf(d).length;
    ws.frame("INFY", "NSE", { ltp: 1503, high: 1510, low: 1488, close: 1495, volume: 120200 });
    release();
    await settle(); // TCS's REST answer lands (INFY's is dropped: its frame is newer, R4)
    await advance(250);
    expect(ticksOf(d).length).toBe(before + 1);
    const tick = lastTick(d)!;
    const byStaleness = Object.fromEntries((tick.quotes as Msg[]).map((q) => [(q.key as Msg).symbol, q.staleness]));
    expect(byStaleness).toEqual({ INFY: "tick", TCS: "delayed" });
    expect(tick.transport).toBe("stream");
    expect(stripText("openalgo", d.state())).toBe("Live · OpenAlgo stream · 0 s");
  });

  it("a MOCK provider tick prints the strip byte-identical to before C7 (`Live · mock · 0 s`)", async () => {
    process.env.VYUHA_QUOTE_PROVIDER = "mock";
    openTrade(1, "INFY");
    const d = await desk();
    await advance(1_000);
    await advance(250);
    expect(ticksOf(d).length).toBeGreaterThan(0);
    // Pre-C7 template, literally: `Live · ${provider} · ${seconds} s`.
    expect(stripText("mock", d.state())).toBe("Live · mock · 0 s");
  });
});

/* ═══════════ S2 — health().stream → feed GET → the card's line ═══════════ */

describe("S2 — the provider's stream health reaches Settings → Live feed (feed route passthrough → feedStreamLine)", () => {
  it("FeedStreamHealth (client restatement) and OpenAlgoStreamHealth are the same type, and the wire carries exactly its keys", async () => {
    type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
    const same: Same<FeedStreamHealth, OpenAlgoStreamHealth> = true;
    expect(same).toBe(true);
    await saveOa({ accountId: 1, apiKey: K1, host: HOST1, underlyingBroker: "upstox" });
    const g = await feedGet();
    expect(Object.keys(g.health.stream as Msg).sort()).toEqual(["reason", "since", "state"]);
  });

  it("off → `Stream starts when the Live Desk opens in market hours.`", async () => {
    await saveOa({ accountId: 1, apiKey: K1, host: HOST1, underlyingBroker: "upstox" });
    const g = await feedGet();
    expect((g.health.stream as Msg).state).toBe("off");
    expect(cardStreamLine(g)).toBe(LIVE_FEED_COPY.streamOff);
  });

  it("connecting → the provider's own sentence naming the URL", async () => {
    await saveOa({ accountId: 1, apiKey: K1, host: HOST1, underlyingBroker: "upstox" });
    openTrade(1, "INFY");
    await desk();
    const g = await feedGet(); // the SAME cached instance the desk's SSE holds
    expect((g.health.stream as Msg).state).toBe("connecting");
    expect(cardStreamLine(g)).toBe(`Connecting to OpenAlgo's stream at ${DEFAULT_WS}.`);
  });

  it("streaming → `Streaming from ws://127.0.0.1:8765.` only after the first frame since auth", async () => {
    await saveOa({ accountId: 1, apiKey: K1, host: HOST1, underlyingBroker: "upstox" });
    openTrade(1, "INFY");
    await desk();
    const ws = lastWs();
    await handshake(ws);
    expect(cardStreamLine(await feedGet())).toBe(`Authenticated with OpenAlgo at ${DEFAULT_WS}; waiting for the first streamed price.`);
    ws.frame("INFY", "NSE", { ltp: 1501, volume: 1 });
    await settle();
    const g = await feedGet();
    expect((g.health.stream as Msg).state).toBe("streaming");
    expect(cardStreamLine(g)).toBe(`Streaming from ${DEFAULT_WS}.`);
  });

  it("polling → `Polling every <the slider's s> s — <the provider's reason>`", async () => {
    await saveOa({ accountId: 1, apiKey: K1, host: HOST1, underlyingBroker: "upstox" });
    openTrade(1, "INFY");
    await desk();
    lastWs().serverClose(1006); // refused before open
    await settle();
    const g = await feedGet();
    expect((g.health.stream as Msg).state).toBe("polling");
    expect(cardStreamLine(g)).toBe(
      `Polling every 3 s — Cannot reach OpenAlgo's stream at ${DEFAULT_WS}. Reconnecting in 2 s; prices come from polling meanwhile.`,
    );
  });
});

/* ═══════════ S3 — save → vault → gate → the URL the socket is constructed with ═══════════ */

/** Open a desk, let the socket open, and read WHERE it went and WHICH key signed in. */
async function streamTarget(): Promise<{ url: string; key: unknown; restHost: string | undefined; restKey: unknown }> {
  net.calls = [];
  const d = await desk();
  const ws = lastWs();
  ws.serverOpen();
  await settle();
  const snap = multiquotes()[0];
  const out = { url: ws.url, key: ws.auth?.api_key, restHost: snap?.url.replace("/api/v1/multiquotes", ""), restKey: snap?.body?.apikey };
  d.destroy();
  await settle(5);
  return out;
}

describe("S3 — the streaming address: Import form body → broker route → vault → gate → socket URL", () => {
  const UP = { accountId: 1, apiKey: KU, host: "http://127.0.0.1:5050", underlyingBroker: "upstox" };

  it("set: the owner's Upstox instance (REST 5050 / WS 4051) streams from 4051 with ITS key", async () => {
    openTrade(1, "INFY");
    const r = await saveOa({ ...UP, ...openAlgoSaveFields({ host: UP.host, underlyingBroker: "upstox", wsUrl: "  ws://127.0.0.1:4051  " }) });
    expect(r.status).toBe(200);
    expect((await oaConnections())[0].openalgoWsUrl).toBe("ws://127.0.0.1:4051");
    expect(await streamTarget()).toEqual({ url: "ws://127.0.0.1:4051", key: KU, restHost: "http://127.0.0.1:5050", restKey: KU });
  });

  it("an untouched box (null → field OMITTED) keeps the stored address across a re-save; the key box left empty too", async () => {
    openTrade(1, "INFY");
    await saveOa({ ...UP, wsUrl: "ws://127.0.0.1:4051" });
    vi.setSystemTime(Date.now() + 1_000);
    const body = { accountId: 1, apiKey: "", ...openAlgoSaveFields({ host: UP.host, underlyingBroker: "upstox", wsUrl: null }) };
    expect((await saveOa(body)).status).toBe(200);
    expect((await oaConnections())[0].openalgoWsUrl).toBe("ws://127.0.0.1:4051");
    expect((await streamTarget()).url).toBe("ws://127.0.0.1:4051");
  });

  it('"" clears it → the default derived from the saved host: ws://127.0.0.1:OPENALGO_WS_PORT', async () => {
    openTrade(1, "INFY");
    await saveOa({ ...UP, wsUrl: "ws://127.0.0.1:4051" });
    vi.setSystemTime(Date.now() + 1_000);
    const r = await saveOa({ ...UP, ...openAlgoSaveFields({ host: UP.host, underlyingBroker: "upstox", wsUrl: "" }) });
    expect(r.status).toBe(200);
    expect((await oaConnections())[0].openalgoWsUrl).toBeNull();
    expect((await streamTarget()).url).toBe(DEFAULT_WS);
  });

  it("another machine → 400 with the plain reason; the stored address is untouched", async () => {
    await saveOa({ ...UP, wsUrl: "ws://127.0.0.1:4051" });
    const r = await saveOa({ ...UP, wsUrl: "ws://192.168.1.20:4051" });
    expect(r.status).toBe(400);
    expect(r.json.message).toBe("The streaming address must be on the same machine as the bridge address (127.0.0.1), not 192.168.1.20.");
    expect((await oaConnections())[0].openalgoWsUrl).toBe("ws://127.0.0.1:4051");
  });

  it("a host change that would orphan the stored address (field omitted) → 400; nothing is re-pointed", async () => {
    await saveOa({ ...UP, wsUrl: "ws://127.0.0.1:4051" });
    const r = await saveOa({ accountId: 1, apiKey: KU, host: "http://192.168.1.20:5050", underlyingBroker: "upstox" });
    expect(r.status).toBe(400);
    expect(String(r.json.message)).toMatch(/^The streaming address must be on the same machine as the bridge address \(192\.168\.1\.20\), not 127\.0\.0\.1\.$/);
    const [row] = await oaConnections();
    expect([row.openalgoHost, row.openalgoWsUrl]).toEqual(["http://127.0.0.1:5050", "ws://127.0.0.1:4051"]);
  });

  const UP_TUPLE = { url: "ws://127.0.0.1:4051", key: KU, restHost: "http://127.0.0.1:5050", restKey: KU };
  const DH_TUPLE = { url: "ws://127.0.0.1:4052", key: KD, restHost: "http://127.0.0.1:5051", restKey: KD };
  const DH = { accountId: 1, apiKey: KD, host: "http://127.0.0.1:5051", underlyingBroker: "dhan" };

  it("TWO OpenAlgo rows on one account (Upstox 5050/4051, Dhan 5051/4052): the socket URL, the authenticate key and the REST host/key are always ONE row's", async () => {
    openTrade(1, "INFY");
    expect((await saveOa({ ...UP, wsUrl: "ws://127.0.0.1:4051" })).status).toBe(200);
    expect((await saveOa({ ...DH, wsUrl: "ws://127.0.0.1:4052" })).status).toBe(200);
    // Each row's own address reads back on its own row.
    expect(Object.fromEntries((await oaConnections()).map((c) => [c.broker, c.openalgoWsUrl]))).toEqual({
      "openalgo:upstox": "ws://127.0.0.1:4051",
      "openalgo:dhan": "ws://127.0.0.1:4052",
    });
    // Re-save Dhan from the form (key box empty, streaming box untouched) → it is the most recent.
    vi.setSystemTime(Date.now() + 1_000);
    await saveOa({ ...DH, apiKey: "", ...openAlgoSaveFields({ host: DH.host, underlyingBroker: "dhan", wsUrl: null }) });
    expect(await streamTarget()).toEqual(DH_TUPLE);
    // Re-save Upstox the same way: the registry re-keys and the WHOLE pair moves with the row.
    vi.setSystemTime(Date.now() + 1_000);
    await saveOa({ ...UP, apiKey: "", ...openAlgoSaveFields({ host: UP.host, underlyingBroker: "upstox", wsUrl: null }) });
    expect(await streamTarget()).toEqual(UP_TUPLE);
  });

  it("D-C7-3 — 'the most recently updated' OpenAlgo row: a NEW instance saved after an earlier RE-SAVE of another must be the one the feed uses", async () => {
    // Same-day stamps from ONE clock: the fake Date is the real wall clock, so the broker route's
    // UPDATE stamp (JS ISO, `T`) and its INSERT stamp (SQLite datetime('now'), a space) share a date.
    vi.useRealTimers();
    const wall = Date.now();
    // A minute apart, on ONE UTC date (inside 61 s of UTC midnight the gap shrinks to stay there).
    const gap = Math.max(1_100, Math.min(60_000, (wall % 86_400_000) - 1_000));
    clock(new Date(wall - gap));
    openTrade(1, "INFY");
    await saveOa({ ...UP, wsUrl: "ws://127.0.0.1:4051" }); // insert
    await saveOa({ ...UP, apiKey: "" }); // a re-save a minute ago → update, ISO stamp
    vi.setSystemTime(wall);
    await saveOa({ ...DH, wsUrl: "ws://127.0.0.1:4052" }); // the Dhan instance added NOW → insert
    const stamps = Object.fromEntries((await oaConnections()).map((c) => [c.broker, c.updatedAt]));
    // The ROUTE's half: the REST snapshot the desk takes on connect (no live window needed).
    net.calls = [];
    const d = await desk();
    const snap = multiquotes()[0];
    d.destroy();
    expect(
      [snap?.url.replace("/api/v1/multiquotes", ""), snap?.body?.apikey],
      `gate ordered by desc(updated_at) over mixed stamps ${JSON.stringify(stamps)}`,
    ).toEqual([DH_TUPLE.restHost, KD]);
  });
});

/* ═══════════ S4 — dispose: registry replacement → onEnd → the route closes the SSE ═══════════ */

/** A streaming desk on account 1, then `replace()`; afterwards NOTHING may leave the old instance. */
async function replacedWhileStreaming(replace: () => Promise<void>) {
  await saveOa({ accountId: 1, apiKey: K1, host: HOST1, underlyingBroker: "upstox" });
  openTrade(1, "INFY");
  const d = await desk();
  const ws = lastWs();
  await handshake(ws);
  ws.frame("INFY", "NSE", { ltp: 1501, volume: 120001 });
  await advance(250);
  expect(d.closed()).toBe(false);
  await replace();
  await settle();
  const sentAtDispose = ws.sent.length;
  const fetchesAtDispose = net.calls.length;
  await advance(120_000); // pump periods, the quiet window, backoffs, the close grace
  return { d, ws, sentAfter: ws.sent.slice(sentAtDispose), fetchesAfter: net.calls.slice(fetchesAtDispose) };
}

describe("S4 — a replaced instance ends its subscriptions (onEnd → route shutdown) and makes no request of any kind", () => {
  it("account switch (real accounts route) + the desk's RSC refresh (getLiveFeedProvider) → SSE closed, socket closed, zero fetches / sends", async () => {
    await saveOa({ accountId: 2, apiKey: K2, host: HOST2, underlyingBroker: "dhan" });
    const r = await replacedWhileStreaming(async () => {
      await selectAccount(2);
      await registry.getLiveFeedProvider(); // what components/live/load-desk.ts:212 calls on router.refresh()
    });
    expect(r.d.closed(), "the route did not close the SSE on onEnd").toBe(true);
    expect(r.ws.closedByClient?.reason).toBe("disposed");
    expect(r.fetchesAfter).toEqual([]);
    expect(r.sentAfter).toEqual([]);
  });

  it("slider change (real feed route POST + the card's GET) → SSE closed, zero fetches / sends", async () => {
    const r = await replacedWhileStreaming(async () => {
      await feedPost({ action: "refresh-seconds", seconds: 5 });
      await feedGet();
    });
    expect(r.d.closed()).toBe(true);
    expect(r.ws.readyState).toBe(3);
    // The card's GET builds the NEW instance and probes it (/funds + app-info): those are the new
    // instance's. Nothing may come from the disposed one — no /multiquotes at all.
    expect(r.fetchesAfter.filter((c) => c.url.endsWith("/multiquotes"))).toEqual([]);
    expect(r.sentAfter).toEqual([]);
  });

  it("switch to end-of-day (non-memoised id, review R1 b) → SSE closed, zero fetches / sends", async () => {
    const r = await replacedWhileStreaming(async () => {
      await feedPost({ action: "provider", provider: "eod" });
      await feedGet();
    });
    expect(r.d.closed()).toBe(true);
    expect(r.ws.readyState).toBe(3);
    expect(r.fetchesAfter.filter((c) => c.url.startsWith(HOST1))).toEqual([]);
    expect(r.sentAfter).toEqual([]);
  });

  it("consent revoked with NO registry call → the old pump's gate re-read closes the socket within one period and asks nothing (R1 a)", async () => {
    const r = await replacedWhileStreaming(async () => {
      t.sqlite.prepare("UPDATE settings SET openalgo_enabled = 0").run();
      await advance(3_000);
    });
    expect(r.ws.closedByClient?.reason).toBe("gate closed");
    expect(r.fetchesAfter).toEqual([]);
    expect(r.sentAfter).toEqual([]);
  });

  it("the Telegram alert job (real, through peekLiveFeedProvider) gets a REST snapshot during and after a replacement and never opens a socket", async () => {
    const TOKEN = "123456:SEAM-C7";
    const { TELEGRAM_DISCLOSURE } = await import("@/lib/domain/telegram-disclosure");
    t.sqlite
      .prepare(
        `UPDATE settings SET telegram_enabled = 1, telegram_ack_version = ?, telegram_token_enc = ?, telegram_chat_id = '770011',
         telegram_alerts_enabled = 1, telegram_alert_from = NULL, telegram_alert_to = NULL, last_telegram_alert_summary_date = NULL`,
      )
      .run(TELEGRAM_DISCLOSURE.version, vault.encryptSecret(TOKEN));
    await saveOa({ accountId: 1, apiKey: K1, host: HOST1, underlyingBroker: "upstox" });
    openTrade(1, "INFY", { slPlanned: 1400 });
    const d = await desk();
    const ws = lastWs();
    await handshake(ws);
    ws.frame("INFY", "NSE", { ltp: 1501, volume: 120001 });
    await advance(250);
    const sockets = FakeWS.all.length;
    const sent = ws.sent.length;
    const sends: string[] = [];
    const deps = { isPro: () => true, send: async (_t: string, _c: string, html: string) => (sends.push(html), { ok: true as const }) };

    net.calls = [];
    const during = await job.runTelegramAlerts(new Date(), deps);
    expect(during.refused).toBeNull();
    expect(during.refused === null && during.checked).toBe(1);
    expect(multiquotes().map((c) => [c.url, c.body?.apikey, symbolsOf(c)])).toEqual([[`${HOST1}/api/v1/multiquotes`, K1, ["INFY"]]]);
    expect([FakeWS.all.length, ws.sent.length]).toEqual([sockets, sent]);

    await feedPost({ action: "refresh-seconds", seconds: 4 });
    await feedGet(); // replacement: the desk's instance is disposed, the slot holds a new one
    await settle();
    expect(d.closed()).toBe(true);
    net.calls = [];
    const after = await job.runTelegramAlerts(new Date(), deps);
    expect(after.refused).toBeNull();
    expect(multiquotes().map((c) => [c.url, c.body?.apikey, symbolsOf(c)])).toEqual([[`${HOST1}/api/v1/multiquotes`, K1, ["INFY"]]]);
    expect(FakeWS.all.length, "the alert job opened a socket").toBe(sockets);
  });
});

/* ═══════════ S5 — the copy's numbers ↔ the constants and the behaviour they describe ═══════════ */

const stripTags = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
const privacyItem3 = () => {
  const md = fs.readFileSync(path.join(ROOT, "docs/client/PRIVACY.md"), "utf8").replace(/\s+/g, " ");
  const from = md.indexOf("That same bridge can also price your open positions");
  const to = md.indexOf("Upstox can price the desk instead", from);
  expect(from, "PRIVACY.md item 3's OpenAlgo paragraph moved").toBeGreaterThan(0);
  return md.slice(from, to);
};
const guide = () => stripTags(fs.readFileSync(path.join(ROOT, "docs/client/OPENALGO_SETUP_GUIDE.html"), "utf8"));
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const one = (text: string, re: RegExp, what: string): string => {
  const m = text.match(re);
  expect(m, `${what} is not stated`).not.toBeNull();
  return m![1];
};

describe("S5 — every number the consent / PRIVACY / setup guide states is the code's constant, and the code does it", () => {
  const item2 = OPENALGO_FEED_ITEMS[1].body;
  const item5 = OPENALGO_FEED_ITEMS[4].body;
  const SURFACES: [string, () => string][] = [
    ["disclosure item 2+5", () => `${item2} ${item5}`],
    ["PRIVACY.md item 3", privacyItem3],
    ["OPENALGO_SETUP_GUIDE.html", guide],
  ];

  it.each(SURFACES)("%s — quiet window, close grace, port, 1–5 s clamp, window end", (_name, read) => {
    const text = read();
    expect(Number(one(text, /(?:streamed price|has not priced) for (\d+) seconds/, "the quiet rule"))).toBe(STREAM_QUIET_MS / 1000);
    expect(Number(one(text, /within (\d+) seconds of the desk closing/, "the close grace"))).toBe(STREAM_CLOSE_GRACE_MS / 1000);
    expect(Number(one(text, /streaming port (?:<b>)?(\d+)/, "the streaming port"))).toBe(OPENALGO_WS_PORT);
    const range = text.match(/\b(\d) to (\d) seconds|\((\d)–(\d) seconds\)/);
    expect(range, "the 1–5 s range is not stated").not.toBeNull();
    const [lo, hi] = range![1] ? [range![1], range![2]] : [range![3], range![4]];
    expect([Number(lo), Number(hi)]).toEqual([REFRESH_SECONDS_MIN, REFRESH_SECONDS_MAX]);
    const w = liveWindowOn(TODAY)!;
    const said = one(text, /about (\d\d:\d\d) IST/, "the window end");
    const [h, m] = said.split(":").map(Number);
    expect(Math.abs(h * 60 + m - w.endMin), `"about ${said} IST" vs the calendar's window end ${hhmm(w.endMin)}`).toBeLessThanOrEqual(1);
  });

  it(`the consent's request ceiling is RATE_LIMIT_PER_SECOND; the version is still "5" (D-6, amended never bumped)`, () => {
    expect(Number(one(item2, /more than (\d+) requests a second/, "the ceiling"))).toBe(RATE_LIMIT_PER_SECOND);
    expect(OPENALGO_DISCLOSURE_VERSION).toBe("5");
  });

  // The BEHAVIOUR cases are timed by the number the CONSENT states, not by the constant: a
  // constant that drifted from the copy must fail here as well as in the text cases above.
  const saidQuietMs = () => Number(one(item2, /no streamed price for (\d+) seconds/, "the quiet rule")) * 1000;
  const saidGraceMs = () => Number(one(item2, /within (\d+) seconds of the desk closing/, "the close grace")) * 1000;
  const saidMaxS = () => Number(one(item2, /outside \d to (\d) seconds/, "the range"));

  it("BEHAVIOUR — the stated quiet rule: a key with a streamed price is not polled until that many seconds have passed", async () => {
    await saveOa({ accountId: 1, apiKey: K1, host: HOST1, underlyingBroker: "upstox" });
    openTrade(1, "INFY");
    await desk();
    const ws = lastWs();
    await handshake(ws);
    ws.frame("INFY", "NSE", { ltp: 1501, volume: 120001 });
    await settle();
    net.calls = [];
    await advance(saidQuietMs() - 1_000); // pumps at 3 s keep running; the key is fresh
    expect(multiquotes()).toEqual([]);
    await advance(3_000);
    expect(multiquotes().map(symbolsOf)).toEqual([["INFY"]]);
  });

  it("BEHAVIOUR — the desk closes: unsubscribe at once, the socket closes the stated grace later, never earlier", async () => {
    await saveOa({ accountId: 1, apiKey: K1, host: HOST1, underlyingBroker: "upstox" });
    openTrade(1, "INFY");
    const d = await desk();
    const ws = lastWs();
    await handshake(ws);
    d.destroy(); // the desk unmounts → the EventSource closes → the request aborts
    await settle();
    expect(ws.sent[ws.sent.length - 1]?.action).toBe("unsubscribe");
    await advance(saidGraceMs() - 1_000);
    expect(ws.readyState).toBe(1);
    await advance(1_000);
    expect(ws.closedByClient?.reason).toBe("idle");
  });

  it("BEHAVIOUR — a hand-edited slider of 9 s is clamped to the stated maximum for the fallback poll", async () => {
    t.sqlite.prepare("UPDATE settings SET live_feed_refresh_seconds = 9").run();
    await saveOa({ accountId: 1, apiKey: K1, host: HOST1, underlyingBroker: "upstox" });
    openTrade(1, "INFY");
    await desk();
    net.calls = [];
    await advance(saidMaxS() * 1000 - 100);
    expect(multiquotes()).toEqual([]);
    await advance(100);
    expect(multiquotes().length).toBe(1);
  });

  /** A desk streaming just before the window's end. */
  async function streamingAtWindowEnd() {
    const w = liveWindowOn(TODAY)!;
    clock(at(hhmm(w.endMin - 1)));
    await saveOa({ accountId: 1, apiKey: K1, host: HOST1, underlyingBroker: "upstox" });
    openTrade(1, "INFY");
    // The bridge's REST answer for the quiet key equals the last frame (no trade since): the
    // fallback poll after STREAM_QUIET_MS is neither stall evidence (R3) nor a changed tick.
    net.rest.set("NSE:INFY", { ltp: 1501, high: 1510, low: 1488, prev_close: 1495, volume: 120001 });
    const d = await desk();
    const ws = lastWs();
    await handshake(ws);
    ws.frame("INFY", "NSE", { ltp: 1501, high: 1510, low: 1488, close: 1495, volume: 120001 });
    await advance(250);
    expect(stripText("openalgo", d.state())).toBe("Live · OpenAlgo stream · 0 s");
    const toEnd = (w.endMin + 1 - istClock(new Date()).minutes) * 60_000 - (Date.now() % 60_000);
    await advance(toEnd);
    return { d, ws };
  }

  it("BEHAVIOUR — at the end of the live window the route unsubscribes: stream AND poll stop, the socket closes after the grace", async () => {
    const { ws } = await streamingAtWindowEnd();
    // The stream module's own window check (R3) and the route's window-end unsubscribe (Q4) land
    // on the same instant; either way the socket is closed by the window, not left for the grace.
    expect(ws.closedByClient?.reason).toBe("window closed");
    net.calls = [];
    const sent = ws.sent.length;
    await advance(10 * 60_000);
    expect(multiquotes(), "the fallback poll outlived the live window").toEqual([]);
    expect(ws.sent.length).toBe(sent);
    expect(FakeWS.all.length, "a socket was re-opened after the window").toBe(1);
  });

  it("D-C7-2 — after the window-end unsubscribe the strip says `Connected · openalgo · not streaming` (owner answer Q4), not Live · stream", async () => {
    const { d } = await streamingAtWindowEnd();
    await advance(30_000); // at least one heartbeat after the unsubscribe
    expect(d.events[d.events.length - 1]?.event).toBe("heartbeat");
    expect(stripText("openalgo", d.state())).toBe(LIVE_STREAM_COPY.connected("openalgo"));
  });
});

/* ═══════════ S6 — invariant 8: one account's symbols never travel on another account's key/host ═══════════ */

describe("S6 — invariant 8 across a selection switch while a desk is open", () => {
  async function twoBooks() {
    await saveOa({ accountId: 1, apiKey: K1, host: HOST1, underlyingBroker: "upstox" });
    await saveOa({ accountId: 2, apiKey: K2, host: HOST2, underlyingBroker: "dhan" });
    openTrade(1, "INFY");
    openTrade(2, "RELIANCE");
    const d = await desk();
    const ws = lastWs();
    await handshake(ws);
    expect([ws.auth?.api_key, ws.subscribedSymbols()]).toEqual([K1, ["INFY"]]);
    net.calls = [];
    return { d, ws };
  }
  const leaked = () => multiquotes().filter((c) => c.body?.apikey === K2 && symbolsOf(c).includes("INFY"));

  it("switch + the desk's refresh (registry re-key) → the old SSE ends; account 2's desk streams ONLY account 2's symbols on account 2's key/host", async () => {
    const { d } = await twoBooks();
    await selectAccount(2);
    await registry.getLiveFeedProvider(); // load-desk.ts:212 on router.refresh()
    await settle();
    expect(d.closed()).toBe(true);
    await advance(60_000);
    expect(leaked()).toEqual([]);
    const d2 = await desk(); // the EventSource's reconnect
    const ws2 = lastWs();
    await handshake(ws2);
    expect([ws2.auth?.api_key, ws2.subscribedSymbols()]).toEqual([K2, ["RELIANCE"]]);
    expect(multiquotes().map((c) => [c.url.replace("/api/v1/multiquotes", ""), c.body?.apikey, symbolsOf(c)])).toEqual([[HOST2, K2, ["RELIANCE"]]]);
    expect(d2.closed()).toBe(false);
  });

  it("D-C7-1 — switch with NO registry call yet: the old instance's pump must not send account 1's symbols with account 2's key/host", async () => {
    await twoBooks();
    await selectAccount(2); // another tab, or before the RSC refresh lands
    await advance(6_000); // two fallback periods; INFY never framed, so it is quiet
    expect(leaked(), "account 1's INFY was POSTed to account 2's bridge with account 2's key").toEqual([]);
  });
});

/* ═══════════ S7 — invariant 1: a string-rupee ltp becomes paise ONCE, at the edge ═══════════ */

function row(side: "long" | "short"): TickableRow {
  return {
    symbol: "INFY",
    tradingsymbol: "INFY",
    exchange: "NSE",
    side,
    qty: 10,
    avgEntryP: 240_000,
    investedP: 2_400_000,
    markP: null,
    staleness: null,
    markAsOf: null,
    dayChangePpm: null,
    unrealisedP: null,
    unrealisedPctPpm: null,
    effectiveStopP: null,
    targetP: null,
    distanceToStopP: null,
    distanceToStopPpm: null,
    distanceToTargetP: null,
    distanceToTargetPpm: null,
    distanceToStopAtrX100: null,
    atrP3: null,
    riskAmountP: null,
    openRPpm: null,
  };
}

describe("S7 — invariant 1: `\"2510.55\"` on the wire is 251055 paise on the row, through the route, the SSE and apply-ticks", () => {
  it("a streamed frame (string ltp) → tick quote 251055 → row mark 251055; long and short P&L mirror", async () => {
    await saveOa({ accountId: 1, apiKey: K1, host: HOST1, underlyingBroker: "upstox" });
    openTrade(1, "INFY");
    const d = await desk();
    const ws = lastWs();
    await handshake(ws);
    ws.frame("INFY", "NSE", { ltp: "2510.55", close: "2490.00", volume: "120001" });
    await advance(250);
    const q = (lastTick(d)!.quotes as Msg[])[0];
    expect([q.ltp, q.prevClose, q.staleness]).toEqual([251055, 249000, "tick"]);
    const [long] = applyTicks([row("long")], d.ticks());
    const [short] = applyTicks([row("short")], d.ticks());
    expect([long.markP, long.unrealisedP, long.staleness]).toEqual([251055, 110_550, "tick"]);
    expect([short.markP, short.unrealisedP]).toEqual([251055, -110_550]);
  });

  it("the REST fallback (string ltp) lands on the SAME paise — one conversion rule for both paths", async () => {
    await saveOa({ accountId: 1, apiKey: K1, host: HOST1, underlyingBroker: "upstox" });
    openTrade(1, "INFY");
    const d = await desk();
    net.rest.set("NSE:INFY", { ltp: "2510.55", prev_close: "2490", volume: "120001" });
    await advance(3_000);
    await advance(250);
    const q = (lastTick(d)!.quotes as Msg[])[0];
    expect([q.ltp, q.staleness]).toEqual([251055, "delayed"]);
    const [long] = applyTicks([row("long")], d.ticks());
    expect([long.markP, long.unrealisedP, long.staleness]).toEqual([251055, 110_550, "delayed"]);
  });
});
