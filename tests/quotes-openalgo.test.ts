import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPENALGO_CAPABILITIES,
  RATE_LIMIT_PER_SECOND,
  REFRESH_SECONDS_DEFAULT,
  clampRefreshSeconds,
  createOpenAlgoProvider,
  createRateGuard,
  type FeedGateState,
  type OpenAlgoHealth,
} from "@/lib/quotes/openalgo";
import { quoteKeyId, type QuoteKey } from "@/lib/quotes/types";

/**
 * The OpenAlgo quote provider (v4.1, owner answers Q20/Q21/Q25).
 *
 * Nothing here touches a database or a network: the gate reader and `fetch`
 * are both injected, which is the whole reason the provider takes them. What
 * this file holds to account is the four properties the provider exists for —
 * paise at the edge, ticks that are never written, a 1–5 s poll that emits
 * only on change, and a self-imposed 10 req/s ceiling — plus the four health
 * states the Settings card renders.
 */

const READY: FeedGateState = { state: "ready", creds: { apiKey: "k-123", host: "http://127.0.0.1:5000" } };
const RELIANCE: QuoteKey = { symbol: "RELIANCE", exchange: "NSE" };
const TCS: QuoteKey = { symbol: "TCS", exchange: "NSE" };

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** One `/multiquotes` payload in OpenAlgo's documented nested shape. */
function results(rows: Record<string, unknown>[]) {
  return { status: "success", results: rows };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("snapshot", () => {
  it("maps rupees to integer PAISE, exactly once, at the provider edge", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        results([
          {
            symbol: "RELIANCE",
            exchange: "NSE",
            data: { ltp: 1418.35, open: 1400.1, high: 1425, low: 1398.05, prev_close: 1405.5, volume: 91234 },
          },
        ]),
      ),
    );
    const p = createOpenAlgoProvider({ readGate: async () => READY, fetchImpl: fetchImpl as unknown as typeof fetch });
    const map = await p.snapshot([RELIANCE]);
    const q = map.get(quoteKeyId(RELIANCE))!;

    expect(q.ltp).toBe(141835);
    expect(q.dayOpen).toBe(140010);
    expect(q.dayHigh).toBe(142500);
    expect(q.dayLow).toBe(139805);
    expect(q.prevClose).toBe(140550);
    expect(q.volume).toBe(91234);
    expect(q.source).toBe("openalgo");
    // A 3-second poll of an LTP is not a tick stream, and never says it is.
    expect(q.staleness).toBe("delayed");
  });

  it("posts the api key in the JSON BODY, to /api/v1/multiquotes on the stored host", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(results([])));
    const p = createOpenAlgoProvider({ readGate: async () => READY, fetchImpl: fetchImpl as unknown as typeof fetch });
    await p.snapshot([RELIANCE, TCS]);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:5000/api/v1/multiquotes");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body.apikey).toBe("k-123");
    expect(body.symbols).toEqual([
      { symbol: "RELIANCE", exchange: "NSE" },
      { symbol: "TCS", exchange: "NSE" },
    ]);
    // The key must never travel in a header or a query string.
    expect(JSON.stringify(init.headers ?? {})).not.toContain("k-123");
    expect(url).not.toContain("k-123");
  });

  it("accepts the flat row shape too — field placement is broker-plugin dependent", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(results([{ symbol: "TCS", exchange: "NSE", ltp: 3100 }])));
    const p = createOpenAlgoProvider({ readGate: async () => READY, fetchImpl: fetchImpl as unknown as typeof fetch });
    const map = await p.snapshot([TCS]);
    expect(map.get(quoteKeyId(TCS))!.ltp).toBe(310000);
    expect(map.get(quoteKeyId(TCS))!.dayOpen).toBeNull(); // absent, not zero
  });

  it("refuses a zero or missing last price rather than marking a position to nothing", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        results([
          { symbol: "RELIANCE", exchange: "NSE", data: { ltp: 0 } },
          { symbol: "TCS", exchange: "NSE", data: { ltp: null } },
        ]),
      ),
    );
    const p = createOpenAlgoProvider({ readGate: async () => READY, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await p.snapshot([RELIANCE, TCS])).size).toBe(0);
  });

  it("refuses to send anything at all when consent or the key is missing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(results([])));
    const p = createOpenAlgoProvider({
      readGate: async () => ({ state: "disabled", reason: "The OpenAlgo integration is off." }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(p.snapshot([RELIANCE])).rejects.toThrow(/integration is off/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the rate-limit guard", () => {
  it("caps Vyuha at 10 requests a second and REFUSES the eleventh — never queues it", async () => {
    const guard = createRateGuard();
    for (let i = 0; i < RATE_LIMIT_PER_SECOND; i++) expect(guard.take(1000)).toBe(true);
    expect(guard.take(1000)).toBe(false);
    // …and the window rolls, so a second later the budget is back.
    expect(guard.take(2000)).toBe(true);
  });

  it("stops the request before fetch, so a flood costs the bridge nothing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(results([])));
    const p = createOpenAlgoProvider({
      readGate: async () => READY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 5_000, // one frozen instant: every call lands in one window
    });
    for (let i = 0; i < RATE_LIMIT_PER_SECOND; i++) await p.snapshot([RELIANCE]);
    await expect(p.snapshot([RELIANCE])).rejects.toThrow(/rate guard/i);
    expect(fetchImpl).toHaveBeenCalledTimes(RATE_LIMIT_PER_SECOND);
  });
});

describe("subscribe", () => {
  it("polls at the configured interval and emits ONLY when a number changed", async () => {
    vi.useFakeTimers();
    let ltp = 100;
    const fetchImpl = vi.fn(async () =>
      jsonResponse(results([{ symbol: "RELIANCE", exchange: "NSE", data: { ltp } }])),
    );
    const p = createOpenAlgoProvider({
      readGate: async () => READY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      refreshSeconds: 2,
    });
    const seen: number[] = [];
    const stop = p.subscribe([RELIANCE], (q) => seen.push(q.ltp));

    await vi.advanceTimersByTimeAsync(2000); // first poll: a new price
    expect(seen).toEqual([10000]);
    await vi.advanceTimersByTimeAsync(2000); // unchanged: no tick at all
    expect(seen).toEqual([10000]);
    ltp = 101.5;
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen).toEqual([10000, 10150]);

    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(seen).toEqual([10000, 10150]);
    expect(() => stop()).not.toThrow(); // idempotent, by contract
  });

  it("emits nothing before the first interval — the SSE snapshot already covered it", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => jsonResponse(results([{ symbol: "RELIANCE", exchange: "NSE", ltp: 100 }])));
    const p = createOpenAlgoProvider({
      readGate: async () => READY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      refreshSeconds: 3,
    });
    const seen: number[] = [];
    const stop = p.subscribe([RELIANCE], (q) => seen.push(q.ltp));
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    stop();
  });

  it("stops on abort, and a failed poll never kills the subscription", async () => {
    vi.useFakeTimers();
    let fail = true;
    const fetchImpl = vi.fn(async () => {
      if (fail) throw new Error("ECONNREFUSED");
      return jsonResponse(results([{ symbol: "RELIANCE", exchange: "NSE", ltp: 55 }]));
    });
    const p = createOpenAlgoProvider({
      readGate: async () => READY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      refreshSeconds: 1,
    });
    const ac = new AbortController();
    const seen: number[] = [];
    p.subscribe([RELIANCE], (q) => seen.push(q.ltp), ac.signal);

    await vi.advanceTimersByTimeAsync(1000); // poll throws, nothing emitted
    expect(seen).toEqual([]);
    fail = false;
    await vi.advanceTimersByTimeAsync(1000); // the subscription survived it
    expect(seen).toEqual([5500]);

    ac.abort();
    const calls = fetchImpl.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl.mock.calls.length).toBe(calls);
  });

  it("clamps the on-screen refresh to 1–5 s whatever is stored", () => {
    expect(clampRefreshSeconds(0)).toBe(1);
    expect(clampRefreshSeconds(-9)).toBe(1);
    expect(clampRefreshSeconds(3)).toBe(3);
    expect(clampRefreshSeconds(60)).toBe(5);
    expect(clampRefreshSeconds("nonsense")).toBe(REFRESH_SECONDS_DEFAULT);
    expect(clampRefreshSeconds(undefined)).toBe(REFRESH_SECONDS_DEFAULT);
  });
});

describe("health", () => {
  const probe = () => jsonResponse({ status: "success", data: {} });

  it("says DISABLED when the integration is off or the disclosure lapsed", async () => {
    const p = createOpenAlgoProvider({
      readGate: async () => ({ state: "disabled", reason: "The OpenAlgo integration is off." }),
    });
    const h = (await p.health()) as { state: string; ok: boolean };
    expect(h.state).toBe("disabled");
    expect(h.ok).toBe(false);
  });

  it("says NO-KEY with the 20-second connect line when nothing is saved yet", async () => {
    const p = createOpenAlgoProvider({
      readGate: async () => ({ state: "no-key", reason: "Connect your feed — 20 seconds: Import → OpenAlgo." }),
    });
    const h = (await p.health()) as OpenAlgoHealth;
    expect(h.state).toBe("no-key");
    expect(h.reason).toMatch(/20 seconds/);
  });

  it("says UNREACHABLE, naming the host, when the bridge is not running", async () => {
    const p = createOpenAlgoProvider({
      readGate: async () => READY,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    const h = (await p.health()) as { state: string; ok: boolean; reason?: string };
    expect(h.state).toBe("unreachable");
    expect(h.ok).toBe(false);
    expect(h.reason).toMatch(/127\.0\.0\.1:5000/);
  });

  it("says OK with a latency, and NEVER throws", async () => {
    let t = 1000;
    const p = createOpenAlgoProvider({
      readGate: async () => READY,
      fetchImpl: (async () => {
        t += 17;
        return probe();
      }) as unknown as typeof fetch,
      now: () => t,
    });
    const h = (await p.health()) as { state: string; ok: boolean; latencyMs: number | null };
    expect(h.state).toBe("ok");
    expect(h.ok).toBe(true);
    expect(h.latencyMs).toBe(17);
  });
});

describe("ticks are never persisted", () => {
  it("the provider makes no write of any kind — the only write is persist-mark.ts", () => {
    const src = readFileSync(path.join(process.cwd(), "lib/quotes/openalgo.ts"), "utf8");
    // It READS the database: the consent pair on `settings` and the saved
    // key/host on `broker_connections` are what decide whether a request may be
    // made at all, and reading them is the gate doing its job. What it must
    // never do is WRITE — a provider that persisted anything would be the tick
    // database owner answer Q25 forbids. So the assertion is on the verbs.
    expect(src).not.toMatch(/\b(insert|update|delete)\s*\(/);
    // …and the read is LAZY. A static import of the db here would bind the
    // SQLite connection ahead of tests/helpers/temp-db.ts for every test that
    // touches the registry.
    expect(src).not.toMatch(/^import .*@\/lib\/db/m);
    expect(src).toMatch(/await import\("@\/lib\/db"\)/);
  });

  it("declares its egress as the user's own bridge, and names no remote host", () => {
    expect(OPENALGO_CAPABILITIES.egressDescription).toMatch(/127\.0\.0\.1/);
    expect(OPENALGO_CAPABILITIES.egressDescription).toMatch(/host you configured/i);
    expect(OPENALGO_CAPABILITIES.requiresDailyAuth).toBe(true);
    expect(OPENALGO_CAPABILITIES.streaming).toBe(true);
  });
});
