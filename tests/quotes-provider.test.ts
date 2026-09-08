import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import type { QuoteKey, QuoteProvider } from "@/lib/quotes/types";
// TYPE-ONLY, and it must stay that way: a value import of a `lib/quotes`
// module here would bind the SQLite connection before `openTempDb()` runs.
import type { UpstoxGetter } from "@/lib/quotes/upstox";
import type { AngelOneHealth, AngelQuoteFetcher } from "@/lib/quotes/angelone";
import type { AngelTokenCache, ResolvedAngelToken } from "@/lib/quotes/angelone-tokens";

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
let upstox: QuoteProvider;
let angelone: QuoteProvider;
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

  /**
   * The v4.2 Upstox adapter, run against the SAME conformance assertions with
   * its gate, its clock and its HTTPS GET injected — no socket is opened. The
   * recorded payload is the documented v3 `market-quote/ltp` shape: keyed by
   * SEGMENT:TRADINGSYMBOL, each value repeating the instrument key that was
   * SENT in `instrument_token`, which is what the adapter indexes on.
   */
  const ISINS: Record<string, string> = { TCS: "INE467B01029", INFY: "INE009A01021" };
  upstox = quotes.createUpstoxProvider({
    readGate: async () => ({ state: "ready", creds: { accessToken: "analytics-token" } }),
    isinOf: (symbol) => ISINS[symbol] ?? null,
    now: () => Date.parse("2026-09-04T10:00:00Z"),
    getImpl: (async (path: string) =>
      path.startsWith("/v3/market-quote/ohlc")
        ? {
            "NSE_EQ:TCS": {
              instrument_token: "NSE_EQ|INE467B01029",
              live_ohlc: { open: 3005.5, high: 3030, low: 3000, close: 3025.75 },
            },
          }
        : {
            "NSE_EQ:TCS": { last_price: 3025.75, instrument_token: "NSE_EQ|INE467B01029", cp: 3010.25, volume: 4567 },
            "NSE_EQ:INFY": { last_price: 1499.9, instrument_token: "NSE_EQ|INE009A01021", cp: 1490, volume: 987 },
          }) as UpstoxGetter,
  });

  /**
   * The v4.2 Angel One adapter, run against the SAME conformance assertions
   * with its gate, its clock, its pacing, its login, its symbol search and its
   * token cache injected — no socket is opened and no login is minted twice.
   *
   * The recorded payload is the documented OHLC-mode shape: `fetched` rows
   * keyed by the exchange TOKEN that was sent, with `close` carrying the
   * PREVIOUS session's close. `sleep` advances the fake clock, which is what
   * makes the adapter's own one-request-a-second pacing satisfiable inside a
   * test that takes no wall-clock time.
   */
  const ANGEL_TOKENS: ResolvedAngelToken[] = [
    { exchange: "NSE", symbol: "TCS", tradingsymbol: "TCS-EQ", token: "11536" },
    { exchange: "NSE", symbol: "INFY", tradingsymbol: "INFY-EQ", token: "1594" },
  ];
  const ANGEL_ROWS: Record<string, { ltp: number; open: number; high: number; low: number; close: number }> = {
    "11536": { ltp: 3025.75, open: 3005.5, high: 3030, low: 3000, close: 3010.25 },
    "1594": { ltp: 1499.9, open: 1495, high: 1510, low: 1490, close: 1490 },
  };
  let angelClock = Date.parse("2026-09-04T10:00:00Z");
  const angelCache: AngelTokenCache = {
    async read(pairs) {
      const out = new Map<string, ResolvedAngelToken>();
      for (const p of pairs) {
        const hit = ANGEL_TOKENS.find((r) => r.exchange === p.exchange && r.symbol === p.symbol);
        if (hit) out.set(`${p.exchange}:${p.symbol}`, hit);
      }
      return out;
    },
    async write() {},
  };
  angelone = quotes.createAngelOneProvider({
    readGate: async () => ({
      state: "ready",
      creds: { apiKey: "smart-key", clientCode: "C1", pin: "1234", totpSecret: "JBSWY3DPEHPK3PXP" },
    }),
    now: () => angelClock,
    sleep: async (ms) => {
      angelClock += ms;
    },
    loginImpl: async () => ({ jwtToken: "jwt-conformance" }),
    tokenCache: angelCache,
    // Nothing this suite asks for is outside the cache, so a search would only
    // ever be the NOSUCHSCRIP case — which must come back with no rows.
    searchImpl: async () => [],
    quoteImpl: (async (_creds, _jwt, batch) => ({
      fetched: batch.tokens
        .filter((t) => t in ANGEL_ROWS)
        .map((t) => ({ exchange: batch.exchange, symbolToken: t, ...ANGEL_ROWS[t] })),
      unfetched: batch.tokens.filter((t) => !(t in ANGEL_ROWS)),
    })) as AngelQuoteFetcher,
  });
});

afterAll(() => t?.cleanup());

describe.each([
  ["mock", () => mock],
  ["manual", () => manual],
  ["eod", () => eod],
  ["upstox", () => upstox],
  ["angelone", () => angelone],
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

describe("migration 0069 — settings.live_feed_ack_json, on a really migrated database", () => {
  /**
   * A hand-written migration with no `drizzle/meta/_journal.json` entry is
   * SILENTLY SKIPPED (AGENTS.md, migrations 0027+), and the failure then
   * surfaces as a SQLite "no such column" the first time the desk asks which
   * feed may run. This asserts the column exists where it matters — in a
   * database built by running the migrations — and that `resolveLiveFeed()`
   * reads it.
   */
  it("exists on the migrated schema and is null until somebody accepts a sheet", () => {
    const cols = t.sqlite.prepare("PRAGMA table_info(settings)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain("live_feed_ack_json");
    const row = t.db.select({ ack: t.schema.settings.liveFeedAckJson }).from(t.schema.settings).limit(1).all()[0];
    expect(row?.ack ?? null).toBeNull();
  });

  it("is what decides whether a stored 'upstox' selection may actually run", async () => {
    const registry = await import("@/lib/quotes/registry");
    const { withFeedAck } = await import("@/lib/domain/live-feed-disclosure");

    t.db.update(t.schema.settings).set({ liveFeedProvider: "upstox", liveFeedAckJson: null }).run();
    const blocked = await registry.resolveLiveFeed();
    expect(blocked.stored).toBe("upstox");
    expect(blocked.effective, "no acknowledgement means no broker feed").toBe("eod");
    expect(blocked.blockedReason).toMatch(/disclosure/i);

    t.db.update(t.schema.settings).set({ liveFeedAckJson: withFeedAck(null, "upstox") }).run();
    const allowed = await registry.resolveLiveFeed();
    expect(allowed.effective).toBe("upstox");
    expect(allowed.blockedReason).toBeUndefined();

    // Leave the row as the rest of the file found it.
    t.db.update(t.schema.settings).set({ liveFeedProvider: "eod", liveFeedAckJson: null }).run();
  });
});

/* ═══════ ONE LIVE-FEED INSTANCE PER PROCESS (v4.2 fix A-2) ════════════════
 * `getLiveFeedProvider()` has four callers on one /live visit — the SSR desk
 * load, every EventSource open, the Settings health line and "Save today's
 * mark" — and the session, the rate guard, the hourly budget and `lastError`
 * all live INSIDE the instance. A factory call per caller therefore meant a
 * login per caller, a ceiling per caller, and a health line from an instance
 * that had never made a request. These tests drive the REAL registry against
 * the REAL Angel One adapter over a stubbed `fetch`, so the login is counted
 * where it actually happens: no socket is opened, and the credential is a
 * fixture.
 */
describe("the live feed is one instance per process, not one per caller", () => {
  let registry: typeof import("@/lib/quotes/registry");
  let ANGEL_ACK: string;
  let UPSTOX_ACK: string;

  /** Counted per request KIND, which is what the consent sheet promises. */
  let logins = 0;
  let quoteCalls = 0;
  let loginWorks = true;

  const TCS_ONLY: QuoteKey[] = [{ symbol: "TCS", exchange: "NSE" }];

  const envelope = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  /** The SmartAPI wire, recorded — login, then the OHLC quote, and nothing else. */
  const stubbedFetch = async (input: unknown): Promise<Response> => {
    const url = String(input);
    if (url.includes("/rest/auth/angelbroking/user/v1/loginByPassword")) {
      logins += 1;
      return loginWorks
        ? envelope({ status: true, data: { jwtToken: `jwt-${logins}` } })
        : envelope({ status: false, message: "Invalid totp" });
    }
    if (url.includes("/rest/secure/angelbroking/market/v1/quote/")) {
      quoteCalls += 1;
      return envelope({
        status: true,
        data: {
          fetched: [
            { exchange: "NSE", symbolToken: "11536", ltp: 3025.75, open: 3005.5, high: 3030, low: 3000, close: 3010.25 },
          ],
          unfetched: [],
        },
      });
    }
    throw new Error(`the adapter asked for something nobody stubbed: ${url}`);
  };

  beforeAll(async () => {
    registry = await import("@/lib/quotes/registry");
    const { withFeedAck } = await import("@/lib/domain/live-feed-disclosure");
    ANGEL_ACK = withFeedAck(null, "angelone");
    UPSTOX_ACK = withFeedAck(ANGEL_ACK, "upstox");

    t.db
      .insert(t.schema.brokerConnections)
      .values({
        accountId: 1,
        broker: "angelone",
        apiKey: "smartapi-key",
        accessToken: "unused-by-the-feed",
        authJson: JSON.stringify({ clientCode: "C1", pin: "1234", totpSecret: "JBSWY3DPEHPK3PXP" }),
        updatedAt: "2026-09-07T04:00:00.000Z",
      })
      .run();
    // Pre-resolved, so the poll is a login plus ONE quote request: searchScrip
    // is the resolver's business and `tests/angelone-tokens.test.ts` owns it.
    t.db
      .insert(t.schema.angeloneInstrumentTokens)
      .values({ exchange: "NSE", symbol: "TCS", tradingsymbol: "TCS-EQ", token: "11536" })
      .run();
    t.db
      .update(t.schema.settings)
      .set({ liveFeedProvider: "angelone", liveFeedAckJson: ANGEL_ACK, liveFeedRefreshSeconds: 3 })
      .run();
    vi.stubGlobal("fetch", stubbedFetch);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    registry.resetLiveFeedProviderCache();
    t.db.update(t.schema.settings).set({ liveFeedProvider: "eod", liveFeedAckJson: null }).run();
    t.db.delete(t.schema.brokerConnections).run();
    t.db.delete(t.schema.angeloneInstrumentTokens).run();
  });

  it(
    "hands two callers the SAME provider, so one visit is one Angel One sign-in",
    async () => {
      registry.resetLiveFeedProviderCache();
      logins = 0;
      quoteCalls = 0;

      // The two callers the /live visit really makes: the SSR desk load and
      // the EventSource the browser opens a moment later.
      const ssr = await registry.getLiveFeedProvider();
      const stream = await registry.getLiveFeedProvider();
      expect(ssr.id).toBe("angelone");
      expect(stream, "a second caller must not build a second session").toBe(ssr);

      expect((await ssr.snapshot(TCS_ONLY)).get("NSE:TCS")!.ltp).toBe(302575);
      expect((await stream.snapshot(TCS_ONLY)).get("NSE:TCS")!.ltp).toBe(302575);

      // The consent sheet says the account is "signed in at most once a day
      // while Vyuha stays open" — a PROCESS rule since fix wave 2, and this
      // cache is the process it is a rule about. That is the sentence, counted
      // on the wire.
      expect(logins, "one visit, one login").toBe(1);
      expect(quoteCalls).toBe(2);
    },
    20_000,
  );

  it("keeps the instance across the slider and the OTHER broker's consent; rebuilds it when the connection row changes (S-2)", async () => {
    registry.resetLiveFeedProviderCache();
    const base = await registry.getLiveFeedProvider();
    expect(await registry.getLiveFeedProvider(), "nothing changed, so nothing is rebuilt").toBe(base);

    // Since fix wave 5 the memo key is PER PROVIDER (ruling S-2, 2026-09-08):
    // Angel One never reads the slider (its cadence is the open-position count,
    // ruling 4.2-4), so the slider is not in its key and moving it is not a
    // sign-in. Before this wave it was — an undisclosed trigger.
    t.db.update(t.schema.settings).set({ liveFeedRefreshSeconds: 5 }).run();
    const afterSlider = await registry.getLiveFeedProvider();
    expect(afterSlider, "the slider rebuilt an Angel One instance that never reads it (S-2)").toBe(base);

    // A SECOND sheet accepted into the same column (migration 0069 holds both
    // brokers) is the OTHER broker's consent: the Angel One key carries only
    // its own ack entry, so this instance — and its session — stay put.
    t.db.update(t.schema.settings).set({ liveFeedAckJson: UPSTOX_ACK }).run();
    const afterAck = await registry.getLiveFeedProvider();
    expect(afterAck, "the Upstox acknowledgement rebuilt the Angel One instance (S-2)").toBe(base);
    expect(await registry.getLiveFeedProvider(), "and it is still reused").toBe(afterAck);

    // A re-saved credential — the case a stale jwt would survive.
    t.db
      .update(t.schema.brokerConnections)
      .set({ apiKey: "smartapi-key-regenerated", updatedAt: "2026-09-07T05:00:00.000Z" })
      .run();
    const afterCredential = await registry.getLiveFeedProvider();
    expect(afterCredential).not.toBe(afterAck);
    expect(await registry.getLiveFeedProvider()).toBe(afterCredential);

    // Put the settings back the way the block found them.
    t.db.update(t.schema.settings).set({ liveFeedRefreshSeconds: 3, liveFeedAckJson: ANGEL_ACK }).run();
  });

  it(
    "reports the FAILED sign-in on the health line, because it is the instance that failed",
    async () => {
      registry.resetLiveFeedProviderCache();
      logins = 0;
      loginWorks = false;
      try {
        const desk = await registry.getLiveFeedProvider();
        await expect(desk.snapshot(TCS_ONLY)).rejects.toThrow(/TOTP/i);

        // The Settings card asks a moment later. A fresh instance would have
        // no memory of the failure and would say "connected" with zero
        // requests made — which is exactly what this cache exists to stop.
        const settingsCard = await registry.getLiveFeedProvider();
        const health = (await settingsCard.health()) as AngelOneHealth;
        expect(health.ok).toBe(false);
        expect(health.state).toBe("unreachable");
        expect(health.reason).toMatch(/TOTP/i);
        // …and the wrong TOTP was not re-sent by the second caller.
        expect(logins).toBe(1);
      } finally {
        loginWorks = true;
        registry.resetLiveFeedProviderCache();
      }
    },
    20_000,
  );
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

  /**
   * A-1 (owner ruling 2026-09-07, "drop the symbol rung for derivatives"), the
   * QUOTE door of the same defect `storedMarkFor()` closes on the stored-mark
   * door: `mtm_prices` is keyed on the UNDERLYING, so resolving an option key
   * by `symbol` marks the premium at the underlying's cash mark — and on the
   * desk a quote OUTRANKS the stored mark, so this door alone still returns
   * the wrong number. `eod-bhavcopy.ts` has filtered by `isCashKey()` since it
   * was written; this provider is the one that never did.
   */
  it("gives a derivative key NO quote from the underlying's typed mark (A-1)", async () => {
    const snap = await manual.snapshot([
      { symbol: "TCS", exchange: "NFO", tradingsymbol: "OPT TCS 30 Jun 2026 2500 CE" },
      { symbol: "TCS", exchange: "NSE" },
    ]);
    expect(snap.has("NFO:OPT TCS 30 JUN 2026 2500 CE")).toBe(false);
    // …and the cash key of the same underlying still reads its own mark.
    expect(snap.get("NSE:TCS")!.ltp).toBe(312040);
  });

  it("quotes a derivative ONLY from a mark typed under the contract's own tradingsymbol", async () => {
    // The store holds both the underlying's cash mark and a mark for the
    // contract itself; the contract must read ₹2.75, never ₹2,057.50.
    const p = quotes.createManualProvider(async () => [
      { symbol: "TCS", tradingsymbol: "TCS", price: 2057.5, asOfDate: "2026-09-04" },
      { symbol: "TCS", tradingsymbol: "OPT TCS 30 JUN 2026 2500 CE", price: 2.75, asOfDate: "2026-09-04" },
    ]);
    const snap = await p.snapshot([
      { symbol: "TCS", exchange: "NFO", tradingsymbol: "OPT TCS 30 Jun 2026 2500 CE" },
      { symbol: "TCS", exchange: "NSE" },
    ]);
    expect(snap.get("NFO:OPT TCS 30 JUN 2026 2500 CE")!.ltp).toBe(275);
    expect(snap.get("NSE:TCS")!.ltp).toBe(205750);
  });

  it("gives a derivative key with no tradingsymbol nothing at all, not the underlying", async () => {
    // `quoteKeyId()` falls back to `symbol`, so the contract-only rung must not
    // fall back with it — that would restore the symbol rung through the back
    // door for a future keyed without its contract name.
    const p = quotes.createManualProvider(async () => [
      { symbol: "TCS", tradingsymbol: "TCS", price: 2057.5, asOfDate: "2026-09-04" },
    ]);
    const snap = await p.snapshot([{ symbol: "TCS", exchange: "NFO" }]);
    expect(snap.has("NFO:TCS")).toBe(false);
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

  it("gives a derivative key NO quote — a cash bar is not a contract price (M1)", async () => {
    // An option on TCS must come back absent, so the desk shows its "no mark"
    // state; marking it at TCS's ₹3,025.75 close is a silent wrong number on
    // every figure the position touches.
    const snap = await eod.snapshot([
      { symbol: "TCS", exchange: "NFO", tradingsymbol: "TCS26SEP3000CE" },
      { symbol: "TCS", exchange: "NSE" },
    ]);
    expect(snap.has("NFO:TCS26SEP3000CE")).toBe(false);
    // …and the cash key of the same underlying is unaffected.
    expect(snap.get("NSE:TCS")!.ltp).toBe(302575);
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

/* ═══════ A WITHHELD FEED, READ OFF A REAL DATABASE (v4.2 fix wave 2) ═══════
 * The pure half of this lives in `tests/quotes-registry.test.ts`. This is the
 * half that only a real `settings` row can show: `resolveLiveFeed()` publishes
 * the verdict AND the sentence the Settings card prints, and before the fix a
 * withheld pick with a CURRENT acknowledgement came back
 * {stored:"angelone", effective:"angelone"} with no `blockedReason` at all —
 * so the card showed no radio, no block, and said nothing about it anywhere.
 *
 * LAST IN THE FILE ON PURPOSE: `vi.resetModules()` gives every later import a
 * fresh module registry, and `lib/db` caches its connection on `globalThis`,
 * so the re-imported registry reads the very same temp database.
 * ════════════════════════════════════════════════════════════════════════ */
describe("resolveLiveFeed on a build that withholds the stored feed", () => {
  it("answers 'eod' with a reason, and the reason names no source-file constant", async () => {
    const { withFeedAck } = await import("@/lib/domain/live-feed-disclosure");
    t.db
      .update(t.schema.settings)
      .set({ liveFeedProvider: "angelone", liveFeedAckJson: withFeedAck(null, "angelone") })
      .run();

    // CONTROL, as this build ships: the acknowledgement really does open it.
    const shipped = await import("@/lib/quotes/registry");
    shipped.resetLiveFeedProviderCache();
    const on = await shipped.resolveLiveFeed();
    expect(on.stored).toBe("angelone");
    expect(on.effective).toBe("angelone");

    vi.resetModules();
    vi.doMock("@/lib/quotes/types", async () => ({
      ...(await vi.importActual<typeof import("@/lib/quotes/types")>("@/lib/quotes/types")),
      ANGELONE_FEED_ENABLED: false,
    }));
    try {
      const off = await import("@/lib/quotes/registry");
      const feed = await off.resolveLiveFeed();
      expect(feed.stored, "the pick is still reported verbatim").toBe("angelone");
      expect(feed.effective, "a withheld feed was left effective by a stored consent").toBe("eod");
      expect(feed.blockedReason, "the withheld state was stated nowhere on the screen").toBe(
        "This build does not offer the Angel One feed; the desk stays on end-of-day prices.",
      );
      // …and the provider the desk then builds is end-of-day, not the PLANNED
      // stub whose sentence names the constant to a paying customer.
      const built = off.createProvider(feed.effective);
      expect(built.id).toBe("eod");
      expect((await built.health()).reason ?? "").not.toContain("ANGELONE_FEED_ENABLED");
    } finally {
      vi.doUnmock("@/lib/quotes/types");
      vi.resetModules();
      t.db.update(t.schema.settings).set({ liveFeedProvider: "eod", liveFeedAckJson: null }).run();
      (await import("@/lib/quotes/registry")).resetLiveFeedProviderCache();
    }
  });
});
