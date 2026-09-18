import { describe, expect, it } from "vitest";
import { DEPTH_SEGMENTS, segmentDepth, segmentFinding, type DepthTrade } from "@/lib/analytics/segment-depth";
import { bySegment, computeKpis, edgeMeasurable, type AnalyticsTrade } from "@/lib/analytics/metrics";
import { winLossReport, type WinLossTrade } from "@/lib/analytics/win-loss";
import { segmentEdgeRows } from "@/lib/domain/kpi-detail";

/**
 * Five different businesses that share a login. Rolling them into one
 * expectancy hides the thing a trader most needs to know: which one pays.
 */

const t = (o: Partial<DepthTrade>): DepthTrade => ({
  segment: "eq_delivery",
  netPnl: 0, grossPnl: 0, chargesTotal: 0, buyValue: 10000,
  isOpen: false, basisKnown: true, ...o,
});

describe("DEPTH_SEGMENTS", () => {
  it("covers exactly the five the owner asked for, index and stock options apart", () => {
    expect(DEPTH_SEGMENTS.map((d) => d.segment)).toEqual([
      "eq_intraday", "eq_delivery", "eq_mtf", "index_option", "stock_option",
    ]);
  });

  it("says why each segment is its own business, not just what it is called", () => {
    const stock = DEPTH_SEGMENTS.find((d) => d.segment === "stock_option")!;
    expect(stock.note).toMatch(/PHYSICALLY settled/);
    const mtf = DEPTH_SEGMENTS.find((d) => d.segment === "eq_mtf")!;
    expect(mtf.note).toMatch(/financing/);
  });
});

describe("segmentDepth", () => {
  it("separates index and stock options rather than lumping them as options", () => {
    const r = segmentDepth([
      t({ segment: "index_option", netPnl: 500, grossPnl: 600, chargesTotal: 100 }),
      t({ segment: "stock_option", netPnl: -300, grossPnl: -200, chargesTotal: 100 }),
    ]);
    expect(r.rows.find((x) => x.segment === "index_option")!.net).toBe(500);
    expect(r.rows.find((x) => x.segment === "stock_option")!.net).toBe(-300);
  });

  it("EXCLUDES unknown-basis trades from every rate and reports how many", () => {
    const r = segmentDepth([
      t({ netPnl: 100 }),
      t({ netPnl: 999, basisKnown: false }),
    ]);
    const row = r.rows.find((x) => x.segment === "eq_delivery")!;
    expect(row.count).toBe(1);
    expect(row.excluded).toBe(1);
    expect(row.net).toBe(100); // the excluded trade's P&L is not in the rate population
    expect(r.totalExcluded).toBe(1);
  });

  it("carries a Wilson interval on every win rate, so a thin segment shows as thin", () => {
    const thin = segmentDepth([t({ segment: "eq_mtf", netPnl: 100 })]);
    const row = thin.rows.find((x) => x.segment === "eq_mtf")!;
    expect(row.winRate).toBe(1); // 1/1 looks like a 100% win rate
    // …but the interval says how little that means.
    expect(row.winRateCi.lo).toBeLessThan(0.3);
  });

  it("refuses a charge-drag percentage against a negative gross", () => {
    // A percentage of a loss is not a share of profit.
    const r = segmentDepth([t({ netPnl: -500, grossPnl: -400, chargesTotal: 100 })]);
    expect(r.rows.find((x) => x.segment === "eq_delivery")!.chargeDragPct).toBeNull();
  });

  it("computes charge drag as a share of gross profit when there is one", () => {
    const r = segmentDepth([t({ netPnl: 800, grossPnl: 1000, chargesTotal: 200 })]);
    expect(r.rows.find((x) => x.segment === "eq_delivery")!.chargeDragPct).toBe(20);
  });

  it("counts trades in segments this surface does not cover, instead of dropping them", () => {
    const r = segmentDepth([t({ segment: "future", netPnl: 100 }), t({ segment: "commodity_option" })]);
    expect(r.otherSegmentTrades).toBe(2);
    expect(r.bookCount).toBe(0);
  });

  it("ignores open positions", () => {
    expect(segmentDepth([t({ isOpen: true, netPnl: 500 })]).bookCount).toBe(0);
  });

  it("averages fills only over trades that carry them", () => {
    const r = segmentDepth([
      t({ buyOrderCount: 1, sellOrderCount: 1 }),
      t({ buyOrderCount: 3, sellOrderCount: 3 }),
      t({ buyOrderCount: null, sellOrderCount: null }),
    ]);
    expect(r.rows.find((x) => x.segment === "eq_delivery")!.avgFills).toBe(4);
  });

  it("has no book win rate at all when nothing is measurable", () => {
    expect(segmentDepth([]).bookWinRate).toBeNull();
  });

  /**
   * D6 — ONE per-segment profit factor and payoff. `groupBy` (the dashboard
   * table and /reports/edge "By segment"), `segmentDepth` (the edge depth
   * card) and `computeKpis` over the segment's own trades (the dashboard KPI
   * under a segment filter) all go through `edgeRatios`, so they cannot
   * disagree. Kpis' PF keeps its documented Infinity-when-no-loser rule; the
   * comparison normalises it to null exactly as `LensEdge` does
   * (lens-edge.ts, the design review's D6 delta).
   */
  it("per segment, groupBy PF = segmentDepth PF = computeKpis PF (and payoff likewise)", () => {
    const a = (o: Partial<AnalyticsTrade>): AnalyticsTrade => ({
      broker: "dhan", bucket: "active", segment: "eq_delivery",
      netPnl: 0, grossPnl: 0, chargesTotal: 0, rMultiple: null, isOpen: false,
      sellDate: "2026-06-01", buyDate: "2026-06-01", setupTag: null,
      acquisition: null, acquisitionPrice: null, buyValue: 10000, ...o,
    });
    const book: AnalyticsTrade[] = [
      a({ segment: "eq_delivery", netPnl: 1200.37 }), a({ segment: "eq_delivery", netPnl: 800.11 }),
      a({ segment: "eq_delivery", netPnl: -700.29 }),
      // an unpriced winner: cash in every total, absent from every ratio
      a({ segment: "eq_delivery", netPnl: 90000, acquisition: "ipo", buyValue: 0 }),
      a({ segment: "eq_intraday", netPnl: 333.33 }), a({ segment: "eq_intraday", netPnl: -111.11 }),
      a({ segment: "eq_intraday", netPnl: -222.22 }),
      a({ segment: "index_option", netPnl: 4000 }), // winners only → PF ∞ → null
      a({ segment: "stock_option", netPnl: -900 }), // losers only → PF 0, payoff null
    ];
    const groups = bySegment(book);
    const depth = segmentDepth(book.map((x) => ({ ...x, basisKnown: edgeMeasurable(x) })));
    const table = segmentEdgeRows(groups);
    const lensPf = (pf: number) => (Number.isFinite(pf) ? pf : null);
    for (const seg of ["eq_delivery", "eq_intraday", "index_option", "stock_option"] as const) {
      const own = book.filter((x) => x.segment === seg);
      const k = computeKpis(own);
      const g = groups.find((x) => x.key === seg)!;
      const d = depth.rows.find((x) => x.segment === seg)!;
      const row = table.find((x) => x.segment === seg)!;
      expect(g.profitFactor, seg).toBe(lensPf(k.profitFactor));
      expect(d.profitFactor, seg).toBe(g.profitFactor);
      expect(row.profitFactor, seg).toBe(g.profitFactor);
      expect(g.payoff, seg).toBe(winLossReport(own as WinLossTrade[]).payoff);
      expect(d.payoff, seg).toBe(g.payoff);
      expect(row.payoff, seg).toBe(g.payoff);
      expect(row.expectancy, seg).toBe(k.expectancy);
      expect(row.winRate, seg).toBe(k.winRate);
    }
    expect(groups.find((x) => x.key === "eq_delivery")!.profitFactor).toBe(2.86); // 2000.48 ÷ 700.29
    expect(groups.find((x) => x.key === "index_option")!.profitFactor).toBeNull();
    expect(groups.find((x) => x.key === "stock_option")!.profitFactor).toBe(0);
    expect(groups.find((x) => x.key === "stock_option")!.payoff).toBeNull();
    // An empty segment has no row in the dashboard table and no ratio in depth.
    expect(table.find((x) => x.segment === "eq_mtf")).toBeUndefined();
    expect(depth.rows.find((x) => x.segment === "eq_mtf")!.profitFactor).toBeNull();
    // The table lists DEPTH_SEGMENTS only, in their order.
    expect(table.map((x) => x.segment)).toEqual(["eq_intraday", "eq_delivery", "index_option", "stock_option"]);
  });

  it("an empty segment's win rate and expectancy are null, never 0 (invariant 6)", () => {
    // eq_intraday has no trade; eq_delivery has only an UNPRICED one (count 0,
    // excluded 1) — both are rows on the table, neither has a rate to state.
    const r = segmentDepth([t({ segment: "eq_delivery", netPnl: 999, basisKnown: false })]);
    for (const seg of ["eq_intraday", "eq_delivery"] as const) {
      const row = r.rows.find((x) => x.segment === seg)!;
      expect(row.count, seg).toBe(0);
      expect(row.winRate, seg).toBeNull();
      expect(row.expectancy, seg).toBeNull();
    }
  });
});

describe("segmentFinding", () => {
  const many = (segment: string, n: number, netPnl: number) =>
    Array.from({ length: n }, () => t({ segment, netPnl, grossPnl: netPnl }));

  it("stays silent when fewer than two segments have enough trades", () => {
    expect(segmentFinding(segmentDepth(many("eq_delivery", 30, 100)), 20)).toBeNull();
  });

  it("names the two ends when one segment funds another's losses", () => {
    const r = segmentDepth([...many("eq_delivery", 25, 8000), ...many("index_option", 25, -6400)]);
    const msg = segmentFinding(r, 20)!;
    expect(msg).toMatch(/Equity Delivery/);
    expect(msg).toMatch(/Options \(Index\)/);
    expect(msg).toMatch(/cancelling/);
  });

  it("says so plainly when every measured segment is positive", () => {
    const r = segmentDepth([...many("eq_delivery", 25, 500), ...many("eq_intraday", 25, 200)]);
    expect(segmentFinding(r, 20)!).toMatch(/Every segment with enough trades is positive/);
  });
});
