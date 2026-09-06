import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { applyTicks, mergeTicks, parseTickFrame, rowQuoteKey, type TickQuote } from "@/lib/live/apply-ticks";
import { connectPromptKey, showConnectPrompt } from "@/lib/live/connect-prompt";
import { computeTrackerRow, ppmTrunc } from "@/lib/live/tracker-row";
import type { Bar, LivePosition, Paise } from "@/lib/live/types";
import { CONNECT_PROMPT_COPY, LIVE_STREAM_COPY } from "@/components/live/desk-copy";
import { LIVE_FEED_COPY } from "@/components/settings/live-feed-card";
import type { DeskRow, FeedHealthState, LiveDeskData } from "@/components/live/desk-types";
import { OPENALGO_FEED_ITEMS } from "@/lib/domain/openalgo-disclosure";
import { HELP_ENTRIES } from "@/lib/domain/help-content";
import { todayIstIso } from "@/lib/domain/trading-day";
import { quoteKeyId, type ProviderCapabilities, type ProviderHealth, type Quote, type QuoteMap, type QuoteProvider } from "@/lib/quotes/types";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE v4.1 FIX WAVE'S SEAMS — the values handed between FW-1, FW-2 and the
 * orchestrator, tested with BOTH real halves running together.
 *
 * The wave was cut into disjoint file sets so two builders could not clobber
 * one file. That also guarantees nobody ran the two halves together: v4.0's
 * audit found seven money findings and almost all of them sat exactly here —
 * a `side` not passed, an R recomputed on the other side of a prop, a paise
 * figure rounded once on each side. This file is the pass that runs them
 * together, and nothing in it mocks either end of a seam. The only doubles are
 * the NETWORK (an OpenAlgo bridge that does not exist on this machine) and
 * they carry the SHIPPED capability block, so the rule under test is real code.
 *
 * ── THE SEAM TABLE ─────────────────────────────────────────────────────────
 * # | crossing value            | producer (file:line)               | consumer (file:line)                    | unit / type              | test
 * --|---------------------------|------------------------------------|-----------------------------------------|--------------------------|------------------
 * 1 | frame `quotes[]` (JSON)   | app/api/live/stream/route.ts:206   | lib/live/apply-ticks.ts:104 parseTick…  | integer paise            | S1a/S1b
 * 2 | `quotes[].key.exchange`   | app/api/live/stream/route.ts:66    | lib/live/apply-ticks.ts:112 (allow-list)| Exchange enum, string    | S1c
 * 3 | `DeskRow.exchange`        | components/live/load-desk.ts:349    | lib/live/apply-ticks.ts:88 rowQuoteKey  | Exchange enum            | S2a
 * 4 | ticked mark → row figures | lib/live/apply-ticks.ts:160         | lib/live/tracker-row.ts:248 (server)    | paise / ppm integers     | S2b/S2c
 * 5 | Pro nulls on a free wire  | components/live/load-desk.ts:334    | lib/live/apply-ticks.ts:186 (carry)     | null ⇒ NOT ENTITLED      | S2d
 * 6 | gated `stop` object       | components/live/load-desk.ts:365    | client row                              | {kind:"gated"}           | S2d
 * 7 | `capabilities{id,stream}` | lib/quotes/*.ts capability blocks   | lib/quotes/persist-mark.ts:283 mayAuto… | boolean pair             | S3a
 * 8 | `last_live_mark_date`     | route door 1 (stream/route.ts:202)  | door 2 (load-desk.ts:236)               | IST ISO day              | S3b/S3c
 * 9 | `ignoreClock`             | app/api/live/feed/route.ts:176      | lib/quotes/persist-mark.ts:196          | boolean → refusal code   | S4a/S4b
 * 10| the weekend sentence      | lib/quotes/persist-mark.ts:139      | disclosure item 6 / the POST body       | string (shared clause)   | S4c
 * 11| `feed.healthState`        | components/live/load-desk.ts:414    | lib/live/connect-prompt.ts:93           | 4-value union            | S6b
 * 12| `data.today` (IST day)    | components/live/load-desk.ts:186    | lib/live/connect-prompt.ts:31           | IST ISO day              | S6a
 * 13| the two prompt sentences  | components/settings/live-feed-card  | components/live/tracker-client.tsx:718   | string identity          | S5b
 * 14| doc sentences ↔ constants | CHANGELOG / docs/client/README.md    | code constants                          | minutes, day key, words  | S7
 *
 * CLOCK. Every seam that carries a date runs on a pinned clock, and the IST-day
 * seam runs at the 18:30–24:00 UTC boundary where the IST day is already
 * tomorrow. `toFake: ["Date"]` only: `loadLiveDesk()` and `persistDailyMarks()`
 * reach the database through REAL dynamic imports, and a fully faked timer set
 * stalls the module loader (the same reason `tests/live-page.test.ts` gives).
 * ═══════════════════════════════════════════════════════════════════════════
 */

let t: TempDb;
let live: typeof import("@/components/live/load-desk");
let streamRoute: typeof import("@/app/api/live/stream/route");
let feedRoute: typeof import("@/app/api/live/feed/route");
let persist: typeof import("@/lib/quotes/persist-mark");
let caps: {
  openalgo: ProviderCapabilities;
  mock: ProviderCapabilities;
  eod: ProviderCapabilities;
};

/**
 * The NETWORK, and only the network. `stub.provider` is null for every test
 * that does not name it, so the registry is the real one and the real
 * end-of-day / mock providers answer. The double below carries the SHIPPED
 * `OPENALGO_CAPABILITIES` object rather than a hand-written capability block,
 * so `providerMayAutoMark()` is asked the same question production asks it.
 */
const stub = vi.hoisted(() => ({ provider: null as QuoteProvider | null }));

vi.mock("@/lib/quotes/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/quotes/registry")>();
  return {
    ...actual,
    getLiveFeedProvider: async () => stub.provider ?? (await actual.getLiveFeedProvider()),
  };
});

/* ── the fixture, in the journal's own units (rupees at runtime) ─────────── */

const PRIMARY = 1;
const EQUITY_CAPITAL = 1_000_000;
const CAPITAL_P: Paise = EQUITY_CAPITAL * 100;

const TCS = { qty: 10, avg: 3000, stop: 2800, target: 3400, risk: 2000 };
/** SHORT, with its stop ABOVE entry — the sign the v4.0 audit found missing. */
const INFY = { qty: 8, avg: 1500, stop: 1600, target: 1350, risk: 1200 };

/** Friday 2026-09-04, 10:30 IST — inside the 09:00–15:40 live window. */
const MARKET_HOURS = new Date("2026-09-04T05:00:00Z");
/** Friday 2026-09-04, 16:00 IST — after the 15:30 close, on a session day. */
const AFTER_CLOSE = new Date("2026-09-04T10:30:00Z");
/** Friday 2026-09-04, 12:00 IST — a mid-session press of "Save today's mark". */
const MID_SESSION = new Date("2026-09-04T06:30:00Z");
/** Saturday 2026-09-05, 16:00 IST — no session to close. */
const SATURDAY = new Date("2026-09-05T10:30:00Z");
/** 2026-09-04 23:59:59 UTC — the IST day is already the 5th. */
const IST_TOMORROW = new Date("2026-09-04T23:59:59Z");
/** 2026-09-04 18:29:59 UTC — one second before the IST day rolls. */
const IST_TODAY_EDGE = new Date("2026-09-04T18:29:59Z");

const SESSIONS = 30;

function barRows(symbol: string, base: number, step: number) {
  const out: { symbol: string; date: string; open: number; high: number; low: number; close: number; volume: number }[] = [];
  for (let i = 0; i < SESSIONS; i++) {
    const date = new Date(Date.UTC(2026, 7, 6) + i * 86_400_000).toISOString().slice(0, 10);
    const close = base + step * i;
    out.push({ symbol, date, open: close - 3, high: close + 15, low: close - 12, close, volume: 1000 + i * 10 });
  }
  return out;
}

/* ── stream-route plumbing, copied from tests/live-stream-route.test.ts ──── */

function getStream(): Promise<Response> {
  return streamRoute.GET(
    new Request("http://127.0.0.1:3011/api/live/stream", { headers: { host: "127.0.0.1:3011" } }),
  );
}

function postFeed(body: unknown): Promise<Response> {
  return feedRoute.POST(
    new Request("http://127.0.0.1:3011/api/live/feed", {
      method: "POST",
      headers: { host: "127.0.0.1:3011", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

interface Drain {
  text: string;
  done: boolean;
}

/** Drain the SSE body in the background; the text accumulates as frames arrive. */
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
async function waitForFrame(state: Drain, event: string, tries = 200): Promise<unknown> {
  for (let i = 0; i < tries; i++) {
    const got = frames(state.text, event);
    if (got.length > 0) return got[0];
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`no "${event}" frame arrived`);
}

/* ── the network double: SHIPPED capabilities, a scripted bridge ─────────── */

function bridgeQuote(symbol: string, ltp: Paise, asOf: string): Quote {
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

/**
 * A bridge whose snapshot moves on every call. If the once-a-day stamp did not
 * hold across the two doors, the SECOND door would overwrite the first door's
 * price — and the assertion on the stored price is what catches it.
 */
function scriptedBridge(prices: readonly Paise[], health: ProviderHealth & { state?: string } = { ok: true, state: "ok" }): QuoteProvider {
  let call = 0;
  return {
    id: "openalgo",
    capabilities: caps.openalgo,
    async snapshot(): Promise<QuoteMap> {
      const ltp = prices[Math.min(call++, prices.length - 1)];
      return new Map([["NSE:TCS", bridgeQuote("TCS", ltp, "2026-09-04T10:00:00.000Z")]]);
    },
    subscribe: () => () => {},
    async health(): Promise<ProviderHealth> {
      return health;
    },
  };
}

/** Same bridge, but NOT streaming — used where the clock, not the mark, is the subject. */
function quietBridge(state: FeedHealthState | "teapot", ok: boolean): QuoteProvider {
  return {
    id: "openalgo",
    capabilities: { ...caps.openalgo, streaming: false },
    async snapshot(): Promise<QuoteMap> {
      return new Map();
    },
    subscribe: () => () => {},
    async health(): Promise<ProviderHealth & { state?: string }> {
      return { ok, state };
    },
  };
}

/* ── state helpers ───────────────────────────────────────────────────────── */

const marks = () => t.db.select().from(t.schema.mtmPrices).all();
const stamp = () => t.db.select().from(t.schema.settings).limit(1).all()[0]?.lastLiveMarkDate ?? null;

function clearMarks() {
  t.db.update(t.schema.settings).set({ lastLiveMarkDate: null }).run();
  t.sqlite.prepare("DELETE FROM mtm_prices").run();
}

function pinDate(when: Date) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(when);
}

beforeAll(async () => {
  t = await openTempDb("seams-v41", { seed: true });
  live = await import("@/components/live/load-desk");
  streamRoute = await import("@/app/api/live/stream/route");
  feedRoute = await import("@/app/api/live/feed/route");
  persist = await import("@/lib/quotes/persist-mark");

  // Warm the LAZY imports the providers and the mark path use, so a fake-timer
  // test never waits on a module loader that fake timers cannot advance.
  await import("@/lib/queries/price-history");
  await import("@/lib/db/schema");
  await import("@/lib/audit");
  await import("drizzle-orm");

  const openalgo = await import("@/lib/quotes/openalgo");
  const mock = await import("@/lib/quotes/mock");
  const eod = await import("@/lib/quotes/eod-bhavcopy");
  caps = { openalgo: openalgo.OPENALGO_CAPABILITIES, mock: mock.MOCK_CAPABILITIES, eod: eod.EOD_CAPABILITIES };

  t.db.update(t.schema.settings).set({ equityCapital: EQUITY_CAPITAL, selectedAccountId: PRIMARY }).run();
  t.db.update(t.schema.riskConfig).set({ riskPctPpm: 2500 }).run();

  t.db
    .insert(t.schema.trades)
    .values([
      tradeRow({
        id: 501,
        accountId: PRIMARY,
        symbol: "TCS",
        tradingsymbol: "TCS",
        isOpen: true,
        buyQty: TCS.qty,
        avgBuyPrice: TCS.avg,
        buyDate: "2026-08-06",
        slPlanned: TCS.stop,
        targetPlanned: TCS.target,
        riskAmount: TCS.risk,
      }),
      // SHORT: the open leg is on sellQty with buyQty still 0
      // (lib/analytics/positions.ts:77), and the stop sits ABOVE entry.
      tradeRow({
        id: 502,
        accountId: PRIMARY,
        symbol: "INFY",
        tradingsymbol: "INFY",
        isOpen: true,
        buyQty: 0,
        sellQty: INFY.qty,
        avgSellPrice: INFY.avg,
        sellDate: "2026-08-06",
        slPlanned: INFY.stop,
        targetPlanned: INFY.target,
        riskAmount: INFY.risk,
      }),
    ])
    .run();

  t.db
    .insert(t.schema.priceHistory)
    .values([...barRows("TCS", 3000, 2), ...barRows("INFY", 1500, -1)])
    .run();
});

afterAll(() => t?.cleanup());

afterEach(() => {
  vi.useRealTimers();
  stub.provider = null;
  delete process.env.VYUHA_QUOTE_PROVIDER;
});

/* ═══════════════════════ SEAM 1 — the frame on the wire ═══════════════════ */

describe("SEAM 1 · the stream route's frame → the client's parser", () => {
  it("S1a: every quote the route serialised survives parseTickFrame, in integer paise", async () => {
    pinDate(MARKET_HOURS);
    const drain = reading(await getStream());
    const raw = await waitForFrame(drain, "snapshot");

    // The frame is handed across EXACTLY as the browser hands it: the route
    // JSON.stringify'd it and `tracker-client.tsx:381` JSON.parse'd it back.
    const quotes = parseTickFrame(raw);
    const emitted = (raw as { quotes: { key: { symbol: string }; ltp: number }[] }).quotes;

    expect(emitted.length, "the fixture must emit both positions").toBe(2);
    expect(quotes).toHaveLength(emitted.length);
    expect(quotes.map((q) => q.key.symbol).sort()).toEqual(["INFY", "TCS"]);

    // PAISE, END TO END. The last stored closes are ₹3,058 and ₹1,471; the
    // desk must receive 305_800 and 147_100 — not 3058, not 3058.0, and not a
    // float that a second ×100 would round differently on the client.
    const byKey = new Map(quotes.map((q) => [quoteKeyId(q.key), q]));
    expect(byKey.get("NSE:TCS")!.ltp).toBe(305_800);
    expect(byKey.get("NSE:INFY")!.ltp).toBe(147_100);
    for (const q of quotes) {
      expect(Number.isInteger(q.ltp), `${q.key.symbol} arrived as a non-integer`).toBe(true);
      expect(Number.isInteger(q.prevClose ?? 0)).toBe(true);
    }
    // The previous session's close rides across too — it is the only honest
    // live day change, and `applyTicks` uses it in preference to the wire's.
    expect(byKey.get("NSE:TCS")!.prevClose).toBe(305_600);
    expect(byKey.get("NSE:INFY")!.prevClose).toBe(147_200);

    await drain.text; // keep the drain referenced
  });

  it("S1b: a real `tick` frame from a streaming provider parses the same way", async () => {
    process.env.VYUHA_QUOTE_PROVIDER = "mock";
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_HOURS);
    const drain = reading(await getStream());
    // 250 ms coalesce + the mock's one-tick-per-second push.
    await vi.advanceTimersByTimeAsync(1300);

    const tick = frames(drain.text, "tick")[0];
    expect(frames(drain.text, "tick").length, "the mock provider produced no tick frame").toBeGreaterThan(0);
    const quotes = parseTickFrame(tick);
    const emitted = (tick as { quotes: unknown[] }).quotes;
    expect(quotes).toHaveLength(emitted.length);
    expect(quotes.length).toBeGreaterThan(0);
    for (const q of quotes) {
      expect(Number.isInteger(q.ltp)).toBe(true);
      expect(q.ltp).toBeGreaterThan(0);
      expect(["tick", "delayed", "eod", "manual"]).toContain(q.staleness);
    }
  });

  it("S1c: a quote the route would never emit — a bad exchange — is dropped, and the rest survive", async () => {
    pinDate(MARKET_HOURS);
    const drain = reading(await getStream());
    const raw = (await waitForFrame(drain, "snapshot")) as { quotes: { key: { exchange: string } }[] };

    // The route clamps an unknown exchange to NSE (`toExchange`, route.ts:66),
    // so this frame can only come from a corrupted pipe. Re-serialise it the
    // way the route does and hand it across the same boundary.
    const tampered = JSON.parse(JSON.stringify(raw)) as { quotes: { key: { exchange: string } }[] };
    tampered.quotes[0].key.exchange = "XSE";
    const parsed = parseTickFrame(JSON.parse(JSON.stringify(tampered)));

    expect(parsed).toHaveLength(raw.quotes.length - 1);
    expect(parsed.some((q) => (q.key.exchange as string) === "XSE")).toBe(false);
    // …and one bad quote must never cost the whole frame.
    expect(parsed.length).toBeGreaterThan(0);
    // A frame that is not an object at all costs nothing either.
    expect(parseTickFrame(null)).toEqual([]);
    expect(parseTickFrame({ quotes: "all of them" })).toEqual([]);
  });
});

/* ═════════ SEAM 2 — the client's arithmetic vs the server's own ═══════════ */

/** Rebuild the position the loader built, from the journal's own numbers. */
function positionOf(row: DeskRow, fix: { qty: number; avg: number; stop: number; target: number; risk: number }): LivePosition {
  return {
    id: row.id,
    accountId: row.accountId,
    symbol: row.symbol,
    tradingsymbol: row.tradingsymbol,
    segment: row.segment,
    instrumentType: null,
    side: row.side,
    qty: fix.qty,
    avgEntryP: Math.round(fix.avg * 100),
    investedP: Math.round(fix.qty * fix.avg * 100),
    entryDate: row.entryDate,
    slPlannedP: Math.round(fix.stop * 100),
    trailingSlP: null,
    targetPlannedP: Math.round(fix.target * 100),
    riskAmountP: Math.round(fix.risk * 100),
    lotSize: null,
    sector: row.sector,
    sectorTier: row.sectorTier,
  };
}

describe("SEAM 2 · applyTicks (client) vs computeTrackerRow (server), one tick apart", () => {
  async function tickedDesk(pro: boolean) {
    delete process.env.VYUHA_QUOTE_PROVIDER;
    pinDate(MARKET_HOURS);
    // BOTH REAL HALVES: the rows come from the real loader against the real
    // database (the end-of-day provider's stored close), and the tick comes
    // from the real route's real frame. The two providers differ on purpose —
    // a tick that happened to equal the rendered mark would prove nothing
    // about whether `applyTicks` recomputed anything at all.
    const data: LiveDeskData = await live.loadLiveDesk({ pro });
    process.env.VYUHA_QUOTE_PROVIDER = "mock";
    const drain = reading(await getStream());
    const raw = await waitForFrame(drain, "snapshot");
    const quotes: TickQuote[] = parseTickFrame(raw);
    expect(quotes.length).toBeGreaterThan(0);
    const ticks = mergeTicks(new Map(), quotes);
    return { data, ticks, quotes, applied: applyTicks(data.rows, ticks) };
  }

  it("S2a: the row's exchange and the frame's key agree, so the tick lands on the right row", async () => {
    const { data, quotes, applied } = await tickedDesk(true);
    // The stream is keyed on `exchange:tradingsymbol`. If `DeskRow.exchange`
    // were absent the client would have to guess one, and a BSE-only holding
    // would be priced from the wrong book.
    for (const r of data.rows) expect(r.exchange).toBe("NSE");
    expect(new Set(data.rows.map(rowQuoteKey))).toEqual(new Set(quotes.map((q) => quoteKeyId(q.key))));
    // Every row actually MOVED — the mock's price is not the stored close.
    for (const [i, r] of applied.entries()) expect(r.markP).not.toBe(data.rows[i].markP);
  });

  it("S2b: a LONG's ticked figures equal the server's own recompute, to the paise and the ppm", async () => {
    const { data, ticks, applied } = await tickedDesk(true);
    const before = data.rows.find((r) => r.symbol === "TCS")!;
    const after = applied.find((r) => r.symbol === "TCS")!;
    const q = ticks.get(rowQuoteKey(before))!;

    const server = computeTrackerRow(positionOf(before, TCS), { markP: q.ltp, staleness: q.staleness, asOf: q.asOf }, {
      today: data.today,
      capitalP: CAPITAL_P,
      bars: data.barsBySymbol["TCS"] as Bar[],
      atrLength: data.atrLength,
    });

    expect(after.side).toBe("long");
    expect(after.markP).toBe(q.ltp);
    expect(after.unrealisedP).toBe(server.unrealisedP);
    expect(after.unrealisedPctPpm).toBe(server.unrealisedPctPpm);
    expect(after.distanceToStopP).toBe(server.distanceToStopP);
    expect(after.distanceToStopPpm).toBe(server.distanceToStopPpm);
    expect(after.distanceToTargetP).toBe(server.distanceToTargetP);
    expect(after.distanceToTargetPpm).toBe(server.distanceToTargetPpm);
    expect(after.distanceToStopAtrX100).toBe(server.distanceToStopAtrX100);
    expect(after.distanceToStopAtrX100).not.toBe(null); // 30 sessions: a real ATR
    expect(after.openRPpm).toBe(server.openRPpm);
    // INVARIANT UNDER A TICK, and the client must not have moved them:
    // risk at stop is a property of the LEVEL, and % of capital and heat follow it.
    expect(after.riskAtStopP).toBe(server.riskAtStopP);
    expect(after.riskAtStopP).toBe(before.riskAtStopP);
    expect(after.pctOfCapital).toEqual(before.pctOfCapital);
    expect(after.rvol).toEqual(server.rvol);
    expect(after.highDistance).toEqual(server.highDistance);
    // The day change is the PROVIDER's own previous close, not the two stored
    // sessions — a different measurement, and the one the wire carries.
    if (q.prevClose !== null && q.prevClose > 0) {
      expect(after.dayChangePpm).toBe(ppmTrunc(q.ltp - q.prevClose, q.prevClose));
    } else {
      expect(after.dayChangePpm).toBe(before.dayChangePpm);
    }
  });

  it("S2c: a SHORT with its stop ABOVE entry comes out a short on both sides", async () => {
    const { data, ticks, applied } = await tickedDesk(true);
    const before = data.rows.find((r) => r.symbol === "INFY")!;
    const after = applied.find((r) => r.symbol === "INFY")!;
    const q = ticks.get(rowQuoteKey(before))!;

    const server = computeTrackerRow(positionOf(before, INFY), { markP: q.ltp, staleness: q.staleness, asOf: q.asOf }, {
      today: data.today,
      capitalP: CAPITAL_P,
      bars: data.barsBySymbol["INFY"] as Bar[],
      atrLength: data.atrLength,
    });

    expect(after.side).toBe("short");
    expect(after.effectiveStopP).toBe(160_000);
    expect(after.effectiveStopP! > after.avgEntryP, "the short's stop must sit above entry").toBe(true);
    // The mirror, both sides: a short profits as the price FALLS.
    expect(after.unrealisedP).toBe(server.unrealisedP);
    expect(after.unrealisedP).toBe(Math.round(INFY.qty * INFY.avg * 100) - INFY.qty * q.ltp);
    expect(after.distanceToStopP).toBe(server.distanceToStopP);
    expect(after.distanceToStopP).toBe(160_000 - q.ltp);
    expect(after.distanceToTargetP).toBe(server.distanceToTargetP);
    expect(after.distanceToTargetPpm).toBe(server.distanceToTargetPpm);
    expect(after.distanceToStopAtrX100).toBe(server.distanceToStopAtrX100);
    expect(after.openRPpm).toBe(server.openRPpm);
    expect(after.riskAtStopP).toBe(server.riskAtStopP);
  });

  it("S2d: a FREE wire gains no Pro figure past the tick, and the stop stays gated", async () => {
    const { data, applied } = await tickedDesk(false);
    const freeRow = applied.find((r) => r.symbol === "TCS")!;
    const freeBefore = data.rows.find((r) => r.symbol === "TCS")!;

    // The paywall boundary is `load-desk.ts`'s whole-field null. A tick may
    // only RE-COMPUTE a figure the wire already carries; re-deriving
    // `riskAtStopP = investedP − qty × stop` from the free fields would hand a
    // free reader the exact figure the server had just stripped.
    expect(freeBefore.riskAtStopP).toBe(null);
    expect(freeRow.riskAtStopP).toBe(null);
    expect(freeRow.riskAmountP).toBe(null);
    expect(freeRow.openRPpm).toBe(null);
    expect(freeRow.pctOfCapital).toEqual({ ppm: null, denominator: null });
    expect(freeRow.stop.kind).toBe("gated");
    // …and the free row's OWN record still moved: the journal is never gated.
    expect(freeRow.markP).not.toBe(freeBefore.markP);
    expect(freeRow.unrealisedP).not.toBe(null);
    expect(freeRow.effectiveStopP).toBe(280_000);

    // The same tick on the PRO wire does produce them — otherwise the four
    // nulls above prove nothing about the boundary.
    const pro = await tickedDesk(true);
    const proRow = pro.applied.find((r) => r.symbol === "TCS")!;
    expect(proRow.riskAtStopP).not.toBe(null);
    expect(proRow.openRPpm).not.toBe(null);
    expect(proRow.pctOfCapital.ppm).not.toBe(null);
    expect(proRow.stop.kind).not.toBe("gated");
  });

  it("S2e: the empty desk and the unheld symbol — no phantom row is ever appended", async () => {
    const { ticks } = await tickedDesk(true);
    expect(applyTicks([], ticks)).toEqual([]);
    const stranger: TickQuote = {
      key: { symbol: "NOTHELD", exchange: "NSE", tradingsymbol: "NOTHELD" },
      ltp: 99_900,
      prevClose: null,
      asOf: "2026-09-04T10:00:00.000Z",
      staleness: "tick",
    };
    const data = await live.loadLiveDesk({ pro: true });
    const out = applyTicks(data.rows, mergeTicks(new Map(), [stranger]));
    expect(out).toHaveLength(data.rows.length);
    expect(out.some((r) => r.symbol === "NOTHELD")).toBe(false);
    // A row with no tick comes back BY IDENTITY, so nothing re-measures.
    expect(out[0]).toBe(data.rows[0]);
  });
});

/* ═══════════ SEAM 3 — the catch-up write, through both doors ══════════════ */

describe("SEAM 3 · catchUpDailyMark, called by the stream route AND by the desk render", () => {
  it("S3a: the rule both doors ask is the SHIPPED capability block, and the mock is refused", () => {
    // Not a hand-written double: the real blocks the real providers publish.
    expect(persist.providerMayAutoMark(caps.openalgo)).toBe(true);
    expect(persist.providerMayAutoMark(caps.mock)).toBe(false); // streams, but is a fixture
    expect(persist.providerMayAutoMark(caps.eod)).toBe(false); // the bhavcopy IS yesterday's close
    expect(caps.mock.streaming, "the mock must still stream, or S3a proves nothing").toBe(true);
  });

  it("S3b: with the mock pinned, NEITHER door writes — a generated number is not a mark", async () => {
    process.env.VYUHA_QUOTE_PROVIDER = "mock";
    clearMarks();
    pinDate(AFTER_CLOSE); // Friday 16:00 IST — past the close, on a session day

    const drain = reading(await getStream());
    await waitForFrame(drain, "snapshot"); // door 1 has run by now
    await live.loadLiveDesk({ pro: true }); // door 2

    expect(marks()).toEqual([]);
    expect(stamp()).toBe(null);
  });

  it("S3c: with a streaming bridge at 16:00 IST, door 1 writes ONE row per position and door 2 is a no-op", async () => {
    clearMarks();
    // Two different prices: if the once-a-day stamp did not hold, the second
    // door's ₹3,200 would overwrite the first door's ₹3,120.
    stub.provider = scriptedBridge([312_000, 320_000]);
    pinDate(AFTER_CLOSE);

    const drain = reading(await getStream());
    await waitForFrame(drain, "snapshot");

    // RUPEES in `mtm_prices` — invariant 1's documented exception, converted
    // from the quote's paise exactly once, at the write edge.
    expect(marks().map((m) => [m.symbol, m.price, m.asOfDate])).toEqual([["TCS", 3120, "2026-09-04"]]);
    expect(stamp()).toBe("2026-09-04");

    await live.loadLiveDesk({ pro: true });
    expect(marks().map((m) => [m.symbol, m.price])).toEqual([["TCS", 3120]]);
    expect(stamp()).toBe("2026-09-04");
  });

  it("S3d: the other order — the desk render writes, and the stream connect is then the no-op", async () => {
    clearMarks();
    stub.provider = scriptedBridge([333_000, 344_000]);
    pinDate(AFTER_CLOSE);

    await live.loadLiveDesk({ pro: true }); // door 2 first
    expect(marks().map((m) => [m.symbol, m.price])).toEqual([["TCS", 3330]]);

    const drain = reading(await getStream()); // door 1 second
    await waitForFrame(drain, "snapshot");
    expect(marks().map((m) => [m.symbol, m.price])).toEqual([["TCS", 3330]]);
    expect(marks()).toHaveLength(1);
  });

  it("S3e: neither door waives the clock — nothing is written before 15:30 IST or on a Saturday", async () => {
    clearMarks();
    stub.provider = scriptedBridge([312_000]);
    pinDate(MARKET_HOURS); // 10:30 IST, mid-session
    await live.loadLiveDesk({ pro: true });
    const mid = reading(await getStream());
    await waitForFrame(mid, "snapshot");
    expect(marks(), "a mid-session price is not the day's close").toEqual([]);
    expect(stamp()).toBe(null);

    pinDate(SATURDAY);
    await live.loadLiveDesk({ pro: true });
    expect(marks(), "a weekend has no session to close").toEqual([]);
    expect(stamp()).toBe(null);
  });
});

/* ═════════════════════ SEAM 4 — the ignoreClock waiver ═══════════════════ */

describe("SEAM 4 · `ignoreClock` waives the clock and nothing else", () => {
  const quote = (ltp: Paise): Quote[] => [bridgeQuote("TCS", ltp, "2026-09-04T06:00:00.000Z")];

  it("S4a: on a SATURDAY it returns the weekend refusal and writes nothing", async () => {
    clearMarks();
    const decision = persist.shouldPersistMark(SATURDAY, null);
    expect(decision.code).toBe("weekend");

    const result = await persist.persistDailyMarks(quote(312_000), { ignoreClock: true, now: SATURDAY });
    expect(result.written).toBe(false);
    expect(result.marked).toBe(0);
    // The SENTENCE the user reads is the decision's own, not a second copy.
    expect(result.reason).toBe(decision.reason);
    expect(marks()).toEqual([]);
    expect(stamp()).toBe(null);
  });

  it("S4b: at 12:00 IST on a Friday it DOES write — the clock is the only thing waived", async () => {
    clearMarks();
    expect(persist.shouldPersistMark(MID_SESSION, null).code).toBe("before-close");

    const refused = await persist.persistDailyMarks(quote(312_000), { now: MID_SESSION });
    expect(refused.written, "without the waiver a mid-session price is refused").toBe(false);
    expect(marks()).toEqual([]);

    const result = await persist.persistDailyMarks(quote(312_000), { ignoreClock: true, now: MID_SESSION });
    expect(result.written).toBe(true);
    expect(result.marked).toBe(1);
    expect(result.date).toBe("2026-09-04");
    expect(marks().map((m) => [m.symbol, m.price, m.asOfDate])).toEqual([["TCS", 3120, "2026-09-04"]]);
    // The once-a-day half is NEVER waived: a second press changes nothing.
    const again = await persist.persistDailyMarks(quote(999_900), { ignoreClock: true, now: MID_SESSION });
    expect(again.written).toBe(false);
    expect(marks().map((m) => m.price)).toEqual([3120]);
  });

  it("S4c: POST /api/live/feed {action:\"mark\"} on a Saturday answers in the disclosure's own words", async () => {
    clearMarks();
    pinDate(SATURDAY);
    const res = await postFeed({ action: "mark" });
    const body = (await res.json()) as { ok: boolean; message: string; date: string };

    expect(body.ok).toBe(false);
    expect(body.date).toBe("2026-09-05");
    expect(marks()).toEqual([]);

    // THE SHARED CLAUSE. `persist-mark.ts` writes the sentence; disclosure
    // item 6 (orchestrator) promises the same refusal. One clause, both ends.
    const CLAUSE = "there is no session to close";
    const item6 = OPENALGO_FEED_ITEMS[5];
    expect(item6.title).toBe("Prices refresh on screen only — ticks are never written");
    expect(item6.body).toContain(CLAUSE);
    expect(item6.body).toContain("On a weekend the button refuses");
    expect(body.message).toContain(CLAUSE);
    expect(body.message).toBe(persist.shouldPersistMark(SATURDAY, null).reason);
  });
});

/* ══════════ SEAM 5 — the disclosure's promise vs the client's code ════════ */

const clientSource = () =>
  fs.readFileSync(path.join(process.cwd(), "components", "live", "tracker-client.tsx"), "utf8");

describe("SEAM 5 · the disclosure and PRIVACY promise a hidden tab holds no stream", () => {
  it("S5a: item 2 and PRIVACY item 3 say it, and the client closes the EventSource on hidden", () => {
    const item2 = OPENALGO_FEED_ITEMS[1];
    expect(item2.title).toBe("It asks every 1 to 5 seconds, while the Live Desk is open");
    expect(item2.body).toContain("or when its tab goes to the background");

    const privacy = fs.readFileSync(path.join(process.cwd(), "docs", "client", "PRIVACY.md"), "utf8");
    expect(privacy).toContain("open and in the foreground");

    // SOURCE GUARD, deliberately, and only here: `visibilitychange` is a
    // browser event and this suite runs in node with no DOM. The behaviour it
    // guards is one branch, and the alternative is an unasserted promise.
    const src = clientSource();
    expect(src).toMatch(/document\.addEventListener\("visibilitychange", onVisibility\)/);
    expect(src).toMatch(/if \(document\.visibilityState === "hidden"\) \{\s*close\(\);/);
    // …and the strip must SAY it, or a paused feed reads as a fault.
    expect(LIVE_STREAM_COPY.paused).toContain("background");
  });

  it("S5b: the two prompt sentences have exactly ONE source — desk-copy restates neither", () => {
    const deskCopySource = fs.readFileSync(path.join(process.cwd(), "components", "live", "desk-copy.ts"), "utf8");
    const restated = [LIVE_FEED_COPY.connect, LIVE_FEED_COPY.dailyReauth];

    for (const sentence of restated) {
      expect(sentence.length).toBeGreaterThan(20);
      expect(deskCopySource.includes(sentence), "desk-copy.ts restates a sentence it should import").toBe(false);
    }
    const values: string[] = [...Object.values(CONNECT_PROMPT_COPY), ...Object.values(LIVE_STREAM_COPY)].flatMap((v) =>
      typeof v === "string" ? [v] : [],
    );
    for (const sentence of restated) expect(values).not.toContain(sentence);

    // The banner renders the ONE source, by reference.
    const src = clientSource();
    expect(src).toContain('import { LIVE_FEED_COPY } from "@/components/settings/live-feed-card"');
    expect(src).toContain("{LIVE_FEED_COPY.connect}");
    expect(src).toContain("{LIVE_FEED_COPY.dailyReauth}");
    // The banner's own chrome does live in desk-copy — it has no Settings twin.
    expect(deskCopySource).toContain(CONNECT_PROMPT_COPY.dismiss);
  });
});

/* ═════════════ SEAM 6 — the day key and the health state ══════════════════ */

describe("SEAM 6 · the connect prompt's day key and the health state it branches on", () => {
  it("S6a: the key is the payload's IST day, across the 18:30 UTC boundary", async () => {
    stub.provider = quietBridge("no-key", false);

    pinDate(IST_TODAY_EDGE); // 18:29:59 UTC — still the 4th in India
    const before = await live.loadLiveDesk({ pro: true });
    expect(before.today).toBe("2026-09-04");
    expect(connectPromptKey(before.today)).toBe("vyuha-live-connect-prompt:2026-09-04");

    pinDate(IST_TOMORROW); // 23:59:59 UTC — the 5th in India
    const after = await live.loadLiveDesk({ pro: true });
    expect(after.today).toBe("2026-09-05");
    expect(after.today).toBe(todayIstIso(new Date()));
    expect(connectPromptKey(after.today)).toBe("vyuha-live-connect-prompt:2026-09-05");
    // The key MOVED — a UTC day key would still read 2026-09-04 at 23:59 UTC
    // and the prompt would be suppressed through India's whole next morning.
    expect(connectPromptKey(after.today)).not.toBe(connectPromptKey(before.today));

    // Dismissal is per key, so it expires by itself at the IST midnight.
    const { connectPromptDismissal } = await import("@/lib/live/connect-prompt");
    expect(showConnectPrompt({ providerId: "openalgo", healthState: "no-key" }, connectPromptDismissal())).toBe(false);
    expect(showConnectPrompt({ providerId: "openalgo", healthState: "no-key" }, null)).toBe(true);
  });

  it("S6b: every healthState the loader can publish is a value the prompt already decides", async () => {
    pinDate(MARKET_HOURS); // before the close: nothing may be written here
    const published: string[] = [];
    const cases: { state: FeedHealthState | "teapot"; ok: boolean; expected: FeedHealthState; prompt: boolean }[] = [
      { state: "ok", ok: true, expected: "ok", prompt: false },
      { state: "no-key", ok: false, expected: "no-key", prompt: true },
      { state: "unreachable", ok: false, expected: "unreachable", prompt: true },
      { state: "disabled", ok: false, expected: "disabled", prompt: false },
      // A provider that reports a state nobody typed falls back — never leaks
      // an unknown string into a union the prompt branches on.
      { state: "teapot", ok: true, expected: "ok", prompt: false },
      { state: "teapot", ok: false, expected: "disabled", prompt: false },
    ];

    for (const c of cases) {
      stub.provider = quietBridge(c.state, c.ok);
      const data = await live.loadLiveDesk({ pro: true });
      expect(data.feed.healthState, `state "${c.state}" (ok=${c.ok})`).toBe(c.expected);
      published.push(data.feed.healthState);
      expect(
        showConnectPrompt({ providerId: data.feed.providerId, healthState: data.feed.healthState }, null),
        `the prompt for "${c.expected}"`,
      ).toBe(c.prompt);
    }

    // The published set is exactly the union — no fifth value ever reaches the client.
    expect(new Set(published)).toEqual(new Set<FeedHealthState>(["ok", "no-key", "unreachable", "disabled"]));

    // …and the prompt is for the bridge the user chose, never for the default feed.
    delete process.env.VYUHA_QUOTE_PROVIDER;
    stub.provider = null;
    const eodDesk = await live.loadLiveDesk({ pro: true });
    expect(eodDesk.feed.providerId).toBe("eod");
    expect(showConnectPrompt({ providerId: eodDesk.feed.providerId, healthState: "no-key" }, null)).toBe(false);
  });
});

/* ═════════════ SEAM 7 — FW-2's sentences against FW-1's constants ═════════ */

describe("SEAM 7 · the docs describe the code that shipped", () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), "utf8");
  const changelog = () => {
    const all = read("CHANGELOG.md");
    const start = all.indexOf("## v4.1.0");
    const next = all.indexOf("\n## ", start + 1);
    expect(start).toBeGreaterThan(-1);
    return all.slice(start, next === -1 ? undefined : next);
  };

  it("S7a: (a) the stream consumer — both docs describe the connection the client actually opens", () => {
    const log = changelog();
    const clientReadme = read("docs", "client", "README.md");
    const src = clientSource();

    // The route the consumer opens, named in the changelog and present in code.
    expect(log).toContain("/api/live/stream");
    expect(src).toContain('new EventSource("/api/live/stream")');
    // …and both docs promise the hidden-tab close that S5a pinned in code.
    expect(log).toMatch(/closes the connection when you leave the screen\s+or switch to another tab/);
    expect(clientReadme).toContain("closes when you leave it or switch to another tab");
  });

  it("S7b: (b) the catch-up write — 15:30 in the docs is MARK_AFTER_IST_MIN in code", () => {
    const log = changelog();
    const stated = log.match(/after (\d{1,2}):(\d{2}) IST/);
    expect(log.match(/after \d{1,2}:\d{2} IST/g), "the changelog no longer states the close time").toEqual(["after 15:30 IST"]);
    expect(Number(stated![1]) * 60 + Number(stated![2])).toBe(persist.MARK_AFTER_IST_MIN);
    expect(persist.MARK_AFTER_IST_MIN).toBe(15 * 60 + 30);

    // "by the app itself", i.e. a caller that is not the button.
    expect(log).toContain("by the app itself");
    expect(read("docs", "client", "README.md")).toContain("The close-of-session mark is written by the app itself");
    // …and the non-trading-day refusal both docs claim is the `weekend` code.
    expect(log).toContain("non-trading day");
    expect(read("docs", "client", "README.md")).toContain("neither of them writes anything on a day the market did not trade");
    expect(persist.shouldPersistMark(SATURDAY, null).code).toBe("weekend");

    // The help entry says the same thing to the user, in its own words.
    const desk = HELP_ENTRIES.find((e) => e.body.some((b) => b.includes("one mark per position per day")));
    expect(HELP_ENTRIES.filter((e) => e.body.some((b) => b.includes("one mark per position per day"))).length).toBe(1);
    expect(desk!.body.join(" ")).toContain("written after the close or when you press Save today's mark");
  });

  it("S7c: (c) the once-a-day prompt — \"once per IST day\" is the day-keyed store", () => {
    const log = changelog();
    expect(log).toContain("once per IST day");
    expect(log).toContain(LIVE_FEED_COPY.connect); // the sentence the desk shows, verbatim
    expect(read("docs", "client", "README.md")).toContain("once-a-day reminder to reconnect");
    // The claim in code: one key per IST day, and two days are two keys.
    expect(connectPromptKey("2026-09-04")).not.toBe(connectPromptKey("2026-09-05"));
    expect(connectPromptKey("2026-09-04").endsWith("2026-09-04")).toBe(true);
    // …shown only for the two states a reconnection fixes.
    expect(showConnectPrompt({ providerId: "openalgo", healthState: "disabled" }, null)).toBe(false);
    expect(showConnectPrompt({ providerId: "openalgo", healthState: "unreachable" }, null)).toBe(true);
  });
});
