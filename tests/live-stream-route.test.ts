import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import type { ProviderCapabilities, QuoteMap, QuoteProvider } from "@/lib/quotes/types";

/**
 * `GET /api/live/stream` — the Live Desk's SSE channel.
 *
 * What this file holds to account: the account scope (invariant 8) is read per
 * REQUEST and never leaks another book's symbols into the stream; the frame
 * contract (`snapshot` on connect, `tick` coalesced to one per 250 ms,
 * `heartbeat` every 25 s) is what the UI is written against; a non-streaming
 * provider is never started, so the desk can never call an end-of-day print
 * "live"; and an aborted request tears the provider and both timers down.
 *
 * Clock: fake timers throughout. The route creates its intervals inside the
 * handler, so they are faked too, and the IST market window is pinned with
 * `vi.setSystemTime` instead of being waited for.
 */

let t: TempDb;
let route: typeof import("@/app/api/live/stream/route");

/**
 * One test needs a provider whose `snapshot()` is still pending when the
 * request aborts — a real provider resolves too fast to ever hit that window.
 * The stub is opt-in: while `stub.provider` is null every other test in the
 * file gets the real registry, untouched.
 */
const stub = vi.hoisted(() => ({ provider: null as QuoteProvider | null }));

vi.mock("@/lib/quotes/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/quotes/registry")>();
  return {
    ...actual,
    getQuoteProvider: (stored?: string | null) => stub.provider ?? actual.getQuoteProvider(stored),
    // The route resolves the STORED selection (S-X), so the stub has to sit on
    // the same resolver the route actually calls — a stub left on the old one
    // is a mock that silently stops mocking.
    getLiveFeedProvider: async () => stub.provider ?? (await actual.getLiveFeedProvider()),
  };
});

const SWING = 2;
const LONG_TERM = 3;
/** Friday 2026-09-04, 10:30 IST — inside the 09:00–15:40 window. */
const MARKET_HOURS = new Date("2026-09-04T05:00:00Z");
/** Friday 2026-09-04, 22:00 IST — outside it. */
const AFTER_HOURS = new Date("2026-09-04T16:30:00Z");

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

function get(init: RequestInit = {}): Promise<Response> {
  return route.GET(new Request("http://127.0.0.1:3011/api/live/stream", { headers: { host: "127.0.0.1:3011" }, ...init }));
}

/** Drain the SSE body in the background; the text accumulates as frames arrive. */
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
      /* the stream was cancelled — that is one of the things under test */
    }
    state.done = true;
  })();
  return state;
}

const frames = (text: string, event: string) =>
  [...text.matchAll(new RegExp(`event: ${event}\\ndata: (.*)\\n\\n`, "g"))].map((m) => JSON.parse(m[1]));

beforeAll(async () => {
  t = await openTempDb("live-stream", { seed: true });
  route = await import("@/app/api/live/stream/route");
  // The providers import their query modules LAZILY (so that importing the
  // registry never binds the SQLite connection before openTempDb runs). A
  // first-time dynamic import needs real event-loop turns, and fake timers do
  // not advance the module loader — so warm them here rather than have the
  // first streaming test wait on a loader it cannot tick.
  await import("@/lib/queries/price-history");
  await import("@/lib/db/schema");
  // Same reason, for the connect-time mark: `persistDailyMarks()` reaches the
  // database, the schema, drizzle and the audit log through LAZY imports (so
  // that importing it never binds SQLite ahead of `openTempDb`). A first-time
  // module load needs real event-loop turns, which `advanceTimersByTimeAsync`
  // cannot supply — unwarmed, the snapshot frame lands after the assertion.
  await import("@/lib/quotes/persist-mark");
  await import("@/lib/audit");
  await import("drizzle-orm");

  t.db.insert(t.schema.accounts).values([{ id: SWING, name: "Swing" }, { id: LONG_TERM, name: "Long term" }]).run();
  t.db
    .insert(t.schema.trades)
    .values([
      tradeRow({ accountId: SWING, symbol: "TCS", tradingsymbol: "TCS", isOpen: true, buyQty: 10, avgBuyPrice: 3000 }),
      tradeRow({ accountId: SWING, symbol: "HDFCBANK", tradingsymbol: "HDFCBANK", isOpen: true, buyQty: 4, avgBuyPrice: 1600 }),
      tradeRow({ accountId: SWING, symbol: "WIPRO", tradingsymbol: "WIPRO", isOpen: false, buyQty: 5, sellQty: 5 }),
      tradeRow({ accountId: LONG_TERM, symbol: "INFY", tradingsymbol: "INFY", isOpen: true, buyQty: 8, avgBuyPrice: 1400 }),
    ])
    .run();
  t.db
    .insert(t.schema.priceHistory)
    .values([
      { symbol: "TCS", date: "2026-09-03", close: 3010.25 },
      { symbol: "TCS", date: "2026-09-04", close: 3025.75 },
      { symbol: "INFY", date: "2026-09-04", close: 1499.9 },
    ])
    .run();
});

afterAll(() => t?.cleanup());

afterEach(() => {
  vi.useRealTimers();
  delete process.env.VYUHA_QUOTE_PROVIDER;
});

describe("route configuration", () => {
  it("runs on Node and is never cached — a streamed route that gets cached is a dead desk", () => {
    expect(route.runtime).toBe("nodejs");
    expect(route.dynamic).toBe("force-dynamic");
  });
});

describe("the origin guard", () => {
  it("refuses a cross-site request", async () => {
    const res = await get({ headers: { host: "127.0.0.1:3011", "sec-fetch-site": "cross-site" } });
    expect(res.status).toBe(403);
    expect((await res.json()).ok).toBe(false);
  });

  it("refuses a foreign Origin even when the fetch metadata is absent", async () => {
    const res = await get({ headers: { host: "127.0.0.1:3011", origin: "https://quotes.example.com" } });
    expect(res.status).toBe(403);
  });

  it("serves the app itself — same host, the Tauri shell origin, and a bare EventSource with no Origin at all", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_HOURS);
    selectAccount(SWING);
    const cases: Record<string, string>[] = [
      { host: "127.0.0.1:3011", origin: "http://127.0.0.1:3011" },
      { host: "127.0.0.1:3011", origin: "https://tauri.localhost" },
      { host: "127.0.0.1:3011", "sec-fetch-site": "same-origin" },
      { host: "127.0.0.1:3011" },
    ];
    for (const headers of cases) {
      const res = await get({ headers });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
      await res.body!.cancel();
    }
  });
});

describe("the snapshot frame", () => {
  it("carries the selected account's OPEN positions and nobody else's", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_HOURS);
    selectAccount(SWING);

    const stream = reading(await get());
    await vi.advanceTimersByTimeAsync(10);

    const [snap] = frames(stream.text, "snapshot");
    expect(snap.accountId).toBe(SWING);
    expect(snap.provider).toBe("eod");
    // Two OPEN positions in the Swing book: WIPRO is closed (is_open — never
    // sell_date, which is a sort key here) and INFY belongs to the other
    // account, so neither is subscribed.
    expect(snap.symbols).toBe(2);
    // …but only TCS has stored bars, and a provider never invents the other.
    expect(snap.quotes.map((q: { key: { symbol: string } }) => q.key.symbol)).toEqual(["TCS"]);
    expect(snap.quotes[0].ltp).toBe(302575);
    expect(snap.quotes[0].prevClose).toBe(301025);
    expect(snap.quotes[0].staleness).toBe("eod");
  });

  it("re-reads the account on the NEXT request — the id is never a module global", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_HOURS);

    selectAccount(LONG_TERM);
    const other = reading(await get());
    await vi.advanceTimersByTimeAsync(10);
    expect(frames(other.text, "snapshot")[0].quotes.map((q: { key: { symbol: string } }) => q.key.symbol)).toEqual([
      "INFY",
    ]);

    selectAccount(SWING);
    const swing = reading(await get());
    await vi.advanceTimersByTimeAsync(10);
    expect(frames(swing.text, "snapshot")[0].accountId).toBe(SWING);
  });

  it("publishes the provider's capabilities and health so the pill can tell the truth", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_HOURS);
    selectAccount(SWING);

    const stream = reading(await get());
    await vi.advanceTimersByTimeAsync(10);
    const [snap] = frames(stream.text, "snapshot");
    expect(snap.capabilities.streaming).toBe(false);
    expect(snap.capabilities.staleness).toBe("eod");
    expect(snap.health.ok).toBe(true);
    expect(snap.marketOpen).toBe(true);
    expect(stream.text.startsWith("retry: ")).toBe(true);
  });
});

describe("ticks are coalesced, and only a streaming provider produces them", () => {
  it("holds ticks back to one frame per 250 ms and folds every symbol into it", async () => {
    process.env.VYUHA_QUOTE_PROVIDER = "mock";
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_HOURS);
    selectAccount(SWING);

    const stream = reading(await get());
    await vi.advanceTimersByTimeAsync(240);
    expect(frames(stream.text, "tick"), "nothing may be emitted inside the 250 ms window").toHaveLength(0);

    // The mock pushes one tick per symbol per second; the flush that follows
    // must be ONE frame carrying BOTH symbols, not one frame per tick.
    await vi.advanceTimersByTimeAsync(1000);
    const ticks = frames(stream.text, "tick");
    expect(ticks).toHaveLength(1);
    expect(ticks[0].provider).toBe("mock");
    expect(ticks[0].quotes.map((q: { key: { symbol: string } }) => q.key.symbol).sort()).toEqual(["HDFCBANK", "TCS"]);
  });

  it("never starts an end-of-day provider — no tick frame, ever", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_HOURS);
    selectAccount(SWING);

    const stream = reading(await get());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(frames(stream.text, "tick")).toHaveLength(0);
  });

  it("does not start a streaming provider outside 09:00–15:40 IST", async () => {
    process.env.VYUHA_QUOTE_PROVIDER = "mock";
    vi.useFakeTimers();
    vi.setSystemTime(AFTER_HOURS);
    selectAccount(SWING);

    const stream = reading(await get());
    await vi.advanceTimersByTimeAsync(10);
    expect(frames(stream.text, "snapshot")[0].marketOpen).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(frames(stream.text, "tick")).toHaveLength(0);
  });
});

describe("the heartbeat", () => {
  it("beats every 25 s on an idle end-of-day desk, and not before", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_HOURS);
    selectAccount(SWING);

    const stream = reading(await get());
    await vi.advanceTimersByTimeAsync(24_000);
    expect(frames(stream.text, "heartbeat")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(frames(stream.text, "heartbeat")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(frames(stream.text, "heartbeat")).toHaveLength(2);
    expect(frames(stream.text, "heartbeat")[0].provider).toBe("eod");
  });
});

describe("teardown", () => {
  it("closes cleanly on abort and stops every timer with it", async () => {
    process.env.VYUHA_QUOTE_PROVIDER = "mock";
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_HOURS);
    selectAccount(SWING);

    const ctrl = new AbortController();
    const stream = reading(await get({ signal: ctrl.signal }));
    await vi.advanceTimersByTimeAsync(1_300);
    const before = stream.text.length;
    expect(before).toBeGreaterThan(0);

    ctrl.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stream.done).toBe(true);
    // Not one byte more: the provider was unsubscribed and both intervals cleared.
    expect(stream.text.length).toBe(before);
  });

  it("creates no timer when the request aborts while the first snapshot is still in flight", async () => {
    // The leak this pins: `start()` checked `closed` once, before the awaits.
    // An abort during `snapshot()` ran the shutdown, and then the resumed
    // continuation subscribed the provider and created BOTH intervals on a
    // controller that was already closed — two timers per aborted connect,
    // never cleared, for the life of the process.
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_HOURS);
    selectAccount(SWING);

    let release: (q: QuoteMap) => void = () => {};
    let subscribes = 0;
    const capabilities: ProviderCapabilities = {
      id: "mock",
      label: "deferred snapshot",
      streaming: true,
      maxSubscriptions: 10,
      minSnapshotIntervalMs: 0,
      depth: 0,
      segments: ["NSE"],
      staleness: "tick",
      requiresDailyAuth: false,
      egressDescription: "None. A test double.",
    };
    stub.provider = {
      id: "mock",
      capabilities,
      snapshot: () => new Promise<QuoteMap>((resolve) => (release = resolve)),
      subscribe: () => {
        subscribes++;
        return () => {};
      },
      health: async () => ({ ok: true }),
    };

    try {
      const ctrl = new AbortController();
      const stream = reading(await get({ signal: ctrl.signal }));
      await vi.advanceTimersByTimeAsync(10); // health() resolved; snapshot pending

      ctrl.abort();
      release(new Map());
      await vi.advanceTimersByTimeAsync(10);

      expect(vi.getTimerCount(), "an aborted connect must leave no interval behind").toBe(0);
      expect(subscribes, "a closed stream must not subscribe a provider").toBe(0);
      expect(stream.text).not.toContain("event: snapshot");
    } finally {
      stub.provider = null;
    }
  });

  it("stops the provider when the consumer cancels the body instead", async () => {
    process.env.VYUHA_QUOTE_PROVIDER = "mock";
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_HOURS);
    selectAccount(SWING);

    const res = await get();
    const reader = res.body!.getReader();
    await vi.advanceTimersByTimeAsync(10);
    await reader.cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });
});

/**
 * S-X — the stored feed selection.
 *
 * `settings.live_feed_provider` is what the Settings card writes and what
 * `app/api/live/feed/route.ts` honours through `getLiveFeedProvider()`. This
 * route called `getQuoteProvider()` with NO stored value, which always resolves
 * to the end-of-day default — so the one screen that promises "My typed marks
 * — Nothing is fetched, ever" still read the stored bhavcopy.
 */
describe("the stored feed provider is the one that streams (S-X)", () => {
  it("runs a saved `manual` selection, and quotes nothing it was not typed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_HOURS);
    selectAccount(SWING);
    t.db.update(t.schema.settings).set({ liveFeedProvider: "manual" }).run();

    const stream = reading(await get());
    await vi.advanceTimersByTimeAsync(10);

    const [snap] = frames(stream.text, "snapshot");
    expect(snap.provider, "the stream ignored the saved provider").toBe("manual");
    expect(snap.capabilities.staleness).toBe("manual");
    // TCS has two stored bhavcopy sessions and no typed mark. The end-of-day
    // provider quoted it; the manual one must not — that is the whole promise.
    expect(snap.quotes).toEqual([]);

    t.db.update(t.schema.settings).set({ liveFeedProvider: "eod" }).run();
  });

  it("…and still runs the end-of-day provider when that is what is stored", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_HOURS);
    selectAccount(SWING);
    t.db.update(t.schema.settings).set({ liveFeedProvider: "eod" }).run();

    const stream = reading(await get());
    await vi.advanceTimersByTimeAsync(10);

    const [snap] = frames(stream.text, "snapshot");
    expect(snap.provider).toBe("eod");
    expect(snap.quotes.map((q: { key: { symbol: string } }) => q.key.symbol)).toEqual(["TCS"]);
  });
});

/**
 * FW-1 — the AUTOMATIC half of the once-a-day mark (owner answer Q25).
 *
 * `persistDailyMarks()` shipped in v4.1 with exactly one caller: the "Save
 * today's mark" button on the Settings card. So the "last price of the
 * session" mark that the Settings copy, the OpenAlgo disclosure and PRIVACY
 * all describe as automatic never happened on its own. Connecting the desk is
 * the moment the server holds a fresh snapshot of exactly the open positions,
 * so the catch-up runs there — on the snapshot already in hand, with no second
 * network call.
 *
 * Friday 2026-09-04 15:35 IST: after the 15:30 close AND still inside the
 * 09:00–15:40 live window, which is the only clock at which both halves of
 * this feature are live at once.
 */
describe("the day's mark is caught up on connect", () => {
  /** Friday 2026-09-04, 15:35 IST. */
  const AFTER_CLOSE = new Date("2026-09-04T10:05:00Z");

  function marks() {
    return t.db.select().from(t.schema.mtmPrices).all();
  }
  function stamp(): string | null {
    return t.db.select().from(t.schema.settings).limit(1).all()[0]?.lastLiveMarkDate ?? null;
  }
  function clearMarks() {
    t.db.update(t.schema.settings).set({ lastLiveMarkDate: null }).run();
    t.sqlite.prepare("DELETE FROM mtm_prices").run();
  }

  /** A streaming provider that is NOT the mock — the mock is a fixture, never a mark. */
  function liveProvider(ltp: number): QuoteProvider {
    const capabilities: ProviderCapabilities = {
      id: "openalgo",
      label: "bridge double",
      streaming: true,
      maxSubscriptions: 500,
      minSnapshotIntervalMs: 1000,
      depth: 0,
      segments: ["NSE"],
      staleness: "delayed",
      requiresDailyAuth: true,
      egressDescription: "None. A test double.",
    };
    return {
      id: "openalgo",
      capabilities,
      snapshot: async () =>
        new Map([
          [
            "NSE:TCS",
            {
              key: { symbol: "TCS", exchange: "NSE" as const },
              ltp,
              prevClose: null,
              dayOpen: null,
              dayHigh: null,
              dayLow: null,
              volume: null,
              asOf: AFTER_CLOSE.toISOString(),
              staleness: "delayed" as const,
              source: "openalgo" as const,
            },
          ],
        ]),
      subscribe: () => () => {},
      health: async () => ({ ok: true }),
    };
  }

  it("writes exactly one mark per position on the first connect of the day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AFTER_CLOSE);
    selectAccount(SWING);
    clearMarks();
    stub.provider = liveProvider(302_575);
    try {
      const stream = reading(await get());
      await vi.advanceTimersByTimeAsync(10);
      // The frame still ships — the mark is a side effect of connecting, never
      // a gate on it.
      expect(frames(stream.text, "snapshot")).toHaveLength(1);
      expect(marks().map((m) => [m.symbol, m.price])).toEqual([["TCS", 3025.75]]);
      expect(stamp()).toBe("2026-09-04");
    } finally {
      stub.provider = null;
    }
  });

  it("does nothing at all on the second connect — the stamp is the once-a-day rule", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AFTER_CLOSE);
    selectAccount(SWING);
    // The stamp from the test above still stands; a reconnect (or a second
    // window) must not overwrite the mark with a later price.
    stub.provider = liveProvider(999_900);
    try {
      const stream = reading(await get());
      await vi.advanceTimersByTimeAsync(10);
      expect(frames(stream.text, "snapshot")).toHaveLength(1);
      expect(marks().map((m) => m.price), "a second connect rewrote the day's mark").toEqual([3025.75]);
    } finally {
      stub.provider = null;
    }
  });

  it("never marks from an end-of-day or typed-marks provider", async () => {
    for (const provider of ["eod", "manual"]) {
      vi.useFakeTimers();
      vi.setSystemTime(AFTER_CLOSE);
      selectAccount(SWING);
      clearMarks();
      t.db.update(t.schema.settings).set({ liveFeedProvider: provider }).run();

      const stream = reading(await get());
      await vi.advanceTimersByTimeAsync(10);
      expect(frames(stream.text, "snapshot")[0].provider, provider).toBe(provider);
      // Neither has a "last price of the session" to catch: the bhavcopy IS
      // yesterday's close and a typed mark is already in `mtm_prices`.
      expect(marks(), `${provider} wrote a mark`).toHaveLength(0);
      expect(stamp(), `${provider} stamped the day`).toBe(null);
      vi.useRealTimers();
    }
    t.db.update(t.schema.settings).set({ liveFeedProvider: "eod" }).run();
  });

  it("never marks from the MOCK provider — a generated price is not a mark", async () => {
    // `mock` reports `streaming: true` because `subscribe()` really emits, so
    // the streaming flag alone would let a seeded walk be written into the
    // user's journal by any e2e run that fell after 15:30 IST on a weekday.
    process.env.VYUHA_QUOTE_PROVIDER = "mock";
    vi.useFakeTimers();
    vi.setSystemTime(AFTER_CLOSE);
    selectAccount(SWING);
    clearMarks();

    const stream = reading(await get());
    await vi.advanceTimersByTimeAsync(10);
    expect(frames(stream.text, "snapshot")[0].provider).toBe("mock");
    expect(marks()).toHaveLength(0);
    expect(stamp()).toBe(null);
  });

  it("does not mark before the close, however live the feed is", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(MARKET_HOURS); // 10:30 IST
    selectAccount(SWING);
    clearMarks();
    stub.provider = liveProvider(302_575);
    try {
      const stream = reading(await get());
      await vi.advanceTimersByTimeAsync(10);
      expect(frames(stream.text, "snapshot")).toHaveLength(1);
      // 10:30's price is not the day's close, and persisting one would make
      // every "yesterday's close" in the app mean mid-session.
      expect(marks()).toHaveLength(0);
      expect(stamp()).toBe(null);
    } finally {
      stub.provider = null;
      clearMarks();
    }
  });
});
