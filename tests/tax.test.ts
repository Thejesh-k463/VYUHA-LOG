import { describe, expect, it } from "vitest";
import { taxByFy, type TaxTrade } from "@/lib/analytics/tax";
import { itrPackByFy, type ItrTrade } from "@/lib/analytics/itr";

// lib/analytics/tax.ts is the module behind the primary /reports/tax FY table and
// was the ONLY tax module without a test file when the v3.2.1 audit ran.

const t = (over: Partial<TaxTrade> = {}): TaxTrade => ({
  segment: "eq_delivery",
  instrumentType: "equity",
  buyDate: "2026-05-01",
  sellDate: "2026-06-01",
  grossPnl: 0,
  netPnl: 0,
  buyValue: 0,
  sellValue: 0,
  chargesTotal: 0,
  isOpen: false,
  ...over,
});

describe("taxByFy — head segregation", () => {
  it("routes each segment to the head the Act puts it in", () => {
    const [fy] = taxByFy([
      // s.66(31): intraday equity is settled otherwise than by delivery → speculative.
      t({ segment: "eq_intraday", grossPnl: 5000, netPnl: 4800, chargesTotal: 200 }),
      // s.66(33): exchange-traded derivatives are carved OUT of speculation.
      t({ segment: "index_option", grossPnl: 9000, netPnl: 8500, sellValue: 120000, chargesTotal: 500 }),
      t({ segment: "future", grossPnl: -4000, netPnl: -4300, chargesTotal: 300 }),
      // Delivery and MTF are capital gains, split on the 12-month line.
      t({ segment: "eq_delivery", buyDate: "2026-04-01", sellDate: "2026-06-01", netPnl: 2000 }),
      t({ segment: "eq_mtf", buyDate: "2024-04-01", sellDate: "2026-06-01", netPnl: 15000 }),
    ]);

    expect(fy.fy).toBe("2026-27");
    expect(fy.intradaySpeculative).toBe(4800);
    expect(fy.fnoBusiness).toBe(4200); // 8500 − 4300
    expect(fy.stcg).toBe(2000);
    expect(fy.ltcg).toBe(15000);
    expect(fy.trades).toBe(5);
  });

  it("holds long-term at exactly 365 days and short-term one day under", () => {
    const lt = taxByFy([t({ buyDate: "2025-06-01", sellDate: "2026-06-01", netPnl: 100 })]);
    expect(lt[0].ltcg).toBe(100);
    expect(lt[0].stcg).toBe(0);

    const st = taxByFy([t({ buyDate: "2025-06-02", sellDate: "2026-06-01", netPnl: 100 })]);
    expect(st[0].stcg).toBe(100);
    expect(st[0].ltcg).toBe(0);
  });

  it("excludes open positions from every head", () => {
    const rows = taxByFy([t({ isOpen: true, netPnl: 99999, grossPnl: 99999 })]);
    expect(rows).toHaveLength(0);
  });

  it("splits on the financial year boundary and honours fyStartMonth", () => {
    const rows = taxByFy([
      t({ sellDate: "2026-03-31", netPnl: 100 }),
      t({ sellDate: "2026-04-01", netPnl: 200 }),
    ]);
    expect(rows.map((r) => r.fy)).toEqual(["2025-26", "2026-27"]);
  });
});

describe("taxByFy — turnover", () => {
  it("includes option sell premium (ICAI GN 11th ed. 5.11(b)(ii))", () => {
    const [fy] = taxByFy([
      t({ segment: "index_option", grossPnl: 5000, netPnl: 4500, sellValue: 200000 }),
    ]);
    expect(fy.fnoTurnover).toBe(205000);
  });

  it("adds no premium for futures, which have none", () => {
    const [fy] = taxByFy([t({ segment: "future", grossPnl: -5000, netPnl: -5300, sellValue: 800000 })]);
    expect(fy.fnoTurnover).toBe(5000);
  });

  it("leaves capital-gains and speculative trades out of F&O turnover", () => {
    const [fy] = taxByFy([
      t({ segment: "eq_delivery", netPnl: 1000, sellValue: 500000 }),
      t({ segment: "eq_intraday", grossPnl: 400, netPnl: 300, sellValue: 90000 }),
    ]);
    expect(fy.fnoTurnover).toBe(0);
  });
});

// The defect that motivated lib/analytics/turnover.ts: /reports/tax and
// /reports/itr computed turnover differently, so the same book showed two
// figures on two screens, and the audit verdict rode on the smaller one.
describe("turnover agrees across /reports/tax and /reports/itr", () => {
  it("reports the SAME F&O turnover from both modules", () => {
    const shared = [
      { segment: "index_option", grossPnl: 5000, netPnl: 4500, sellValue: 200000, chargesTotal: 500 },
      { segment: "stock_option", grossPnl: -2000, netPnl: -2300, sellValue: 90000, chargesTotal: 300 },
      { segment: "future", grossPnl: 1500, netPnl: 1200, sellValue: 400000, chargesTotal: 300 },
    ];

    const taxRows = taxByFy(
      shared.map((s) =>
        t({ ...s, buyDate: "2026-05-01", sellDate: "2026-06-01", instrumentType: "option", buyValue: 0 }),
      ),
    );
    const itrTrades: ItrTrade[] = shared.map((s) => ({
      segment: s.segment,
      buyDate: "2026-05-01",
      sellDate: "2026-06-01",
      grossPnl: s.grossPnl,
      netPnl: s.netPnl,
      sellValue: s.sellValue,
      chargesTotal: s.chargesTotal,
      isOpen: false,
    }));
    const itrPacks = itrPackByFy(itrTrades);

    expect(taxRows[0].fnoTurnover).toBe(itrPacks[0].nonSpeculative.turnover);
    // 5000 + 2000 + 1500 differences, plus 200000 + 90000 option premium.
    expect(taxRows[0].fnoTurnover).toBe(298500);
  });
});
