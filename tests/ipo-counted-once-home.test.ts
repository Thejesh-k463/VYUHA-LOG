import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * The counted-once rule has ONE home and ONE link read (v4.3.0 wave 2L).
 *
 * CAP-IPO-LINK / TAX-IPO-LINK (wave 2H) is a single rule: an IPO is left out
 * only where THAT consumer already counted its linked trade. Wave 2I then gave
 * `getIpoRealisedNet` an account-scoped LEFT JOIN (trades.account_id =
 * ipos.account_id) while `ipoIdsCountedThroughTrades` kept reading the link
 * raw — so the two halves disagreed about what a link IS, and a link crossing
 * the account boundary (reachable through a Trash restore of a holding deleted
 * before the startup re-home ran, or through an account merge that re-points a
 * legacy IPO) was counted TWICE in the capital summary — and through
 * `totalRealised` in `available` and compounding — while the tax pack, the ITR
 * export and both AIS sides counted it once.
 *
 * The rule as it now stands, in one sentence: `countedTradeIds` is the set of
 * trade ids the consumer counted IN THE CURRENT VIEW, and the link read is
 * UNSCOPED by account — the IPO's own account has no bearing on whether its
 * trade was counted. So for an IPO in account 1 linked to a holding in
 * account 2:
 *   - account 1: the holding was not counted (it is not in view) → the IPO
 *     counts its own realised net, once;
 *   - account 2: the holding counts, and the IPO is not in view;
 *   - All accounts: the holding counts, so the IPO is excluded.
 * Every view states the ONE economic sale exactly once, everywhere.
 *
 * One temp database for the file; one account pair for the whole scenario.
 */

let t: TempDb;
let capital: typeof import("@/lib/queries/capital");
let taxItr: typeof import("@/lib/queries/tax-itr");
let ipoQueries: typeof import("@/lib/queries/ipos");
let ais: typeof import("@/app/api/ais/route");

const IPO_ACCT = 1; //   the seeded default account — where the IPO record sits
const TRADE_ACCT = 2; // the book the holding it became actually lives in

const TRADE_NET = 490.25; // the holding's own net, as the trades book states it
const FY = "2025-26"; // allotment 2026-02-20 and exit 2026-03-02 both fall in it
const SYMBOL = "XACCT";
const IPO_NAME = "XACCT-IPO";

let tradeId = 0;
let ipoNet = 0; // the IPO's own realised net, as /ipos prices it

const selectAccount = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();

/** capital as /settings reads it, for one scope. */
function capitalOf(accountId: number) {
  selectAccount(accountId);
  const s = capital.getCapitalSummary();
  return [s.equityRealised, s.ipoRealised, s.totalRealised];
}

/** The tax base as /reports/tax and /api/tax-itr read it, for one scope. */
function taxOf(accountId: number) {
  selectAccount(accountId);
  const base = taxItr.getTaxBase();
  return {
    ipoNames: base.exitedIpos.map((r) => r.name),
    cgNets: base.cgTrades.map((r) => r.netPnl),
    itrScrips: taxItr.getItrExportRows().map((r) => r.scrip),
    itrCount: taxItr.countItrRows(),
  };
}

/** POST /api/ais with nothing to parse: every journal FY total surfaces as missing_in_ais. */
async function aisOf(accountId: number): Promise<Record<string, number | null>> {
  selectAccount(accountId);
  const res = await ais.POST(
    new Request("http://local/api/ais", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "nothing to parse" }) }),
  );
  expect(res.status).toBe(200);
  const { recon } = (await res.json()) as { recon: { fyTotals: { fy: string; kind: string; journal: number | null }[] } };
  return Object.fromEntries(recon.fyTotals.map((f) => [`${f.fy} ${f.kind}`, f.journal]));
}

beforeAll(async () => {
  t = await openTempDb("ipo-counted-once-home", { seed: true });
  capital = await import("@/lib/queries/capital");
  taxItr = await import("@/lib/queries/tax-itr");
  ipoQueries = await import("@/lib/queries/ipos");
  ais = await import("@/app/api/ais/route");
  t.db.insert(t.schema.accounts).values({ id: TRADE_ACCT, name: "counted-once 2", isDefault: false }).run();
  // The holding lives in account 2 …
  tradeId = t.db
    .insert(t.schema.trades)
    .values(
      tradeRow({
        accountId: TRADE_ACCT,
        broker: "zerodha",
        segment: "eq_delivery",
        symbol: SYMBOL,
        tradingsymbol: SYMBOL,
        buyQty: 10,
        avgBuyPrice: 100,
        buyValue: 1000,
        buyDate: "2026-02-20",
        sellQty: 10,
        avgSellPrice: 150,
        sellValue: 1500,
        sellDate: "2026-03-02",
        grossPnl: 500,
        chargesTotal: 500 - TRADE_NET,
        netPnl: TRADE_NET,
        isOpen: false,
      }),
    )
    .returning({ id: t.schema.trades.id })
    .get()!.id;
  // … while the IPO record that became it sits in account 1 (the pre-4.3 push
  // filed every record in account 1 whatever book the holding was in; a Trash
  // restore and an account merge both re-create exactly this shape).
  t.db
    .insert(t.schema.ipos)
    .values({
      accountId: IPO_ACCT,
      name: IPO_NAME,
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
  selectAccount(IPO_ACCT);
  ipoNet = ipoQueries.getIposComputed().summary.realisedNet;
}, 30_000);

afterAll(() => t?.cleanup());

describe("a cross-account link counts the sale ONCE in every view", () => {
  it("the fixture is live: the IPO is realised at a net that is not the holding's (a match would make every assertion below vacuous)", () => {
    expect(ipoNet).toBeGreaterThan(400);
    expect(ipoNet).not.toBe(TRADE_NET);
    expect(t.db.select().from(t.schema.ipos).all().map((r) => [r.accountId, r.tradeId])).toEqual([[IPO_ACCT, tradeId]]);
  });

  it("capital: the IPO's account counts the IPO alone, the trade's account the trade alone, All accounts the trade ONLY", () => {
    expect(capitalOf(IPO_ACCT), "IPO account").toEqual([0, ipoNet, ipoNet]);
    expect(capitalOf(TRADE_ACCT), "trade account").toEqual([TRADE_NET, 0, TRADE_NET]);
    // The regression this pins: the scoped join made the cross-account link "not a
    // link" here, so the All-accounts summary stated one sale twice
    // (490.25 + 482.60 = 972.85) in totalRealised, `available` and compounding.
    expect(capitalOf(0), "All accounts").toEqual([TRADE_NET, 0, TRADE_NET]);
  });

  it("the tax pack and the ITR export: one row per view, the IPO's own only where its holding was not counted", () => {
    expect(taxOf(IPO_ACCT), "IPO account").toEqual({ ipoNames: [IPO_NAME], cgNets: [ipoNet], itrScrips: [`${IPO_NAME} (IPO)`], itrCount: 1 });
    expect(taxOf(TRADE_ACCT), "trade account").toEqual({ ipoNames: [], cgNets: [TRADE_NET], itrScrips: [SYMBOL], itrCount: 1 });
    expect(taxOf(0), "All accounts").toEqual({ ipoNames: [], cgNets: [TRADE_NET], itrScrips: [SYMBOL], itrCount: 1 });
  });

  it("both AIS sides: purchase 1,000 and sale 1,500 in every view, never doubled", async () => {
    for (const id of [IPO_ACCT, TRADE_ACCT, 0]) {
      expect(await aisOf(id), `account ${id}`).toEqual({ [`${FY} purchase`]: 1000, [`${FY} sale`]: 1500 });
    }
  });

  it("/ipos itself is unchanged: with no countedTradeIds the IPO book still states its own realised net", () => {
    selectAccount(IPO_ACCT);
    expect(ipoQueries.getIpoRealisedNet()).toBe(ipoNet);
    selectAccount(0);
    expect(ipoQueries.getIpoRealisedNet()).toBe(ipoNet);
  });
});

describe("the rule has ONE home", () => {
  /** Every .ts/.tsx under lib/ and app/. */
  function sources(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) sources(p, out);
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  }

  it("exactly one definition of ipoIdsCountedThroughTrades exists in lib/ and app/, and it lives beside getIpoRealisedNet", () => {
    const defs = [...sources("lib"), ...sources("app")].filter((p) =>
      /function\s+ipoIdsCountedThroughTrades\b/.test(fs.readFileSync(p, "utf8")),
    );
    expect(defs.map((p) => p.split(path.sep).join("/"))).toEqual(["lib/queries/ipos.ts"]);
  });
});
