import { describe, expect, it } from "vitest";
import { createAngelOneProvider, type AngelOneGateState, type AngelOneHealth, type AngelQuoteFetcher } from "@/lib/quotes/angelone";
import type { AngelTokenCache, ResolvedAngelToken } from "@/lib/quotes/angelone-tokens";
import type { AngelOneCredentials } from "@/lib/import/api/angelone";
import { angelOneCadenceSeconds, type QuoteKey } from "@/lib/quotes/types";

/**
 * THE SHARED ANGEL ONE INSTANCE HAS TWO CALLERS SINCE v4.7.0 C5 (review R3):
 * the desk's poll and the Telegram alert job. Two overlapping `snapshot()`s used
 * to race for `slot()` — both minted a session, or the 1 req/s guard refused
 * the second and wrote its sentence onto the desk's pill — and the alert job's
 * key count overwrote the cadence the pill states. Pinned here: snapshots are
 * SERIALISED on the instance, and only `subscribe()` sets the cadence.
 *
 * Nothing touches the network: gate, login, quote and token cache are injected,
 * and the clock moves only when the pacing sleeps (a real macrotask yield, so
 * two un-awaited snapshots genuinely interleave).
 */

const CREDS: AngelOneCredentials = { apiKey: "k", clientCode: "C1", pin: "1234", totpSecret: "JBSWY3DPEHPK3PXP" };
const READY: AngelOneGateState = { state: "ready", creds: CREDS };
const T0 = Date.parse("2026-10-07T04:00:00Z");
const KEY = (symbol: string): QuoteKey => ({ symbol, exchange: "NSE" });

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

function harness() {
  let clock = T0;
  const state = { logins: 0, quotes: 0 };
  const quoteImpl: AngelQuoteFetcher = async (_c, _j, batch) => {
    state.quotes += 1;
    await new Promise((r) => setTimeout(r, 0));
    return {
      fetched: batch.tokens.map((tok) => ({ exchange: batch.exchange,tradingSymbol: "SBIN-EQ", symbolToken: tok, ltp: 1005.9, open: 1, high: 1, low: 1, close: 1 })),
      unfetched: [],
    };
  };
  const provider = createAngelOneProvider({
    readGate: async () => READY,
    now: () => clock,
    sleep: async (ms) => {
      await new Promise((r) => setTimeout(r, 0));
      clock += ms;
    },
    loginImpl: async () => {
      state.logins += 1;
      await new Promise((r) => setTimeout(r, 0));
      return { jwtToken: `jwt-${state.logins}` };
    },
    quoteImpl,
    tokenCache: seededCache([{ exchange: "NSE", symbol: "SBIN", tradingsymbol: "SBIN-EQ", token: "3045" }]),
    searchImpl: async () => [],
  });
  return { provider, state };
}

describe("R3 — one snapshot at a time on the shared instance", () => {
  it("two overlapping snapshots (the desk's poll + the alert job) sign in ONCE and BOTH are priced, no guard refusal", async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.provider.snapshot([KEY("SBIN")]), h.provider.snapshot([KEY("SBIN")])]);
    expect(h.state.logins, "the second sweep minted its own session").toBe(1);
    expect(a.size).toBe(1);
    expect(b.size).toBe(1);
    const health = (await h.provider.health()) as AngelOneHealth;
    expect(health.ok, `the pill carries a refusal: ${health.reason}`).toBe(true);
  });

  it("a sweep that throws does not block the next one", async () => {
    let fail = true;
    const provider = createAngelOneProvider({
      readGate: async () => {
        if (fail) {
          fail = false;
          return { state: "disabled", reason: "off" } as AngelOneGateState;
        }
        return READY;
      },
      now: () => T0,
      sleep: async () => {},
      loginImpl: async () => ({ jwtToken: "j" }),
      quoteImpl: async () => ({ fetched: [], unfetched: [] }),
      tokenCache: seededCache([]),
      searchImpl: async () => [],
    });
    await expect(provider.snapshot([KEY("SBIN")])).rejects.toThrow("off");
    await expect(provider.snapshot([KEY("SBIN")])).resolves.toBeInstanceOf(Map);
  });
});

describe("R3 — the cadence the pill states comes from subscribe() only", () => {
  const many = Array.from({ length: 300 }, (_, i) => KEY(`ZZ${i}`));

  it("a snapshot of a different key count (the alert job's) leaves the stated cadence alone", async () => {
    const h = harness();
    const before = ((await h.provider.health()) as AngelOneHealth).cadenceSeconds;
    expect(angelOneCadenceSeconds(many.length)).not.toBe(before);
    await h.provider.snapshot(many);
    expect(((await h.provider.health()) as AngelOneHealth).cadenceSeconds).toBe(before);
  });

  it("subscribe() still sets it from the desk's own key count", async () => {
    const h = harness();
    const stop = h.provider.subscribe(many, () => {});
    expect(((await h.provider.health()) as AngelOneHealth).cadenceSeconds).toBe(angelOneCadenceSeconds(many.length));
    stop();
  });
});
