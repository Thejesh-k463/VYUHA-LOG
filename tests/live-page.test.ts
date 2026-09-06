import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { NAV_DEFAULT_VISIBLE, NAV_ITEMS } from "@/components/layout/nav-config";
import { SCREEN_DOMAIN, WORKSPACES, screenVisible } from "@/lib/domain/workspace";
import type { ProviderCapabilities, QuoteProvider } from "@/lib/quotes/types";

/**
 * `/live` — the server loader, against a real (temp) database.
 *
 * The three things that can go quietly wrong here, and cost the most:
 *
 *  1. A CLOSED trade in the desk. `is_open` is the open predicate, not
 *     `sell_date IS NULL` — the sell date is a sort key and a staged position
 *     can carry one while still being open.
 *  2. A row with no account. The desk aggregates every account when the
 *     selection is 0 (owner ruling Q19), so `accountId` must ride on every row
 *     from `LivePosition` onward — retrofitting a grouping key through a live
 *     view later is the expensive version (invariant 8).
 *  3. A fabricated risk setting. With `risk_pct_ppm` unset the desk must SAY
 *     so and route to the Sizing Lab, never default to 2% (invariant 6).
 *
 * `lib/db` is imported DYNAMICALLY, through `openTempDb`, and every module
 * that reaches it is imported after — a static import anywhere in this file's
 * graph binds the connection before the helper sets `VYUHA_DB_PATH`.
 */

let t: TempDb;
let live: typeof import("@/components/live/load-desk");

/**
 * Opt-in provider double (FW-1). While `stub.provider` is null every test in
 * this file gets the real registry, untouched — the same shape
 * `tests/live-stream-route.test.ts` uses, and for the same reason: the loader
 * has to be watched with a STREAMING provider, and no shipped one can be made
 * to stream from a temp database.
 */
const stub = vi.hoisted(() => ({ provider: null as QuoteProvider | null }));

vi.mock("@/lib/quotes/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/quotes/registry")>();
  return {
    ...actual,
    getLiveFeedProvider: async () => stub.provider ?? (await actual.getLiveFeedProvider()),
  };
});

const PRIMARY = 1;
const SWING = 2;

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

function setRiskPpm(ppm: number | null) {
  t.db.update(t.schema.riskConfig).set({ riskPctPpm: ppm }).run();
}

beforeAll(async () => {
  t = await openTempDb("live-desk", { seed: true });
  live = await import("@/components/live/load-desk");

  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing", isDefault: false }).run();
  // Capital lives on `settings` for the aggregate view (getBucketCapital's own
  // rule: the aggregate has no single account to ask).
  t.db.update(t.schema.settings).set({ equityCapital: 1_000_000, selectedAccountId: 0 }).run();

  t.db
    .insert(t.schema.trades)
    .values([
      tradeRow({
        id: 101,
        accountId: PRIMARY,
        symbol: "TCS",
        tradingsymbol: "TCS",
        isOpen: true,
        buyQty: 10,
        avgBuyPrice: 3000,
        buyDate: "2026-08-01",
        slPlanned: 2800,
        targetPlanned: 3400,
        riskAmount: 2000,
      }),
      tradeRow({
        id: 102,
        accountId: PRIMARY,
        symbol: "INFY",
        tradingsymbol: "INFY",
        isOpen: true,
        buyQty: 20,
        avgBuyPrice: 1500,
        buyDate: "2026-08-04",
      }),
      tradeRow({
        id: 103,
        accountId: SWING,
        symbol: "RELIANCE",
        tradingsymbol: "RELIANCE",
        isOpen: true,
        buyQty: 5,
        avgBuyPrice: 2500,
        buyDate: "2026-08-06",
      }),
      // Closed, and it carries a sell date — the row that proves the predicate.
      tradeRow({
        id: 104,
        accountId: PRIMARY,
        symbol: "WIPRO",
        tradingsymbol: "WIPRO",
        isOpen: false,
        buyQty: 30,
        avgBuyPrice: 400,
        sellQty: 30,
        avgSellPrice: 430,
        buyDate: "2026-07-01",
        sellDate: "2026-07-20",
      }),
    ])
    .run();

  t.db
    .insert(t.schema.priceHistory)
    .values([
      { symbol: "TCS", date: "2026-09-01", open: 2980, high: 3010, low: 2970, close: 3005, volume: 1000 },
      { symbol: "TCS", date: "2026-09-02", open: 3005, high: 3080, low: 3000, close: 3060, volume: 1200 },
      { symbol: "TCS", date: "2026-09-03", open: 3060, high: 3120, low: 3050, close: 3100, volume: 900 },
    ])
    .run();
});

afterAll(() => t?.cleanup());

describe("/live loader — which rows the desk is allowed to show", () => {
  it("aggregates every account when the selection is 0, and excludes closed trades", async () => {
    selectAccount(0);
    const data = await live.loadLiveDesk({ pro: true });
    expect(data.rows).toHaveLength(3);
    expect(data.rows.map((r) => r.symbol).sort()).toEqual(["INFY", "RELIANCE", "TCS"]);
    expect(data.rows.some((r) => r.symbol === "WIPRO"), "a closed trade reached the desk").toBe(false);
    expect(data.selectedAccountId).toBe(0);
  });

  it("carries the account id on EVERY row (invariant 8, owner ruling Q19)", async () => {
    selectAccount(0);
    const data = await live.loadLiveDesk({ pro: true });
    for (const r of data.rows) expect(r.accountId, `${r.symbol} has no account`).toBeGreaterThan(0);
    expect(new Set(data.rows.map((r) => r.accountId))).toEqual(new Set([PRIMARY, SWING]));
    expect(data.rows.find((r) => r.symbol === "RELIANCE")!.accountId).toBe(SWING);
    expect(data.rows.find((r) => r.symbol === "RELIANCE")!.accountName).toBe("Swing");
  });

  it("scopes down to one account when one is selected — the other direction", async () => {
    selectAccount(SWING);
    const data = await live.loadLiveDesk({ pro: true });
    expect(data.rows.map((r) => r.symbol)).toEqual(["RELIANCE"]);
    expect(data.selectedAccountId).toBe(SWING);
    selectAccount(0);
  });
});

describe("/live loader — units and null discipline", () => {
  it("hands the client integer paise, never runtime rupees (invariant 1)", async () => {
    selectAccount(0);
    const data = await live.loadLiveDesk({ pro: true });
    const tcs = data.rows.find((r) => r.symbol === "TCS")!;
    expect(tcs.avgEntryP).toBe(300_000);
    expect(Number.isInteger(tcs.avgEntryP)).toBe(true);
    expect(tcs.investedP).toBe(3_000_000);
    expect(tcs.effectiveStopP).toBe(280_000);
    expect(tcs.targetP).toBe(340_000);
    // `riskAmount` is a ₹ AMOUNT column (rupees at runtime, paise at rest), so
    // ₹2,000 of frozen risk against ₹1,000 unrealised is exactly +0.50R.
    expect(tcs.unrealisedP).toBe(100_000);
    expect(tcs.openRPpm).toBe(500_000);
    // The mark comes from the stored bhavcopy close, in paise.
    expect(tcs.markP).toBe(310_000);
    expect(tcs.staleness).toBe("eod");
  });

  it("a position with no stored history gets nulls and a session count, never zeros", async () => {
    selectAccount(0);
    const data = await live.loadLiveDesk({ pro: true });
    const infy = data.rows.find((r) => r.symbol === "INFY")!;
    expect(infy.markP).toBe(null);
    expect(infy.dayChangePpm).toBe(null);
    expect(infy.unrealisedP).toBe(null);
    expect(infy.atrP3).toBe(null);
    expect(infy.rvol.ppm).toBe(null);
    expect(infy.atrSessions).toBe(0);
    expect(infy.spark).toEqual([]);
  });

  it("open R is null when no risk was recorded at entry (invariant 4)", async () => {
    selectAccount(0);
    const data = await live.loadLiveDesk({ pro: true });
    expect(data.rows.find((r) => r.symbol === "INFY")!.openRPpm).toBe(null);
  });
});

describe("/live loader — the risk-not-set banner (owner ruling Q33)", () => {
  it("is raised while risk_pct_ppm is unset, and the stop tree says so too", async () => {
    setRiskPpm(null);
    const data = await live.loadLiveDesk({ pro: true });
    expect(data.riskNotSet).toBe(true);
    expect(data.rows.every((r) => r.stop.kind === "risk-not-set")).toBe(true);
  });

  it("drops the moment the user records a risk percentage", async () => {
    setRiskPpm(2500); // owner ruling Q38b: 0.25% of capital
    const data = await live.loadLiveDesk({ pro: true });
    expect(data.riskNotSet).toBe(false);
    expect(data.rows.find((r) => r.symbol === "TCS")!.stop.kind).not.toBe("risk-not-set");
    setRiskPpm(null);
  });
});

describe("/live loader — the chart payload states its cap", () => {
  it("ships paise OHLC bars per symbol, ascending, with a stated cap", async () => {
    selectAccount(0);
    const data = await live.loadLiveDesk({ pro: true });
    const bars = data.barsBySymbol["TCS"];
    expect(bars).toHaveLength(3);
    // The chart panel's `Bar` shape verbatim (`lib/live/types.ts`), not a
    // desk-local rename: the panel is loaded through `next/dynamic`, so a
    // field mismatch here would show up as an empty chart, not a type error.
    expect(bars[0]).toEqual({
      date: "2026-09-01",
      openP: 298_000,
      highP: 301_000,
      lowP: 297_000,
      closeP: 300_500,
      volume: 1000,
    });
    expect(bars.map((b) => b.date)).toEqual([...bars.map((b) => b.date)].sort());
    expect(data.barsCap.sessions).toBe(live.DESK_CHART_BARS);
    expect(data.barsCap.symbols).toBe(live.DESK_CHART_SYMBOLS);
    expect(data.barsCap.trimmed).toBe(false);
  });

  it("names the provider it printed the marks from", async () => {
    const data = await live.loadLiveDesk({ pro: true });
    expect(data.feed.providerId).toBe("eod");
    expect(data.feed.streaming).toBe(false);
    expect(data.feed.staleness).toBe("eod");
  });
});

/**
 * Navigation and workspace, pinned HERE rather than in `nav-order.test.ts`:
 * that file guards the fold primitives and is shared with other waves. These
 * three assertions belong to the routes this wave introduced.
 */
describe("the v4.0 routes are reachable", () => {
  it("/live leads the Positions group and /atlas joins it; /sizing-lab is in Risk", () => {
    const byHref = new Map(NAV_ITEMS.map((i) => [i.href, i]));
    expect(byHref.get("/live")?.label).toBe("Live Desk");
    expect(byHref.get("/live")?.group).toBe("Positions");
    expect(byHref.get("/atlas")?.group).toBe("Positions");
    expect(byHref.get("/sizing-lab")?.group).toBe("Risk");
    expect(NAV_DEFAULT_VISIBLE.Positions, "/live must lead the fold, or it hides behind “N more…”").toContain("/live");
  });

  it("all three are SHARED screens — visible in equity, F&O and both", () => {
    for (const href of ["/live", "/sizing-lab", "/atlas"]) {
      expect(SCREEN_DOMAIN[href], `${href} was given a workspace domain — it would hide from the other book`).toBeUndefined();
      for (const ws of WORKSPACES) expect(screenVisible(href, ws), `${href} hidden in ${ws}`).toBe(true);
    }
  });
});

/**
 * G2 — the Pro half of a PARTIAL gate must not reach the browser at all.
 *
 * `/live` is `partial: true` in `PRO_FEATURES` (invariant 7 — the journal is
 * never gated), so the page is not wrapped in <ProGate> and the client hides
 * the Pro cells behind <ProLock>. Hiding is not gating: every locked number was
 * still computed on the server and shipped inside the RSC payload, where View
 * Source reads it. `lib/domain/lens-edge.ts` settled the shape of the answer —
 * `edge: null` means NOT ENTITLED, and the read site is forced to branch.
 *
 * The entitlement is a REQUIRED argument, not an option with a default: a
 * default of `pro: true` is a leak the next call site inherits by forgetting.
 */
describe("/live loader — the Pro fields are absent for a free user (G2)", () => {
  it("nulls R, risk at stop and % of capital on every row", async () => {
    selectAccount(0);
    // A risk percentage, so the stop tree actually COMPUTES rather than
    // returning `{kind:"risk-not-set"}` — a gate asserted against an empty
    // object would pass whether or not the reduction below exists.
    setRiskPpm(2500);
    const proRows = (await live.loadLiveDesk({ pro: true })).rows.filter((r) => r.stop.kind === "ok");
    expect(proRows.length, "no row computed a stop; the assertions below would prove nothing").toBeGreaterThan(0);
    expect(proRows[0].stop).toHaveProperty("riskAtStopP");

    const data = await live.loadLiveDesk({ pro: false });
    expect(data.rows.length).toBeGreaterThan(0);
    // The row that DID compute a stop, named: a loop that meets a `no-stop`
    // row first would otherwise report the weakest of the failures.
    const sized = data.rows.find((r) => r.symbol === proRows[0].symbol)!;
    expect(
      (sized.stop as unknown as Record<string, unknown>).riskAtStopP,
      `${sized.symbol} shipped risk at stop inside the stop object`,
    ).toBeUndefined();
    for (const r of data.rows) {
      expect(r.riskAtStopP, `${r.symbol} shipped risk at stop`).toBeNull();
      expect(r.openRPpm, `${r.symbol} shipped open R`).toBeNull();
      expect(r.pctOfCapital.ppm, `${r.symbol} shipped % of capital`).toBeNull();
      expect(r.pctOfCapital.denominator, `${r.symbol} shipped the capital base`).toBeNull();
      expect(r.riskAmountP, `${r.symbol} shipped the frozen risk R is derived from`).toBeNull();
      // S-1. `stop` is an OBJECT, and nulling four scalars beside it left the
      // very same figures inside it: `StopOk` carries `riskAtStopP`,
      // `riskBudgetP`, `qty` and `deployedP`. The free wire shape keeps the
      // provenance and no number at all.
      const stop = r.stop as unknown as Record<string, unknown>;
      expect(r.stop.kind, `${r.symbol} shipped a computed stop object`).toBe("gated");
      expect(stop.riskAtStopP, `${r.symbol} shipped risk at stop inside \`stop\``).toBeUndefined();
      expect(stop.riskBudgetP, `${r.symbol} shipped the risk budget inside \`stop\``).toBeUndefined();
      expect(stop.qty, `${r.symbol} shipped the sized quantity inside \`stop\``).toBeUndefined();
      expect(stop.deployedP, `${r.symbol} shipped the deployed capital inside \`stop\``).toBeUndefined();
    }
    expect(data.heat, "the heat strip's numbers rode along in the payload").toBeNull();
    expect(data.concentration, "the sector table's numbers rode along in the payload").toBeNull();
    setRiskPpm(null);
  });

  it("leaves every FREE field intact — the journal is never gated (invariant 7)", async () => {
    selectAccount(0);
    const free = await live.loadLiveDesk({ pro: false });
    const tcs = free.rows.find((r) => r.symbol === "TCS")!;
    expect(tcs.qty).toBe(10);
    expect(tcs.avgEntryP).toBe(300_000);
    expect(tcs.investedP).toBe(3_000_000);
    expect(tcs.markP).toBe(310_000);
    expect(tcs.staleness).toBe("eod");
    expect(tcs.unrealisedP).toBe(100_000);
    expect(tcs.unrealisedPctPpm).not.toBeNull();
    expect(tcs.effectiveStopP).toBe(280_000);
    expect(tcs.spark.length).toBe(3);
    expect(free.rows).toHaveLength(3);
  });

  it("…and the same call with pro:true still carries them, so the gate is the flag", async () => {
    selectAccount(0);
    const pro = await live.loadLiveDesk({ pro: true });
    const tcs = pro.rows.find((r) => r.symbol === "TCS")!;
    expect(pro.rows.some((r) => r.stop.kind === "gated"), "a Pro payload must never carry the reduced stop").toBe(false);
    expect(tcs.riskAtStopP).toBe(200_000);
    expect(tcs.openRPpm).toBe(500_000);
    expect(tcs.riskAmountP).toBe(200_000);
    expect(pro.heat).not.toBeNull();
    expect(pro.concentration).not.toBeNull();
  });
});

/**
 * S-X — the stored feed selection.
 *
 * `settings.live_feed_provider` is what the Settings card writes and what
 * `app/api/live/feed/route.ts` resolves through `getLiveFeedProvider()`. The
 * desk called `getQuoteProvider()` with NO argument, which ignores the stored
 * value and always builds the end-of-day provider — so a user who had chosen
 * "My typed marks — Nothing is fetched, ever" had the desk read the bhavcopy
 * behind their choice, while the card still showed the choice as saved.
 */
describe("/live loader — the stored feed provider is the one that runs (S-X)", () => {
  it("honours a saved `manual` selection instead of the end-of-day default", async () => {
    selectAccount(0);
    t.db.update(t.schema.settings).set({ liveFeedProvider: "manual" }).run();
    const data = await live.loadLiveDesk({ pro: true });
    expect(data.feed.providerId, "the desk ignored the saved provider").toBe("manual");
    expect(data.feed.staleness).toBe("manual");
    expect(data.feed.streaming).toBe(false);
    t.db.update(t.schema.settings).set({ liveFeedProvider: "eod" }).run();
  });

  it("…and still builds the end-of-day provider when that is what is stored", async () => {
    selectAccount(0);
    t.db.update(t.schema.settings).set({ liveFeedProvider: "eod" }).run();
    const data = await live.loadLiveDesk({ pro: true });
    expect(data.feed.providerId).toBe("eod");
    expect(data.feed.staleness).toBe("eod");
  });
});

/**
 * v4.1 — `instruments.results_date` reaches the row (owner ruling Q-9,
 * migration 0068).
 *
 * The seam this pins is the one a wire field always breaks at: the column is
 * written on /instruments and read on /live, and the two halves are joined by
 * nothing but the upper-cased SYMBOL. A row that quietly ships `null` looks
 * exactly like an instrument the user never dated, so nothing on screen looks
 * broken — the same failure mode invariant 8's account test exists for.
 *
 * It is also FREE on purpose: a results date is a fact about the COMPANY, like
 * the symbol, and the Pro boundary in `load-desk.ts` must not touch it.
 */
describe("/live loader — the results date rides on the row", () => {
  it("threads the date the user recorded onto the matching symbol only", async () => {
    selectAccount(0);
    t.db.insert(t.schema.instruments).values([
      { symbol: "TCS", resultsDate: "2026-10-14" },
      { symbol: "INFY" },
    ]).run();

    const data = await live.loadLiveDesk({ pro: true });
    expect(data.rows.find((r) => r.symbol === "TCS")!.resultsDate).toBe("2026-10-14");
    // An instrument row with no date, and a symbol with no instrument row at
    // all, are both "not recorded" — null, never an invented date.
    expect(data.rows.find((r) => r.symbol === "INFY")!.resultsDate).toBeNull();
    expect(data.rows.find((r) => r.symbol === "RELIANCE")!.resultsDate).toBeNull();
  });

  it("is FREE — the Pro boundary strips R and risk at stop, never the date", async () => {
    selectAccount(0);
    const data = await live.loadLiveDesk({ pro: false });
    const tcs = data.rows.find((r) => r.symbol === "TCS")!;
    expect(tcs.resultsDate, "a fact about the company was put behind the paywall").toBe("2026-10-14");
    // The Pro fields on the same row are still stripped, so this is a
    // statement about the boundary and not about a missing boundary.
    expect(tcs.riskAtStopP).toBeNull();
    expect(tcs.openRPpm).toBeNull();
    expect(data.heat).toBeNull();
  });

  it("`today` travels with the payload, so the chip is computed from IST", async () => {
    // `daysToResults(row.resultsDate, data.today)` is the whole render path.
    // `today` is `todayIstIso()` in the loader; a client-side `new Date()`
    // would answer with the user's machine calendar instead.
    const data = await live.loadLiveDesk({ pro: true });
    expect(data.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

/**
 * FW-1 — what the desk has to know to consume the live stream, and the
 * automatic day mark it takes on the way past.
 */
describe("/live loader — the wire the SSE consumer needs", () => {
  it("carries the EXCHANGE each position is quoted on, on every row", async () => {
    selectAccount(0);
    const data = await live.loadLiveDesk({ pro: true });
    // The stream is keyed on `quoteKeyId()` = `exchange:tradingsymbol`. Without
    // the exchange on the row the client has to guess one to match a tick, and
    // a BSE-only holding is then priced from the wrong book.
    expect(data.rows.length).toBeGreaterThan(0);
    for (const r of data.rows) expect(r.exchange, `${r.symbol} has no exchange`).toBe("NSE");
  });

  it("publishes WHICH failure the feed reported, not only its sentence", async () => {
    selectAccount(0);
    const data = await live.loadLiveDesk({ pro: true });
    // The end-of-day provider is healthy against this database, so the state is
    // `ok` — the point is that the field exists and is a value the once-a-day
    // connect prompt (Q24) can branch on, never a string it has to parse.
    expect(data.feed.healthState).toBe("ok");
    expect(data.feed.ok).toBe(true);
  });
});

describe("/live loader — the automatic day mark (owner answer Q25)", () => {
  /** Friday 2026-09-04, 16:00 IST — after the close, on a session day. */
  const AFTER_CLOSE = new Date("2026-09-04T10:30:00Z");

  const marks = () => t.db.select().from(t.schema.mtmPrices).all();
  const stamp = () => t.db.select().from(t.schema.settings).limit(1).all()[0]?.lastLiveMarkDate ?? null;
  function clearMarks() {
    t.db.update(t.schema.settings).set({ lastLiveMarkDate: null }).run();
    t.sqlite.prepare("DELETE FROM mtm_prices").run();
  }

  /** A streaming provider that is not the mock — the mock is a fixture, never a mark. */
  function liveProvider(): QuoteProvider {
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
              key: { symbol: "TCS", exchange: "NSE" as const, tradingsymbol: "TCS" },
              ltp: 312_000,
              prevClose: 310_000,
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
      health: async () => ({ ok: true, state: "ok" }),
    };
  }

  /**
   * Only `Date` is faked. `loadLiveDesk` awaits real dynamic imports on the way
   * to the database, and a fully faked timer set stalls the module loader.
   */
  function atClose(when: Date) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(when);
  }

  it("writes the day's mark on the server render, once, when the feed is a live one", async () => {
    selectAccount(0);
    clearMarks();
    stub.provider = liveProvider();
    atClose(AFTER_CLOSE);
    try {
      await live.loadLiveDesk({ pro: true });
      // ₹3,120.00 — RUPEES in `mtm_prices` (invariant 1's documented exception),
      // converted from the quote's paise exactly once at the write edge.
      expect(marks().map((m) => [m.symbol, m.price])).toEqual([["TCS", 3120]]);
      expect(stamp()).toBe("2026-09-04");

      // A second render the same day changes nothing at all.
      await live.loadLiveDesk({ pro: true });
      expect(marks()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      stub.provider = null;
      clearMarks();
    }
  });

  it("writes nothing from the end-of-day provider, however late in the day it is", async () => {
    selectAccount(0);
    clearMarks();
    atClose(AFTER_CLOSE);
    try {
      await live.loadLiveDesk({ pro: true });
      // The bhavcopy IS yesterday's close; marking from it would copy a row
      // onto itself under today's date.
      expect(marks()).toHaveLength(0);
      expect(stamp()).toBe(null);
    } finally {
      vi.useRealTimers();
      clearMarks();
    }
  });
});
