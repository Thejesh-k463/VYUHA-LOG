import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { NAV_DEFAULT_VISIBLE, NAV_ITEMS } from "@/components/layout/nav-config";
import { SCREEN_DOMAIN, WORKSPACES, screenVisible } from "@/lib/domain/workspace";

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
    const data = await live.loadLiveDesk();
    expect(data.rows).toHaveLength(3);
    expect(data.rows.map((r) => r.symbol).sort()).toEqual(["INFY", "RELIANCE", "TCS"]);
    expect(data.rows.some((r) => r.symbol === "WIPRO"), "a closed trade reached the desk").toBe(false);
    expect(data.selectedAccountId).toBe(0);
  });

  it("carries the account id on EVERY row (invariant 8, owner ruling Q19)", async () => {
    selectAccount(0);
    const data = await live.loadLiveDesk();
    for (const r of data.rows) expect(r.accountId, `${r.symbol} has no account`).toBeGreaterThan(0);
    expect(new Set(data.rows.map((r) => r.accountId))).toEqual(new Set([PRIMARY, SWING]));
    expect(data.rows.find((r) => r.symbol === "RELIANCE")!.accountId).toBe(SWING);
    expect(data.rows.find((r) => r.symbol === "RELIANCE")!.accountName).toBe("Swing");
  });

  it("scopes down to one account when one is selected — the other direction", async () => {
    selectAccount(SWING);
    const data = await live.loadLiveDesk();
    expect(data.rows.map((r) => r.symbol)).toEqual(["RELIANCE"]);
    expect(data.selectedAccountId).toBe(SWING);
    selectAccount(0);
  });
});

describe("/live loader — units and null discipline", () => {
  it("hands the client integer paise, never runtime rupees (invariant 1)", async () => {
    selectAccount(0);
    const data = await live.loadLiveDesk();
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
    const data = await live.loadLiveDesk();
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
    const data = await live.loadLiveDesk();
    expect(data.rows.find((r) => r.symbol === "INFY")!.openRPpm).toBe(null);
  });
});

describe("/live loader — the risk-not-set banner (owner ruling Q33)", () => {
  it("is raised while risk_pct_ppm is unset, and the stop tree says so too", async () => {
    setRiskPpm(null);
    const data = await live.loadLiveDesk();
    expect(data.riskNotSet).toBe(true);
    expect(data.rows.every((r) => r.stop.kind === "risk-not-set")).toBe(true);
  });

  it("drops the moment the user records a risk percentage", async () => {
    setRiskPpm(2500); // owner ruling Q38b: 0.25% of capital
    const data = await live.loadLiveDesk();
    expect(data.riskNotSet).toBe(false);
    expect(data.rows.find((r) => r.symbol === "TCS")!.stop.kind).not.toBe("risk-not-set");
    setRiskPpm(null);
  });
});

describe("/live loader — the chart payload states its cap", () => {
  it("ships paise OHLC bars per symbol, ascending, with a stated cap", async () => {
    selectAccount(0);
    const data = await live.loadLiveDesk();
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
    const data = await live.loadLiveDesk();
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
