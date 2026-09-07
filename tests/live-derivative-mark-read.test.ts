import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import type { ProviderCapabilities, ProviderHealth, QuoteKey, QuoteMap, QuoteProvider } from "@/lib/quotes/types";
// PURE (no `lib/db`, no React) — `lib/live/connect-prompt.ts` reads a string and
// a stored envelope and nothing else, so a static import cannot bind a database
// connection before `openTempDb()` sets `VYUHA_DB_PATH`.
import { showConnectPrompt } from "@/lib/live/connect-prompt";

/**
 * The Live Desk's READ of a stored mark, against a real (temp) database.
 *
 * Two v4.2 fix-wave rulings meet in `components/live/load-desk.ts`, and both
 * are invisible to a pure unit test because the behaviour under test is what
 * the loader does with the database and with the quote provider:
 *
 *  A-1  A DERIVATIVE NEVER READS THE UNDERLYING'S CASH MARK. `mtm_prices` is
 *       keyed on `symbol`, and a derivative trade carries its UNDERLYING
 *       there. The loader used to resolve
 *       `mtm.get(symbol) ?? mtm.get(tradingsymbol) ?? close`, so an open
 *       `OPT TCS …2500 CE` (875 × ₹2.75) beside a stored `TCS = 2057.5`
 *       printed the SPOT as the premium — +₹17,97,906.25 on the desk, and the
 *       "Stored mark" pill presented the cash number as this contract's own
 *       (invariant 6). `lib/analytics/positions.ts` `storedMarkFor()` is now
 *       the single implementation of the precedence, called from both sides.
 *
 *  A-5  THE SSR SNAPSHOT KEYS ARE DEDUPED, on `quoteKeyId()`, exactly as
 *       `app/api/live/stream/route.ts` and `lib/quotes/persist-mark.ts`
 *       already dedupe them — two open trades in one scrip are ONE
 *       subscription, not two. `feed.symbolCount` publishes the deduped count
 *       the provider was actually handed (the client reads it for the Angel
 *       One cadence sentence before the stream connects).
 *
 * `lib/db` is imported DYNAMICALLY, through `openTempDb`, and everything that
 * reaches it is imported after — a static import anywhere in this file's graph
 * binds the connection before the helper sets `VYUHA_DB_PATH`. ONE temp
 * database per FILE (`lib/db` caches its connection on `globalThis`).
 */

let t: TempDb;
let live: typeof import("@/components/live/load-desk");
let quoteKeyId: typeof import("@/lib/quotes/types").quoteKeyId;

/** Every key set the loader handed the provider, newest last. */
const stub = vi.hoisted(() => ({
  provider: null as QuoteProvider | null,
  snapshotKeys: [] as QuoteKey[][],
}));

vi.mock("@/lib/quotes/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/quotes/registry")>();
  return {
    ...actual,
    getLiveFeedProvider: async () => stub.provider ?? (await actual.getLiveFeedProvider()),
  };
});

const ACCOUNT = 1;
const EQUITY_A = 301;
const EQUITY_B = 302;
const OPTION = 303;

/** ₹2,057.50 — the CASH close of the underlying, and the trap this file exists for. */
const TCS_SPOT = 2057.5;
const OPT_TRADINGSYMBOL = "OPT TCS 30 JUN 2026 2500 CE";

/**
 * A provider that quotes NOTHING and records what it was asked for.
 *
 * Quoting nothing is the point: with no live quote every row falls to the
 * STORED rung, which is the rung A-1 is about. `streaming: false` also makes
 * `catchUpDailyMark()` a no-op, so reading the desk never writes a mark.
 */
function recordingProvider(): QuoteProvider {
  const capabilities: ProviderCapabilities = {
    id: "eod",
    label: "recording double",
    streaming: false,
    maxSubscriptions: 500,
    minSnapshotIntervalMs: 1000,
    depth: 0,
    segments: ["NSE"],
    staleness: "eod",
    requiresDailyAuth: false,
    egressDescription: "None. A test double.",
  };
  return {
    id: "eod",
    capabilities,
    snapshot: async (keys: readonly QuoteKey[]): Promise<QuoteMap> => {
      stub.snapshotKeys.push([...keys]);
      return new Map();
    },
    subscribe: () => () => {},
    health: async () => ({ ok: true }),
  };
}

function setOpen(id: number, isOpen: boolean) {
  t.sqlite.prepare("UPDATE trades SET is_open = ? WHERE id = ?").run(isOpen ? 1 : 0, id);
}

/** The keys the LAST render handed the provider. */
function lastKeys(): QuoteKey[] {
  return stub.snapshotKeys[stub.snapshotKeys.length - 1] ?? [];
}

beforeAll(async () => {
  t = await openTempDb("live-derivative-mark", { seed: true });
  live = await import("@/components/live/load-desk");
  // `lib/quotes/types.ts` is a pure leaf, but it is imported here rather than
  // statically for the same discipline the rest of this file follows.
  ({ quoteKeyId } = await import("@/lib/quotes/types"));

  t.db.update(t.schema.settings).set({ equityCapital: 1_000_000, selectedAccountId: 0 }).run();

  t.db
    .insert(t.schema.trades)
    .values([
      // Two open trades in ONE scrip — the A-5 dedupe case.
      tradeRow({
        id: EQUITY_A,
        accountId: ACCOUNT,
        symbol: "TCS",
        tradingsymbol: "TCS",
        isOpen: true,
        buyQty: 10,
        avgBuyPrice: 2000,
        buyDate: "2026-06-01",
      }),
      tradeRow({
        id: EQUITY_B,
        accountId: ACCOUNT,
        symbol: "TCS",
        tradingsymbol: "TCS",
        isOpen: true,
        buyQty: 5,
        avgBuyPrice: 2010,
        buyDate: "2026-06-02",
      }),
      // The derivative: its `symbol` IS the underlying, which is the whole trap.
      tradeRow({
        id: OPTION,
        accountId: ACCOUNT,
        bucket: "active",
        segment: "stock_option",
        instrumentType: "option",
        symbol: "TCS",
        tradingsymbol: OPT_TRADINGSYMBOL,
        optionType: "CE",
        strike: 2500,
        expiry: "2026-06-30",
        isOpen: true,
        buyQty: 875,
        avgBuyPrice: 2.75,
        closingPrice: 3.1,
        buyDate: "2026-06-01",
      }),
    ])
    .run();

  // The cash mark, stored under the SYMBOL — which both the equity rows and
  // (before A-1) the option row read.
  t.db.insert(t.schema.mtmPrices).values({ symbol: "TCS", tradingsymbol: "TCS", price: TCS_SPOT, asOfDate: "2026-06-05" }).run();

  stub.provider = recordingProvider();
});

afterAll(() => {
  stub.provider = null;
  t.cleanup();
});

describe("loadLiveDesk — A-1: the desk never prices a contract off its underlying", () => {
  it("the option row's mark is its own close, and the equity rows still read the cash mark", async () => {
    setOpen(OPTION, true);
    stub.snapshotKeys.length = 0;
    const data = await live.loadLiveDesk({ pro: true });

    const opt = data.rows.find((r) => r.id === OPTION);
    expect(opt, "the open option must be on the desk").toBeTruthy();
    // ₹3.10, the contract's OWN recorded close — in paise (invariant 1).
    expect(opt!.markP).toBe(310);
    expect(opt!.markP).not.toBe(205_750); // the cash mark, in paise
    // The "Stored mark" pill is the `manual` staleness key (desk-copy.ts). A
    // derivative must never wear it off a mark stored under the underlying:
    // this row is priced from the journal's own close, and says so.
    expect(opt!.staleness).toBe("eod");
    // 875 × (₹3.10 − ₹2.75) = ₹306.25, NOT the +₹17,97,906.25 the spot printed.
    expect(opt!.unrealisedP).toBe(30_625);
    expect(opt!.unrealisedP).not.toBe(179_790_625);
    expect(opt!.instrumentType).toBe("option");

    // CONTROL — an equity in the SAME scrip is unchanged: it reads the stored
    // cash mark under its symbol and wears the stored-mark badge.
    const eq = data.rows.find((r) => r.id === EQUITY_A);
    expect(eq!.markP).toBe(205_750);
    expect(eq!.staleness).toBe("manual");
  });
});

describe("loadLiveDesk — A-5: the SSR snapshot keys are deduped on quoteKeyId", () => {
  it("two open trades in one scrip are ONE key, and feed.symbolCount says so", async () => {
    setOpen(OPTION, false); // only the two TCS equity trades remain open
    stub.snapshotKeys.length = 0;
    try {
      const data = await live.loadLiveDesk({ pro: true });

      expect(data.rows.map((r) => r.id).sort()).toEqual([EQUITY_A, EQUITY_B]);
      const keys = lastKeys();
      expect(keys).toHaveLength(1);
      expect(quoteKeyId(keys[0])).toBe("NSE:TCS");
      expect(data.feed.symbolCount).toBe(1);
    } finally {
      setOpen(OPTION, true);
    }
  });

  it("a contract and its underlying are two DIFFERENT keys — dedupe is on the traded scrip", async () => {
    setOpen(OPTION, true);
    stub.snapshotKeys.length = 0;
    const data = await live.loadLiveDesk({ pro: true });

    const ids = lastKeys().map(quoteKeyId).sort();
    expect(ids).toEqual([`NSE:${OPT_TRADINGSYMBOL}`, "NSE:TCS"]);
    expect(data.feed.symbolCount).toBe(2);
    // Three open positions, two subscriptions — the count is the KEY count,
    // never the row count.
    expect(data.rows).toHaveLength(3);
  });

  it("every row still finds its own quote key after the dedupe (the row/key pairing is by id, not by index)", async () => {
    setOpen(OPTION, true);
    const data = await live.loadLiveDesk({ pro: true });
    for (const r of data.rows) expect(r.exchange).toBe("NSE");
    expect(data.rows.find((r) => r.id === OPTION)!.tradingsymbol).toBe(OPT_TRADINGSYMBOL);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * A-13 — THE ADAPTER'S `state` SURVIVES A THROWN `snapshot()`.
 *
 * `load-desk.ts` asks `snapshot()` FIRST and only reaches `health()` when the
 * snapshot came back. On a consented broker feed with no connection saved for
 * the SELECTED account (switch accounts and the connection is gone) the adapter
 * throws the gate's own sentence, and the catch used to rebuild health from
 * that MESSAGE alone — dropping `state`, so `desk-types.ts` fell back to
 * "disabled". `GET /api/live/feed` calls `health()` directly and reported
 * "no-key" off the very same provider and the very same database, and
 * `showConnectPrompt()` (owner answer Q24) fires only on `no-key`/
 * `unreachable` — so the once-a-day desk prompt was dead for exactly the state
 * it exists for. Only an EMPTY book escaped, because `snapshot([])` returns
 * before it can throw.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** The gate's own sentence, as `lib/quotes/angelone.ts` throws and reports it. */
const NO_CONNECTION =
  "No Angel One connection is saved for this account. Save the API key, client code, PIN and TOTP secret under Import → Connect broker.";

/**
 * A CONSENTED broker feed with nothing saved for the selected account: its
 * `snapshot()` throws the gate's sentence, and its `health()` — which never
 * throws and makes no request, by contract — carries the `state` that sentence
 * cannot. `streaming: false` keeps `catchUpDailyMark()` a no-op, so reading the
 * desk still writes nothing.
 */
function brokerHealth(state: string, ok: boolean, reason?: string): QuoteProvider {
  const capabilities: ProviderCapabilities = {
    id: "angelone",
    label: "broker double",
    streaming: false,
    maxSubscriptions: 500,
    minSnapshotIntervalMs: 1000,
    depth: 0,
    segments: ["NSE"],
    staleness: "delayed",
    requiresDailyAuth: true,
    egressDescription: "None. A test double.",
  };
  return {
    id: "angelone",
    capabilities,
    snapshot: async (): Promise<QuoteMap> => {
      throw new Error(NO_CONNECTION);
    },
    subscribe: () => () => {},
    health: async (): Promise<ProviderHealth & { state?: string }> => ({ ok, state, reason }),
  };
}

describe("loadLiveDesk — A-13: a thrown snapshot keeps the adapter's health STATE", () => {
  it("a consented broker feed with no connection publishes `no-key`, so Q24's connect prompt can fire", async () => {
    const previous = stub.provider;
    stub.provider = brokerHealth("no-key", false, NO_CONNECTION);
    try {
      const data = await live.loadLiveDesk({ pro: true });

      expect(data.feed.providerId).toBe("angelone");
      expect(data.feed.ok).toBe(false);
      // The state the ADAPTER reported — not the "disabled" fallback a
      // message-only rebuild leaves behind, and the same value
      // `GET /api/live/feed` publishes for this database.
      expect(data.feed.healthState).toBe("no-key");
      expect(data.feed.reason).toBe(NO_CONNECTION);
      // …and the once-a-day desk prompt can fire for the one state it exists for.
      expect(
        showConnectPrompt({ providerId: data.feed.providerId, healthState: data.feed.healthState }, null),
        "the Q24 connect prompt for a consented feed with no connection",
      ).toBe(true);

      // The journal's own record survived the throw (invariant 7), and the
      // subscription size stays NOT KNOWN because no snapshot came back
      // (invariant 6 — null is a value, never a fabricated 0).
      expect(data.rows).toHaveLength(3);
      expect(data.feed.symbolCount).toBeNull();
    } finally {
      stub.provider = previous;
    }
  });

  it("`unreachable` crosses the same way — the state a reconnection fixes reaches the prompt", async () => {
    const previous = stub.provider;
    stub.provider = brokerHealth("unreachable", false, "Angel One did not answer.");
    try {
      const data = await live.loadLiveDesk({ pro: true });
      expect(data.feed.healthState).toBe("unreachable");
      expect(data.feed.reason).toBe("Angel One did not answer.");
      expect(showConnectPrompt({ providerId: data.feed.providerId, healthState: data.feed.healthState }, null)).toBe(true);
    } finally {
      stub.provider = previous;
    }
  });

  it("a provider reporting itself HEALTHY explains nothing about the throw, so the thrown sentence stands alone", async () => {
    const previous = stub.provider;
    // ok:true says the feed is fine; the snapshot still failed for THIS render.
    // Publishing that `ok` would print a green pill over a desk that priced
    // nothing, so the loader keeps the honest failure and the thrown sentence.
    stub.provider = brokerHealth("ok", true, "Angel One is connected.");
    try {
      const data = await live.loadLiveDesk({ pro: true });
      expect(data.feed.ok).toBe(false);
      expect(data.feed.reason).toBe(NO_CONNECTION);
      expect(data.feed.healthState).toBe("disabled");
      expect(showConnectPrompt({ providerId: data.feed.providerId, healthState: data.feed.healthState }, null)).toBe(false);
    } finally {
      stub.provider = previous;
    }
  });
});
