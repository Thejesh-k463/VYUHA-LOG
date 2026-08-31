import { describe, it, expect } from "vitest";
import {
  winLossReport,
  rDistribution,
  tailReport,
  hasPlanR,
  MIN_SAMPLE,
  NEAR_BREAKEVEN_MARGIN,
  R_BUCKET_EDGES,
  DEEP_LOSS_R,
  type WinLossTrade,
} from "@/lib/analytics/win-loss";

function trade(p: Partial<WinLossTrade>): WinLossTrade {
  return {
    broker: "zerodha",
    bucket: "active",
    segment: "eq_intraday",
    netPnl: 0,
    grossPnl: 0,
    chargesTotal: 0,
    rMultiple: null,
    isOpen: false,
    sellDate: "2026-01-05",
    buyDate: "2026-01-05",
    setupTag: null,
    slPlanned: null,
    trailingSl: null,
    ...p,
  };
}

/** n wins of `win` ₹ and m losses of `loss` ₹ (loss passed positive). */
function book(nWins: number, win: number, nLosses: number, loss: number): WinLossTrade[] {
  return [
    ...Array.from({ length: nWins }, () => trade({ netPnl: win, grossPnl: win })),
    ...Array.from({ length: nLosses }, () => trade({ netPnl: -loss, grossPnl: -loss })),
  ];
}

describe("winLossReport", () => {
  it("computes payoff from computeKpis averages and both breakeven figures", () => {
    // 12 wins of 200, 8 losses of 100 → w = 0.6, payoff = 2
    const r = winLossReport(book(12, 200, 8, 100));
    expect(r.n).toBe(20);
    expect(r.payoff).toBe(2);
    expect(r.kpis.winRate).toBeCloseTo(0.6, 10);
    // required payoff at w=0.6: (1-0.6)/0.6
    expect(r.payoffNeeded).toBeCloseTo(0.6667, 3);
    // required win rate at payoff 2: 1/(1+2)
    expect(r.winRateNeeded).toBeCloseTo(0.3333, 3);
  });

  it("carries a Wilson interval on the win rate", () => {
    const r = winLossReport(book(12, 200, 8, 100));
    expect(r.winRate.n).toBe(20);
    expect(r.winRate.point).toBeCloseTo(0.6, 10);
    expect(r.winRate.lo).toBeGreaterThan(0);
    expect(r.winRate.lo).toBeLessThan(0.6);
    expect(r.winRate.hi).toBeGreaterThan(0.6);
    expect(r.winRate.hi).toBeLessThanOrEqual(1);
  });

  it("payoff is null — never Infinity — with no losses, and null with no wins", () => {
    const noLosses = winLossReport(book(25, 100, 0, 0));
    expect(noLosses.payoff).toBeNull();
    expect(noLosses.winRateNeeded).toBeNull();
    expect(noLosses.verdict).toBeNull(); // cannot be placed on the curve
    const noWins = winLossReport(book(0, 0, 25, 100));
    expect(noWins.payoff).toBeNull();
    expect(noWins.payoffNeeded).toBeNull(); // w = 0: no finite payoff rescues it
    expect(noWins.verdict).toBeNull();
  });

  it("refuses a verdict below MIN_SAMPLE", () => {
    const r = winLossReport(book(10, 300, 9, 100)); // 19 < MIN_SAMPLE
    expect(MIN_SAMPLE).toBe(20);
    expect(r.payoff).toBe(3); // the measurable figures still report
    expect(r.verdict).toBeNull();
  });

  it("labels the four quadrants", () => {
    // w=0.75, payoff=3: wins big, loses rarely — far above the curve (wNeeded 0.25)
    expect(winLossReport(book(30, 300, 10, 100)).verdict).toBe("wins-big-loses-small");
    // w=0.3, payoff=4: trend-follower — big wins, loses most trades (wNeeded 0.2)
    expect(winLossReport(book(12, 400, 28, 100)).verdict).toBe("wins-big-loses-big");
    // w=0.9, payoff=0.5: scalper — small wins, rare losses (wNeeded 0.667)
    expect(winLossReport(book(36, 50, 4, 100)).verdict).toBe("wins-small-loses-small");
    // w=0.25, payoff=0.5: below the curve both ways (wNeeded 0.667)
    expect(winLossReport(book(10, 50, 30, 100)).verdict).toBe("wins-small-loses-big");
  });

  it("reads near-breakeven ON the curve and within the margin, a quadrant beyond it", () => {
    // Exactly on the curve: w=0.5, payoff=1 → wNeeded=0.5.
    expect(winLossReport(book(20, 100, 20, 100)).verdict).toBe("near-breakeven");
    // Inside the margin: w=0.55, payoff=1 → |0.55-0.5| = margin exactly.
    expect(NEAR_BREAKEVEN_MARGIN).toBe(0.05);
    expect(winLossReport(book(55, 100, 45, 100)).verdict).toBe("near-breakeven");
    // Just beyond it: w=0.56, payoff=1.
    expect(winLossReport(book(56, 100, 44, 100)).verdict).toBe("wins-big-loses-small");
    // A flattering 75% win rate that is actually near the curve: payoff 0.36 → wNeeded ~0.7353.
    expect(winLossReport(book(75, 36, 25, 100)).verdict).toBe("near-breakeven");
  });
});

describe("rDistribution", () => {
  it("splits plan-derived R from default-cap R and counts each series", () => {
    const trades = [
      trade({ rMultiple: 1.5, slPlanned: 95 }),
      trade({ rMultiple: 1.5, trailingSl: 98 }),
      trade({ rMultiple: 1.5 }), // default-cap
      trade({ rMultiple: -0.7 }), // default-cap
      trade({ rMultiple: null, slPlanned: 95 }), // no R at all
    ];
    expect(hasPlanR(trades[0])).toBe(true);
    expect(hasPlanR(trades[2])).toBe(false);
    const d = rDistribution(trades);
    expect(d.planCount).toBe(2);
    expect(d.defaultCapCount).toBe(2);
    expect(d.noRCount).toBe(1);
    const b1to2 = d.buckets.find((b) => b.lo === 1 && b.hi === 2)!;
    expect(b1to2.plan).toBe(2);
    expect(b1to2.defaultCap).toBe(1);
    const bNeg = d.buckets.find((b) => b.lo === -1 && b.hi === -0.5)!;
    expect(bNeg.defaultCap).toBe(1);
    expect(bNeg.plan).toBe(0);
  });

  it("buckets are [lo, hi) with open tails", () => {
    const d = rDistribution([
      trade({ rMultiple: -3.5, slPlanned: 1 }), // open left tail
      trade({ rMultiple: -3, slPlanned: 1 }), // lower edge is inclusive → [-3,-2)
      trade({ rMultiple: 0, slPlanned: 1 }), // [0, 0.5)
      trade({ rMultiple: 0.5, slPlanned: 1 }), // [0.5, 1)
      trade({ rMultiple: 5, slPlanned: 1 }), // open right tail, edge inclusive
      trade({ rMultiple: 9, slPlanned: 1 }),
    ]);
    expect(d.edges).toEqual([...R_BUCKET_EDGES]);
    expect(d.buckets).toHaveLength(R_BUCKET_EDGES.length + 1);
    expect(d.buckets[0]).toMatchObject({ lo: null, hi: -3, plan: 1 });
    expect(d.buckets.find((b) => b.lo === -3 && b.hi === -2)!.plan).toBe(1);
    expect(d.buckets.find((b) => b.lo === 0 && b.hi === 0.5)!.plan).toBe(1);
    expect(d.buckets.find((b) => b.lo === 0.5 && b.hi === 1)!.plan).toBe(1);
    expect(d.buckets[d.buckets.length - 1]).toMatchObject({ lo: 5, hi: null, plan: 2 });
  });

  it("skips open trades and renders at any n", () => {
    const d = rDistribution([trade({ rMultiple: 2, isOpen: true, slPlanned: 1 })]);
    expect(d.planCount).toBe(0);
    expect(d.defaultCapCount).toBe(0);
    expect(d.noRCount).toBe(0);
    const empty = rDistribution([]);
    expect(empty.buckets.every((b) => b.plan === 0 && b.defaultCap === 0)).toBe(true);
  });
});

describe("tailReport", () => {
  it("reports loss concentration: worst single loss and worst-5% share", () => {
    // 40 closed trades: 30 wins, 10 losses. worst5PctCount = ceil(2) = 2.
    const trades = [
      ...book(30, 100, 0, 0),
      ...Array.from({ length: 8 }, () => trade({ netPnl: -100 })),
      trade({ netPnl: -600 }),
      trade({ netPnl: -600 }),
    ];
    const t = tailReport(trades);
    expect(t.lossCount).toBe(10);
    expect(t.grossLoss).toBe(2000);
    expect(t.worstLoss).toBe(600);
    expect(t.worstLossShare).toBeCloseTo(0.3, 10);
    expect(t.worst5PctCount).toBe(2);
    expect(t.worst5PctShare).toBeCloseTo(0.6, 10);
  });

  it("computes the deep-loss expectancy gap over plan-derived rows only, with coverage", () => {
    const trades = [
      // clean plan losses: avg -100
      trade({ netPnl: -90, rMultiple: -0.9, slPlanned: 95 }),
      trade({ netPnl: -110, rMultiple: -1.1, trailingSl: 98 }),
      // deep plan losses (R <= -2): avg -400
      trade({ netPnl: -300, rMultiple: -3, slPlanned: 95 }),
      trade({ netPnl: -500, rMultiple: -2, slPlanned: 95 }), // boundary: -2 counts as deep
      // default-cap loss — excluded from the gap, counted in coverage total
      trade({ netPnl: -800, rMultiple: -0.08 }),
      trade({ netPnl: 200 }),
    ];
    const t = tailReport(trades);
    expect(DEEP_LOSS_R).toBe(-2);
    expect(t.planLossCoverage).toEqual({ recorded: 4, total: 5 });
    expect(t.deepLossCount).toBe(2);
    expect(t.cleanLossCount).toBe(2);
    expect(t.deepLossAvg).toBe(-400);
    expect(t.cleanLossAvg).toBe(-100);
    expect(t.deepLossGapPerTrade).toBe(300); // clean − deep
    expect(t.deepLossGapTotal).toBe(600);
  });

  it("returns nulls rather than invented zeros when a side is missing", () => {
    const noLosses = tailReport(book(5, 100, 0, 0));
    expect(noLosses.worstLoss).toBeNull();
    expect(noLosses.worstLossShare).toBeNull();
    expect(noLosses.worst5PctShare).toBeNull();
    expect(noLosses.deepLossGapPerTrade).toBeNull();
    expect(noLosses.deepLossGapTotal).toBeNull();

    // deep losses exist but no clean plan losses → no clean-loss average to compare against
    const onlyDeep = tailReport([trade({ netPnl: -300, rMultiple: -3, slPlanned: 95 })]);
    expect(onlyDeep.deepLossCount).toBe(1);
    expect(onlyDeep.cleanLossCount).toBe(0);
    expect(onlyDeep.deepLossAvg).toBe(-300);
    expect(onlyDeep.cleanLossAvg).toBeNull();
    expect(onlyDeep.deepLossGapPerTrade).toBeNull();
    expect(onlyDeep.deepLossGapTotal).toBeNull();
  });

  it("ignores open trades everywhere", () => {
    const t = tailReport([trade({ netPnl: -500, isOpen: true, rMultiple: -5, slPlanned: 95 })]);
    expect(t.lossCount).toBe(0);
    expect(t.grossLoss).toBe(0);
    expect(t.planLossCoverage).toEqual({ recorded: 0, total: 0 });
  });
});
