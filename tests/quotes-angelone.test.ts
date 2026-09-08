import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANGELONE_CAPABILITIES,
  ANGELONE_HOURLY_BUDGET,
  ANGELONE_LOGIN_CAPPED_REASON,
  ANGELONE_LOGIN_UNREACHABLE_CAPPED_REASON,
  ANGELONE_MAX_LOGIN_ATTEMPTS,
  ANGELONE_MAX_SESSION_INVALIDATIONS,
  ANGELONE_MAX_TOKENS_PER_CALL,
  ANGELONE_MIN_REQUEST_GAP_MS,
  ANGELONE_RATE_LIMIT_PER_SECOND,
  ANGELONE_SESSION_INVALID_CAPPED_REASON,
  angelOneFeedErrorMessage,
  classifyAngelOneLoginFailure,
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
import type { AngelSearchScrip, AngelTokenCache, ResolvedAngelToken } from "@/lib/quotes/angelone-tokens";
import type { AngelOneCredentials } from "@/lib/import/api/angelone";
// PURE, and the real decision the desk makes: the capped state has to be one
// this function opens the connect prompt on, or the sentence has no screen.
import { showConnectPrompt } from "@/lib/live/connect-prompt";
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
    /**
     * The SYMBOL LOOKUP, injected (ruling S-1). The default answers "no such
     * scrip"; a fixture that THROWS is the other half of the poll — a lookup
     * can be answered session-invalid while a cached token still prices.
     */
    searchImpl?: AngelSearchScrip;
    /**
     * HOW THE INJECTED `sleep` MOVES THE FAKE CLOCK (ruling T-1, fix wave 6).
     *
     * The default advances it by exactly the milliseconds asked for, which is
     * the one thing a real timer does NOT promise: `setTimeout(1000)` is allowed
     * to run at 999 ms. A fixture that returns less than `ms` is an early timer.
     */
    sleepAdvance?: (ms: number) => number;
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
      clock += opts.sleepAdvance ? opts.sleepAdvance(ms) : ms;
    },
    loginImpl: async () => {
      state.logins += 1;
      return opts.login ? opts.login() : { jwtToken: `jwt-${state.logins}` };
    },
    quoteImpl,
    tokenCache: seededCache(opts.tokens ?? []),
    searchImpl: opts.searchImpl ?? (async () => []),
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
    // v4.2 fix wave 2, B-5. The tail used to promise "keep their last stored
    // mark" — a value nothing writes, since no writer stores a CONTRACT-keyed
    // mark. The health line is printed by the SAME Settings card that prints
    // the B-5 footnote, so it states the same fallback the footnote does.
    //
    // …and fix wave 3, C-11: the fallback is A DASH, not the entry price. The
    // row prints "—" when no close was ever recorded, and this clause is
    // byte-identical on the card, the sheets, the help and the docs.
    expect(health.reason).toContain(
      "each shows the position's recorded close, or a dash when no close is recorded",
    );
    expect(
      (health.reason ?? "").toLowerCase(),
      "the health line still promises the last stored mark",
    ).not.toContain("last stored mark");
    expect(
      (health.reason ?? "").toLowerCase(),
      "the health line still promises the entry price (C-11)",
    ).not.toContain("entry price");
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

/* ── the pacing is MEASURED, not assumed (owner ruling T-1, fix wave 6) ──── */

/**
 * A TIMER THAT FIRES ONE MILLISECOND EARLY COST A WHOLE SWEEP.
 *
 * `slot()` slept `lastRequestAt + ANGELONE_MIN_REQUEST_GAP_MS - now()` and then
 * asked `guard.take(now())` — but a timer is only ever a lower bound in
 * PRINCIPLE and not in practice: `setTimeout(1000)` may run at 999 ms, and the
 * guard trims its window only once a full second has passed. One millisecond
 * short and the guard refused the request the sleep had just paid for; the batch
 * loop in `snapshot()` reads a refusal as "drop this batch and every remaining
 * one", so the poll returned an EMPTY map and the desk showed no price at all
 * for that cycle. The refusal was correct — the guard is the safety net and it
 * stays one. What was wrong is that the pacing never re-read the clock.
 *
 * The fixture below is what a real timer does: a long sleep may land a
 * millisecond early, a 1 ms re-arm cannot land a whole millisecond early.
 */
describe("pacing re-reads the clock, so an early timer costs no sweep (ruling T-1)", () => {
  const PRICED = { exchange: "NSE", tradingSymbol: "SBIN-EQ", symbolToken: "3045", ltp: 1005.9, close: 1016.1 };
  const EARLY = (ms: number): number => (ms >= 2 ? ms - 1 : ms);

  it("still sends the batch when the paced sleep fires one millisecond early", async () => {
    const h = harness({
      tokens: [tokenOf("SBIN", "NSE", "3045")],
      respond: () => ({ fetched: [PRICED], unfetched: [] }),
      sleepAdvance: EARLY,
    });
    const snap = await h.provider.snapshot([KEY("SBIN")]);

    expect(h.sent.length, "the paced batch never reached the wire — one whole sweep unpriced").toBe(1);
    expect([...snap.keys()], "the poll came back empty because the timer was 1 ms fast").toEqual(["NSE:SBIN"]);
    expect(snap.get("NSE:SBIN")!.ltp).toBe(100590);

    // AND THE GAP IS STILL HELD. The fix is to wait the remainder out, never to
    // send early or to widen the guard: the login took the first slot, so the
    // quote goes a FULL second after it and not 999 ms after it.
    expect(h.sent[0].at - T0, "the request went out inside the pacing gap").toBeGreaterThanOrEqual(
      ANGELONE_MIN_REQUEST_GAP_MS,
    );
    // Nothing was refused, so the desk is told nothing about a guard.
    const health = (await h.provider.health()) as AngelOneHealth;
    expect(health.reason ?? "").not.toMatch(/rate guard/i);
  });

  it("keeps a 120-position book at three requests, a second apart, on the same early timer", async () => {
    const tokens = Array.from({ length: 120 }, (_, i) => tokenOf(`S${i}`, "NSE", String(i)));
    const h = harness({ tokens, sleepAdvance: EARLY });
    await h.provider.snapshot(tokens.map((t) => KEY(t.symbol)));

    expect(h.sent.length, "the sweep was truncated by an early timer, not by a real ceiling").toBe(3);
    const gaps = h.sent.slice(1).map((s, i) => s.at - h.sent[i].at);
    expect(gaps.every((g) => g >= ANGELONE_MIN_REQUEST_GAP_MS), `gaps ${gaps.join(",")}`).toBe(true);
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

  it("NEVER loops a failing login — one attempt, a minute of silence, THREE IN ALL", async () => {
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

    // …and the minute of silence ENDS somewhere (ruling C-2). The third
    // refusal is the last attempt this instance ever makes.
    h.advance(61_000);
    await expect(h.provider.snapshot([KEY("SBIN")])).rejects.toThrow(/refused the login three times/i);
    expect(h.logins, "the third attempt is made, and reports the cap").toBe(3);
    h.advance(61_000);
    await expect(h.provider.snapshot([KEY("SBIN")])).rejects.toThrow(/refused the login three times/i);
    expect(h.logins, "and there is no fourth").toBe(3);
    expect(h.sent, "nothing was ever quoted without a session").toEqual([]);
  });
});

/* ───────── the cap on refused logins (owner ruling C-2, fix wave 3) ──────── */

/**
 * A WRONG PIN IS SENT THREE TIMES, NOT 1,440 TIMES A DAY.
 *
 * `ANGELONE_LOGIN_RETRY_MS` spaced the attempts and nothing ENDED them: a
 * credential saved wrong once went to apiconnect.angelone.in every 60 s for as
 * long as the desk polled. The cap is per INSTANCE — the registry keys its one
 * memoised provider on the connection row's `updated_at` plus a fingerprint of
 * the stored ciphertext, so re-saving the credentials (or relaunching) is what
 * clears it, and nothing about it is persisted.
 */
describe("three refused logins, and then it stops (ruling C-2)", () => {
  const REFUSING = {
    tokens: [tokenOf("SBIN", "NSE", "3045")],
    login: async () => {
      throw new Error("Angel One login: Invalid totp");
    },
  } as const;

  it("attempts at t=0, 61 s and 122 s — and never a fourth", async () => {
    // The constant and the sentence must agree: the user is told "three
    // times", so three is what the code may spend.
    expect(ANGELONE_MAX_LOGIN_ATTEMPTS).toBe(3);
    expect(ANGELONE_LOGIN_CAPPED_REASON).toContain("three times");
    const h = harness(REFUSING);

    await expect(h.provider.snapshot([KEY("SBIN")])).rejects.toThrow();
    h.advance(61_000);
    await expect(h.provider.snapshot([KEY("SBIN")])).rejects.toThrow();
    h.advance(61_000);
    await expect(h.provider.snapshot([KEY("SBIN")])).rejects.toThrow();
    expect(h.logins, "three attempts, one a minute").toBe(3);

    // t = 183 s: the minute is up, the stamp says "go", and the cap says no.
    h.advance(61_000);
    await expect(h.provider.snapshot([KEY("SBIN")])).rejects.toThrow(/refused the login three times/i);
    expect(h.logins, "the fourth attempt is never made").toBe(3);

    // …and not the next morning either. The instance is done; a re-save builds
    // a new one, which is the reset.
    h.advance(24 * 60 * 60 * 1000);
    await expect(h.provider.snapshot([KEY("SBIN")])).rejects.toThrow(/refused the login three times/i);
    expect(h.logins, "not a fourth a day later either").toBe(3);
    expect(h.sent, "and no quote request was ever made without a session").toEqual([]);
  });

  it("says the ONE sentence that names what to re-save, in a state the desk prompts on", async () => {
    const h = harness(REFUSING);
    for (let i = 0; i < 3; i += 1) {
      await expect(h.provider.snapshot([KEY("SBIN")])).rejects.toThrow();
      h.advance(61_000);
    }
    const health = (await h.provider.health()) as AngelOneHealth;
    expect(health.ok).toBe(false);
    // VERBATIM — the desk prints this reason, and it is the only sentence this
    // state produces whatever the last poll happened to fail on.
    expect(health.reason).toBe(
      "Angel One refused the login three times — re-save the client code, PIN and TOTP secret under Import → Connect broker. Signing in resumes when you re-save the credentials or relaunch Vyuha.",
    );
    expect(health.reason).toBe(ANGELONE_LOGIN_CAPPED_REASON);
    // `unreachable`, not `no-key`: a connection IS saved and was refused. What
    // matters to the user is that the once-a-day connect prompt fires, and
    // `lib/live/connect-prompt.ts` opens on exactly these two states — this
    // asserts the real function rather than the state's name.
    expect(health.state).toBe("unreachable");
    expect(
      showConnectPrompt({ providerId: "angelone", healthState: health.state }, null),
      "a capped feed must still send the user to Import → Connect broker",
    ).toBe(true);
    // health() is a report, not a probe: it does not attempt a fourth login.
    expect(h.logins).toBe(3);
  });

  it("a SUCCESSFUL login resets the count — three IN A ROW is the rule", async () => {
    let attempt = 0;
    const h = harness({
      tokens: [tokenOf("SBIN", "NSE", "3045")],
      login: async () => {
        attempt += 1;
        // The second attempt works; every other one is refused.
        if (attempt === 2) return { jwtToken: "jwt-good" };
        throw new Error("Angel One login: Invalid totp");
      },
      // The session dies as soon as it is used, so the next poll signs in
      // again — the 05:00 IST flush case, which is legitimate and counts
      // toward the cap only when it is REFUSED.
      respond: () => {
        throw new Error("Angel One quote: Invalid Token (AG8001)");
      },
    });

    await expect(h.provider.snapshot([KEY("SBIN")])).rejects.toThrow(/TOTP/i);
    h.advance(61_000);
    await expect(h.provider.snapshot([KEY("SBIN")]), "attempt 2 signs in").resolves.toBeInstanceOf(Map);
    expect(h.logins).toBe(2);

    // Three more refusals — a NEW count of three, not one more on top of the
    // first failure. Two would have been enough if the success had not reset.
    for (let i = 0; i < 3; i += 1) {
      h.advance(61_000);
      await expect(h.provider.snapshot([KEY("SBIN")])).rejects.toThrow();
    }
    expect(h.logins, "2 attempts before the reset, then a fresh 3").toBe(5);

    h.advance(61_000);
    await expect(h.provider.snapshot([KEY("SBIN")])).rejects.toThrow(/refused the login three times/i);
    expect(h.logins, "and now it stops").toBe(5);
  });
});

/* ───── the cap on session INVALIDATIONS (owner ruling C-1, fix wave 4) ──── */

/**
 * A LOGIN THAT IS ACCEPTED, AND A SESSION THAT IS NEVER USABLE.
 *
 * C-2 counts REFUSED logins. `invalidateSession()` nulls the jwt whenever an
 * answer matches `isAngelSessionInvalid` — and `lib/import/api/angelone.ts`
 * turns ANY non-ok status into "Angel One quote: HTTP 401", so an app key
 * without market-data entitlement produces that on every single quote. The loop
 * was: login accepted → quote says invalid → jwt nulled → next poll signs in
 * again (accepted, C-2 counter reset) → … The credential went to
 * apiconnect.angelone.in on EVERY poll — 1,200 an hour at the 3 s tier — and
 * the C-2 cap could never fire, because no login was ever refused.
 *
 * The second counter is CONSECUTIVE INVALIDATIONS WITH NO PRICED QUOTE BETWEEN
 * THEM. Three, then this instance stops signing in, in the same `state` and
 * `reason` shape C-2 reports, until a re-save or a relaunch rebuilds it.
 */
describe("three invalid sessions, and then it stops (ruling C-1)", () => {
  const PRICED = { exchange: "NSE", tradingSymbol: "SBIN-EQ", symbolToken: "3045", ltp: 1005.9, close: 1016.1 };
  /** What an app key with no market-data entitlement answers to every quote. */
  const NOT_ENTITLED = (): never => {
    throw new Error("Angel One quote: HTTP 401");
  };
  const SESSION_INVALID_CAPPED_REASON =
    "Angel One reported the session invalid three times in a row, with no price in between. Relaunching Vyuha or re-saving the client code, PIN and TOTP secret under Import → Connect broker starts a fresh attempt.";

  /**
   * Poll n times at the fastest cadence tier (3 s). A poll before the cap
   * returns a map; a poll after it throws, so both are collected.
   */
  async function poll(h: Harness, n: number): Promise<string[]> {
    const out: string[] = [];
    for (let i = 0; i < n; i += 1) {
      try {
        await h.provider.snapshot([KEY("SBIN")]);
        out.push("<no error>");
      } catch (e) {
        out.push(e instanceof Error ? e.message : String(e));
      }
      h.advance(3000);
    }
    return out;
  }

  it("signs in THREE times across ten polls, and then not at all", async () => {
    // The constant, the sentence and this file's literal all say three; the
    // constant is a SIBLING of ANGELONE_MAX_LOGIN_ATTEMPTS, not a replacement.
    expect(ANGELONE_MAX_SESSION_INVALIDATIONS).toBe(3);
    expect(ANGELONE_MAX_LOGIN_ATTEMPTS, "the C-2 cap is untouched").toBe(3);
    expect(SESSION_INVALID_CAPPED_REASON).toBe(ANGELONE_SESSION_INVALID_CAPPED_REASON);
    expect(ANGELONE_SESSION_INVALID_CAPPED_REASON).toContain("three times in a row");
    const h = harness({ tokens: [tokenOf("SBIN", "NSE", "3045")], respond: NOT_ENTITLED });
    const errors = await poll(h, 10);

    // THE POINT OF THE RULING. Before it this was ten logins and ten
    // credential transmissions; the 60 s stamp never applied, because the
    // login itself never failed.
    expect(h.logins, "three logins, whatever the poll count").toBe(3);
    expect(h.sent.length, "one quote per session, and no session after the third").toBe(3);
    // Polls 1–3 spend a session and come back empty; poll 4 onwards sends
    // nothing at all and says why.
    expect(errors.slice(0, 3)).toEqual(["<no error>", "<no error>", "<no error>"]);
    expect(errors[3]).toBe(SESSION_INVALID_CAPPED_REASON);
    expect(errors[9], "and not the tenth poll either").toBe(SESSION_INVALID_CAPPED_REASON);

    const health = (await h.provider.health()) as AngelOneHealth;
    expect(health.ok).toBe(false);
    // The SAME shape C-2 reports, so the card and the route need no change…
    expect(health.state).toBe("unreachable");
    // …and a sentence that is about the SESSION, not about a refused login:
    // nothing was refused here, and re-saving a correct credential would not
    // be what the user is left staring at.
    expect(health.reason).toBe(SESSION_INVALID_CAPPED_REASON);
    expect(health.reason).not.toContain("refused the login");
    expect(
      showConnectPrompt({ providerId: "angelone", healthState: health.state }, null),
      "a capped feed must still reach the user",
    ).toBe(true);
    expect(h.logins, "health() is a report, not a fourth login").toBe(3);
  });

  it("says so the moment the third session dies, not one poll later", async () => {
    // health() is asked BETWEEN the third invalidation and the poll that would
    // have signed in again. The last poll's own error is still "Vyuha signs in
    // again on the next poll" — a promise this instance will not keep.
    const h = harness({ tokens: [tokenOf("SBIN", "NSE", "3045")], respond: NOT_ENTITLED });
    await poll(h, 3);
    expect(h.logins).toBe(3);
    const health = (await h.provider.health()) as AngelOneHealth;
    expect(health.reason).toBe(SESSION_INVALID_CAPPED_REASON);
    expect(health.reason, "the desk was still promised a sign-in that will not happen").not.toMatch(
      /signs in again on the next poll/,
    );
    expect(health.state).toBe("unreachable");
  });

  it("a PRICED answer resets the count — three IN A ROW is the rule", async () => {
    let n = 0;
    const h = harness({
      tokens: [tokenOf("SBIN", "NSE", "3045")],
      respond: () => {
        n += 1;
        // The second poll gets a real price; every other one says the session
        // is invalid.
        if (n === 2) return { fetched: [PRICED], unfetched: [] };
        return NOT_ENTITLED();
      },
    });
    const errors = await poll(h, 10);

    // 1 → invalid (login 1). 2 → login 2, PRICED, count back to zero. 3 → the
    // live jwt is used and dies (no login). 4 → login 3. 5 → login 4, and the
    // third invalidation since the price. 6 onwards → nothing.
    expect(h.logins, "one more login than the cap alone would have allowed").toBe(4);
    expect(errors[1], "the priced poll succeeded").toBe("<no error>");
    expect(errors[5]).toBe(SESSION_INVALID_CAPPED_REASON);
    const health = (await h.provider.health()) as AngelOneHealth;
    expect(health.reason).toBe(SESSION_INVALID_CAPPED_REASON);
  });

  it("the 05:00 IST flush re-login counts toward NEITHER cap", async () => {
    let n = 0;
    const h = harness({
      tokens: [tokenOf("SBIN", "NSE", "3045")],
      respond: () => {
        n += 1;
        // An ANSWER, but not a price: nothing is invalidated and nothing is
        // reset either — an empty answer is not evidence the session works.
        if (n === 2) return { fetched: [], unfetched: [{ symbolToken: "3045" }] };
        return NOT_ENTITLED();
      },
    });

    await poll(h, 2);
    expect(h.logins).toBe(2);
    // Past 05:00 IST: Angel One has flushed the session, so the next poll signs
    // in again. That re-login is SCHEDULED, not an invalidation — it must not
    // move either counter.
    h.advance(Date.parse("2026-09-07T23:30:01Z") - h.now());
    const errors = await poll(h, 4);

    // 3 → the flush re-login (login 3), then invalid. 4 → login 4, invalid, and
    // that is the third invalidation. 5 onwards → nothing.
    expect(h.logins, "the flush login is a login, and it is not an invalidation").toBe(4);
    expect(errors[2]).toBe(SESSION_INVALID_CAPPED_REASON);
    const health = (await h.provider.health()) as AngelOneHealth;
    expect(health.reason).toBe(SESSION_INVALID_CAPPED_REASON);
  });
});

/* ─ the SAME cap, entered through the LOOKUP (owner ruling S-1, fix wave 5) ─ */

/**
 * A POLL CAN INVALIDATE A SESSION AND STILL COME BACK WITH A PRICE.
 *
 * `resolver.resolve()` runs BEFORE the quotes, and `searchScrip` fails the way
 * a quote does: `lib/import/api/angelone.ts` turns any non-ok status into
 * "Angel One symbol search: HTTP 401", which `isAngelSessionInvalid` reads as a
 * dead session, so the jwt is nulled and C-1's count incremented. The quote
 * loop then prices whatever tokens were ALREADY CACHED, with the jwt minted at
 * the top of this same poll — still held in a local. `out.size > 0` was taken
 * as proof the session works, the count went back to zero, and the next poll
 * signed in again: the C-1 loop exactly, reached through the lookup instead of
 * through the quote, with neither ceiling able to fire and the credential going
 * out at poll cadence (1,200 an hour on the 3 s tier).
 *
 * THE RESET NOW NEEDS BOTH: a price, AND a poll that invalidated nothing.
 */
describe("a poll that invalidates and still prices does not reset the count (ruling S-1)", () => {
  const PRICED = { exchange: "NSE", tradingSymbol: "SBIN-EQ", symbolToken: "3045", ltp: 1005.9, close: 1016.1 };
  /** One symbol whose token is cached and prices; one that needs a lookup. */
  const KEYS = [KEY("SBIN"), KEY("TCS")];

  async function poll(h: Harness, n: number): Promise<string[]> {
    const out: string[] = [];
    for (let i = 0; i < n; i += 1) {
      try {
        await h.provider.snapshot(KEYS);
        out.push("<no error>");
      } catch (e) {
        out.push(e instanceof Error ? e.message : String(e));
      }
      h.advance(3000);
    }
    return out;
  }

  it("stops signing in after three lookup 401s, even though every poll priced a row", async () => {
    const h = harness({
      tokens: [tokenOf("SBIN", "NSE", "3045")],
      respond: () => ({ fetched: [PRICED], unfetched: [] }),
      // The unresolved symbol is asked for on every cycle — a thrown lookup is
      // `pending`, never `dead` (lib/quotes/angelone-tokens.ts).
      searchImpl: async () => {
        throw new Error("Angel One symbol search: HTTP 401");
      },
    });
    const errors = await poll(h, 10);

    // THE POINT OF THE RULING. Before it this was ten logins and ten credential
    // transmissions, because SBIN priced on every one of them.
    expect(h.logins, "three sign-ins, whatever the poll count").toBe(ANGELONE_MAX_SESSION_INVALIDATIONS);
    // The first three polls still PRICED — the cap is about the session, and a
    // cached token is not made worthless by a dead lookup.
    expect(errors.slice(0, 3)).toEqual(["<no error>", "<no error>", "<no error>"]);
    expect(errors[3]).toBe(ANGELONE_SESSION_INVALID_CAPPED_REASON);
    expect(errors[9], "and not the tenth poll either").toBe(ANGELONE_SESSION_INVALID_CAPPED_REASON);
    expect(h.sent.length, "one quote per session, and no session after the third").toBe(3);

    const health = (await h.provider.health()) as AngelOneHealth;
    expect(health.ok).toBe(false);
    expect(health.state).toBe("unreachable");
    expect(health.reason, "the desk looked healthy while the credential left every poll").toBe(
      ANGELONE_SESSION_INVALID_CAPPED_REASON,
    );
    expect(
      showConnectPrompt({ providerId: "angelone", healthState: health.state }, null),
      "a capped feed must still reach the user",
    ).toBe(true);
  });

  it("a CLEAN priced poll still resets it, and the next invalidation starts from zero", async () => {
    let lookups = 0;
    const h = harness({
      tokens: [tokenOf("SBIN", "NSE", "3045")],
      respond: () => ({ fetched: [PRICED], unfetched: [] }),
      searchImpl: async () => {
        lookups += 1;
        // The SECOND poll's lookup fails in a way that says nothing about the
        // session — a bare 500 is not `isAngelSessionInvalid`. Nothing is
        // invalidated, so that poll's price is proof the session works.
        if (lookups === 2) throw new Error("Angel One symbol search: HTTP 500");
        throw new Error("Angel One symbol search: HTTP 401");
      },
    });
    const errors = await poll(h, 10);

    // 1 → login 1, invalidated, priced, count 1 (no reset). 2 → login 2, a
    // lookup failure that is not about the session, priced → count back to
    // ZERO and the jwt survives. 3 → no login, invalid again → 1. 4 → login 3
    // → 2. 5 → login 4 → 3, and priced. 6 onwards → nothing is sent.
    expect(errors[1], "the clean poll priced").toBe("<no error>");
    expect(errors[4], "the fifth poll priced too — the count restarted at zero").toBe("<no error>");
    expect(errors[5]).toBe(ANGELONE_SESSION_INVALID_CAPPED_REASON);
    expect(h.logins, "the clean poll bought exactly one more sign-in").toBe(
      ANGELONE_MAX_SESSION_INVALIDATIONS + 1,
    );
    const health = (await h.provider.health()) as AngelOneHealth;
    expect(health.reason).toBe(ANGELONE_SESSION_INVALID_CAPPED_REASON);
  });
});

/* ── the C-1 count is PER INVALIDATED SESSION, not per poll (fix wave 6) ─── */

/**
 * RECORDED AND PINNED, DELIBERATELY NOT CHANGED (owner ruling, fix wave 6).
 *
 * `invalidateSession()` is called from two places in ONE poll: the lookup that
 * came back session-invalid, and the quote that came back session-invalid. Both
 * increment `consecutiveSessionInvalidations`, so a poll in which BOTH surfaces
 * answer 401 moves the count by two and the "at most three sessions" cap is
 * reached inside the SECOND such poll rather than the third.
 *
 * That is the behaviour the owner ruled to keep: each increment corresponds to a
 * session Angel One really did call invalid, the count is about SESSIONS and not
 * about polls, and counting a poll once would spend one more accepted session —
 * one more credential transmission — on evidence that is already in hand. This
 * test exists so the arithmetic is a decision rather than an accident: a
 * single-increment world caps on the FOURTH poll, and this asserts the THIRD.
 *
 * PROVEN BY MUTATION, not by revert — there is no fix here to take away.
 */
describe("the invalidation cap counts sessions, not polls", () => {
  const KEYS = [KEY("SBIN"), KEY("TCS")];

  it("counts each invalidated session in a poll, lookup and quote alike", async () => {
    const h = harness({
      // SBIN is cached, so the quote surface is reached even though the lookup
      // for TCS dies first; both answer the not-entitled 401.
      tokens: [tokenOf("SBIN", "NSE", "3045")],
      respond: () => {
        throw new Error("Angel One quote: HTTP 401");
      },
      searchImpl: async () => {
        throw new Error("Angel One symbol search: HTTP 401");
      },
    });

    const errors: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      await h.provider
        .snapshot(KEYS)
        .then(() => errors.push("<no error>"))
        .catch((e: unknown) => errors.push(e instanceof Error ? e.message : String(e)));
      h.advance(3000);
    }

    // Poll 1: lookup 401 (1) + quote 401 (2). Poll 2: (3) + (4) — the cap is
    // reached inside it, and nothing is sent from poll 3 on.
    expect(errors.slice(0, 2), "both polls spent a session and neither could price").toEqual([
      "<no error>",
      "<no error>",
    ]);
    expect(
      errors[2],
      "two polls that each invalidated TWO sessions did not reach the three-session cap",
    ).toBe(ANGELONE_SESSION_INVALID_CAPPED_REASON);
    expect(h.logins, "a poll counted once would have bought a third sign-in").toBe(2);
    expect(h.sent.length, "one quote attempt per session, and no session after the second poll").toBe(2);

    const health = (await h.provider.health()) as AngelOneHealth;
    expect(health.ok).toBe(false);
    expect(health.state).toBe("unreachable");
    expect(health.reason).toBe(ANGELONE_SESSION_INVALID_CAPPED_REASON);
    expect(
      showConnectPrompt({ providerId: "angelone", healthState: health.state }, null),
      "a capped feed must still reach the user",
    ).toBe(true);
  });
});

/* ── the capped sentence says WHICH failure it was (owner ruling P-3) ────── */

/**
 * THREE MINUTES OF NO NETWORK IS NOT A WRONG PIN.
 *
 * `angelOneLogin` calls a bare `fetch`, which throws a TypeError with no HTTP
 * status when the host cannot be reached. C-2 counted that as a failure like
 * any other — correctly, the bound is about attempts — but then told the user
 * Angel One had REFUSED the login and to re-save credentials that were fine.
 * The count is unchanged; the SENTENCE now distinguishes the two.
 */
describe("the capped sentence distinguishes a refusal from an outage (ruling P-3)", () => {
  const UNREACHABLE_CAPPED_REASON =
    "Angel One could not be reached on three sign-in attempts — the credentials were not refused. Signing in resumes when you re-save the credentials or relaunch Vyuha; the credentials are saved under Import → Connect broker.";

  async function capOut(h: Harness): Promise<string[]> {
    const errors: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      await h.provider.snapshot([KEY("SBIN")]).catch((e: unknown) => {
        errors.push(e instanceof Error ? e.message : String(e));
      });
      h.advance(61_000);
    }
    return errors;
  }

  it("a BROKER REFUSAL keeps the C-2 sentence, and names what to re-save", async () => {
    // An HTTP answer with a SmartAPI envelope: they were reached, and they said no.
    const h = harness({
      tokens: [tokenOf("SBIN", "NSE", "3045")],
      login: async () => {
        throw new Error("Angel One login: Invalid totp");
      },
    });
    const errors = await capOut(h);
    expect(h.logins).toBe(3);
    expect(errors[3]).toBe(
      "Angel One refused the login three times — re-save the client code, PIN and TOTP secret under Import → Connect broker. Signing in resumes when you re-save the credentials or relaunch Vyuha.",
    );
    const health = (await h.provider.health()) as AngelOneHealth;
    expect(health.reason).toContain("refused the login three times");
  });

  it("a 4xx with no envelope is still a refusal — they answered", async () => {
    const h = harness({
      tokens: [tokenOf("SBIN", "NSE", "3045")],
      login: async () => {
        throw new Error("Angel One login: HTTP 403");
      },
    });
    const errors = await capOut(h);
    expect(errors[3]).toContain("refused the login three times");
  });

  it("a HOST THAT CANNOT BE REACHED says so, and does not blame the credentials", async () => {
    // What `fetch` throws on a connect failure: a TypeError, no HTTP status.
    const h = harness({
      tokens: [tokenOf("SBIN", "NSE", "3045")],
      login: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const errors = await capOut(h);
    expect(h.logins, "the bound is unchanged — every failure still counts").toBe(3);
    expect(errors[3]).toBe(UNREACHABLE_CAPPED_REASON);
    const health = (await h.provider.health()) as AngelOneHealth;
    expect(health.ok).toBe(false);
    expect(health.state).toBe("unreachable");
    expect(health.reason).toBe(UNREACHABLE_CAPPED_REASON);
    expect(
      health.reason,
      "a three-minute outage must not tell the user their credentials were refused",
    ).not.toContain("refused the login");
  });

  it("classifies by HOW the login threw, because the API module does not label it", () => {
    expect(UNREACHABLE_CAPPED_REASON).toBe(ANGELONE_LOGIN_UNREACHABLE_CAPPED_REASON);
    // No answer at all — what `fetch` throws on a connect failure.
    expect(classifyAngelOneLoginFailure(new TypeError("fetch failed"))).toBe("unreachable");
    expect(classifyAngelOneLoginFailure(new Error("Angel One login: getaddrinfo ENOTFOUND apiconnect.angelone.in"))).toBe(
      "unreachable",
    );
    expect(classifyAngelOneLoginFailure(new Error("connect ECONNREFUSED 13.234.0.1:443"))).toBe("unreachable");
    // A gateway saying 502 is not a statement about the credential either.
    expect(classifyAngelOneLoginFailure(new Error("Angel One login: HTTP 503"))).toBe("unreachable");
    // They answered: an envelope, a 4xx, or a body with no jwt in it.
    expect(classifyAngelOneLoginFailure(new Error("Angel One login: Invalid totp"))).toBe("refused");
    expect(classifyAngelOneLoginFailure(new Error("Angel One login: HTTP 401"))).toBe("refused");
    expect(classifyAngelOneLoginFailure(new Error("Angel One login: HTTP 403"))).toBe("refused");
    expect(classifyAngelOneLoginFailure(new Error("Angel One login: no session token in the response."))).toBe(
      "refused",
    );
  });

  it("keeps three DISTINCT capped sentences, all SEBI-safe and all naming the screen", () => {
    const three = [
      ANGELONE_LOGIN_CAPPED_REASON,
      ANGELONE_LOGIN_UNREACHABLE_CAPPED_REASON,
      ANGELONE_SESSION_INVALID_CAPPED_REASON,
    ];
    expect(new Set(three).size, "two caps that read the same explain nothing").toBe(3);
    for (const s of three) {
      expect(s, `no breadcrumb in "${s}"`).toContain("Import → Connect broker");
      expect(s.trim().endsWith("."), s).toBe(true);
      for (const banned of [/\brecommend/i, /\bsuggest/i, /\bshould\b/i, /\bconsider\b/i, /\bbuy\b/i, /\bsell\b/i]) {
        expect(s, `banned ${banned} in "${s}"`).not.toMatch(banned);
      }
      // A capped sentence is shown at the moment prices stop: it may never
      // carry a credential VALUE, only the names of the fields.
      expect(s).not.toMatch(/\d{4,}/);
    }
  });

  /**
   * D-1 (fix wave 5) — WHAT RESUMES SIGNING IN IS THE SAME IN BOTH SENTENCES.
   *
   * The refused sentence used to name only a re-save, and its own comment
   * called that "the ONLY thing that clears it". Both counters are instance
   * locals (`consecutiveLoginFailures`, `consecutiveSessionInvalidations`), so
   * a relaunch clears them exactly as a re-save does — a user with correct
   * credentials was being sent to re-type them when closing the window would
   * have done. The two capped states may differ in what HAPPENED; they may not
   * differ in what fixes it.
   */
  it("both first-cap sentences name the same two gestures that resume signing in (D-1)", () => {
    const PHRASE = "re-save the credentials or relaunch Vyuha";
    expect(ANGELONE_LOGIN_CAPPED_REASON, "the refused-capped sentence still omits the relaunch").toContain(
      PHRASE,
    );
    expect(
      ANGELONE_LOGIN_UNREACHABLE_CAPPED_REASON,
      "the unreachable-capped sentence no longer names both gestures",
    ).toContain(PHRASE);
    // The refused sentence still counts to the constant and still names the
    // three fields — the wave-3 promises this wording change must not undo.
    expect(ANGELONE_LOGIN_CAPPED_REASON).toContain("refused the login three times");
    expect(ANGELONE_LOGIN_CAPPED_REASON).toContain("under Import → Connect broker.");
    for (const noun of ["client code", "PIN", "TOTP secret"]) {
      expect(ANGELONE_LOGIN_CAPPED_REASON, `the capped reason does not name "${noun}"`).toContain(noun);
    }
  });

  it("the LAST failure decides the sentence, not the first", async () => {
    let attempt = 0;
    const h = harness({
      tokens: [tokenOf("SBIN", "NSE", "3045")],
      login: async () => {
        attempt += 1;
        // The outage clears; the credential is then genuinely refused.
        if (attempt < 3) throw new TypeError("fetch failed");
        throw new Error("Angel One login: Invalid totp");
      },
    });
    const errors = await capOut(h);
    expect(h.logins).toBe(3);
    expect(errors[2], "the third refusal reports the cap it just reached").toContain(
      "refused the login three times",
    );
    expect(errors[3]).toContain("refused the login three times");
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
    // C-3 (fix wave 3). The sign-in clause is a PROCESS rule — B-7 disproved
    // the calendar claim — and it now states its own ceiling, because C-2 gave
    // the code one and a consent sheet that omits it under-states what is sent.
    expect(ANGELONE_CAPABILITIES.egressDescription).toContain(
      "signed in at most once a day while Vyuha stays open, again after a relaunch, after Angel One's 5 AM IST session flush, or when the credentials are re-saved, or when the selected account is switched.",
    );
    // D-1 (fix wave 5). The first-cap clause is the CANONICAL sentence — the
    // sheet, PRIVACY, help and both READMEs carry it word for word, so a copy
    // that drifts here is a consent surface disagreeing with itself.
    expect(ANGELONE_CAPABILITIES.egressDescription).toContain(
      "If a sign-in is refused, Vyuha tries at most three times and then stops until you re-save the credentials or relaunch Vyuha.",
    );
    expect(
      ANGELONE_CAPABILITIES.egressDescription,
      "the second ceiling stopped being disclosed",
    ).toContain("three sessions in a row that Angel One calls invalid");
    expect(
      ANGELONE_CAPABILITIES.egressDescription,
      "the sheet still claims a calendar-daily sign-in (B-7)",
    ).not.toContain("once each trading day");
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

  /**
   * v4.2 fix wave 2, B-5 — the phrase, gone from the whole file.
   *
   * The health sentence is one branch of one template literal, so an assertion
   * on ONE built reason proves only that branch. B-5 removed the phrase from
   * every surface that states the rule; this holds the adapter's SOURCE to the
   * same standard, so a second branch cannot quietly bring it back.
   */
  it("no longer promises a 'last stored mark' anywhere in the adapter (B-5)", () => {
    expect(SRC.toLowerCase(), "the adapter still promises the last stored mark").not.toContain("last stored mark");
    expect(SRC).toContain(
      "each shows the position's recorded close, or a dash when no close is recorded",
    );
  });

  /**
   * C-11 (fix wave 3) — "or a dash", in every STRING the adapter can print.
   *
   * The comment above the sentence explains what the dash replaced, so a blunt
   * source-wide ban on the words would forbid the explanation as well. This
   * bans the phrase in the STRING LITERALS instead: any line the adapter could
   * hand to `health()` or to an error message.
   */
  it("promises a dash and never an entry price in any string it can print (C-11)", () => {
    const literals = SRC.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"));
    const offenders = literals.filter((line) => /entry price/i.test(line));
    expect(offenders, `the adapter still prints "entry price": ${offenders.join(" | ")}`).toEqual([]);
    expect(SRC, "and the replacement clause is stated, not just deleted").toContain(
      "recorded close, or a dash when no close is recorded",
    );
  });
});
