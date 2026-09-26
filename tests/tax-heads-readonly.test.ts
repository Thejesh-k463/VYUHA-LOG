import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * WAVE 3b-i, the two second-pass rulings that are claims about the DATABASE,
 * not about a pure function — so they are asserted against one.
 *
 * (b) The per-FY "MTF interest / pledge charges not deducted" figure is exactly
 *     Σ(mtfInterest + pledgeCharges) over that FY's capital-gains rows, and
 *     `trades.net_pnl` is UNTOUCHED: the add-back happens inside the tax
 *     modules' own arithmetic and there is no write path. A full render of the
 *     tax base, the FY table, the ITR pack, the ITR export and Schedule CG must
 *     leave every stored column byte-identical. The user's own trade P&L
 *     everywhere else in Vyuha still nets those charges — that sentence is what
 *     this pins.
 *
 * (5) ACCOUNT #3's class — a non-speculative OPTION book. Its rows never enter
 *     the delivery branch, so none of the three add-backs can reach them and
 *     every figure equals the plain sum of the rows' own net P&L, whatever
 *     charge columns they carry.
 *
 * The database is SEEDED so a settings row exists: without one the selected
 * account never changes, resolveTaxScope sees two unassigned tax persons and
 * returns an EMPTY base (which is correct behaviour, and would have made every
 * assertion below vacuously pass).
 *
 * One temp database for the FILE (lib/db caches its connection on globalThis),
 * one account per scenario.
 */

let t: TempDb;
let taxItr: typeof import("@/lib/queries/tax-itr");
let tax: typeof import("@/lib/analytics/tax");
let itr: typeof import("@/lib/analytics/itr");
let schedule: typeof import("@/lib/analytics/itr-schedule");

const EQUITY = 2; //  a delivery + MTF book carrying STT and financing charges
const OPTIONS = 3; // a Dhan manual OPTION book (the account-#3 class)

const selectAccount = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();

/** Every stored column of every trade row, as SQLite holds it. */
const dumpTrades = () =>
  JSON.stringify(t.sqlite.prepare("SELECT * FROM trades ORDER BY id").all());

beforeAll(async () => {
  t = await openTempDb("tax-heads-readonly", { seed: true });
  for (const id of [EQUITY, OPTIONS]) {
    t.db
      .insert(t.schema.accounts)
      .values({ id, name: `acct-${id}`, broker: "dhan" })
      .onConflictDoNothing()
      .run();
  }

  t.db
    .insert(t.schema.trades)
    .values([
      // MTF, held 5 months: s.111A short-term. STT 25, MTF interest 40, pledge 10.
      tradeRow({
        accountId: EQUITY, segment: "eq_mtf", symbol: "TCS", isin: "INE467B01029",
        buyDate: "2025-01-10", sellDate: "2025-06-10", buyQty: 100, sellQty: 100,
        buyValue: 100000, sellValue: 110000, grossPnl: 10000, netPnl: 9800,
        chargesTotal: 200, sttCtt: 25, mtfInterest: 40, pledgeCharges: 10, isOpen: false,
      }),
      // Delivery held past 12 calendar months: s.112A long-term. STT 15 only.
      tradeRow({
        accountId: EQUITY, segment: "eq_delivery", symbol: "INFY", isin: "INE009A01021",
        buyDate: "2023-01-10", sellDate: "2025-06-11", buyQty: 50, sellQty: 50,
        buyValue: 50000, sellValue: 60000, grossPnl: 10000, netPnl: 9900,
        chargesTotal: 100, sttCtt: 15, isOpen: false,
      }),
      // Three option rows, each carrying the same charge columns.
      ...[1, 2, 3].map((n) =>
        tradeRow({
          accountId: OPTIONS, segment: "index_option", instrumentType: "option", bucket: "fno",
          symbol: "NIFTY", expiry: "2025-06-26", strike: 25000, optionType: "CE",
          buyDate: "2025-06-02", sellDate: "2025-06-05", buyQty: 75, sellQty: 75,
          buyValue: 10000, sellValue: 12000, grossPnl: 2000, netPnl: 1900 + n,
          chargesTotal: 100, sttCtt: 25, mtfInterest: 40, pledgeCharges: 10, isOpen: false,
        }),
      ),
    ])
    .run();

  taxItr = await import("@/lib/queries/tax-itr");
  tax = await import("@/lib/analytics/tax");
  itr = await import("@/lib/analytics/itr");
  schedule = await import("@/lib/analytics/itr-schedule");
});

afterAll(() => t?.cleanup());

describe("(b) the add-backs are arithmetic, never a write", () => {
  it("a full tax render leaves every stored trades column byte-identical", () => {
    selectAccount(EQUITY);
    const before = dumpTrades();

    // Everything /reports/tax, /reports/itr and the ITR export do, in one pass.
    const base = taxItr.getTaxBase();
    const fyRows = tax.taxByFy([...base.taxRows, ...base.ipoTaxRows], 4, "2025-26");
    const packs = itr.itrPackByFy(
      base.taxRows.map((r) => ({ ...r, grossPnl: r.grossPnl, sellValue: r.sellValue })),
      4,
      "2025-26",
    );
    const sched = schedule.itrScheduleByFy(
      base.cgTrades.map((r) => ({
        segment: r.segment, assetClass: r.assetClass, buyDate: r.buyDate, sellDate: r.sellDate, fyDate: r.fyDate,
        buyValue: r.buyValue, sellValue: r.sellValue, grossPnl: 0, netPnl: r.netPnl,
        chargesTotal: 0, sttCtt: r.sttCtt ?? 0, mtfInterest: r.mtfInterest, pledgeCharges: r.pledgeCharges,
        isOpen: false,
      })),
      4,
      "2025-26",
    );
    const rows = taxItr.getItrExportRows();

    expect(fyRows.length).toBeGreaterThan(0);
    expect(packs.length).toBeGreaterThan(0);
    expect(sched.length).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThan(0);
    expect(dumpTrades()).toBe(before);
  });

  it("notDeductedMtf is exactly Σ(mtfInterest + pledgeCharges) read out of SQLite", () => {
    selectAccount(EQUITY);
    const stored = t.sqlite
      .prepare(
        "SELECT COALESCE(SUM(mtf_interest_paise),0) AS mtf, COALESCE(SUM(pledge_charges_paise),0) AS pledge, COALESCE(SUM(stt_ctt_paise),0) AS stt FROM trades WHERE account_id = ? AND segment IN ('eq_delivery','eq_mtf')",
      )
      .get(EQUITY) as { mtf: number; pledge: number; stt: number };
    const expectedMtf = (stored.mtf + stored.pledge) / 100; // paise in the DB, rupees at runtime
    const expectedStt = stored.stt / 100;

    const base = taxItr.getTaxBase();
    const [fy] = tax.taxByFy(base.taxRows, 4, "2025-26");
    expect(expectedMtf).toBe(50); // 40 + 10, and no GST: that part is not separable
    expect(fy.notDeductedMtf).toBe(expectedMtf);
    expect(fy.sttAddedBack).toBe(expectedStt);
    expect(fy.sttAddedBack).toBe(40); // 25 + 15

    // …and the stored net P&L is still the charge-netted figure it always was.
    const netPaise = t.sqlite
      .prepare("SELECT COALESCE(SUM(net_pnl_paise),0) AS n FROM trades WHERE account_id = ?")
      .get(EQUITY) as { n: number };
    expect(netPaise.n / 100).toBe(19700); // 9800 + 9900 — untouched by the add-back
    // The CG buckets DO move: 9800 + 25 + 50 = 9875 short, 9900 + 15 = 9915 long.
    expect(fy.stcg111A).toBe(9875);
    expect(fy.ltcg112A).toBe(9915);
    expect(fy.totalRealised).toBe(19700); // the book's own realised figure is unchanged
  });
});

describe("(5) ACCOUNT #3's class — a non-speculative option book is untouched", () => {
  it("every CG bucket is zero and the F&O figure is the plain sum of net P&L", () => {
    selectAccount(OPTIONS);
    const base = taxItr.getTaxBase();
    const [fy] = tax.taxByFy(base.taxRows, 4, "2025-26");
    // 1901 + 1902 + 1903 — each row carries STT, MTF interest and pledge
    // charges, and NONE of them is added back: S.36(1)(xv) keeps them
    // deductible for a business head, which is the whole asymmetry.
    expect(fy.fnoBusiness).toBe(5706);
    expect(fy.totalRealised).toBe(5706);
    expect([fy.stcg111A, fy.stcgOther, fy.ltcg112A, fy.ltcg112, fy.cgUndetermined]).toEqual([0, 0, 0, 0, 0]);
    expect(fy.sttAddedBack).toBe(0);
    expect(fy.notDeductedMtf).toBe(0);
  });

  it("the ITR pack agrees, and the schedule's business expense still includes STT", () => {
    selectAccount(OPTIONS);
    const base = taxItr.getTaxBase();
    const [p] = itr.itrPackByFy(base.taxRows, 4, "2025-26");
    expect(p.nonSpeculative.net).toBe(5706);
    expect(p.capitalGains.trades).toBe(0);
    expect(p.capitalGains.sttAddedBack).toBe(0);
    expect(p.capitalGains.notDeductedMtf).toBe(0);
  });

  it("an options render writes nothing either", () => {
    selectAccount(OPTIONS);
    const before = dumpTrades();
    taxItr.getItrExportRows();
    tax.taxByFy(taxItr.getTaxBase().taxRows, 4, "2025-26");
    expect(dumpTrades()).toBe(before);
  });
});
