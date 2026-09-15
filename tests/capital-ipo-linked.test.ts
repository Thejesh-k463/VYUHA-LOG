import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * CAP-IPO-LINK (v4.3.0 wave 2H) — the capital summary counts a linked, exited
 * IPO's sale ONCE.
 *
 * An IPO pushed to holdings links a `trades` row (ipos.trade_id), and an exit
 * saved on /ipos closes that holding. `getCapitalSummary` summed the closed
 * trade's net (equityRealised) AND `getIpoRealisedNet()` — which summed the same
 * IPO's realised net with no look at trade_id — so one sale reached
 * `totalRealised`, and through it the `available` figure compounding reads
 * (settings/accounts pnlRolledIn), twice.
 *
 * The rule as built: an IPO is realised THROUGH its trade only when the capital
 * summary also counted that trade (it exists in scope and is closed). Every
 * other exited IPO — unlinked, linked to a holding still open, or linked to a
 * row that is gone — adds its own net once. /ipos' KPI reads the IPO book alone
 * and keeps every exited IPO.
 *
 * One account per scenario, one temp database for the file.
 */

let t: TempDb;
let capital: typeof import("@/lib/queries/capital");
let ipoQueries: typeof import("@/lib/queries/ipos");

const LINKED = 2; //   an exited IPO whose linked holding is closed
const UNLINKED = 3; // an exited IPO with no holding
const OPEN = 4; //     an exited IPO whose linked holding is still open
const DANGLING = 5; // an exited IPO whose trade_id names no row

const TRADE_NET = 490.25;
const r2 = (n: number) => Math.round(n * 100) / 100;

const selectAccount = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();

function ipo(accountId: number, name: string, tradeId: number | null) {
  t.db
    .insert(t.schema.ipos)
    .values({
      accountId,
      name,
      broker: "zerodha",
      exchange: "NSE",
      appliedPrice: 100,
      lotSize: 10,
      lotsApplied: 1,
      allotted: true,
      allottedQty: 10,
      listingPrice: 130,
      exitPrice: 150,
      allotmentDate: "2026-02-20",
      listingDate: "2026-02-24",
      exitDate: "2026-03-02",
      tradeId,
    })
    .run();
}

function holding(accountId: number, symbol: string, closed: boolean): number {
  const sold = closed
    ? { sellQty: 10, avgSellPrice: 150, sellValue: 1500, sellDate: "2026-03-02", grossPnl: 500, chargesTotal: 500 - TRADE_NET, netPnl: TRADE_NET, isOpen: false }
    : { isOpen: true };
  return t.db
    .insert(t.schema.trades)
    .values(tradeRow({ accountId, broker: "zerodha", symbol, tradingsymbol: symbol, buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-02-20", ...sold }))
    .returning({ id: t.schema.trades.id })
    .get()!.id;
}

/** The IPO's own realised net as /ipos prices it (the KPI's figure). */
const ipoNetOf = (accountId: number) => {
  selectAccount(accountId);
  return ipoQueries.getIposComputed().summary.realisedNet;
};

beforeAll(async () => {
  t = await openTempDb("capital-ipo-linked", { seed: true });
  capital = await import("@/lib/queries/capital");
  ipoQueries = await import("@/lib/queries/ipos");
  t.db
    .insert(t.schema.accounts)
    .values([LINKED, UNLINKED, OPEN, DANGLING].map((id) => ({ id, name: `cap-ipo ${id}`, isDefault: false })))
    .run();
  ipo(LINKED, "CAPIPO-L", holding(LINKED, "CAPIPOL", true));
  ipo(UNLINKED, "CAPIPO-U", null);
  ipo(OPEN, "CAPIPO-O", holding(OPEN, "CAPIPOO", false));
  ipo(DANGLING, "CAPIPO-D", 987654);
  // An unrelated closed trade in each, so the capital summary HAS counted trades there:
  // an IPO must be excluded by ITS trade being counted, not by any trade being counted.
  holding(OPEN, "OTHERO", true);
  holding(DANGLING, "OTHERD", true);
}, 30_000);

afterAll(() => t?.cleanup());

describe("getCapitalSummary counts an exited IPO's sale once", () => {
  it("the IPOs are priced and realised (a zero net would make every assertion below vacuous)", () => {
    for (const id of [LINKED, UNLINKED, OPEN, DANGLING]) {
      const net = ipoNetOf(id);
      expect(net, `account ${id}`).toBeGreaterThan(400);
      expect(net, `account ${id}`).not.toBe(TRADE_NET);
    }
  });

  it("linked and its holding closed: totalRealised is the trade's net, and the IPO adds nothing on top", () => {
    selectAccount(LINKED);
    const s = capital.getCapitalSummary();
    expect([s.equityRealised, s.ipoRealised, s.totalRealised, s.available]).toEqual([TRADE_NET, 0, TRADE_NET, TRADE_NET]);
  });

  it("unlinked: the exited IPO still adds its realised net, once", () => {
    const net = ipoNetOf(UNLINKED);
    selectAccount(UNLINKED);
    const s = capital.getCapitalSummary();
    expect([s.equityRealised, s.ipoRealised, s.totalRealised]).toEqual([0, net, net]);
  });

  it("linked to a holding still OPEN, or to a trade_id naming no row (beside an unrelated closed trade): its trade is not counted, so the IPO is", () => {
    for (const id of [OPEN, DANGLING]) {
      const net = ipoNetOf(id);
      selectAccount(id);
      const s = capital.getCapitalSummary();
      expect([s.equityRealised, s.ipoRealised, s.totalRealised], `account ${id}`).toEqual([TRADE_NET, net, r2(TRADE_NET + net)]);
    }
  });

  it("All accounts: the linked sale once, every other exited IPO once (invariant 8 scope unchanged)", () => {
    const others = [UNLINKED, OPEN, DANGLING].reduce((a, id) => a + ipoNetOf(id), 0);
    selectAccount(0);
    const s = capital.getCapitalSummary();
    expect(s.equityRealised).toBe(3 * TRADE_NET);
    expect(s.ipoRealised).toBeCloseTo(others, 2);
    expect(s.totalRealised).toBeCloseTo(3 * TRADE_NET + others, 2);
  });

  it("/ipos is unchanged: its KPI and getIpoRealisedNet() with no argument still read every exited IPO, linked or not", () => {
    for (const id of [LINKED, UNLINKED, OPEN, DANGLING]) {
      selectAccount(id);
      const { rows, summary } = ipoQueries.getIposComputed();
      const own = rows.filter((r) => r.realised).reduce((a, r) => a + r.netPnl, 0);
      expect(summary.realisedNet, `account ${id}`).toBeCloseTo(own, 2);
      expect(summary.realisedNet, `account ${id}`).toBeGreaterThan(400);
      expect(ipoQueries.getIpoRealisedNet(), `account ${id}`).toBe(own);
    }
  });
});
