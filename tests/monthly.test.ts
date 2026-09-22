import { describe, expect, it } from "vitest";
import {
  monthlyBreakdown,
  monthlyByHead,
  MONTHLY_HEAD_CAVEAT,
  type MonthlyHeadTrade,
} from "@/lib/analytics/monthly";

// v4.5.0 — `monthlyByHead` takes a `MonthlyHeadTrade`: a month row PLUS the
// asset class, because a month column and the FY table must not disagree about
// which head a trade is in. `MonthlyHeadTrade extends MonthlyTrade`, so this one
// factory still feeds `monthlyBreakdown` too.
const t = (over: Partial<MonthlyHeadTrade> = {}): MonthlyHeadTrade => ({
  sellDate: "2026-05-10",
  buyDate: "2026-05-01",
  segment: "eq_delivery",
  assetClass: "share",
  netPnl: 0,
  grossPnl: 0,
  chargesTotal: 0,
  isOpen: false,
  ...over,
});

describe("monthlyBreakdown", () => {
  it("aggregates a month as a unit of work", () => {
    const r = monthlyBreakdown([
      t({ sellDate: "2026-05-02", netPnl: 1000, grossPnl: 1200, chargesTotal: 200 }),
      t({ sellDate: "2026-05-20", netPnl: -400, grossPnl: -300, chargesTotal: 100 }),
      t({ sellDate: "2026-05-28", netPnl: 600, grossPnl: 700, chargesTotal: 100 }),
    ]);
    expect(r.rows).toHaveLength(1);
    const m = r.rows[0];
    expect(m.ym).toBe("2026-05");
    expect(m.trades).toBe(3);
    expect(m.net).toBe(1200);
    expect(m.gross).toBe(1600);
    expect(m.charges).toBe(400);
    expect(m.wins).toBe(2);
    expect(m.losses).toBe(1);
    expect(m.winRate).toBeCloseTo(2 / 3);
    expect(m.expectancy).toBe(400);
    expect(m.best).toBe(1000);
    expect(m.worst).toBe(-400);
    expect(m.chargeDragPct).toBe(25); // 400 / 1600
  });

  it("refuses a charge-drag percentage against a non-positive gross", () => {
    const r = monthlyBreakdown([t({ netPnl: -500, grossPnl: -400, chargesTotal: 100 })]);
    // A percentage of a loss is not a drag figure — "—", never a number.
    expect(r.rows[0].chargeDragPct).toBeNull();
  });

  it("excludes open positions and COUNTS the closed ones it cannot date", () => {
    const r = monthlyBreakdown([
      t({ netPnl: 100 }),
      t({ isOpen: true, netPnl: 9999 }),
      t({ sellDate: null, netPnl: 50 }),
    ]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].trades).toBe(1);
    // Reported, not silently dropped.
    expect(r.undated).toBe(1);
  });

  it("returns an empty report rather than throwing on no trades", () => {
    const r = monthlyBreakdown([]);
    expect(r.rows).toEqual([]);
    expect(r.bestMonth).toBeNull();
    expect(r.worstMonth).toBeNull();
    expect(r.monthsWithoutTrades).toBe(0);
  });
});

describe("month-over-month", () => {
  it("compares against the immediately preceding calendar month", () => {
    const r = monthlyBreakdown([
      t({ sellDate: "2026-05-10", netPnl: 1000 }),
      t({ sellDate: "2026-06-10", netPnl: 1500 }),
    ]);
    expect(r.rows[0].momNet).toBeNull(); // nothing before it
    expect(r.rows[1].momNet).toBe(500);
  });

  it("crosses a year boundary correctly", () => {
    const r = monthlyBreakdown([
      t({ sellDate: "2026-12-10", netPnl: 300 }),
      t({ sellDate: "2027-01-10", netPnl: 800 }),
    ]);
    expect(r.rows[1].momNet).toBe(500);
  });

  it("does NOT invent a trend across a gap month", () => {
    // No November. December must not be compared against October.
    const r = monthlyBreakdown([
      t({ sellDate: "2026-10-10", netPnl: 1000 }),
      t({ sellDate: "2026-12-10", netPnl: 100 }),
    ]);
    expect(r.rows[1].ym).toBe("2026-12");
    expect(r.rows[1].momNet).toBeNull();
    expect(r.monthsWithoutTrades).toBe(1);
  });

  it("ranks best and worst, and leaves worst null for a single month", () => {
    const one = monthlyBreakdown([t({ netPnl: 100 })]);
    expect(one.bestMonth?.ym).toBe("2026-05");
    expect(one.worstMonth).toBeNull();

    const many = monthlyBreakdown([
      t({ sellDate: "2026-05-10", netPnl: 100 }),
      t({ sellDate: "2026-06-10", netPnl: -900 }),
      t({ sellDate: "2026-07-10", netPnl: 400 }),
    ]);
    expect(many.bestMonth?.ym).toBe("2026-07");
    expect(many.worstMonth?.ym).toBe("2026-06");
  });
});

describe("monthlyByHead — realised, not owed", () => {
  it("splits each month the way the Act splits the year", () => {
    const rows = monthlyByHead([
      t({ sellDate: "2026-05-10", segment: "eq_delivery", buyDate: "2026-04-01", netPnl: 1000, chargesTotal: 50 }),
      t({ sellDate: "2026-05-11", segment: "eq_mtf", buyDate: "2024-04-01", netPnl: 5000, chargesTotal: 80 }),
      t({ sellDate: "2026-05-12", segment: "eq_intraday", netPnl: -300, chargesTotal: 20 }),
      t({ sellDate: "2026-05-13", segment: "index_option", netPnl: 700, chargesTotal: 40 }),
      t({ sellDate: "2026-05-14", segment: "future", netPnl: -200, chargesTotal: 30 }),
    ]);
    expect(rows).toHaveLength(1);
    const m = rows[0];
    expect(m.stcg111A).toBe(1000);
    expect(m.ltcg112A).toBe(5000);
    expect(m.stcgOther).toBe(0);
    expect(m.ltcg112).toBe(0);
    expect(m.cgUndetermined).toBe(0);
    expect(m.speculative).toBe(-300);
    expect(m.fnoBusiness).toBe(500); // 700 − 200
    expect(m.charges).toBe(220);
    expect(m.trades).toBe(5);
  });

  /**
   * Still the same line as the annual modules — but that line is a CALENDAR
   * MONTH one from v4.5.0 (S.2(42A) + General Clauses Act 1897 s.3(35)), not
   * 365 days. Bought 10-May-2025, the sale on 10-May-2026 is exactly twelve
   * months and NOT past them, so it is short-term; 11-May-2026 is the first
   * long-term day. `monthly.ts` held the FOURTH copy of the 365-day count.
   */
  it("uses the same CALENDAR-MONTH line as the annual tax modules", () => {
    const st = monthlyByHead([t({ buyDate: "2025-05-10", sellDate: "2026-05-10", netPnl: 100 })]);
    expect(st[0].stcg111A).toBe(100);
    expect(st[0].ltcg112A).toBe(0);
    const lt = monthlyByHead([t({ buyDate: "2025-05-10", sellDate: "2026-05-11", netPnl: 100 })]);
    expect(lt[0].ltcg112A).toBe(100);
  });

  it("puts a non-equity unit and an unknown asset in their own columns, never in s.111A", () => {
    const rows = monthlyByHead([
      // A gold ETF held 5 months: slab-rate short-term, not S.111A.
      t({ assetClass: "otherUnit", buyDate: "2026-01-10", sellDate: "2026-05-10", netPnl: 400 }),
      // A bare scrip code with no ISIN: the head is BLANK (invariant 6).
      t({ assetClass: "undetermined", netPnl: 60 }),
    ]);
    expect(rows[0].stcgOther).toBe(400);
    expect(rows[0].cgUndetermined).toBe(60);
    expect(rows[0].stcg111A).toBe(0);
  });

  /**
   * The month table is a record of what ARRIVED, so — unlike the annual tax
   * tables — it does NOT add STT or the financing charges back. Its own caveat
   * says so, and this pins the two apart.
   */
  it("reports the trade's own net P&L — no STT or MTF add-back happens here", () => {
    const rows = monthlyByHead([t({ netPnl: 1000, chargesTotal: 120 })]);
    expect(rows[0].stcg111A).toBe(1000);
  });

  it("orders months chronologically across a year boundary", () => {
    const rows = monthlyByHead([
      t({ sellDate: "2027-01-10", netPnl: 1 }),
      t({ sellDate: "2026-12-10", netPnl: 1 }),
    ]);
    expect(rows.map((r) => r.ym)).toEqual(["2026-12", "2027-01"]);
  });

  it("carries a caveat that refuses to call itself a monthly tax bill", () => {
    expect(MONTHLY_HEAD_CAVEAT).toContain("not a monthly tax bill");
    expect(MONTHLY_HEAD_CAVEAT).toContain("annual");
  });
});
