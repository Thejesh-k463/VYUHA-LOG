import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import type { QuoteProvider } from "@/lib/quotes/types";

/**
 * THE PROVIDER CONFORMANCE SUITE — one set of assertions, run against every
 * provider v4.0 ships (03D §1.2). A provider that cannot pass it is not
 * selectable, because the desk renders `staleness`, `asOf` and `source`
 * literally: a provider that lies in any of the three makes the UI lie.
 *
 * The two DB-backed providers run against a real temp database (ONE per file —
 * `lib/db` caches its connection on globalThis), and every import of a module
 * that can reach `lib/db` is DYNAMIC and happens after `openTempDb()`.
 */

let t: TempDb;
let mock: QuoteProvider;
let manual: QuoteProvider;
let eod: QuoteProvider;
let quotes: typeof import("@/lib/quotes");

const KEYS = [
  { symbol: "TCS", exchange: "NSE" as const },
  { symbol: "INFY", exchange: "NSE" as const },
];

beforeAll(async () => {
  t = await openTempDb("quotes-provider", { seed: true });
  quotes = await import("@/lib/quotes");

  t.db
    .insert(t.schema.priceHistory)
    .values([
      { symbol: "TCS", date: "2026-09-03", close: 3010.25, high: 3020, low: 3000 },
      { symbol: "TCS", date: "2026-09-04", close: 3025.75, high: 3030, low: 3005.5 },
      { symbol: "INFY", date: "2026-09-04", close: 1499.9, high: 1510, low: 1490 },
    ])
    .run();
  t.db
    .insert(t.schema.mtmPrices)
    .values([
      { symbol: "TCS", tradingsymbol: "TCS", price: 3100, asOfDate: "2026-09-03" },
      { symbol: "TCS", tradingsymbol: "TCS", price: 3120.4, asOfDate: "2026-09-04" },
    ])
    .run();

  mock = quotes.createMockProvider({ seed: 7, intervalMs: 1000, now: () => Date.parse("2026-09-04T10:00:00Z") });
  manual = quotes.createManualProvider();
  eod = quotes.createEodBhavcopyProvider();
});

afterAll(() => t?.cleanup());

describe.each([
  ["mock", () => mock],
  ["manual", () => manual],
  ["eod", () => eod],
])("conformance — %s", (_name, get) => {
  it("agrees with its own capability block about who it is", () => {
    const p = get();
    expect(p.id).toBe(p.capabilities.id);
    expect(p.capabilities.label.length).toBeGreaterThan(0);
    expect(p.capabilities.egressDescription.length).toBeGreaterThan(0);
  });

  it("answers an empty key set with an empty map, not a throw", async () => {
    await expect(get().snapshot([])).resolves.toEqual(new Map());
  });

  it("returns paise integers stamped with its own source and staleness floor", async () => {
    const p = get();
    const snap = await p.snapshot(KEYS);
    expect(snap.size).toBeGreaterThan(0);
    for (const [id, q] of snap) {
      expect(id).toBe(`${q.key.exchange}:${q.key.tradingsymbol ?? q.key.symbol}`);
      expect(Number.isInteger(q.ltp)).toBe(true);
      expect(q.ltp).toBeGreaterThan(0);
      expect(q.source).toBe(p.id);
      expect(q.staleness).toBe(p.capabilities.staleness);
      expect(Number.isNaN(Date.parse(q.asOf))).toBe(false);
    }
  });

  it("never invents a quote for a symbol it has nothing for", async () => {
    const snap = await get().snapshot([{ symbol: "NOSUCHSCRIP", exchange: "NSE" }]);
    // The mock generates prices for anything; the DB-backed two must not.
    if (get().id !== "mock") expect(snap.size).toBe(0);
  });

  it("health() resolves instead of throwing, and says why when it cannot run", async () => {
    const h = await get().health();
    expect(typeof h.ok).toBe("boolean");
    if (!h.ok) expect((h.reason ?? "").length).toBeGreaterThan(0);
  });

  it("hands back an unsubscribe that is safe to call twice", () => {
    const stop = get().subscribe(KEYS, () => {});
    expect(typeof stop).toBe("function");
    stop();
    expect(() => stop()).not.toThrow();
  });
});

describe("MockProvider — deterministic, and the only provider tests ever see", () => {
  it("gives two providers built with the same seed the same prices", async () => {
    const a = quotes.createMockProvider({ seed: 42, now: () => 0 });
    const b = quotes.createMockProvider({ seed: 42, now: () => 0 });
    expect([...(await a.snapshot(KEYS)).values()].map((q) => q.ltp)).toEqual(
      [...(await b.snapshot(KEYS)).values()].map((q) => q.ltp),
    );
  });

  it("gives two different symbols different levels, and a different seed a different walk", async () => {
    const [tcs, infy] = [...(await quotes.createMockProvider({ seed: 42 }).snapshot(KEYS)).values()];
    expect(tcs.ltp).not.toBe(infy.ltp);

    // Drive the walk through the injected scheduler — no wall clock, no flake.
    const walk = (seed: number) => {
      let fire = () => {};
      const p = quotes.createMockProvider({ seed, schedule: (fn) => ((fire = fn), () => {}) });
      const seen: number[] = [];
      p.subscribe(KEYS, (q) => seen.push(q.ltp));
      fire();
      fire();
      return seen;
    };
    expect(walk(1)).toHaveLength(4);
    expect(walk(1)).toEqual(walk(1));
    expect(walk(1)).not.toEqual(walk(2));
  });

  it("stops emitting the moment unsubscribe is called", () => {
    let fire: (() => void) | null = null;
    const p = quotes.createMockProvider({
      seed: 3,
      schedule: (fn) => {
        fire = fn;
        return () => {
          fire = null;
        };
      },
    });
    const seen: number[] = [];
    const stop = p.subscribe(KEYS, (q) => seen.push(q.ltp));
    fire!();
    expect(seen).toHaveLength(2);
    stop();
    expect(fire).toBeNull();
  });

  it("stops when the request's AbortSignal fires — the stream owns the provider's lifetime", () => {
    const ctrl = new AbortController();
    let live = false;
    const p = quotes.createMockProvider({
      schedule: () => {
        live = true;
        return () => {
          live = false;
        };
      },
    });
    p.subscribe(KEYS, () => {}, ctrl.signal);
    expect(live).toBe(true);
    ctrl.abort();
    expect(live).toBe(false);
  });
});

describe("ManualMarkProvider — the marks the user typed", () => {
  it("reads the LATEST mark per symbol out of mtm_prices, with its own as-of date", async () => {
    const q = (await manual.snapshot(KEYS)).get("NSE:TCS")!;
    expect(q.ltp).toBe(312040); // 2026-09-04's 3120.40, not 2026-09-03's 3100
    expect(q.asOf).toBe("2026-09-04T15:30:00+05:30");
    expect(q.staleness).toBe("manual");
  });

  it("is silent about a symbol with no mark rather than substituting a price", async () => {
    expect((await manual.snapshot(KEYS)).has("NSE:INFY")).toBe(false);
  });

  it("never pushes: streaming is false and subscribe emits nothing", () => {
    expect(manual.capabilities.streaming).toBe(false);
    const seen: unknown[] = [];
    manual.subscribe(KEYS, (q) => seen.push(q))();
    expect(seen).toHaveLength(0);
  });

  it("reports a reason instead of throwing when the reader fails", async () => {
    const broken = quotes.createManualProvider(async () => {
      throw new Error("database is locked");
    });
    await expect(broken.health()).resolves.toEqual({ ok: false, reason: "database is locked" });
  });

  it("reports 'no marks yet' as a reason, not as an empty success", async () => {
    const empty = quotes.createManualProvider(async () => []);
    const h = await empty.health();
    expect(h.ok).toBe(false);
    expect(h.reason).toMatch(/no marks/i);
  });
});

describe("EodBhavcopyProvider — the default, and it fetches nothing", () => {
  it("quotes the latest stored session with the previous close beside it", async () => {
    const q = (await eod.snapshot(KEYS)).get("NSE:TCS")!;
    expect(q.ltp).toBe(302575);
    expect(q.prevClose).toBe(301025);
    expect(q.asOf).toBe("2026-09-04T15:30:00+05:30");
  });

  it("leaves prevClose null for a symbol with one stored session", async () => {
    expect((await eod.snapshot(KEYS)).get("NSE:INFY")!.prevClose).toBeNull();
  });

  it("declares itself non-streaming, so the UI can never claim 'live'", () => {
    expect(eod.capabilities.streaming).toBe(false);
    expect(eod.capabilities.staleness).toBe("eod");
  });

  it("reports coverage when it has bars, and the reason when it has none", async () => {
    const h = await eod.health();
    expect(h.ok).toBe(true);
    expect(h.reason).toMatch(/2026-09-04/);

    const bare = quotes.createEodBhavcopyProvider(
      async () => new Map(),
      async () => ({ symbols: 0, rows: 0, lastDate: null }),
    );
    const none = await bare.health();
    expect(none.ok).toBe(false);
    expect(none.reason).toMatch(/import a bhavcopy/i);
  });
});
