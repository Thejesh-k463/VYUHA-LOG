import { describe, expect, it } from "vitest";
import { DEPTH_SEGMENTS, segmentDepth, segmentFinding, type DepthTrade } from "@/lib/analytics/segment-depth";

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
