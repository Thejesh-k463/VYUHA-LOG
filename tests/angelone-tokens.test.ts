import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
// TYPE-ONLY, and it must stay that way: a value import of a `lib/quotes`
// module here would bind the SQLite connection before `openTempDb()` runs.
import type { AngelScripRow, AngelSearchScrip, AngelTokenCache, ResolvedAngelToken } from "@/lib/quotes/angelone-tokens";
import type { AngelOneCredentials } from "@/lib/import/api/angelone";
import type { QuoteKey } from "@/lib/quotes/types";

/**
 * ANGEL ONE'S TOKEN RESOLVER (v4.2, ruling 4.2-7).
 *
 * Angel One prices a `symboltoken`, not a ticker, and `searchScrip` answers a
 * search for "SBIN" with sixteen rows across six series. Everything in this
 * file exists to defend one property: the row that is CHOSEN is the trade's own
 * instrument, and when it cannot be identified with certainty the symbol is
 * LABELLED unresolvable rather than priced as its neighbour (invariant 6).
 *
 * NO SOCKET IS OPENED. `search` and the cache are injected everywhere except
 * the last block, which drives the REAL cache against a really migrated
 * database — because a hand-written migration with no journal entry is silently
 * skipped, and the failure then surfaces as "no such table" on a live desk.
 */

let t: TempDb;
let tokens: typeof import("@/lib/quotes/angelone-tokens");

beforeAll(async () => {
  t = await openTempDb("angelone-tokens");
  tokens = await import("@/lib/quotes/angelone-tokens");
});
afterAll(() => t?.cleanup());

const CREDS: AngelOneCredentials = { apiKey: "k", clientCode: "C1", pin: "1234", totpSecret: "JBSWY3DPEHPK3PXP" };

/**
 * The REAL shape of `searchScrip` for SBIN on NSE — sixteen rows, six series.
 * Trimmed to the five series the owner's live call returned first, which is
 * enough to make every tie-break decidable.
 */
const SBIN_ROWS: AngelScripRow[] = [
  { exchange: "NSE", tradingsymbol: "SBIN-AF", symboltoken: "11128" },
  { exchange: "NSE", tradingsymbol: "SBIN-BE", symboltoken: "11129" },
  { exchange: "NSE", tradingsymbol: "SBIN-BL", symboltoken: "11130" },
  { exchange: "NSE", tradingsymbol: "SBIN-EQ", symboltoken: "3045" },
  { exchange: "NSE", tradingsymbol: "SBIN-IQ", symboltoken: "11131" },
];

describe("splitAngelSymbol — the series suffix, and the tickers that look like one", () => {
  it("splits a decorated cash symbol into its ticker and its series", () => {
    expect(tokens.splitAngelSymbol("SBIN-EQ")).toEqual({ base: "SBIN", series: "EQ" });
    expect(tokens.splitAngelSymbol("sbin-be")).toEqual({ base: "SBIN", series: "BE" });
    expect(tokens.splitAngelSymbol("SBIN")).toEqual({ base: "SBIN", series: null });
    expect(tokens.splitAngelSymbol(null)).toEqual({ base: "", series: null });
  });

  it("does NOT read a hyphenated NSE ticker as a series — BAJAJ-AUTO is one company", () => {
    // A greedy /-[A-Z]+$/ reads this as BAJAJ, series AUTO, and then prices
    // Bajaj Auto's row with Bajaj Finance's neighbour. The whitelist is why.
    expect(tokens.splitAngelSymbol("BAJAJ-AUTO")).toEqual({ base: "BAJAJ-AUTO", series: null });
    expect(tokens.splitAngelSymbol("BAJAJ-AUTO-EQ")).toEqual({ base: "BAJAJ-AUTO", series: "EQ" });
    expect(tokens.splitAngelSymbol("M&M-EQ")).toEqual({ base: "M&M", series: "EQ" });
  });
});

describe("angelCashKey — what this feed will and will not ask about", () => {
  it("STRIPS the -EQ Angel One's own imports carry, and keeps the series as the hint", () => {
    expect(tokens.angelCashKey({ symbol: "SBIN", exchange: "NSE", tradingsymbol: "SBIN-EQ" })).toEqual({
      symbol: "SBIN",
      exchange: "NSE",
      series: "EQ",
      id: "NSE:SBIN",
    });
    expect(tokens.angelCashKey({ symbol: "SBIN", exchange: "NSE" })).toEqual({
      symbol: "SBIN",
      exchange: "NSE",
      series: null,
      id: "NSE:SBIN",
    });
    expect(tokens.angelCashKey({ symbol: "SBIN", exchange: "NSE", tradingsymbol: "SBIN-BE" })?.series).toBe("BE");
  });

  it("refuses every derivative and every other exchange — they are never SENT (ruling 4.2-8)", () => {
    for (const key of [
      { symbol: "TCS", exchange: "NFO" as const, tradingsymbol: "TCS26SEP3000CE" },
      { symbol: "SENSEX", exchange: "BFO" as const, tradingsymbol: "SENSEX26AUG77600CE" },
      { symbol: "GOLD", exchange: "MCX" as const },
      { symbol: "USDINR", exchange: "CDS" as const },
      // A cash EXCHANGE wearing a contract name is still a contract.
      { symbol: "TCS", exchange: "NSE" as const, tradingsymbol: "TCS26SEP3000CE" },
    ] satisfies QuoteKey[]) {
      expect(tokens.angelCashKey(key), JSON.stringify(key)).toBeNull();
    }
  });
});

describe("pickAngelScripRow — sixteen rows, one instrument (ruling 4.2-7)", () => {
  const want = { symbol: "SBIN", exchange: "NSE" as const };

  it("defaults to -EQ when the trade states no series of its own", () => {
    expect(tokens.pickAngelScripRow(SBIN_ROWS, want)?.symboltoken).toBe("3045");
    expect(tokens.pickAngelScripRow(SBIN_ROWS, { ...want, series: null })?.symboltoken).toBe("3045");
  });

  it("lets the TRADE's own series win — a BE holding is not the EQ scrip", () => {
    expect(tokens.pickAngelScripRow(SBIN_ROWS, { ...want, series: "BE" })?.symboltoken).toBe("11129");
    expect(tokens.pickAngelScripRow(SBIN_ROWS, { ...want, series: "AF" })?.symboltoken).toBe("11128");
    // …and falls back to EQ when the stated series is not on offer, rather
    // than to "whatever came first".
    expect(tokens.pickAngelScripRow(SBIN_ROWS, { ...want, series: "ST" })?.symboltoken).toBe("3045");
  });

  it("takes the only row when there is only one — BSE names many scrips undecorated", () => {
    const bse: AngelScripRow[] = [{ exchange: "BSE", tradingsymbol: "SBIN", symboltoken: "500112" }];
    expect(tokens.pickAngelScripRow(bse, { symbol: "SBIN", exchange: "BSE" })?.symboltoken).toBe("500112");
  });

  it("returns NULL rather than guessing when nothing identifies the instrument", () => {
    // Several rows, none of them EQ and none of them the stated series: the
    // symbol is unresolvable and the desk says so. A guess here prices one
    // instrument under another's name and is not recoverable (invariant 6).
    const noEq = SBIN_ROWS.filter((r) => r.tradingsymbol !== "SBIN-EQ");
    expect(tokens.pickAngelScripRow(noEq, want)).toBeNull();
    // Nothing at all, and nothing on the exchange asked for.
    expect(tokens.pickAngelScripRow([], want)).toBeNull();
    expect(tokens.pickAngelScripRow(null, want)).toBeNull();
    expect(tokens.pickAngelScripRow(SBIN_ROWS, { symbol: "SBIN", exchange: "BSE" })).toBeNull();
  });

  it("refuses a row that is not this symbol, however similar it looks", () => {
    const nearMiss: AngelScripRow[] = [
      { exchange: "NSE", tradingsymbol: "SBINEQ", symboltoken: "99991" },
      { exchange: "NSE", tradingsymbol: "SBICARD-EQ", symboltoken: "99992" },
      { exchange: "NSE", tradingsymbol: "SBIN26SEP800CE", symboltoken: "99993" },
      // A row with no usable token is not a candidate either.
      { exchange: "NSE", tradingsymbol: "SBIN-EQ", symboltoken: "" },
    ];
    expect(tokens.pickAngelScripRow(nearMiss, want)).toBeNull();
  });
});

/* ────────────────────────────── the resolver ────────────────────────────── */

function fakeCache(seed: ResolvedAngelToken[] = []): AngelTokenCache & { written: ResolvedAngelToken[] } {
  const store = new Map(seed.map((r) => [`${r.exchange}:${r.symbol}`, r]));
  const written: ResolvedAngelToken[] = [];
  return {
    written,
    async read(pairs) {
      const out = new Map<string, ResolvedAngelToken>();
      for (const p of pairs) {
        const hit = store.get(`${p.exchange}:${p.symbol}`);
        if (hit) out.set(`${p.exchange}:${p.symbol}`, hit);
      }
      return out;
    },
    async write(row) {
      written.push(row);
      store.set(`${row.exchange}:${row.symbol}`, row);
    },
  };
}

function fakeSearch(bySymbol: Record<string, AngelScripRow[]>): AngelSearchScrip & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (_creds, _jwt, exchange, searchscrip) => {
    calls.push(`${exchange}:${searchscrip}`);
    return bySymbol[searchscrip] ?? [];
  }) as AngelSearchScrip & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const KEY = (symbol: string, exchange: "NSE" | "BSE" = "NSE", tradingsymbol?: string): QuoteKey => ({
  symbol,
  exchange,
  ...(tradingsymbol ? { tradingsymbol } : {}),
});

describe("createAngelTokenResolver — lazy, paced, and never guessing", () => {
  it("resolves through searchScrip, caches the answer, and never asks twice", async () => {
    const search = fakeSearch({ SBIN: SBIN_ROWS });
    const cache = fakeCache();
    const r = tokens.createAngelTokenResolver({ search, cache, now: () => Date.parse("2026-09-07T04:00:00Z") });

    const first = await r.resolve([KEY("SBIN", "NSE", "SBIN-EQ")], { creds: CREDS, jwt: "j", budget: 5 });
    expect(first.lookups).toBe(1);
    expect(first.tokens.get("NSE:SBIN")).toEqual({
      exchange: "NSE",
      symbol: "SBIN",
      tradingsymbol: "SBIN-EQ",
      token: "3045",
    });
    expect(cache.written).toEqual([first.tokens.get("NSE:SBIN")]);

    const second = await r.resolve([KEY("SBIN")], { creds: CREDS, jwt: "j", budget: 5 });
    expect(second.lookups, "a resolved symbol is never looked up again").toBe(0);
    expect(second.tokens.get("NSE:SBIN")?.token).toBe("3045");
    expect(search.calls).toEqual(["NSE:SBIN"]);
  });

  it("reads the cache before the wire — a restart costs no lookups", async () => {
    const cached: ResolvedAngelToken = { exchange: "NSE", symbol: "TCS", tradingsymbol: "TCS-EQ", token: "11536" };
    const search = fakeSearch({});
    const r = tokens.createAngelTokenResolver({ search, cache: fakeCache([cached]) });
    const out = await r.resolve([KEY("TCS")], { creds: CREDS, jwt: "j", budget: 5 });
    expect(out.lookups).toBe(0);
    expect(search.calls).toEqual([]);
    expect(out.tokens.get("NSE:TCS")).toEqual(cached);
  });

  it("spends only its BUDGET per cycle and reports the rest as pending, not as failures", async () => {
    const search = fakeSearch({ SBIN: SBIN_ROWS });
    const r = tokens.createAngelTokenResolver({ search, cache: fakeCache() });
    const keys = [KEY("SBIN"), KEY("TCS"), KEY("INFY"), KEY("WIPRO")];
    const out = await r.resolve(keys, { creds: CREDS, jwt: "j", budget: 2 });
    expect(out.lookups).toBe(2);
    expect(out.pending).toEqual(["INFY", "WIPRO"].map((s) => `NSE:${s}`));
    // The two it DID ask about: SBIN resolved, TCS had no rows at all.
    expect(out.tokens.has("NSE:SBIN")).toBe(true);
    expect(out.unresolved).toEqual(["NSE:TCS"]);
  });

  it("STOPS when the rate guard refuses — nothing is queued and nothing is retried", async () => {
    const search = fakeSearch({ SBIN: SBIN_ROWS, TCS: [] });
    const r = tokens.createAngelTokenResolver({ search, cache: fakeCache() });
    let allowed = 1;
    const out = await r.resolve([KEY("SBIN"), KEY("TCS")], {
      creds: CREDS,
      jwt: "j",
      budget: 5,
      pace: async () => allowed-- > 0,
    });
    expect(out.lookups).toBe(1);
    expect(out.pending).toEqual(["NSE:TCS"]);
    expect(search.calls).toEqual(["NSE:SBIN"]);
  });

  it("labels an unresolvable symbol once and never spends another request on it", async () => {
    const search = fakeSearch({});
    const r = tokens.createAngelTokenResolver({ search, cache: fakeCache() });
    const first = await r.resolve([KEY("NOSUCHSCRIP")], { creds: CREDS, jwt: "j", budget: 5 });
    expect(first.unresolved).toEqual(["NSE:NOSUCHSCRIP"]);
    expect(first.tokens.size).toBe(0);
    const second = await r.resolve([KEY("NOSUCHSCRIP")], { creds: CREDS, jwt: "j", budget: 5 });
    expect(second.lookups, "a stable 'no such scrip' is not re-asked every three seconds").toBe(0);
    expect(second.unresolved).toEqual(["NSE:NOSUCHSCRIP"]);
    expect(r.unresolvable()).toEqual(["NSE:NOSUCHSCRIP"]);
    expect(search.calls).toEqual(["NSE:NOSUCHSCRIP"]);
  });

  it("never SENDS a derivative — it is skipped before any request is built", async () => {
    const search = fakeSearch({ SBIN: SBIN_ROWS });
    const r = tokens.createAngelTokenResolver({ search, cache: fakeCache() });
    const out = await r.resolve(
      [KEY("SBIN"), { symbol: "TCS", exchange: "NFO", tradingsymbol: "TCS26SEP3000CE" }],
      { creds: CREDS, jwt: "j", budget: 5 },
    );
    expect(out.skipped.map((k) => k.tradingsymbol)).toEqual(["TCS26SEP3000CE"]);
    expect(search.calls).toEqual(["NSE:SBIN"]);
  });

  it("hands back a failed lookup as a message, not as a throw — the cycle still prices", async () => {
    const cached: ResolvedAngelToken = { exchange: "NSE", symbol: "TCS", tradingsymbol: "TCS-EQ", token: "11536" };
    const search = (async () => {
      throw new Error("Angel One symbol search: Invalid Token");
    }) as AngelSearchScrip;
    const r = tokens.createAngelTokenResolver({ search, cache: fakeCache([cached]) });
    const out = await r.resolve([KEY("TCS"), KEY("SBIN")], { creds: CREDS, jwt: "j", budget: 5 });
    expect(out.lookupError).toMatch(/Invalid Token/);
    expect(out.tokens.get("NSE:TCS"), "what was already known survives the failure").toEqual(cached);
    // …and the symbol that failed is NOT condemned: a dead session says
    // nothing about Angel One's catalogue.
    expect(out.unresolved).toEqual([]);
    expect(r.unresolvable()).toEqual([]);
  });
});

/* ─────────────────── the real cache, on a real migration ────────────────── */

describe("migration 0070 — angelone_instrument_tokens, on a really migrated database", () => {
  /**
   * A hand-written migration with no `drizzle/meta/_journal.json` entry is
   * SILENTLY SKIPPED (AGENTS.md, migrations 0027+), and the failure then
   * surfaces as a SQLite "no such table" the first time a desk resolves a
   * symbol. This asserts the table exists where it matters — in a database
   * built by running the migrations — and that the real cache round-trips.
   */
  it("exists on the migrated schema, with no account_id and a unique (exchange, symbol)", () => {
    const cols = t.sqlite.prepare("PRAGMA table_info(angelone_instrument_tokens)").all() as { name: string }[];
    expect(cols.map((c) => c.name).sort()).toEqual(
      ["exchange", "id", "resolved_at", "symbol", "token", "tradingsymbol"].sort(),
    );
    // A token is a fact about the market, not about a book: invariants 8/9
    // have nothing to own here, and `tests/account-isolation.test.ts` would
    // fail loudly if a later wave added one.
    expect(cols.map((c) => c.name)).not.toContain("account_id");
    const idx = t.sqlite
      .prepare("SELECT name, \"unique\" AS uniq FROM pragma_index_list('angelone_instrument_tokens')")
      .all() as { name: string; uniq: number }[];
    expect(idx.some((i) => i.name === "angelone_instrument_tokens_exchange_symbol_uq" && i.uniq === 1)).toBe(true);
  });

  it("round-trips a resolution and UPSERTS a correction instead of appending a second row", async () => {
    const row: ResolvedAngelToken = { exchange: "NSE", symbol: "SBIN", tradingsymbol: "SBIN-EQ", token: "3045" };
    await tokens.angelDbTokenCache.write(row, "2026-09-07T09:20:00.000Z");
    const back = await tokens.angelDbTokenCache.read([{ exchange: "NSE", symbol: "SBIN" }]);
    expect(back.get("NSE:SBIN")).toEqual(row);

    // The same symbol on the OTHER exchange is a different instrument and a
    // different row — the token spaces are per exchange.
    await tokens.angelDbTokenCache.write(
      { exchange: "BSE", symbol: "SBIN", tradingsymbol: "SBIN", token: "500112" },
      "2026-09-07T09:20:01.000Z",
    );
    // …and a re-resolution CORRECTS the NSE row rather than adding a second.
    await tokens.angelDbTokenCache.write(
      { exchange: "NSE", symbol: "SBIN", tradingsymbol: "SBIN-BE", token: "11129" },
      "2026-09-07T09:21:00.000Z",
    );
    const n = t.sqlite
      .prepare("SELECT count(*) AS n FROM angelone_instrument_tokens WHERE symbol = 'SBIN'")
      .get() as { n: number };
    expect(n.n).toBe(2);
    const corrected = await tokens.angelDbTokenCache.read([
      { exchange: "NSE", symbol: "SBIN" },
      { exchange: "BSE", symbol: "SBIN" },
    ]);
    expect(corrected.get("NSE:SBIN")?.token).toBe("11129");
    expect(corrected.get("BSE:SBIN")?.token).toBe("500112");
  });

  it("answers a miss with an empty map rather than a throw", async () => {
    await expect(tokens.angelDbTokenCache.read([{ exchange: "NSE", symbol: "NOSUCHSCRIP" }])).resolves.toEqual(
      new Map(),
    );
    await expect(tokens.angelDbTokenCache.read([])).resolves.toEqual(new Map());
  });

  it("is what the resolver actually reads — a restart costs no lookups", async () => {
    const search = fakeSearch({});
    const r = tokens.createAngelTokenResolver({ search });
    const out = await r.resolve([{ symbol: "SBIN", exchange: "BSE" }], { creds: CREDS, jwt: "j", budget: 5 });
    expect(out.lookups).toBe(0);
    expect(search.calls).toEqual([]);
    expect(out.tokens.get("BSE:SBIN")?.token).toBe("500112");
  });
});

/**
 * WHOSE SERIES FEEDS THE TIE-BREAKER (v4.2 fix A-14).
 *
 * The header of `lib/quotes/angelone-tokens.ts` used to say the trade's own
 * series wins "when Vyuha knows it (Angel One's own imports carry SBIN-EQ)".
 * The SmartAPI import strips the suffix before it stores anything, so an
 * Angel-imported trade is the one case that can NEVER feed that rule. The
 * behaviour is right and was never the bug; the sentence was, and a comment
 * that misdescribes which input reaches a tie-break is how the next reader
 * "fixes" the wrong half.
 */
describe("the series tie-breaker is fed by another source, never by Angel One's own import", () => {
  it("Angel One's own import STRIPS the series, so its trades arrive with none", async () => {
    const { stripSeriesSuffix, normalizeAngelTrades } = await import("@/lib/import/api/angelone");
    expect(stripSeriesSuffix("SBIN-EQ")).toBe("SBIN");

    // …and that is really what the import stores on the trade row.
    const { trades } = normalizeAngelTrades(
      [{ tradingsymbol: "SBIN-EQ", exchange: "NSE", producttype: "DELIVERY", transactiontype: "BUY",
         fillsize: "1", fillprice: "800", filltime: "10:00:00" }],
      "2026-09-07",
    );
    expect(trades[0]!.tradingsymbol).toBe("SBIN");

    // So the key the resolver sees carries no series, and the "-EQ" default —
    // not the trade's own series — is what picks the row.
    const cash = tokens.angelCashKey({ symbol: "SBIN", exchange: "NSE", tradingsymbol: trades[0]!.tradingsymbol });
    expect(cash?.series, "an Angel-imported trade cannot feed the tie-breaker").toBeNull();
    expect(tokens.pickAngelScripRow(SBIN_ROWS, { symbol: "SBIN", exchange: "NSE", series: cash?.series })?.symboltoken)
      .toBe("3045"); // SBIN-EQ, by the default rule
  });

  it("a tradingsymbol that KEPT its series is the case the tie-breaker exists for", () => {
    const cash = tokens.angelCashKey({ symbol: "SBIN", exchange: "NSE", tradingsymbol: "SBIN-BE" });
    expect(cash?.series).toBe("BE");
    // Here "-EQ" would be the wrong instrument, and the trade's own series wins.
    expect(tokens.pickAngelScripRow(SBIN_ROWS, { symbol: "SBIN", exchange: "NSE", series: cash?.series })?.symboltoken)
      .toBe("11129");
  });

  it("and the header says so — the claim about Angel One's own imports is gone", () => {
    const src = readFileSync(path.join(process.cwd(), "lib/quotes/angelone-tokens.ts"), "utf8");
    expect(src, "the header still claims Angel One's own imports carry a series").not.toMatch(
      /Angel One's own imports[\s\S]{0,40}carry "SBIN-EQ"/,
    );
    expect(src, "the header must name the strip that makes the tie-breaker unreachable from that source").toMatch(
      /stripSeriesSuffix/,
    );
  });
});
