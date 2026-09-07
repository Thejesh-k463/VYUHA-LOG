import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { type TickQuote } from "@/lib/live/apply-ticks";
import {
  CLOSE_REOPEN_JITTER_MS,
  CLOSE_REOPEN_MINUTE,
  LIVE_GRACE_MS,
  RECONNECT_BASE_MS,
  SOURCE_CONNECTING,
  createStreamLink,
  msUntilCloseReopen,
  streamKeyOf,
  type LinkPhase,
  type LinkState,
  type StreamSource,
} from "@/lib/live/stream-link";
import { LIVE_STREAM_COPY } from "@/components/live/desk-copy";
import { OPENALGO_FEED_ITEMS } from "@/lib/domain/openalgo-disclosure";
import { HELP_ENTRIES } from "@/lib/domain/help-content";
import { exchangeHolidayName, isExchangeHoliday, toIst } from "@/lib/domain/trading-day";
import { quoteKeyId, type ProviderCapabilities, type Quote, type QuoteKey, type QuoteMap, type QuoteProvider } from "@/lib/quotes/types";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE v4.1.0 FIX-WAVE-2 SEAMS — the values handed between builder A (the desk
 * client + `lib/live/stream-link.ts`), builder B (the mark write + the stream
 * route) and builder C (the docs, the disclosure and the help copy), with BOTH
 * REAL HALVES running together.
 *
 * The three file sets are disjoint, which is what stops two builders clobbering
 * one file — and also what guarantees nobody ran the two halves together. v4.0
 * shipped seven money findings on the first audit pass and almost all of them
 * sat exactly here. Nothing below mocks either side of a seam: the only double
 * is the NETWORK (an OpenAlgo bridge that does not exist on this machine) and
 * the BROWSER TRANSPORT (`EventSource`, which the node suite has no DOM for) —
 * neither of which is a side of any seam in this wave. The bridge double
 * carries the SHIPPED `OPENALGO_CAPABILITIES` block, so `providerMayAutoMark()`
 * is asked the question production asks it.
 *
 * ── THE SEAM TABLE ─────────────────────────────────────────────────────────
 *  # | crossing value                  | producer (file:line)                   | consumer (file:line)                       | unit / type            | test
 * ---|---------------------------------|----------------------------------------|--------------------------------------------|------------------------|------
 *  1 | `msUntilCloseReopen()` instant  | lib/live/stream-link.ts:145 (A)        | app/api/live/stream/route.ts:202 (B)       | ms → IST minute        | S1a/S1b
 *  2 | `PersistMarkResult.code`        | lib/quotes/persist-mark.ts:261 (B)     | the connect door's second visit            | "already-marked" enum  | S1b
 *  3 | frame ORDER after a refusal     | app/api/live/stream/route.ts:237 (B)   | lib/live/stream-link.ts:288 onError (A)    | SSE event names        | S2a
 *  4 | `retry:` hint vs own backoff    | app/api/live/stream/route.ts:164 (B)   | lib/live/stream-link.ts:54 RECONNECT_BASE  | milliseconds, both     | S2b
 *  5 | flush timer after a refusal     | app/api/live/stream/route.ts:225 (B)   | the link's frame stream (A)                | interval count         | S2a
 *  6 | `snapshot.quotes[]` (JSON)      | app/api/live/stream/route.ts:205 (B)   | lib/live/stream-link.ts:263 onFrame (A)    | integer paise          | S3a
 *  7 | heartbeat-only ⇒ phase          | app/api/live/stream/route.ts:244 (B)   | lib/live/stream-link.ts:281 (A)            | LinkPhase union        | S3b
 *  8 | `snapshot.marketOpen`           | app/api/live/stream/route.ts:210 (B)   | NOBODY — see DEFECT D1                     | boolean                | S3c
 *  9 | `streamKeyOf()` identity        | lib/live/stream-link.ts:181 (A)        | app/api/live/stream/route.ts:106 keys (B)  | string, account-scoped | S4a/S4b
 * 10 | per (symbol, IST day) mark      | lib/quotes/persist-mark.ts:231 (B)     | docs/client/README.md:44 sentence (C)      | rows in `mtm_prices`   | S5a/S5b
 * 11 | weekend + HOLIDAY refusal (4.2) | lib/quotes/persist-mark.ts:136-146 (B) | disclosure item 6 / setup guide (C)        | refusal code, string   | S6a/S6b
 * 12 | every `health()` call site      | lib/quotes/openalgo.ts:431 (C's text)  | feed route / stream route / load-desk      | call count             | S7a
 * 13 | `egressDescription` location    | lib/quotes/openalgo.ts:92 (C)          | components/settings/settings-form.tsx:475  | section title, string  | S7b
 * 14 | one announcement per phase      | components/live/desk-copy.ts:139 (A)   | CHANGELOG fix-wave-2 bullet (C)            | string per LinkPhase   | S8a/S8b
 *
 * CLOCK. Every seam that carries a date runs on a pinned clock. The IST-day
 * seams run on a FRIDAY (2026-09-04) because `msUntilCloseReopen()` returns
 * null at the weekend, and the mark seam is also run at 18:30–24:00 UTC, where
 * the IST day is already tomorrow. `toFake: ["Date"]` only where the route is
 * driven on real timers: `loadLiveDesk()` and `persistDailyMarks()` reach the
 * database through REAL dynamic imports and a fully faked timer set stalls the
 * module loader (the reason `tests/live-page.test.ts` gives).
 * ═══════════════════════════════════════════════════════════════════════════
 */

let t: TempDb;
let live: typeof import("@/components/live/load-desk");
let streamRoute: typeof import("@/app/api/live/stream/route");
let feedRoute: typeof import("@/app/api/live/feed/route");
let persist: typeof import("@/lib/quotes/persist-mark");
let OPENALGO_CAPS: ProviderCapabilities;

/** The NETWORK, and only the network. */
const stub = vi.hoisted(() => ({ provider: null as QuoteProvider | null }));

vi.mock("@/lib/quotes/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/quotes/registry")>();
  return {
    ...actual,
    getLiveFeedProvider: async () => stub.provider ?? (await actual.getLiveFeedProvider()),
  };
});

/* ── the two books ────────────────────────────────────────────────────────── */

const SWING = 2;
const LONG_TERM = 3;
/** The aggregate VIEW (invariant 9). Never a write target. */
const ALL_ACCOUNTS = 0;

/** Friday 2026-09-04, 15:29 IST — one minute before the close, two before A fires. */
const FRI_1529 = new Date("2026-09-04T09:59:00.000Z");
/** Friday 2026-09-04, 10:30 IST — inside the 09:00–15:40 live window. */
const MARKET_HOURS = new Date("2026-09-04T05:00:00Z");
/** Friday 2026-09-04, 22:00 IST — outside it, and the IST day is already the 5th in UTC. */
const AFTER_HOURS = new Date("2026-09-04T16:30:00Z");
/** Saturday 2026-09-05, 16:00 IST. */
const SATURDAY = new Date("2026-09-05T10:30:00Z");
/**
 * FRIDAY 2026-10-02, 16:30 IST — Mahatma Gandhi Jayanti, on the bundled NSE
 * holiday list. A WEEKDAY the exchange is shut, which is the whole F1 case: a
 * weekend refusal never fires here, so before v4.2 the mark WAS written, from
 * the previous session's price, under this date. Since v4.2 it is refused.
 */
const HOLIDAY = new Date("2026-10-02T11:00:00Z");

const marks = () =>
  t.db
    .select()
    .from(t.schema.mtmPrices)
    .all()
    .map((m) => [m.symbol, m.price, m.asOfDate] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));

const stamp = () => t.db.select().from(t.schema.settings).limit(1).all()[0]?.lastLiveMarkDate ?? null;

function clearMarks() {
  t.db.update(t.schema.settings).set({ lastLiveMarkDate: null }).run();
  t.sqlite.prepare("DELETE FROM mtm_prices").run();
}

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

/** Date-only fake clock: the module loader still runs on real timers. */
function pinDate(when: Date) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(when);
}

/* ── the bridge double: SHIPPED capabilities, a scripted network ──────────── */

function quoteOf(symbol: string, ltp: number, asOf: string): Quote {
  return {
    key: { symbol, exchange: "NSE", tradingsymbol: symbol },
    ltp,
    prevClose: null,
    dayOpen: null,
    dayHigh: null,
    dayLow: null,
    volume: null,
    asOf,
    staleness: "delayed",
    source: "openalgo",
  };
}

interface Bridge extends QuoteProvider {
  /** Every key SET the bridge was asked to price, in request order. */
  asked: QuoteKey[][];
  healthCalls: number;
  /** The route's subscribe callback, once it has taken one. */
  push: ((q: Quote) => void) | null;
}

/**
 * A bridge that answers with `prices` (in PAISE, keyed by symbol) for whichever
 * keys it is handed, and records what it was asked for. `subscribeThrows`
 * reproduces the OpenAlgo refusal when the day's broker login has expired.
 */
function bridge(prices: Record<string, number>, opts: { subscribeThrows?: boolean } = {}): Bridge {
  const b: Bridge = {
    id: "openalgo",
    capabilities: OPENALGO_CAPS,
    asked: [],
    healthCalls: 0,
    push: null,
    async snapshot(keys: QuoteKey[]): Promise<QuoteMap> {
      b.asked.push(keys);
      const out: QuoteMap = new Map();
      for (const k of keys) {
        const ltp = prices[k.symbol];
        if (ltp === undefined) continue;
        out.set(quoteKeyId(k), quoteOf(k.symbol, ltp, "2026-09-04T10:00:00.000Z"));
      }
      return out;
    },
    subscribe(_keys, onQuote) {
      if (opts.subscribeThrows) throw new Error("The bridge is not logged in for today.");
      b.push = onQuote;
      return () => {
        b.push = null;
      };
    },
    async health() {
      b.healthCalls += 1;
      return { ok: true, state: "ok", latencyMs: 3 } as never;
    },
  };
  return b;
}

/* ── the SSE plumbing (copied from tests/live-stream-route.test.ts) ───────── */

function getStream(): Promise<Response> {
  return streamRoute.GET(
    new Request("http://127.0.0.1:3011/api/live/stream", { headers: { host: "127.0.0.1:3011" } }),
  );
}

interface Drain {
  text: string;
  done: boolean;
}

function reading(res: Response): Drain {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const state: Drain = { text: "", done: false };
  void (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        state.text += decoder.decode(chunk.value, { stream: true });
      }
    } catch {
      /* the stream was cancelled — expected */
    }
    state.done = true;
  })();
  return state;
}

/** One SSE frame, parsed back exactly as `EventSource` hands it to the client. */
function frames(text: string, event: string): unknown[] {
  return [...text.matchAll(new RegExp(`event: ${event}\\ndata: (.*)\\n\\n`, "g"))].map((m) => JSON.parse(m[1]) as unknown);
}

/** Wait on REAL timers for a frame to land (the clock may be faked; timers are not). */
async function waitForFrame(state: Drain, event: string, tries = 400): Promise<unknown> {
  for (let i = 0; i < tries; i++) {
    const got = frames(state.text, event);
    if (got.length > 0) return got[0];
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`no "${event}" frame arrived`);
}

/* ── the browser transport double (NOT a side of any seam) ────────────────── */

/**
 * The three members of `EventSource` `createStreamLink()` uses, and nothing
 * else. The suite runs in node with no DOM; this stands in for the BROWSER,
 * not for either half of a seam — the frames it carries are the real route's
 * own bytes, re-delivered exactly as `EventSource` delivers them.
 */
class FakeSource implements StreamSource {
  readyState = 1; // OPEN
  closed = 0;
  private readonly listeners = new Map<string, ((ev: Event) => void)[]>();

  addEventListener(type: string, listener: (ev: Event) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.readyState = 2; // CLOSED
    this.closed += 1;
  }

  /** A named frame carrying the route's own JSON string, byte for byte. */
  deliver(type: string, json: string): void {
    const ev = { data: json } as unknown as Event;
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }

  /** The spec's own connection-failure event: no `data` at all. */
  fail(): void {
    const ev = {} as Event;
    for (const fn of this.listeners.get("error") ?? []) fn(ev);
  }
}

/** A real `StreamLink` with every browser edge injected and recorded. */
function linkHarness(opts: { hidden?: boolean } = {}) {
  const sources: FakeSource[] = [];
  const states: LinkState[] = [];
  const batches: TickQuote[][] = [];
  const paints: (() => void)[] = [];
  const timers: number[] = [];
  let hidden = opts.hidden ?? false;

  const link = createStreamLink<ReturnType<typeof setTimeout>>({
    createSource: () => {
      const s = new FakeSource();
      sources.push(s);
      return s;
    },
    isHidden: () => hidden,
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      timers.push(ms);
      return setTimeout(fn, ms);
    },
    clearTimer: (id) => clearTimeout(id),
    schedulePaint: (fn) => {
      paints.push(fn);
      return paints.length;
    },
    cancelPaint: () => {},
    random: () => 0,
    onState: (s) => states.push(s),
    onQuotes: (q) => batches.push(q),
  });

  return {
    link,
    sources,
    states,
    batches,
    timers,
    paint: () => {
      for (const fn of paints.splice(0, paints.length)) fn();
    },
    phase: () => states.at(-1)?.phase ?? null,
    last: () => states.at(-1) ?? null,
    setHidden: (v: boolean) => {
      hidden = v;
    },
    /** The whole strip line the desk would print for the current phase. */
    strip: (providerId: string, ageS: number): string => {
      const s = states.at(-1);
      if (!s) return LIVE_STREAM_COPY.connecting;
      return s.phase === "live"
        ? LIVE_STREAM_COPY.live(providerId, ageS)
        : s.phase === "connected"
          ? LIVE_STREAM_COPY.connected(providerId)
          : s.phase === "reconnecting"
            ? LIVE_STREAM_COPY.reconnecting
            : s.phase === "paused"
              ? LIVE_STREAM_COPY.paused
              : s.phase === "stopped"
                ? LIVE_STREAM_COPY.stopped(s.reason ?? LIVE_STREAM_COPY.stoppedNoReason)
                : LIVE_STREAM_COPY.connecting;
    },
  };
}

/** Every frame the route wrote, as (event, json) pairs, in wire order. */
function wireFrames(text: string): { event: string; json: string }[] {
  return [...text.matchAll(/event: ([a-z]+)\ndata: (.*)\n\n/g)].map((m) => ({ event: m[1], json: m[2] }));
}

/** The route's own `retry:` hint, in ms, as the browser reads it. */
function retryHintMs(text: string): number {
  const m = text.match(/^retry: (\d+)\n\n/);
  if (!m) throw new Error("the route sent no retry: hint");
  return Number(m[1]);
}

/* ── docs ─────────────────────────────────────────────────────────────────── */

/** Line endings NORMALISED: this repo holds both, and a seam is not a CRLF. */
const read = (...p: string[]) =>
  fs.readFileSync(path.join(process.cwd(), ...p), "utf8").split("\r\n").join("\n");

function changelogWave2(): string {
  const all = read("CHANGELOG.md");
  const start = all.indexOf("- **Fix wave 2 —");
  expect(start, "the CHANGELOG has no fix-wave-2 bullet").toBeGreaterThan(-1);
  const next = all.indexOf("\n\n- **", start + 1);
  return all.slice(start, next === -1 ? undefined : next);
}

beforeAll(async () => {
  t = await openTempDb("seams-v41-fix2", { seed: true });
  live = await import("@/components/live/load-desk");
  streamRoute = await import("@/app/api/live/stream/route");
  feedRoute = await import("@/app/api/live/feed/route");
  persist = await import("@/lib/quotes/persist-mark");
  OPENALGO_CAPS = (await import("@/lib/quotes/openalgo")).OPENALGO_CAPABILITIES;

  // Warm the LAZY imports the mark path uses, so a fake-timer test never waits
  // on a module loader that fake timers cannot advance.
  await import("@/lib/queries/price-history");
  await import("@/lib/queries/trades");
  await import("@/lib/db/schema");
  await import("@/lib/audit");
  await import("drizzle-orm");

  t.db.update(t.schema.settings).set({ equityCapital: 1_000_000, selectedAccountId: SWING }).run();
  t.db.update(t.schema.riskConfig).set({ riskPctPpm: 2500 }).run();
  t.db.insert(t.schema.accounts).values([{ id: SWING, name: "Swing" }, { id: LONG_TERM, name: "Long term" }]).run();
  t.db
    .insert(t.schema.trades)
    .values([
      tradeRow({
        accountId: SWING,
        symbol: "TCS",
        tradingsymbol: "TCS",
        isOpen: true,
        buyQty: 10,
        avgBuyPrice: 3000,
        buyDate: "2026-08-06",
        slPlanned: 2800,
      }),
      tradeRow({
        accountId: SWING,
        symbol: "HDFCBANK",
        tradingsymbol: "HDFCBANK",
        isOpen: true,
        buyQty: 4,
        avgBuyPrice: 1600,
        buyDate: "2026-08-06",
      }),
      // A SHORT in the other book, with its stop ABOVE entry.
      tradeRow({
        accountId: LONG_TERM,
        symbol: "INFY",
        tradingsymbol: "INFY",
        isOpen: false,
        buyQty: 0,
        sellQty: 8,
        avgSellPrice: 1500,
        sellDate: "2026-08-06",
        slPlanned: 1600,
      }),
    ])
    .run();
  // `is_open` is the open predicate; the short leg above is set open directly so
  // the row carries a sell leg with no buy leg (lib/analytics/positions.ts:77).
  t.sqlite.prepare("UPDATE trades SET is_open = 1 WHERE symbol = 'INFY'").run();
  t.db
    .insert(t.schema.priceHistory)
    .values([
      { symbol: "TCS", date: "2026-09-03", close: 3010.25 },
      { symbol: "TCS", date: "2026-09-04", close: 3025.75 },
      { symbol: "HDFCBANK", date: "2026-09-04", close: 1590.5 },
      { symbol: "INFY", date: "2026-09-04", close: 1499.9 },
    ])
    .run();
});

afterAll(() => t?.cleanup());

afterEach(() => {
  vi.useRealTimers();
  stub.provider = null;
  delete process.env.VYUHA_QUOTE_PROVIDER;
});

/* ═══ SEAM 1 (A→B) · the 15:31 reconnect is only useful if the door writes ══ */

describe("SEAM 1 · A's close-of-session reconnect drives B's connect door", () => {
  it("S1a: the instant A schedules is an instant B will WRITE at, and one minute earlier is not", () => {
    const wait = msUntilCloseReopen(FRI_1529);
    expect(wait, "A must schedule a reconnect from 15:29 on a Friday").toBe(2 * 60_000);

    const reopenAt = new Date(FRI_1529.getTime() + wait!);
    const ist = toIst(reopenAt);
    expect(ist.getUTCHours() * 60 + ist.getUTCMinutes()).toBe(CLOSE_REOPEN_MINUTE);

    // THE CROSSING: A's minute against B's gate. 15:31 IST is past
    // MARK_AFTER_IST_MIN, so the door B opens at that instant writes.
    expect(persist.MARK_AFTER_IST_MIN).toBe(15 * 60 + 30);
    expect(CLOSE_REOPEN_MINUTE).toBeGreaterThan(persist.MARK_AFTER_IST_MIN);
    expect(persist.shouldPersistMark(reopenAt, null)).toEqual({
      ok: true,
      reason: "",
      date: "2026-09-04",
      code: null,
    });
    // …and the whole jitter window is still past it, so no desk in a household
    // fires into a refusal.
    expect(persist.shouldPersistMark(new Date(reopenAt.getTime() + CLOSE_REOPEN_JITTER_MS), null).ok).toBe(true);
    // One minute before A's instant, B refuses — which is what makes 15:31 the
    // value under test rather than an arbitrary constant.
    expect(persist.shouldPersistMark(new Date(reopenAt.getTime() - 2 * 60_000), null).code).toBe("before-close");
  });

  it("S1b: at that instant the real route writes ONE row per open cash symbol, and a second connect writes nothing", async () => {
    clearMarks();
    selectAccount(SWING);
    const reopenAt = new Date(FRI_1529.getTime() + msUntilCloseReopen(FRI_1529)!);
    pinDate(reopenAt);

    const first = bridge({ TCS: 312_000, HDFCBANK: 160_050 });
    stub.provider = first;
    const drain = reading(await getStream());
    await waitForFrame(drain, "snapshot");

    // RUPEES in `mtm_prices` — invariant 1's documented exception, converted
    // from the quote's paise exactly once, at the write edge.
    expect(marks()).toEqual([
      ["HDFCBANK", 1600.5, "2026-09-04"],
      ["TCS", 3120, "2026-09-04"],
    ]);
    expect(stamp(), "the banner value is the day just written").toBe("2026-09-04");

    // THE SECOND CONNECT — a reconnect, a second window, a reload. A different
    // price on the wire, so a rewrite would be visible.
    const second = bridge({ TCS: 999_900, HDFCBANK: 999_900 });
    stub.provider = second;
    const again = reading(await getStream());
    await waitForFrame(again, "snapshot");
    expect(second.asked.length, "the second connect really did ask the bridge").toBe(1);
    expect(marks(), "the second connect overwrote the day's mark").toEqual([
      ["HDFCBANK", 1600.5, "2026-09-04"],
      ["TCS", 3120, "2026-09-04"],
    ]);

    // B's NEW RESULT SHAPE, asked the same question the door asked: the refusal
    // is named, not just a sentence. Pre-wave this field did not exist.
    const result = await persist.persistDailyMarks([quoteOf("TCS", 999_900, "2026-09-04T10:01:00.000Z")], {
      now: reopenAt,
    });
    expect(result.written).toBe(false);
    expect(result.marked).toBe(0);
    expect(result.code).toBe("already-marked");
    expect(result.reason).toBe(persist.alreadyMarkedReason("2026-09-04"));
    expect(result.date).toBe("2026-09-04");
  });
});

/* ═══ SEAM 2 (B→A) · the refused subscribe, end to end ═════════════════════ */

describe("SEAM 2 · B's frame sequence after a refused subscribe, through A's phase machine", () => {
  it("S2a: error then heartbeat, no flush timer — and A ends STOPPED, never live", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_HOURS);
    selectAccount(SWING);
    const b = bridge({ TCS: 312_000, HDFCBANK: 160_050 }, { subscribeThrows: true });
    stub.provider = b;

    const drain = reading(await getStream());
    await vi.advanceTimersByTimeAsync(10);

    // B'S HALF. One `error` frame, and exactly ONE interval — the heartbeat.
    // Pre-wave the flush timer was started outside the try and woke 4× a second
    // for the life of a connection that could never have anything to flush.
    expect(frames(drain.text, "error")).toHaveLength(1);
    expect(vi.getTimerCount(), "a refused subscribe must not start the flush timer").toBe(1);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(frames(drain.text, "heartbeat")).toHaveLength(1);
    expect(drain.done, "the stream must not end into a reconnect loop").toBe(false);

    const wire = wireFrames(drain.text);
    expect(wire.map((f) => f.event)).toEqual(["snapshot", "error", "heartbeat"]);

    // A'S HALF, fed B's OWN BYTES in B's own order.
    const h = linkHarness();
    h.link.open();
    const src = h.sources[0];
    for (const f of wire) src.deliver(f.event, f.json);

    expect(h.phase(), "a heartbeat after a refusal must not read as connected").toBe("stopped");
    expect(h.last()!.reason).toBe("The bridge is not logged in for today.");
    // Two more heartbeats change nothing but the age — `stopped` is TERMINAL
    // for this connection, and only a NEW one clears it.
    src.deliver("heartbeat", wire[2].json);
    src.deliver("heartbeat", wire[2].json);
    expect(h.phase()).toBe("stopped");
    expect(h.strip("openalgo", 3)).toBe("Feed stopped — The bridge is not logged in for today.");
    expect(LIVE_STREAM_COPY.announce[h.phase() as LinkPhase]).toBe("Feed stopped.");
    h.link.destroy();
  });

  it("S2b: the route's `retry:` hint and A's own backoff are the same unit, and A defers while CONNECTING", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_HOURS);
    selectAccount(SWING);
    stub.provider = bridge({ TCS: 312_000, HDFCBANK: 160_050 }, { subscribeThrows: true });
    const drain = reading(await getStream());
    await vi.advanceTimersByTimeAsync(10);

    // MILLISECONDS ON BOTH SIDES. The route jitters 2000–3500 ms; A's first
    // backoff step is 2000 ms. If either were seconds the browser would retry
    // 1000× too fast or A would sleep for half an hour.
    const hint = retryHintMs(drain.text);
    expect(hint).toBeGreaterThanOrEqual(2_000);
    expect(hint).toBeLessThan(3_500);
    expect(RECONNECT_BASE_MS).toBe(2_000);
    expect(hint).toBeGreaterThanOrEqual(RECONNECT_BASE_MS);

    // A DEFERS TO THE HINT while the browser is still CONNECTING: no second
    // timer races it. The only timer armed on open is the close-of-session one.
    const h = linkHarness();
    h.link.open();
    const armed = [...h.timers];
    expect(armed, "open() arms exactly one timer — the 15:31 reconnect").toHaveLength(1);
    const src = h.sources[0];
    // A frame, then a gap wider than the heartbeat contract, then a failure the
    // browser is still retrying.
    src.deliver("snapshot", JSON.stringify({ quotes: [] }));
    vi.setSystemTime(new Date(MARKET_HOURS.getTime() + LIVE_GRACE_MS + 1_000));
    src.readyState = SOURCE_CONNECTING;
    src.fail();
    expect(h.phase()).toBe("reconnecting");
    expect(h.timers, "A must not race the route's own retry: hint").toEqual(armed);

    // A source the browser has GIVEN UP on is A's to retry, at its own base.
    src.readyState = 2; // CLOSED
    src.fail();
    expect(h.timers.slice(armed.length)).toEqual([RECONNECT_BASE_MS]);
    h.link.destroy();
  });
});

/* ═══ SEAM 3 (B→A) · what the strip is allowed to say ══════════════════════ */

describe("SEAM 3 · quotes make it live; a pipe with no quotes only makes it connected", () => {
  it("S3a: a real snapshot with quotes → phase live, in integer paise, and a tick keeps it there", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_HOURS);
    selectAccount(SWING);
    const b = bridge({ TCS: 312_000, HDFCBANK: 160_050 });
    stub.provider = b;

    const drain = reading(await getStream());
    await vi.advanceTimersByTimeAsync(10);
    // A real push through the route's own coalescing window.
    b.push!(quoteOf("TCS", 312_500, "2026-09-04T05:00:01.000Z"));
    await vi.advanceTimersByTimeAsync(300);

    const wire = wireFrames(drain.text);
    expect(wire.map((f) => f.event)).toEqual(["snapshot", "tick"]);

    const h = linkHarness();
    h.link.open();
    const src = h.sources[0];
    src.deliver("snapshot", wire[0].json);
    expect(h.phase()).toBe("live");
    h.paint();
    const snapQuotes = h.batches.flat();
    expect(snapQuotes.map((q) => q.key.symbol).sort()).toEqual(["HDFCBANK", "TCS"]);
    // PAISE, END TO END: 312_000, never 3120 and never 3120.00.
    expect(snapQuotes.find((q) => q.key.symbol === "TCS")!.ltp).toBe(312_000);
    for (const q of snapQuotes) expect(Number.isInteger(q.ltp)).toBe(true);

    src.deliver("tick", wire[1].json);
    h.paint();
    expect(h.phase()).toBe("live");
    expect(h.batches.at(-1)!.map((q) => q.ltp)).toEqual([312_500]);
    expect(h.strip("openalgo", 3)).toBe("Live · openalgo · 3 s");
    expect(LIVE_STREAM_COPY.announce.live).toBe("Feed connected.");
    h.link.destroy();
  });

  it("S3b: a pipe that carries no quote is CONNECTED, and stays connected through every heartbeat", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AFTER_HOURS); // 22:00 IST — the route never subscribes
    selectAccount(SWING);
    // A bridge with nothing to say: the broker session behind it has expired,
    // which is the ordinary evening state.
    const b = bridge({});
    stub.provider = b;

    const drain = reading(await getStream());
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(25_000);
    const wire = wireFrames(drain.text);
    expect(wire.map((f) => f.event)).toEqual(["snapshot", "heartbeat"]);
    expect(JSON.parse(wire[0].json).quotes).toEqual([]);
    expect(b.push, "outside 09:00–15:40 the route must never subscribe").toBe(null);

    const h = linkHarness();
    h.link.open();
    const src = h.sources[0];
    src.deliver("snapshot", wire[0].json);
    expect(h.phase()).toBe("connected");
    for (let i = 0; i < 5; i++) src.deliver("heartbeat", wire[1].json);
    expect(h.phase(), "a heartbeat is not a price").toBe("connected");

    // THE STRIP, and what it may claim. `connected` states the connection and
    // the absence; it carries no age, no price and no digit — a number here is
    // what made `Live · openalgo · 3 s` readable at 21:00.
    const line = h.strip("openalgo", 3);
    expect(line).toBe("Connected · openalgo · not streaming");
    expect(line).not.toMatch(/\d/);
    // The ANNOUNCEMENT carries even less: no provider, no number, no price word.
    const said = LIVE_STREAM_COPY.announce[h.phase() as LinkPhase];
    expect(said).toBe("Feed connected.");
    for (const v of Object.values(LIVE_STREAM_COPY.announce)) {
      expect(v).not.toMatch(/\d/);
      expect(v).not.toMatch(/price|rupee|₹|profit|loss|openalgo/i);
    }
    h.link.destroy();
  });

  /**
   * DEFECT D1 — found by this seam pass, fixed in the same wave: onFrame in
   * lib/live/stream-link.ts now reads the snapshot's `marketOpen`. As found: the route sends `marketOpen: false` beside a NON-EMPTY
   * `quotes[]` outside 09:00–15:40 (it snapshots unconditionally,
   * app/api/live/stream/route.ts:176-213), and `onFrame` in
   * lib/live/stream-link.ts:280 promotes any quote-bearing frame to `live`
   * without ever reading `marketOpen`. So a desk left open at 22:00 with a
   * bridge that still answers prints `Live · openalgo · N s` with no
   * subscription behind it — the exact sentence `LIVE_STREAM_COPY.connected`
   * was added to prevent, reached through the snapshot instead of through the
   * heartbeat. Red with the `marketShut` branch of onFrame reverted.
   */
  it("S3c: a snapshot outside the live window does not promote the strip to Live (D1, fixed in this wave)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AFTER_HOURS); // 22:00 IST
    selectAccount(SWING);
    const b = bridge({ TCS: 312_000, HDFCBANK: 160_050 });
    stub.provider = b;

    const drain = reading(await getStream());
    await vi.advanceTimersByTimeAsync(10);
    const wire = wireFrames(drain.text);
    const snap = JSON.parse(wire[0].json) as { marketOpen: boolean; quotes: unknown[] };

    // The wire is honest: the route SAYS the market is shut and still ships the
    // bridge's last prints, and it never subscribed.
    expect(snap.marketOpen).toBe(false);
    expect(snap.quotes.length).toBe(2);
    expect(b.push).toBe(null);

    const h = linkHarness();
    h.link.open();
    h.sources[0].deliver("snapshot", wire[0].json);

    // WHAT SHOULD HAPPEN (and does not): no subscription is running, so the
    // desk knows a price but not that prices are ARRIVING.
    expect(h.phase()).toBe("connected");
    expect(h.strip("openalgo", 3)).toBe("Connected · openalgo · not streaming");
    h.link.destroy();
  });
});

/* ═══ SEAM 4 (A→B) · the stream key and the route's key set ════════════════ */

describe("SEAM 4 · A's streamKeyOf and B's account-scoped key set move together", () => {
  it("S4a: an account switch changes A's key AND the symbols B asks the bridge for", async () => {
    pinDate(MARKET_HOURS);

    selectAccount(SWING);
    const swingDesk = await live.loadLiveDesk({ pro: true });
    const swingKey = streamKeyOf(swingDesk.selectedAccountId, swingDesk.rows);

    selectAccount(LONG_TERM);
    const longDesk = await live.loadLiveDesk({ pro: true });
    const longKey = streamKeyOf(longDesk.selectedAccountId, longDesk.rows);

    expect(swingDesk.rows.map((r) => r.symbol).sort()).toEqual(["HDFCBANK", "TCS"]);
    expect(longDesk.rows.map((r) => r.symbol)).toEqual(["INFY"]);
    expect(swingKey).not.toBe(longKey);

    // B'S HALF, with the NEW selection: the route resolves its own key set per
    // request, and the book the user left must not be in it.
    const b = bridge({ TCS: 312_000, HDFCBANK: 160_050, INFY: 147_100 });
    stub.provider = b;
    const drain = reading(await getStream());
    await waitForFrame(drain, "snapshot");

    const asked = b.asked[0].map((k) => k.symbol).sort();
    expect(asked).toEqual(["INFY"]);
    expect(asked, "the old account's symbol reached the new account's stream").not.toContain("TCS");
    // …and A's key for the account now selected names exactly those symbols.
    expect(longKey).toBe(`${LONG_TERM}|${LONG_TERM}:NSE:INFY`);
    expect(swingKey).toBe(`${SWING}|${SWING}:NSE:HDFCBANK,${SWING}:NSE:TCS`);
    selectAccount(SWING);
  });

  it("S4b: on the AGGREGATE view the id never changes, so the key set is the only thing that can notice", async () => {
    pinDate(MARKET_HOURS);
    selectAccount(ALL_ACCOUNTS);
    const before = await live.loadLiveDesk({ pro: true });
    const beforeKey = streamKeyOf(before.selectedAccountId, before.rows);
    expect(before.selectedAccountId).toBe(ALL_ACCOUNTS);
    expect(before.rows.map((r) => r.symbol).sort()).toEqual(["HDFCBANK", "INFY", "TCS"]);

    try {
      t.db
        .insert(t.schema.trades)
        .values([
          tradeRow({
            accountId: LONG_TERM,
            symbol: "ITC",
            tradingsymbol: "ITC",
            isOpen: true,
            buyQty: 50,
            avgBuyPrice: 440,
            buyDate: "2026-08-06",
          }),
        ])
        .run();

      const after = await live.loadLiveDesk({ pro: true });
      const afterKey = streamKeyOf(after.selectedAccountId, after.rows);
      expect(after.selectedAccountId, "0 stays a view — the id cannot notice").toBe(ALL_ACCOUNTS);
      expect(afterKey, "the desk would hold a stream that never prices the new position").not.toBe(beforeKey);
      expect(afterKey).toContain(`${LONG_TERM}:NSE:ITC`);

      // B agrees: the route's own key set gained the same symbol.
      const b = bridge({ TCS: 312_000, HDFCBANK: 160_050, INFY: 147_100, ITC: 44_000 });
      stub.provider = b;
      const drain = reading(await getStream());
      await waitForFrame(drain, "snapshot");
      expect(b.asked[0].map((k) => k.symbol).sort()).toEqual(["HDFCBANK", "INFY", "ITC", "TCS"]);
    } finally {
      t.sqlite.prepare("DELETE FROM trades WHERE symbol = 'ITC'").run();
      selectAccount(SWING);
    }
  });
});

/* ═══ SEAM 5 (B→C) · one mark per symbol per IST day, per account ══════════ */

describe("SEAM 5 · two accounts, one day — the behaviour C's sentence is pinned to", () => {
  it("S5a: the door writes for BOTH books on the same day, and the global stamp is not the gate", async () => {
    clearMarks();
    const reopenAt = new Date(FRI_1529.getTime() + msUntilCloseReopen(FRI_1529)!);
    pinDate(reopenAt);

    selectAccount(SWING);
    stub.provider = bridge({ TCS: 312_000, HDFCBANK: 160_050, INFY: 147_100 });
    const first = reading(await getStream());
    await waitForFrame(first, "snapshot");
    expect(marks().map((m) => m[0])).toEqual(["HDFCBANK", "TCS"]);

    // THE ACCOUNT SWITCH, and the door again. Under the global stamp the second
    // book was told "Today's mark is already saved" and carried no mark at all.
    selectAccount(LONG_TERM);
    stub.provider = bridge({ TCS: 312_000, HDFCBANK: 160_050, INFY: 147_100 });
    const second = reading(await getStream());
    await waitForFrame(second, "snapshot");
    expect(marks(), "the second account's open positions got no mark for the day").toEqual([
      ["HDFCBANK", 1600.5, "2026-09-04"],
      ["INFY", 1471, "2026-09-04"],
      ["TCS", 3120, "2026-09-04"],
    ]);
    expect(stamp(), "the banner value is the newest day written").toBe("2026-09-04");

    // BLANK THE STAMP — a restored backup, a second machine. The row is the
    // rule, so the first book is still refused and its price is not rewritten.
    t.db.update(t.schema.settings).set({ lastLiveMarkDate: null }).run();
    selectAccount(SWING);
    const refused = await persist.persistDailyMarks(
      [quoteOf("TCS", 999_900, "2026-09-04T10:01:00.000Z"), quoteOf("HDFCBANK", 999_900, "2026-09-04T10:01:00.000Z")],
      { now: reopenAt },
    );
    expect(refused.code).toBe("already-marked");
    expect(refused.written).toBe(false);
    expect(marks().find((m) => m[0] === "TCS")![1]).toBe(3120);
    // …and a stamp that is only a banner is never moved backwards by a refusal.
    expect(stamp()).toBe(null);
  });

  it("S5b: the IST day the row is dated is India's day, not the machine's, at 23:59 UTC", async () => {
    clearMarks();
    // 2026-09-04 23:59 UTC — the IST day is already the 5th, which is a
    // SATURDAY, so the door must refuse rather than date a row to a weekend.
    pinDate(new Date("2026-09-04T23:59:00.000Z"));
    selectAccount(SWING);
    stub.provider = bridge({ TCS: 312_000, HDFCBANK: 160_050 });
    const drain = reading(await getStream());
    await waitForFrame(drain, "snapshot");
    expect(marks()).toEqual([]);
    expect(persist.shouldPersistMark(new Date("2026-09-04T23:59:00.000Z"), null)).toMatchObject({
      code: "weekend",
      date: "2026-09-05",
    });

    // …and 18:29 UTC on the same Friday is still the 4th in India, and writes.
    clearMarks();
    pinDate(new Date("2026-09-04T18:29:00.000Z"));
    stub.provider = bridge({ TCS: 312_000, HDFCBANK: 160_050 });
    const edge = reading(await getStream());
    await waitForFrame(edge, "snapshot");
    expect(marks()).toEqual([
      ["HDFCBANK", 1600.5, "2026-09-04"],
      ["TCS", 3120, "2026-09-04"],
    ]);
  });

  it("S5c: C's sentence says exactly that, in the disclosure, the client README and the help page", () => {
    const CLAUSE = "decided per symbol per IST day, so a second account's open positions get their own mark on the same day";
    expect(read("docs", "client", "README.md")).toContain(CLAUSE);
    expect(OPENALGO_FEED_ITEMS[5].body).toContain(CLAUSE);
    expect(HELP_ENTRIES.flatMap((e) => e.body).join(" ")).toContain(CLAUSE);
    expect(changelogWave2()).toContain("per symbol per IST\n  day");
    expect(read("docs", "client", "OPENALGO_SETUP_GUIDE.html")).toContain(
      "decided per symbol per IST day, so\n    a second account's open positions get their own mark on the same day",
    );
    // The 15:31 reconnect C describes is A's constant, to the minute.
    expect(CLOSE_REOPEN_MINUTE).toBe(15 * 60 + 31);
    for (const [file, text] of [
      ["docs/client/README.md", read("docs", "client", "README.md")],
      ["README.md", read("README.md")],
      ["docs/client/PRIVACY.md", read("docs", "client", "PRIVACY.md")],
      ["CHANGELOG.md", changelogWave2()],
    ] as const) {
      expect(text, `${file} does not name the reconnect instant`).toContain("15:31 IST");
    }
  });
});

/* ═══ SEAM 6 (B→C) · the weekend AND the exchange holiday are refusals ═════ */

/**
 * RE-PINNED FOR v4.2 (ruling F1). This seam pinned a DEFECT: v4.1 modelled the
 * clock and not the exchange calendar, so a weekday the exchange was shut got a
 * mark written under that day's date from whatever the bridge last printed —
 * the previous session's close, filed as the holiday's. Both halves invert:
 * `shouldPersistMark()` now refuses with code "holiday" from the bundled NSE
 * list, and every surface that said "exchange holidays are not modelled in this
 * version" says the refusal covers them. The guard is the same guard — B's
 * refusal and C's sentence still have to agree — it is the agreed FACT that
 * changed, so the banned phrase inverts with it.
 */
describe("SEAM 6 · a weekday exchange holiday is refused, and every surface says so", () => {
  it("S6a: 2026-10-02 (a Friday the exchange is shut) is REFUSED, by name; the weekend still is; an ordinary weekday still writes", async () => {
    clearMarks();
    selectAccount(SWING);

    // The calendar, not just the clock. Gandhi Jayanti is a Friday.
    expect(isExchangeHoliday("2026-10-02"), "the bundled list no longer covers 2026-10-02").toBe(true);
    expect(new Date("2026-10-02T00:00:00Z").getUTCDay(), "the case only bites on a WEEKDAY holiday").toBe(5);

    const decision = persist.shouldPersistMark(HOLIDAY, null);
    expect(decision.ok).toBe(false);
    expect(decision.code).toBe("holiday");
    expect(decision.date).toBe("2026-10-02");
    // The refusal SAYS which day it was — the name comes from the same list.
    expect(decision.reason).toBe(
      `The exchange was closed for ${exchangeHolidayName("2026-10-02")} — there is no session to close.`,
    );
    expect(decision.reason).toContain("Mahatma Gandhi Jayanti");

    // …and `ignoreClock` (the Save-today's-mark waiver) does not waive it.
    const holiday = await persist.persistDailyMarks([quoteOf("TCS", 305_000, "2026-10-02T10:00:00.000Z")], {
      now: HOLIDAY,
      ignoreClock: true,
    });
    expect(holiday.written, "the previous session's price was filed under a shut day").toBe(false);
    expect(holiday.code).toBe("holiday");
    expect(marks()).toEqual([]);

    // The WEEKEND refusal is untouched, and `ignoreClock` does not waive it.
    expect(persist.shouldPersistMark(SATURDAY, null).code).toBe("weekend");
    const saturday = await persist.persistDailyMarks([quoteOf("TCS", 305_000, "2026-09-05T10:00:00.000Z")], {
      now: SATURDAY,
      ignoreClock: true,
    });
    expect(saturday.written).toBe(false);
    expect(saturday.code).toBe("weekend");
    expect(marks()).toEqual([]);

    // THE DOOR DID NOT JUST CLOSE. An ordinary open weekday after the close
    // still writes — without this the two refusals above prove nothing.
    const open = await persist.persistDailyMarks([quoteOf("TCS", 312_000, "2026-09-04T10:00:00.000Z")], {
      now: AFTER_HOURS,
    });
    expect(open.written, "a normal trading day stopped writing its mark").toBe(true);
    expect(open.code ?? null, "a successful write carries no refusal code").toBe(null);
    expect(marks()).toEqual([["TCS", 3120, "2026-09-04"]]);
    clearMarks();
  });

  it("S6b: C's surfaces say weekend AND exchange holiday — and no surface still promises the write B no longer makes", () => {
    const guide = read("docs", "client", "OPENALGO_SETUP_GUIDE.html");
    const clientReadme = read("docs", "client", "README.md");
    const privacy = read("docs", "client", "PRIVACY.md");
    const readme = read("README.md");
    const help = HELP_ENTRIES.flatMap((e) => e.body).join(" ");

    expect(OPENALGO_FEED_ITEMS[5].body).toContain("On a weekend the button refuses — there is no session to close");
    expect(OPENALGO_FEED_ITEMS[5].body).toContain("on an exchange holiday it refuses for the same reason");
    expect(guide).toContain("On a Saturday or a\n    Sunday nothing is written at all");
    expect(guide).toContain("exchange holidays");
    expect(clientReadme).toContain("writes anything at the weekend or on an exchange holiday");
    expect(privacy).toContain("never\n   at the weekend or on an exchange holiday");
    expect(help).toContain("At the weekend or on an exchange holiday nothing is written");
    // The sentence is B's own refusal, verbatim, and B still says it.
    expect(persist.shouldPersistMark(SATURDAY, null).reason).toBe("It is the weekend — there is no session to close.");

    // THE ABSENCE, INVERTED. In 4.1 the surfaces over-promised a refusal; in
    // 4.2 the stale sentence over-promises a WRITE — it tells a user that a
    // shut weekday still gets a mark, which is exactly what F1 stopped.
    const BANNED = /holidays are not modelled|weekend and only the weekend|non-trading day|day the market did not trade/g;
    const surfaces: [string, string][] = [
      ["docs/client/README.md", clientReadme],
      ["docs/client/PRIVACY.md", privacy],
      ["docs/client/OPENALGO_SETUP_GUIDE.html", guide],
      ["help-content.ts", help],
      ["openalgo-disclosure.ts", OPENALGO_FEED_ITEMS.map((i) => `${i.title} ${i.body}`).join(" ")],
    ];
    for (const [name, text] of surfaces) {
      expect(text.match(BANNED) ?? [], `${name} still promises a write the code no longer makes`).toEqual([]);
    }
    // The scan really fires on the sentence it is written against.
    expect("exchange holidays are not modelled in this version".match(BANNED)?.length).toBe(1);

    // THE VERSIONED HISTORIES are the one place the old sentence may survive,
    // and only BEHIND the release that made it false: the root README's per
    // version narrative and the CHANGELOG are records of what a release said.
    // What may NOT happen is the CURRENT release's own block saying it.
    const current = readme.indexOf("**v4.2.0");
    const previous = readme.indexOf("**v4.1.0");
    expect(current, "README.md no longer opens with the v4.2.0 note").toBeGreaterThan(-1);
    expect(previous).toBeGreaterThan(current);
    const currentBlock = readme.slice(current, previous);
    expect(currentBlock.match(BANNED) ?? [], "README.md's v4.2.0 block still says holidays are not modelled").toEqual(
      [],
    );
    expect(currentBlock, "README.md's v4.2.0 block does not state the holiday refusal").toContain("exchange holiday");
    for (const m of [...readme.matchAll(BANNED)]) {
      expect(m.index!, `README.md states "${m[0]}" outside a superseded release note`).toBeGreaterThan(previous);
    }
    const log = read("CHANGELOG.md");
    expect(log).toContain('the docs said "on a non-trading day"');
  });
});

/* ═══ SEAM 7 (C→code) · the /funds sentence against the call sites ═════════ */

describe("SEAM 7 · every place C says /funds is posted, really posts it", () => {
  it("S7a: the connection check, the desk render and the stream connect each call health() once", async () => {
    pinDate(MARKET_HOURS);
    selectAccount(SWING);
    const b = bridge({ TCS: 312_000, HDFCBANK: 160_050 });
    stub.provider = b;

    // 1. THE CONNECTION CHECK — `GET /api/live/feed` → `healthLine()`.
    const before = b.healthCalls;
    const res = await feedRoute.GET(
      new Request("http://127.0.0.1:3011/api/live/feed", { headers: { host: "127.0.0.1:3011" } }),
    );
    expect(res.status).toBe(200);
    const checked = b.healthCalls;
    expect(checked, "the connection check does not probe the bridge").toBeGreaterThan(before);

    // 2. THE DESK OPENING — the server render of `/live`.
    await live.loadLiveDesk({ pro: true });
    const opened = b.healthCalls;
    expect(opened, "opening the desk does not probe the bridge").toBeGreaterThan(checked);

    // 3. THE STREAM CONNECT — every open and every reconnect.
    const drain = reading(await getStream());
    await waitForFrame(drain, "snapshot");
    expect(b.healthCalls, "connecting the stream does not probe the bridge").toBeGreaterThan(opened);

    // C'S SENTENCE names the check and the desk, which is what the three call
    // sites above are. `health()` is the ONE function that posts /funds.
    const item = OPENALGO_FEED_ITEMS[3];
    expect(item.title).toBe("A /funds request when the feed is checked, and when the desk connects");
    expect(item.body).toContain(
      "calls OpenAlgo's /funds endpoint once, and the desk does the same each time it opens and each time its price stream reconnects",
    );
    expect(item.body).toContain("nothing further is sent");
    expect(read("docs", "client", "PRIVACY.md")).toContain(
      "each time you check the connection and each time the desk opens or its price\n   stream reconnects",
    );
    // …and the /funds COUNT correction did not move the version: same host,
    // same key, nothing new sent or kept. The constant is "3" in v4.2 for a
    // different sentence entirely — item 6's holiday clause, which changed what
    // the accepted disclosure promises is WRITTEN (see the constant's own note
    // in lib/domain/openalgo-disclosure.ts). Pinned as a literal on purpose: a
    // consent version that follows whatever the module says proves nothing.
    const { OPENALGO_DISCLOSURE_VERSION } = await import("@/lib/domain/openalgo-disclosure");
    expect(OPENALGO_DISCLOSURE_VERSION).toBe("3");
  });

  it("S7b: the egress sentence sends the reader to a Settings section that exists", () => {
    expect(OPENALGO_CAPS.egressDescription).toContain("Settings → Integrations");
    expect(OPENALGO_CAPS.egressDescription).not.toContain("Import → OpenAlgo");
    // The section the sentence names, on the page it names it on.
    const settings = read("components", "settings", "settings-form.tsx");
    expect(settings).toContain("<CardTitle>Integrations (advanced)</CardTitle>");
  });
});

/* ═══ SEAM 8 (A→C) · one announcement per link change ══════════════════════ */

describe("SEAM 8 · the desk's ONE live region, and the sentence C wrote about it", () => {
  it("S8a: every phase the real machine emits has a fixed announcement, and a repeat frame never re-announces", () => {
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_HOURS);
    const h = linkHarness();
    const said: string[] = [];
    const say = () => {
      const p = h.phase();
      if (p) said.push(LIVE_STREAM_COPY.announce[p]);
    };

    h.link.open();
    const src = h.sources[0];
    src.deliver("heartbeat", JSON.stringify({ at: "2026-09-04T05:00:00.000Z", provider: "openalgo" }));
    say(); // connected
    for (let i = 0; i < 4; i++) {
      src.deliver("snapshot", JSON.stringify({ quotes: [{ key: { symbol: "TCS", exchange: "NSE", tradingsymbol: "TCS" }, ltp: 312_000, asOf: "2026-09-04T05:00:00.000Z", staleness: "delayed" }] }));
      say(); // live, four times over, one string
    }
    src.deliver("error", JSON.stringify({ provider: "openalgo", message: "The bridge is not logged in for today." }));
    say(); // stopped
    h.link.pause();
    say(); // paused

    expect(said).toEqual([
      "Feed connected.",
      "Feed connected.",
      "Feed connected.",
      "Feed connected.",
      "Feed connected.",
      "Feed stopped.",
      "Feed paused.",
    ]);
    // FOUR ticks in a row produced ONE distinct string — nothing in the region
    // changes while the state has not, so a screen reader is not re-interrupted
    // per price. The strip beside it DID change (the age is on it, not here).
    expect(new Set(said.slice(0, 5)).size).toBe(1);
    expect(LIVE_STREAM_COPY.live("openalgo", 3)).not.toBe(LIVE_STREAM_COPY.live("openalgo", 33));
    h.link.destroy();
  });

  it("S8b: the desk's one aria-live region is the STRIP, not the Mark cell, and C's sentence says so", () => {
    // SOURCE, deliberately and only here: `aria-live` is a DOM attribute and
    // this suite runs in node with no DOM. WHERE it sits is the whole finding
    // and a count cannot see it — pre-wave there was also exactly ONE
    // occurrence, on the Mark `<td>` INSIDE the row component, which renders
    // one polite region PER ROW (40 rows × a 1 s poll). So what is pinned is
    // the region's HOME: on the strip, and absent from the mark cell.
    const src = read("components", "live", "tracker-client.tsx");
    expect(src.match(/aria-live=/g) ?? []).toHaveLength(1);
    expect(src).toContain(
      '<td className="px-2 py-1.5 text-right font-mono tabular-nums">\n        <span className="block">{fmt.level(row.markP)}</span>',
    );
    expect(src).toContain('<span className="sr-only" aria-live="polite" data-testid="live-stream-announce">');
    expect(src).toContain("{linkAnnouncement}");
    expect(src).toContain("LIVE_STREAM_COPY.announce[link.phase]");

    expect(changelogWave2()).toContain("one\n  announcement per link change");
    expect(changelogWave2()).toContain("The strip reads\n  **Live** once a quote-bearing frame has arrived on a subscribed connection,");
  });
});
