import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANGELONE_CAPABILITIES,
  ANGELONE_HOURLY_BUDGET,
  ANGELONE_MAX_TOKENS_PER_CALL,
  ANGELONE_RATE_LIMIT_PER_SECOND,
  angelOneFeedErrorMessage,
  angelOneSessionExpiresAt,
  createAngelOneProvider,
  createHourlyBudget,
  isAngelSessionInvalid,
  planAngelOneBatches,
  quoteFromAngelOne,
  type AngelOneGateState,
  type AngelOneHealth,
  type AngelQuoteBatch,
  type AngelQuoteData,
  type AngelQuoteFetcher,
} from "@/lib/quotes/angelone";
import type { AngelTokenCache, ResolvedAngelToken } from "@/lib/quotes/angelone-tokens";
import type { AngelOneCredentials } from "@/lib/import/api/angelone";
import {
  ANGELONE_CADENCE_TIERS,
  angelOneCadenceSeconds,
  type QuoteKey,
  type QuoteProvider,
} from "@/lib/quotes/types";

/**
 * THE ANGEL ONE LIVE FEED (v4.2, rulings 4.2-4, 4.2-7, 4.2-8, 4.2-9).
 *
 * NO SOCKET IS OPENED ANYWHERE IN THIS FILE and no database is touched: the
 * gate, the login, the quote request, the symbol search and the token cache are
 * all injected, and the clock is an argument. What is exercised is the
 * behaviour that costs money when it is wrong — the batch cap, the two
 * ceilings, the daily session, and the refusal to fill a missing price with a
 * zero.
 *
 * The fake clock is advanced BY THE PACING ITSELF: `sleep` adds the requested
 * milliseconds, so a test that asserts "these two requests were a second apart"
 * is asserting the real pacing rather than a stubbed one.
 */

const CREDS: AngelOneCredentials = { apiKey: "k", clientCode: "C1", pin: "1234", totpSecret: "JBSWY3DPEHPK3PXP" };
const READY: AngelOneGateState = { state: "ready", creds: CREDS };

/** 2026-09-07 09:30 IST — a Monday morning, inside the session. */
const T0 = Date.parse("2026-09-07T04:00:00Z");

const KEY = (symbol: string, exchange: "NSE" | "BSE" = "NSE"): QuoteKey => ({ symbol, exchange });

function tokenOf(symbol: string, exchange: "NSE" | "BSE", token: string): ResolvedAngelToken {
  return { exchange, symbol, tradingsymbol: `${symbol}-EQ`, token };
}

/** A cache that already knows every pair handed to it — zero lookups. */
function seededCache(rows: readonly ResolvedAngelToken[]): AngelTokenCache {
  const store = new Map(rows.map((r) => [`${r.exchange}:${r.symbol}`, r]));
  return {
    async read(pairs) {
      const out = new Map<string, ResolvedAngelToken>();
      for (const p of pairs) {
        const hit = store.get(`${p.exchange}:${p.symbol}`);
        if (hit) out.set(`${p.exchange}:${p.symbol}`, hit);
      }
      return out;
    },
    async write() {},
  };
}

interface Harness {
  provider: QuoteProvider;
  /** Every quote request, with the fake-clock instant it was allowed to go. */
  sent: { batch: AngelQuoteBatch; at: number }[];
  logins: number;
  now: () => number;
  advance: (ms: number) => void;
}

function harness(
  opts: {
    tokens?: readonly ResolvedAngelToken[];
    respond?: (batch: AngelQuoteBatch) => AngelQuoteData | null;
    login?: () => Promise<{ jwtToken: string }>;
    gate?: AngelOneGateState;
    startAt?: number;
  } = {},
): Harness {
  let clock = opts.startAt ?? T0;
  const sent: { batch: AngelQuoteBatch; at: number }[] = [];
  const state = { logins: 0 };
  const quoteImpl: AngelQuoteFetcher = async (_creds, _jwt, batch) => {
    sent.push({ batch, at: clock });
    return opts.respond ? opts.respond(batch) : { fetched: [], unfetched: [] };
  };
  const provider = createAngelOneProvider({
    readGate: async () => opts.gate ?? READY,
    now: () => clock,
    // The pacing IS the clock here: nothing waits on a real timer.
    sleep: async (ms) => {
      clock += ms;
    },
    loginImpl: async () => {
      state.logins += 1;
      return opts.login ? opts.login() : { jwtToken: `jwt-${state.logins}` };
    },
    quoteImpl,
    tokenCache: seededCache(opts.tokens ?? []),
    searchImpl: async () => [],
  });
  return {
    provider,
    sent,
    get logins() {
      return state.logins;
    },
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
  };
}

/* ─────────────────────────────── the cadence ────────────────────────────── */

describe("the cadence ladder — the book's size, not a slider (ruling 4.2-4)", () => {
  it("steps at exactly 50, 200 and 500 open positions", () => {
    expect(angelOneCadenceSeconds(0)).toBe(3);
    expect(angelOneCadenceSeconds(1)).toBe(3);
    expect(angelOneCadenceSeconds(50)).toBe(3);
    expect(angelOneCadenceSeconds(51)).toBe(5);
    expect(angelOneCadenceSeconds(200)).toBe(5);
    expect(angelOneCadenceSeconds(201)).toBe(10);
    expect(angelOneCadenceSeconds(500)).toBe(10);
    // Past the last tier the SLOWEST cadence stands — speeding up in response
    // to "too many positions" is the wrong direction.
    expect(angelOneCadenceSeconds(501)).toBe(10);
    expect(angelOneCadenceSeconds(5000)).toBe(10);
    // A nonsense count sizes a timer, never a price.
    expect(angelOneCadenceSeconds(-3)).toBe(3);
    expect(angelOneCadenceSeconds(Number.NaN)).toBe(3);
  });

  it("gives every batch of every tier a whole second of wire time", () => {
    // This is WHY the tiers are 3/5/10 and not 1/2/3: at 50 tokens a request
    // and one request a second, a book of N needs ceil(N/50) seconds before it
    // can be re-polled at all.
    for (const tier of ANGELONE_CADENCE_TIERS) {
      const requests = Math.ceil(tier.maxOpenPositions / ANGELONE_MAX_TOKENS_PER_CALL);
      expect(requests, `tier ${tier.seconds}s`).toBeLessThanOrEqual(tier.seconds);
    }
  });

  it("IGNORES the refresh slider — it is accepted and not consulted", async () => {
    // The registry hands every provider the stored slider value. Angel One's
    // interval must be the cadence ladder whatever it is told.
    const seen: number[] = [];
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((fn: () => void, ms: number) => {
      seen.push(ms);
      return realSetInterval(fn, 1_000_000);
    }) as typeof setInterval;
    try {
      const p = createAngelOneProvider({ refreshSeconds: 1, readGate: async () => READY, searchImpl: async () => [] });
      const stop = p.subscribe([KEY("SBIN")], () => {});
      stop();
      const q = createAngelOneProvider({ refreshSeconds: 1, readGate: async () => READY, searchImpl: async () => [] });
      const stop2 = q.subscribe(
        Array.from({ length: 60 }, (_, i) => KEY(`SYM${i}`)),
        () => {},
      );
      stop2();
    } finally {
      globalThis.setInterval = realSetInterval;
    }
    expect(seen, "a 1 s slider must not produce a 1 s poll").toEqual([3000, 5000]);
  });
});

/* ─────────────────────────────── the batching ───────────────────────────── */

describe("batching — 50 tokens a request, grouped by exchange", () => {
  it("turns 137 positions into 3 requests, never one that mixes two exchanges", () => {
    const tokens = [
      ...Array.from({ length: 100 }, (_, i) => tokenOf(`NS${i}`, "NSE", String(1000 + i))),
      ...Array.from({ length: 37 }, (_, i) => tokenOf(`BS${i}`, "BSE", String(500000 + i))),
    ];
    const batches = planAngelOneBatches(tokens);
    expect(batches).toHaveLength(3);
    expect(batches.map((b) => `${b.exchange}:${b.tokens.length}`)).toEqual(["NSE:50", "NSE:50", "BSE:37"]);
    for (const b of batches) expect(b.tokens.length).toBeLessThanOrEqual(ANGELONE_MAX_TOKENS_PER_CALL);
    // Every token is sent exactly once — nothing dropped, nothing duplicated.
    const flat = batches.flatMap((b) => b.tokens);
    expect(flat).toHaveLength(137);
    expect(new Set(flat).size).toBe(137);
  });

  it("is exact at the boundary and empty for an empty book", () => {
    const fifty = Array.from({ length: 50 }, (_, i) => tokenOf(`S${i}`, "NSE", String(i)));
    expect(planAngelOneBatches(fifty)).toHaveLength(1);
    expect(planAngelOneBatches([...fifty, tokenOf("EXTRA", "NSE", "999")])).toHaveLength(2);
    expect(planAngelOneBatches([])).toEqual([]);
  });

  it("sends 137 positions as 3 requests on the wire too, a second apart", async () => {
    const tokens = [
      ...Array.from({ length: 100 }, (_, i) => tokenOf(`NS${i}`, "NSE", String(1000 + i))),
      ...Array.from({ length: 37 }, (_, i) => tokenOf(`BS${i}`, "BSE", String(500000 + i))),
    ];
    const h = harness({ tokens });
    const keys = tokens.map((t) => KEY(t.symbol, t.exchange));
    await h.provider.snapshot(keys);
    expect(h.sent.map((s) => `${s.batch.exchange}:${s.batch.tokens.length}`)).toEqual(["NSE:50", "NSE:50", "BSE:37"]);
    // ONE REQUEST A SECOND. The login took the first slot, so every quote is
    // at least a second after the one before it.
    for (let i = 1; i < h.sent.length; i++) {
      expect(h.sent[i].at - h.sent[i - 1].at, `gap ${i}`).toBeGreaterThanOrEqual(1000);
    }
    expect(h.logins).toBe(1);
  });
});

/* ───────────────────────────── prices, and misses ───────────────────────── */

describe("a quote — rupees in, paise out, and `close` is the PREVIOUS close", () => {
  const ROW = { exchange: "NSE", tradingSymbol: "SBIN-EQ", symbolToken: "3045", ltp: 1005.9, open: 1020.8, high: 1021.7, low: 1000.6, close: 1016.1 };

  it("converts at the edge exactly once and reads `close` as prevClose", () => {
    const q = quoteFromAngelOne(KEY("SBIN"), ROW, "2026-09-07T04:00:00.000Z")!;
    expect(q.ltp).toBe(100590);
    expect(q.prevClose, "OHLC mode's `close` is YESTERDAY's close").toBe(101610);
    expect(q.dayOpen).toBe(102080);
    expect(q.dayHigh).toBe(102170);
    expect(q.dayLow).toBe(100060);
    // OHLC mode carries no volume: null, never a 0 that renders as "no trades".
    expect(q.volume).toBeNull();
    expect(q.staleness).toBe("delayed");
    expect(q.source).toBe("angelone");
    expect(q.asOf).toBe("2026-09-07T04:00:00.000Z");
    for (const v of [q.ltp, q.prevClose, q.dayOpen, q.dayHigh, q.dayLow]) expect(Number.isInteger(v)).toBe(true);
  });

  it("refuses a non-price rather than marking a position to zero (invariant 6)", () => {
    for (const ltp of [0, -1, null, undefined, "", "abc"]) {
      expect(quoteFromAngelOne(KEY("SBIN"), { ...ROW, ltp }, "x"), String(ltp)).toBeNull();
    }
    // A missing day figure is null, not zero — the desk renders "—".
    const partial = quoteFromAngelOne(KEY("SBIN"), { ltp: 10, symbolToken: "3045" }, "x")!;
    expect(partial.prevClose).toBeNull();
    expect(partial.dayOpen).toBeNull();
  });

  it("attributes a row by the TOKEN it sent, never by the tradingsymbol", async () => {
    const h = harness({
      tokens: [tokenOf("SBIN", "NSE", "3045")],
      // A response whose tradingSymbol is a different company's. The token is
      // the only thing that maps back to a QuoteKey, and it is what is used.
      respond: () => ({ fetched: [{ ...ROW, tradingSymbol: "SBICARD-EQ" }], unfetched: [] }),
    });
    const snap = await h.provider.snapshot([KEY("SBIN")]);
    expect([...snap.keys()]).toEqual(["NSE:SBIN"]);
    expect(snap.get("NSE:SBIN")!.ltp).toBe(100590);

    // …and a row carrying a token nobody asked for is dropped, not attached
    // to whatever key happens to be first.
    const stray = harness({
      tokens: [tokenOf("SBIN", "NSE", "3045")],
      respond: () => ({ fetched: [{ ...ROW, symbolToken: "99999" }], unfetched: [] }),
    });
    expect((await stray.provider.snapshot([KEY("SBIN")])).size).toBe(0);
  });

  it("OMITS an unfetched token and COUNTS it — a missing price is never a zero", async () => {
    const h = harness({
      tokens: [tokenOf("SBIN", "NSE", "3045"), tokenOf("TCS", "NSE", "11536")],
      respond: () => ({
        fetched: [ROW],
        unfetched: [{ exchange: "NSE", symbolToken: "11536", message: "Invalid symbol token" }],
      }),
    });
    const snap = await h.provider.snapshot([KEY("SBIN"), KEY("TCS")]);
    expect([...snap.keys()], "the unfetched row is absent, not zero-filled").toEqual(["NSE:SBIN"]);
    const health = (await h.provider.health()) as AngelOneHealth;
    expect(health.unfetched).toBe(1);
  });

  it("never SENDS a derivative, and says how many it could not price", async () => {
    const h = harness({ tokens: [tokenOf("SBIN", "NSE", "3045")], respond: () => ({ fetched: [ROW], unfetched: [] }) });
    const snap = await h.provider.snapshot([
      KEY("SBIN"),
      { symbol: "TCS", exchange: "NFO", tradingsymbol: "TCS26SEP3000CE" },
    ]);
    expect([...snap.keys()]).toEqual(["NSE:SBIN"]);
    expect(h.sent[0].batch.tokens, "only the equity token went on the wire").toEqual(["3045"]);
    const health = (await h.provider.health()) as AngelOneHealth;
    expect(health.skippedDerivatives).toBe(1);
    expect(health.reason).toMatch(/not priced by this feed/i);
  });
});

/* ────────────────────────────── the two ceilings ────────────────────────── */

describe("the two ceilings — both refuse, neither queues", () => {
  it("serialises to one request a second", async () => {
    expect(ANGELONE_RATE_LIMIT_PER_SECOND).toBe(1);
    const tokens = Array.from({ length: 120 }, (_, i) => tokenOf(`S${i}`, "NSE", String(i)));
    const h = harness({ tokens });
    await h.provider.snapshot(tokens.map((t) => KEY(t.symbol)));
    expect(h.sent).toHaveLength(3);
    const gaps = h.sent.slice(1).map((s, i) => s.at - h.sent[i].at);
    expect(gaps.every((g) => g >= 1000), `gaps ${gaps.join(",")}`).toBe(true);
  });

  it("counts every request against the rolling hour, login included", async () => {
    const h = harness({ tokens: [tokenOf("SBIN", "NSE", "3045")] });
    await h.provider.snapshot([KEY("SBIN")]);
    const first = (await h.provider.health()) as AngelOneHealth;
    expect(first.hourlyBudgetUsed, "one login plus one quote").toBe(2);
    await h.provider.snapshot([KEY("SBIN")]);
    expect(((await h.provider.health()) as AngelOneHealth).hourlyBudgetUsed, "the cached jwt costs nothing").toBe(3);
  });

  it("refuses the 4,001st request in a rolling hour, and lets it through once the hour rolls", () => {
    const budget = createHourlyBudget(ANGELONE_HOURLY_BUDGET);
    expect(ANGELONE_HOURLY_BUDGET).toBe(4000);
    for (let i = 0; i < ANGELONE_HOURLY_BUDGET; i++) expect(budget.take(T0 + i)).toBe(true);
    expect(budget.used(T0 + ANGELONE_HOURLY_BUDGET), "the window is full").toBe(4000);
    expect(budget.take(T0 + ANGELONE_HOURLY_BUDGET), "the 4,001st is REFUSED, not queued").toBe(false);
    // Rolling, not fixed: an hour after the first stamp, the first stamp goes.
    expect(budget.take(T0 + 3_600_000)).toBe(true);
    expect(budget.used(T0 + 3_600_000 + 4000)).toBeLessThan(ANGELONE_HOURLY_BUDGET);
  });

  it("is a SECOND ceiling: the per-second guard already caps the hour below it", () => {
    // 3,600 seconds in an hour at one request a second. 4,000 is therefore
    // unreachable while the pacing holds — which is the point: it catches a
    // pacing bug rather than being the binding limit.
    expect(ANGELONE_HOURLY_BUDGET).toBeGreaterThan(3600 * ANGELONE_RATE_LIMIT_PER_SECOND);
  });
});

/* ───────────────────────────── the daily session ────────────────────────── */

describe("the session — one login a day, at 05:00 IST, and one attempt at a time", () => {
  it("expires at the next 05:00 IST, not 24 hours after login and not at the jwt's exp", () => {
    // 09:30 IST Monday → 05:00 IST Tuesday.
    expect(new Date(angelOneSessionExpiresAt(T0)).toISOString()).toBe("2026-09-07T23:30:00.000Z");
    // 04:30 IST → 05:00 IST the SAME morning, thirty minutes later.
    const early = Date.parse("2026-09-06T23:00:00Z");
    expect(new Date(angelOneSessionExpiresAt(early)).toISOString()).toBe("2026-09-06T23:30:00.000Z");
    // Exactly 05:00 IST → the NEXT one; a session minted at the flush is not
    // flushed by it.
    const atFlush = Date.parse("2026-09-06T23:30:00Z");
    expect(new Date(angelOneSessionExpiresAt(atFlush)).toISOString()).toBe("2026-09-07T23:30:00.000Z");
  });

  it("signs in once and reuses the jwt all day, then again after the flush", async () => {
    const h = harness({ tokens: [tokenOf("SBIN", "NSE", "3045")] });
    await h.provider.snapshot([KEY("SBIN")]);
    await h.provider.snapshot([KEY("SBIN")]);
    expect(h.logins, "the jwt is cached in memory").toBe(1);
    // Past 05:00 IST the next morning: Angel One has cleared the session.
    h.advance(Date.parse("2026-09-07T23:30:01Z") - h.now());
    await h.provider.snapshot([KEY("SBIN")]);
    expect(h.logins).toBe(2);
  });

  it("signs in again when an envelope says the session is invalid", async () => {
    let calls = 0;
    const h = harness({
      tokens: [tokenOf("SBIN", "NSE", "3045")],
      respond: () => {
        calls += 1;
        if (calls === 1) throw new Error("Angel One quote: Invalid Token (AG8001)");
        return { fetched: [], unfetched: [] };
      },
    });
    await h.provider.snapshot([KEY("SBIN")]);
    expect(h.logins).toBe(1);
    const dead = (await h.provider.health()) as AngelOneHealth;
    expect(dead.ok).toBe(false);
    expect(dead.reason).toMatch(/session is no longer valid/i);
    await h.provider.snapshot([KEY("SBIN")]);
    expect(h.logins, "the dead session is replaced, not reused").toBe(2);
  });

  it("recognises the session codes and nothing else as a reason to re-login", () => {
    for (const msg of ["AG8001", "AG8002 Token Expired", "Invalid Token", "HTTP 401", "session expired"]) {
      expect(isAngelSessionInvalid(new Error(msg)), msg).toBe(true);
    }
    for (const msg of ["Invalid symbol token", "HTTP 500", "exchange not supported", "AG8054"]) {
      expect(isAngelSessionInvalid(new Error(msg)), msg).toBe(false);
    }
  });

  it("NEVER loops a failing login — one attempt, then a minute of silence", async () => {
    const h = harness({
      tokens: [tokenOf("SBIN", "NSE", "3045")],
      login: async () => {
        throw new Error("Angel One login: Invalid totp");
      },
    });
    await expect(h.provider.snapshot([KEY("SBIN")])).rejects.toThrow(/TOTP/i);
    expect(h.logins).toBe(1);

    // Every poll for the next minute reports the same failure and spends NO
    // login: generateTokens is 1,000/hour and a wrong TOTP fails identically.
    h.advance(30_000);
    await expect(h.provider.snapshot([KEY("SBIN")])).rejects.toThrow(/TOTP/i);
    expect(h.logins, "no second attempt inside the minute").toBe(1);

    h.advance(31_000);
    await expect(h.provider.snapshot([KEY("SBIN")])).rejects.toThrow(/TOTP/i);
    expect(h.logins, "one more attempt, once the minute is up").toBe(2);
    expect(h.sent, "nothing was ever quoted without a session").toEqual([]);
  });
});

/* ────────────────────────────── gate and health ─────────────────────────── */

describe("the gate, and a health() that never throws", () => {
  it("refuses to run at all without the acknowledgement, and says where to give it", async () => {
    const h = harness({
      gate: { state: "disabled", reason: "The Angel One live-price disclosure has not been accepted on this machine." },
    });
    await expect(h.provider.snapshot([KEY("SBIN")])).rejects.toThrow(/disclosure/i);
    const health = (await h.provider.health()) as AngelOneHealth;
    expect(health.ok).toBe(false);
    expect(health.state).toBe("disabled");
    expect(h.logins, "no sign-in happens before consent does").toBe(0);
  });

  it("MAKES NO REQUEST OF ITS OWN — health() is a report, not a probe", async () => {
    const h = harness({ tokens: [tokenOf("SBIN", "NSE", "3045")] });
    await h.provider.health();
    await h.provider.health();
    expect(h.logins, "a probe here would burn a login a poll").toBe(0);
    expect(h.sent).toEqual([]);
  });

  it("answers an empty key set with an empty map before it looks at anything", async () => {
    const h = harness({ gate: { state: "no-key", reason: "No Angel One connection is saved for this account." } });
    await expect(h.provider.snapshot([])).resolves.toEqual(new Map());
    expect(h.logins).toBe(0);
  });

  it("declares the one host it can reach, and the daily auth it really needs", () => {
    expect(ANGELONE_CAPABILITIES.id).toBe("angelone");
    expect(ANGELONE_CAPABILITIES.egressDescription).toContain("apiconnect.angelone.in");
    expect(ANGELONE_CAPABILITIES.staleness).toBe("delayed");
    expect(ANGELONE_CAPABILITIES.requiresDailyAuth).toBe(true);
    expect(ANGELONE_CAPABILITIES.segments).toEqual(["NSE", "BSE"]);
    expect(ANGELONE_CAPABILITIES.minSnapshotIntervalMs).toBe(angelOneCadenceSeconds(0) * 1000);
    expect(ANGELONE_CAPABILITIES.maxSubscriptions).toBe(
      ANGELONE_CADENCE_TIERS[ANGELONE_CADENCE_TIERS.length - 1].maxOpenPositions,
    );
  });
});

/**
 * THE BREADCRUMB THESE MESSAGES SEND THE USER TO (v4.2 fix A-11).
 *
 * The Import screen's card is called "Connect broker". Every sentence this
 * adapter shows when a credential is missing or refused has to name it exactly
 * — a breadcrumb to a screen that is not called that is a dead end, and this
 * adapter's three messages are shown at the moment prices stop arriving.
 */
describe("the breadcrumb the Angel One messages name", () => {
  const SRC = readFileSync(path.join(process.cwd(), "lib/quotes/angelone.ts"), "utf8");

  it("is Import → Connect broker, in every sentence that names a screen", () => {
    expect(angelOneFeedErrorMessage(new Error("Invalid totp"))).toContain("Import → Connect broker");
    expect(angelOneFeedErrorMessage(new Error("Invalid pin"))).toContain("Import → Connect broker");
    expect(SRC).toContain(
      "Save the API key, client code, PIN and TOTP secret under Import → Connect broker",
    );
    expect(SRC, "the old screen name is still here").not.toContain("Import → Brokers");
  });
});
