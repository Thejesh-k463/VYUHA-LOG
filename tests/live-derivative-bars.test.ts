import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as React from "react";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { todayIstIso } from "@/lib/domain/trading-day";
import { isoMinusDays } from "@/lib/live/positions-view";
import type { ProviderCapabilities, QuoteKey, QuoteMap, QuoteProvider } from "@/lib/quotes/types";
import type { DeskRow } from "@/components/live/desk-types";

/**
 * v4.7.0 release-audit fix wave FA — two loader findings, against a real (temp)
 * database.
 *
 *  M-B1 (design review R1). `load-desk.ts` read `barsBySymbol.get(p.symbol)` for
 *       EVERY row, and a derivative's `symbol` is its UNDERLYING. So a STOCK
 *       option or future over a scrip with stored history inherited six of the
 *       underlying's facts as its own: prevCloseP (→ P7 "since the close", both
 *       give-back sums), dayChangePpm (and `applyTicks`' fallback to it), atrP3
 *       (→ distanceToStopAtrX100 → nearStop, and the ATR branch of the stop
 *       tree), rvol, highDistance and the spark. An index option escaped only
 *       because nobody stores NIFTY bars. The fix is one rule at the read: a
 *       contract has NO bars of its own, so it gets none.
 *
 *  UJ-3 (design review R12). The desk publishes the Settings choice's
 *       `blockedReason` when the stored feed is not the one running, so /live
 *       can say why instead of silently pricing from another feed.
 *
 * ONE temp database for the file; every module reaching `lib/db` is imported
 * dynamically after `openTempDb` (AGENTS.md Testing).
 */

let t: TempDb;
let live: typeof import("@/components/live/load-desk");
let view: typeof import("@/lib/live/positions-view");
let ticks: typeof import("@/lib/live/apply-ticks");

const stub = vi.hoisted(() => ({ provider: null as QuoteProvider | null }));

vi.mock("@/lib/quotes/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/quotes/registry")>();
  return {
    ...actual,
    getLiveFeedProvider: async () => stub.provider ?? (await actual.getLiveFeedProvider()),
  };
});

/** Quotes nothing: every row falls to its own recorded close (`closingPrice`). */
function silentProvider(): QuoteProvider {
  const capabilities: ProviderCapabilities = {
    id: "eod",
    label: "silent double",
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
    snapshot: async (_keys: readonly QuoteKey[]): Promise<QuoteMap> => new Map(),
    subscribe: () => () => {},
    health: async () => ({ ok: true }),
  };
}

const TODAY = todayIstIso();
const CASH = 401;
const STOCK_OPTION = 402;
const STOCK_FUTURE = 403;
const INDEX_OPTION = 404;
const CONTRACTS = [STOCK_OPTION, STOCK_FUTURE] as const;

const rowOf = (rows: readonly DeskRow[], id: number): DeskRow => {
  const r = rows.find((x) => x.id === id);
  if (!r) throw new Error(`row ${id} missing from the desk`);
  return r;
};
const stopSource = (r: DeskRow): string | null => ("source" in r.stop ? (r.stop.source ?? null) : null);

// Measured locally 2026-10-05: migrate + seed + the dynamic imports ≈ 2 s; every
// `it` is under 100 ms. 120 s is for the Windows CI runner (> 15× slower on
// SQLite-file work, AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("live-derivative-bars", { seed: true });
  live = await import("@/components/live/load-desk");
  view = await import("@/lib/live/positions-view");
  ticks = await import("@/lib/live/apply-ticks");

  t.db.update(t.schema.settings).set({ equityCapital: 1_000_000, activeCapital: 500_000, selectedAccountId: 0 }).run();
  // ATR FIRST in the tree (an explicit stopMethod is walked before the rest), so a
  // row that can see an ATR gets an ATR stop — which is exactly what a contract
  // reading its underlying's bars used to get. No percent default: a row with
  // neither ATR nor a level has no stop at all.
  t.db
    .update(t.schema.riskConfig)
    .set({ riskPctPpm: 10_000, stopMethod: "atr", stopAtrMultPermille: 2000, stopDefaultPctPpm: null })
    .run();

  t.db
    .insert(t.schema.trades)
    .values([
      // CONTROL — the cash scrip the bars belong to. No level: its stop is ATR.
      tradeRow({
        id: CASH, accountId: 1, symbol: "RELIANCE", tradingsymbol: "RELIANCE", isOpen: true,
        buyQty: 10, avgBuyPrice: 2800, buyValue: 28_000, buyDate: isoMinusDays(TODAY, 40), closingPrice: 2950,
      }),
      // A STOCK OPTION over RELIANCE. Its `symbol` is the underlying — the trap.
      tradeRow({
        id: STOCK_OPTION, accountId: 1, symbol: "RELIANCE", tradingsymbol: "RELIANCE26DEC3000CE", isOpen: true,
        segment: "stock_option", instrumentType: "option", exchange: "NFO", bucket: "active",
        optionType: "CE", strike: 3000, expiry: "2026-12-29", lotSize: 500,
        buyQty: 500, avgBuyPrice: 100, buyValue: 50_000, buyDate: isoMinusDays(TODAY, 10),
        slPlanned: 80, closingPrice: 90,
      }),
      // A STOCK FUTURE over RELIANCE.
      tradeRow({
        id: STOCK_FUTURE, accountId: 1, symbol: "RELIANCE", tradingsymbol: "RELIANCE26DECFUT", isOpen: true,
        segment: "future", instrumentType: "future", exchange: "NFO", bucket: "active",
        expiry: "2026-12-29", lotSize: 250,
        buyQty: 250, avgBuyPrice: 2950, buyValue: 737_500, buyDate: isoMinusDays(TODAY, 10),
        slPlanned: 2850, closingPrice: 2920,
      }),
      // An INDEX option — its behaviour before the fix (no NIFTY bars stored) is
      // the behaviour every contract now has. It must not move.
      tradeRow({
        id: INDEX_OPTION, accountId: 1, symbol: "NIFTY", tradingsymbol: "NIFTY26DEC24000CE", isOpen: true,
        segment: "index_option", instrumentType: "option", exchange: "NFO", bucket: "active",
        optionType: "CE", strike: 24000, expiry: "2026-12-29", lotSize: 75,
        buyQty: 75, avgBuyPrice: 100, buyValue: 7_500, buyDate: isoMinusDays(TODAY, 10),
        slPlanned: 80, closingPrice: 95,
      }),
    ])
    .run();

  // 30 sessions of RELIANCE — enough for ATR 21, RVOL 20 and a previous close.
  const bars = [];
  for (let i = 29; i >= 0; i--) {
    const close = 2900 + (29 - i);
    bars.push({ symbol: "RELIANCE", date: isoMinusDays(TODAY, i), open: close - 5, high: close + 30, low: close - 30, close, volume: 1000 + (29 - i) * 10 });
  }
  t.db.insert(t.schema.priceHistory).values(bars).run();

  stub.provider = silentProvider();
}, 120_000);

afterAll(() => {
  stub.provider = null;
  t?.cleanup();
});

describe("M-B1 — a contract never reads its underlying's bars (R1)", () => {
  it("CONTROL: the cash scrip reads its own bars for all six readers, and its stop is ATR", async () => {
    const d = await live.loadLiveDesk({ pro: true });
    const cash = rowOf(d.rows, CASH);
    expect(cash.prevCloseP).toBe(292_800); // yesterday's close, ₹2,928
    expect(cash.dayChangePpm).not.toBeNull();
    expect(cash.atrP3).not.toBeNull();
    expect(cash.rvol.ppm).not.toBeNull();
    expect(cash.highDistance.ppm).not.toBeNull();
    expect(cash.spark.length).toBeGreaterThan(0);
    expect(stopSource(cash)).toBe("atr");
  });

  it.each(CONTRACTS)("row %i: prevCloseP, dayChangePpm, atrP3/distance, rvol, highDistance and spark are all null/empty", async (id) => {
    const d = await live.loadLiveDesk({ pro: true });
    const r = rowOf(d.rows, id);
    expect(r.markP, "the contract is marked from its own close").not.toBeNull();
    expect(r.effectiveStopP, "the contract carries its own recorded level").not.toBeNull();
    expect(r.prevCloseP, "the underlying's previous close printed as the contract's").toBeNull();
    expect(r.dayChangePpm, "the underlying's day change printed as the contract's").toBeNull();
    expect(r.atrP3, "the underlying's ATR read as the contract's").toBeNull();
    expect(r.atrSessions).toBe(0);
    expect(r.distanceToStopAtrX100, "stop distance measured in the underlying's ATR").toBeNull();
    expect(r.rvol).toEqual({ ppm: null, denominator: null });
    expect(r.highDistance.ppm, "the underlying's 52w high read as the contract's").toBeNull();
    expect(r.highDistance.sessions).toBe(0);
    expect(r.spark, "the underlying's closes drawn as the contract's spark").toEqual([]);
  });

  it.each(CONTRACTS)("row %i: no ATR stop — the tree falls through to the recorded level", async (id) => {
    const d = await live.loadLiveDesk({ pro: true });
    expect(stopSource(rowOf(d.rows, id)), "an ATR stop from the underlying's range").toBe("manual");
  });

  it("P7 sinceClose: only the cash row is compared; no contract is near its stop; give-back is the cash row's alone", async () => {
    const d = await live.loadLiveDesk({ pro: true });
    const sc = view.sinceClose(d.rows, d.heat);
    expect(sc.compared, "a contract was compared against its underlying's close").toBe(1);
    for (const id of [...CONTRACTS, INDEX_OPTION]) expect(sc.nearStop, `row ${id}`).not.toContain(id);
    const cashOnly = view.sinceClose([rowOf(d.rows, CASH)], d.heat);
    expect(sc.unrealisedAtCloseP).toBe(cashOnly.unrealisedAtCloseP);
    expect(sc.givesBackAtCloseP).toBe(cashOnly.givesBackAtCloseP);
    expect(sc.givesBackNowP).toBe(cashOnly.givesBackNowP);
  });

  it("applyTicks: a contract tick without a provider prevClose leaves day change null (the wire's fallback is null)", async () => {
    const d = await live.loadLiveDesk({ pro: true });
    const opt = rowOf(d.rows, STOCK_OPTION);
    const map = ticks.mergeTicks(new Map(), [
      { key: { symbol: "RELIANCE", exchange: "NFO", tradingsymbol: "RELIANCE26DEC3000CE" }, ltp: 9_500, prevClose: null, asOf: "x", staleness: "delayed" },
    ] as never);
    const [ticked] = ticks.applyTicks([opt], map);
    expect(ticked.markP).toBe(9_500);
    expect(ticked.dayChangePpm).toBeNull();
  });

  it("the detail pane's chart (a 7th reader of the same key) draws no underlying candles under a contract", async () => {
    const client = await import("@/components/live/tracker-client");
    const d = await live.loadLiveDesk({ pro: true });
    expect(d.barsBySymbol.RELIANCE?.length ?? 0, "the cash scrip still ships its chart").toBeGreaterThan(0);
    expect(client.chartBarsFor(rowOf(d.rows, CASH), d.barsBySymbol)).toBe(d.barsBySymbol.RELIANCE);
    for (const id of [...CONTRACTS, INDEX_OPTION]) {
      expect(client.chartBarsFor(rowOf(d.rows, id), d.barsBySymbol), `row ${id} charted its underlying`).toEqual([]);
    }
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("components/live/tracker-client.tsx", "utf8");
    expect(src).toMatch(/bars=\{chartBarsFor\(expanded, barsBySymbol\)\}/);
  });

  it("UNCHANGED: the NIFTY index option (no bars stored) behaves as before", async () => {
    const d = await live.loadLiveDesk({ pro: true });
    const r = rowOf(d.rows, INDEX_OPTION);
    expect(r.prevCloseP).toBeNull();
    expect(r.dayChangePpm).toBeNull();
    expect(r.atrP3).toBeNull();
    expect(r.rvol.ppm).toBeNull();
    expect(r.spark).toEqual([]);
    expect(stopSource(r)).toBe("manual");
    expect(r.expiry).toBe("2026-12-29");
  });
});

describe("UJ-3 — the desk publishes why the chosen feed is not running (R12)", () => {
  it("stored === effective: blockedReason is null", async () => {
    t.db.update(t.schema.settings).set({ liveFeedProvider: "eod" }).run();
    const d = await live.loadLiveDesk({ pro: true });
    expect(d.feed.blockedReason).toBeNull();
  });

  it("stored ≠ effective (OpenAlgo chosen, switched off): blockedReason is the registry's own sentence", async () => {
    const { resolveLiveFeed } = await import("@/lib/quotes/registry");
    t.db.update(t.schema.settings).set({ liveFeedProvider: "openalgo", openalgoEnabled: false }).run();
    try {
      const resolved = await resolveLiveFeed();
      expect(resolved.stored).not.toBe(resolved.effective);
      expect(typeof resolved.blockedReason).toBe("string");
      const d = await live.loadLiveDesk({ pro: true });
      expect(d.feed.blockedReason).toBe(resolved.blockedReason);
      // Free wire too: why a feed is not running is not a Pro fact (invariant 7).
      expect((await live.loadLiveDesk({ pro: false })).feed.blockedReason).toBe(resolved.blockedReason);
    } finally {
      t.db.update(t.schema.settings).set({ liveFeedProvider: "eod" }).run();
    }
  });

  it("/live renders the reason with a link to Settings → Live feed, and nothing when there is none", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const client = await import("@/components/live/tracker-client");
    const { FEED_BLOCKED_COPY } = await import("@/components/live/desk-copy");
    const reason = "The OpenAlgo bridge is switched off in Settings.";
    const html = renderToStaticMarkup(React.createElement(client.FeedBlockedNotice, { reason }));
    expect(html).toContain('data-testid="live-feed-blocked"');
    expect(html).toContain(reason);
    expect(html).toContain(`href="${FEED_BLOCKED_COPY.href}"`);
    expect(FEED_BLOCKED_COPY.href).toBe("/settings#settings-live-feed");
    expect(html).toContain(FEED_BLOCKED_COPY.cta);
    expect(renderToStaticMarkup(React.createElement(client.FeedBlockedNotice, { reason: null }))).toBe("");
  });

  it("the desk renders the notice from its own feed (the wiring, which this node suite cannot mount)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("components/live/tracker-client.tsx", "utf8").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(src).toMatch(/<FeedBlockedNotice reason=\{blockedReasonOf\(feed\)\} \/>/);
  });

  it("blockedReasonOf reads the loader's field, and nothing from a payload without it", async () => {
    const client = await import("@/components/live/tracker-client");
    const d = await live.loadLiveDesk({ pro: false });
    expect(client.blockedReasonOf(d.feed)).toBeNull();
    expect(client.blockedReasonOf({ ...d.feed, blockedReason: "Off." })).toBe("Off.");
    const { blockedReason: _drop, ...without } = { ...d.feed, blockedReason: "x" };
    expect(client.blockedReasonOf(without)).toBeNull();
    expect(client.blockedReasonOf({ ...d.feed, blockedReason: "" })).toBeNull();
  });

  it("the anchor the link lands on is the Settings section's real id", async () => {
    const { readFileSync } = await import("node:fs");
    const { FEED_BLOCKED_COPY } = await import("@/components/live/desk-copy");
    const anchor = FEED_BLOCKED_COPY.href.split("#")[1];
    expect(readFileSync("app/settings/page.tsx", "utf8")).toContain(`<Section id="${anchor}">`);
  });
});
