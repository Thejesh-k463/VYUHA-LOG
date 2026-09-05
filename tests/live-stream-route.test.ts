import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

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
