import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * TAX-IPO-LINK (v4.3.0 wave 2H) — the tax pack, the ITR export and the AIS
 * reconciliation count a linked IPO's sale ONCE.
 *
 * The same double count CAP-IPO-LINK fixed in the capital summary
 * (tests/capital-ipo-linked.test.ts): an IPO pushed to holdings links a `trades`
 * row (ipos.trade_id), and an exit saved on /ipos closes that holding. Then
 *  - `getTaxBase` folded the closed trade into cgTrades AND the exited IPO into
 *    ipoTaxRows / cgTrades, so one gain reached taxByFy, the set-off engine and
 *    the ITR export twice;
 *  - POST /api/ais bumped the holding's buy/sell values AND the IPO's allotment
 *    and exit, so the journal's FY purchase and sale totals read double.
 *
 * The rule as built is CAP-IPO-LINK's: an IPO is excluded from the IPO side only
 * where the consumer ALREADY counted its linked trade. The tax base counts closed
 * trades, so an exited IPO whose holding is closed is skipped. AIS counts a
 * delivery trade's purchase always and its sale once closed, so the IPO's
 * allotment is skipped when the holding's purchase was counted and its exit when
 * the holding's sale was. Every other IPO — unlinked, linked to a holding still
 * open, or to a trade_id naming no row — counts exactly as before.
 *
 * One account per scenario, one temp database for the file.
 */

let t: TempDb;
let taxItr: typeof import("@/lib/queries/tax-itr");
let ipoQueries: typeof import("@/lib/queries/ipos");
let tax: typeof import("@/lib/analytics/tax");
let ais: typeof import("@/app/api/ais/route");

const LINKED = 2; //   an exited IPO whose linked holding is closed
const UNLINKED = 3; // an exited IPO with no holding
const OPEN = 4; //     an exited IPO whose linked holding is still open
const DANGLING = 5; // an exited IPO whose trade_id names no row
const HELD = 6; //     an allotted, UNSOLD IPO linked to its open holding

const TRADE_NET = 490.25;
const FY = "2025-26"; // allotment 2026-02-20 and exit 2026-03-02 both fall in it

const selectAccount = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();

function ipo(accountId: number, name: string, tradeId: number | null, exited = true) {
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
      exitPrice: exited ? 150 : null,
      allotmentDate: "2026-02-20",
      listingDate: "2026-02-24",
      exitDate: exited ? "2026-03-02" : null,
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
    .values(tradeRow({ accountId, broker: "zerodha", segment: "eq_delivery", symbol, tradingsymbol: symbol, buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-02-20", ...sold }))
    .returning({ id: t.schema.trades.id })
    .get()!.id;
}

/** The IPO's own realised net as /ipos prices it. */
const ipoNetOf = (accountId: number) => {
  selectAccount(accountId);
  return ipoQueries.getIposComputed().summary.realisedNet;
};

/** The tax base as /reports/tax and /api/tax-itr read it, for one scope. */
function taxOf(accountId: number) {
  selectAccount(accountId);
  const base = taxItr.getTaxBase();
  // v4.5.0 — `taxRows` (not `trades`) is what /reports/tax feeds taxByFy: the
  // same closed rows, carrying the RESOLVED assetClass and the three
  // non-deductible charge lines (app/reports/tax/page.tsx:112).
  const fy = tax.taxByFy([...base.taxRows, ...base.ipoTaxRows], 4, FY);
  return {
    ipoNames: base.exitedIpos.map((r) => r.name),
    ipoTaxNets: base.ipoTaxRows.map((r) => r.netPnl),
    cgNets: base.cgTrades.map((r) => r.netPnl),
    itrScrips: taxItr.getItrExportRows().map((r) => r.scrip),
    itrCount: taxItr.countItrRows(),
    fy: fy.map((f) => [f.fy, f.trades, f.totalRealised]),
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

/**
 * Every scenario book read TOGETHER (v4.5.0 wave TP, owner ruling T1).
 *
 * From v4.5.0 the tax base, the ITR export and the AIS reconciliation are
 * scoped to a tax PERSON, never to an account and never to "all accounts": a
 * book stating no `tax_identity` is its OWN person, so the All-accounts view
 * over these five books yields NO tax figure at all (invariant 6 — a total
 * spanning two persons is one nobody can file).
 *
 * The aggregate case below is therefore stated as ONE PERSON holding all five
 * books, which is the same set of rows and a scope that can actually be filed.
 * The identity is set for the read and cleared afterwards, so every
 * single-account case above keeps reading exactly one book.
 */
async function asOnePerson<T>(read: () => T | Promise<T>): Promise<T> {
  const ids = [LINKED, UNLINKED, OPEN, DANGLING, HELD];
  const set = (v: string | null) => {
    for (const id of ids) t.sqlite.prepare("UPDATE accounts SET tax_identity = ? WHERE id = ?").run(v, id);
  };
  set("Tax IPO Holder");
  try {
    return await read();
  } finally {
    set(null);
  }
}

beforeAll(async () => {
  t = await openTempDb("tax-ipo-linked", { seed: true });
  taxItr = await import("@/lib/queries/tax-itr");
  ipoQueries = await import("@/lib/queries/ipos");
  tax = await import("@/lib/analytics/tax");
  ais = await import("@/app/api/ais/route");
  t.db
    .insert(t.schema.accounts)
    .values([LINKED, UNLINKED, OPEN, DANGLING, HELD].map((id) => ({ id, name: `tax-ipo ${id}`, isDefault: false })))
    .run();
  ipo(LINKED, "TAXIPO-L", holding(LINKED, "TAXIPOL", true));
  ipo(UNLINKED, "TAXIPO-U", null);
  ipo(OPEN, "TAXIPO-O", holding(OPEN, "TAXIPOO", false));
  ipo(DANGLING, "TAXIPO-D", 987654);
  ipo(HELD, "TAXIPO-H", holding(HELD, "TAXIPOH", false), false);
}, 30_000);

afterAll(() => t?.cleanup());

describe("getTaxBase counts an exited IPO's gain once", () => {
  it("the IPOs are priced and realised, at a net that is not the holding's (a match would make every assertion below vacuous)", () => {
    for (const id of [LINKED, UNLINKED, OPEN, DANGLING]) {
      const net = ipoNetOf(id);
      expect(net, `account ${id}`).toBeGreaterThan(400);
      expect(net, `account ${id}`).not.toBe(TRADE_NET);
    }
  });

  it("linked and its holding closed: the gain is the holding's, once — no IPO tax row, one ITR row, taxByFy one trade", () => {
    expect(taxOf(LINKED)).toEqual({
      ipoNames: [],
      ipoTaxNets: [],
      cgNets: [TRADE_NET],
      itrScrips: ["TAXIPOL"],
      itrCount: 1,
      fy: [[FY, 1, TRADE_NET]],
    });
  });

  it("unlinked, linked to a holding still OPEN, or to a trade_id naming no row: the IPO's own gain is counted, once", () => {
    for (const [id, name] of [[UNLINKED, "TAXIPO-U"], [OPEN, "TAXIPO-O"], [DANGLING, "TAXIPO-D"]] as const) {
      const net = ipoNetOf(id);
      expect(taxOf(id), `account ${id}`).toEqual({
        ipoNames: [name],
        ipoTaxNets: [net],
        cgNets: [net],
        itrScrips: [`${name} (IPO)`],
        itrCount: 1,
        fy: [[FY, 1, net]],
      });
    }
  });

  it("one tax person holding all five books: the linked gain once from its holding, every other exited IPO once", async () => {
    const others = [UNLINKED, OPEN, DANGLING].map(ipoNetOf);
    const all = await asOnePerson(() => taxOf(LINKED));
    expect(all.ipoNames.sort()).toEqual(["TAXIPO-D", "TAXIPO-O", "TAXIPO-U"]);
    expect(all.itrCount).toBe(4);
    expect(all.itrScrips.filter((s) => s === "TAXIPOL" || s === "TAXIPO-L (IPO)")).toEqual(["TAXIPOL"]);
    expect(all.fy.map((f) => f.slice(0, 2))).toEqual([[FY, 4]]);
    expect(all.fy[0][2]).toBeCloseTo(TRADE_NET + others.reduce((a, b) => a + b, 0), 2);
  });
});

describe("POST /api/ais counts a linked holding's purchase and sale once", () => {
  it("linked and its holding closed: FY purchase 1,000 and sale 1,500 — the holding's, not doubled by the IPO's allotment and exit", async () => {
    expect(await aisOf(LINKED)).toEqual({ [`${FY} purchase`]: 1000, [`${FY} sale`]: 1500 });
  });

  it("linked to an OPEN holding: the holding counted the purchase, so the IPO adds only its exit; an unsold linked IPO adds nothing", async () => {
    expect(await aisOf(OPEN)).toEqual({ [`${FY} purchase`]: 1000, [`${FY} sale`]: 1500 });
    expect(await aisOf(HELD)).toEqual({ [`${FY} purchase`]: 1000 });
  });

  it("unlinked, or linked to a trade_id naming no row: the IPO's allotment and exit count as before", async () => {
    for (const id of [UNLINKED, DANGLING]) {
      expect(await aisOf(id), `account ${id}`).toEqual({ [`${FY} purchase`]: 1000, [`${FY} sale`]: 1500 });
    }
  });

  it("one tax person holding all five books: five purchases and four sales of 10 shares, each once", async () => {
    expect(await asOnePerson(() => aisOf(LINKED))).toEqual({ [`${FY} purchase`]: 5000, [`${FY} sale`]: 6000 });
  });

  it("the All-accounts view reconciles nothing rather than merging five tax persons", async () => {
    // Five books, five identities-in-absentia, five persons: AIS is issued per
    // PAN, so there is no statement to compare a journal against here.
    expect(await aisOf(0)).toEqual({});
  });
});
