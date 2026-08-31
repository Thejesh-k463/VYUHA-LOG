import { describe, it, expect } from "vitest";
import {
  slReport,
  slBySetup,
  tslReport,
  classifyLoser,
  resolveDirection,
  MIN_SAMPLE,
  STOP_TOLERANCE_PCT,
  type SlTrade,
} from "@/lib/analytics/sl-analysis";

function trade(p: Partial<SlTrade>): SlTrade {
  return {
    isOpen: false,
    netPnl: 0,
    qty: 10,
    avgBuyPrice: null,
    avgSellPrice: null,
    slPlanned: null,
    trailingSl: null,
    setupTag: null,
    ...p,
  };
}

// Canonical fixtures — long entry 100, stop 95 (tolerance band 95 ± 0.475).
const longSlipped = trade({
  direction: "long", netPnl: -70, avgBuyPrice: 100, avgSellPrice: 93, slPlanned: 95,
});
const longHeld = trade({
  direction: "long", netPnl: -49, avgBuyPrice: 100, avgSellPrice: 95.1, slPlanned: 95,
});
const longEarly = trade({
  direction: "long", netPnl: -30, avgBuyPrice: 100, avgSellPrice: 97, slPlanned: 95,
});
// Short entry (sell) 100, stop 105 (band 105 ± 0.525), cover = avgBuyPrice.
const shortSlipped = trade({
  direction: "short", netPnl: -35, avgSellPrice: 100, avgBuyPrice: 107, slPlanned: 105, qty: 5,
});
const shortHeld = trade({
  direction: "short", netPnl: -26, avgSellPrice: 100, avgBuyPrice: 105.3, slPlanned: 105, qty: 5,
});
const shortEarly = trade({
  direction: "short", netPnl: -10, avgSellPrice: 100, avgBuyPrice: 102, slPlanned: 105, qty: 5,
});

describe("resolveDirection", () => {
  it("prefers the caller's direction", () => {
    expect(resolveDirection(longSlipped)).toBe("long");
    expect(resolveDirection(shortSlipped)).toBe("short");
  });

  it("derives long when only the long reading has a protective stop", () => {
    // Winner: buy 100 sell 110, stop 95 — below both prices, only long-protective.
    const t = trade({ netPnl: 100, avgBuyPrice: 100, avgSellPrice: 110, slPlanned: 95 });
    expect(resolveDirection(t)).toBe("long");
    // Loser exited early: buy 100 sell 97, stop 95 ≤ sell — not short-protective.
    const early = trade({ netPnl: -30, avgBuyPrice: 100, avgSellPrice: 97, slPlanned: 95 });
    expect(resolveDirection(early)).toBe("long");
  });

  it("derives short when only the short reading is protective", () => {
    const t = trade({ netPnl: 50, avgSellPrice: 100, avgBuyPrice: 90, slPlanned: 105 });
    expect(resolveDirection(t)).toBe("short");
  });

  it("refuses when both readings are protective (slipped-stop band)", () => {
    // buy 100, sell 93, stop 95: long slipped past 95, OR short (entry 93)
    // slipped past 95 — indistinguishable from the flat row.
    const t = trade({ netPnl: -70, avgBuyPrice: 100, avgSellPrice: 93, slPlanned: 95 });
    expect(resolveDirection(t)).toBeNull();
  });

  it("refuses when neither reading is protective, or prices are missing", () => {
    // Stop above the buy and below the sell — profit side either way.
    expect(
      resolveDirection(trade({ netPnl: 100, avgBuyPrice: 100, avgSellPrice: 110, slPlanned: 105 })),
    ).toBeNull();
    expect(resolveDirection(trade({ avgSellPrice: 93, slPlanned: 95 }))).toBeNull();
  });
});

describe("classifyLoser", () => {
  it("long: slipped-past reports slippage in ₹ and SL-derived R", () => {
    const c = classifyLoser(longSlipped)!;
    expect(c.outcome).toBe("slipped-past");
    expect(c.slippageRs).toBe(20); // (95 − 93) × 10
    expect(c.slippageR).toBe(0.4); // 20 / (|100 − 95| × 10)
  });

  it("long: held within tolerance, exited-early inside the stop", () => {
    expect(classifyLoser(longHeld)!.outcome).toBe("held-to-stop");
    expect(classifyLoser(longHeld)!.slippageRs).toBe(0);
    expect(classifyLoser(longEarly)!.outcome).toBe("exited-early");
  });

  it("short: mirrored classification", () => {
    const c = classifyLoser(shortSlipped)!;
    expect(c.outcome).toBe("slipped-past");
    expect(c.slippageRs).toBe(10); // (107 − 105) × 5
    expect(c.slippageR).toBe(0.4); // 10 / (|100 − 105| × 5)
    expect(classifyLoser(shortHeld)!.outcome).toBe("held-to-stop");
    expect(classifyLoser(shortEarly)!.outcome).toBe("exited-early");
  });

  it("tolerance is a fraction of the stop price", () => {
    const justInside = trade({
      direction: "long", netPnl: -50, avgBuyPrice: 100, slPlanned: 95,
      avgSellPrice: 95 - 95 * STOP_TOLERANCE_PCT + 0.001,
    });
    const justBeyond = trade({
      direction: "long", netPnl: -51, avgBuyPrice: 100, slPlanned: 95,
      avgSellPrice: 95 - 95 * STOP_TOLERANCE_PCT - 0.01,
    });
    expect(classifyLoser(justInside)!.outcome).toBe("held-to-stop");
    expect(classifyLoser(justBeyond)!.outcome).toBe("slipped-past");
  });

  it("returns null for winners, open trades, and rows without a stop", () => {
    expect(classifyLoser(trade({ netPnl: 100, direction: "long", avgBuyPrice: 100, avgSellPrice: 110, slPlanned: 95 }))).toBeNull();
    expect(classifyLoser(trade({ isOpen: true, netPnl: -10 }))).toBeNull();
    expect(classifyLoser(trade({ netPnl: -10, avgBuyPrice: 100, avgSellPrice: 99 }))).toBeNull();
  });
});

describe("slReport", () => {
  it("classifies losers and reports slippage totals", () => {
    const r = slReport([longSlipped, longHeld, longEarly, shortSlipped, shortHeld, shortEarly]);
    expect(r.closed).toBe(6);
    expect(r.withSl).toBe(6);
    expect(r.losersClassified).toBe(6);
    expect(r.heldToStop).toBe(2);
    expect(r.slippedPast).toBe(2);
    expect(r.exitedEarly).toBe(2);
    expect(r.totalSlippageRs).toBe(30);
    expect(r.avgSlippageRs).toBe(15);
    expect(r.avgSlippageR).toBe(0.4);
    expect(r.slippageRFrom).toBe(2);
    expect(r.excluded).toBe(0);
    expect(r.excludedLosers).toBe(0);
    expect(r.excludedWinners).toBe(0);
  });

  it("excludes and counts rows whose direction cannot be derived", () => {
    const ambiguous = trade({ netPnl: -70, avgBuyPrice: 100, avgSellPrice: 93, slPlanned: 95 });
    const r = slReport([longHeld, ambiguous]);
    expect(r.withSl).toBe(2);
    expect(r.losersClassified).toBe(1);
    expect(r.excluded).toBe(1);
    expect(r.excludedLosers).toBe(1);
    expect(r.excludedWinners).toBe(0);
    // But its LOSS still counts in the coverage and averages — netPnl needs no direction.
    expect(r.losingWithSl).toBe(2);
  });

  it("counts unresolvable stop-recorded WINNERS separately from loser exclusions", () => {
    // Stop between the two prices on a winner: neither reading protective —
    // direction underivable, excluded, and it must NOT appear as a loser exclusion.
    const unresolvableWinner = () =>
      trade({ netPnl: 100, avgBuyPrice: 100, avgSellPrice: 110, slPlanned: 105 });
    const r = slReport([unresolvableWinner(), unresolvableWinner(), unresolvableWinner()]);
    expect(r.excludedWinners).toBe(3);
    expect(r.excludedLosers).toBe(0); // the losers card shows 0, not 3
    expect(r.excluded).toBe(3); // sum of the two, always
    expect(r.winnersWithSl).toBe(0); // none resolvable
    expect(r.winnersMeasured).toBe(0);
    expect(r.losersClassified).toBe(0);
  });

  it("keeps excluded === excludedLosers + excludedWinners when both populations exclude", () => {
    const ambiguousLoser = trade({ netPnl: -70, avgBuyPrice: 100, avgSellPrice: 93, slPlanned: 95 });
    const unresolvableWinner = trade({ netPnl: 100, avgBuyPrice: 100, avgSellPrice: 110, slPlanned: 105 });
    const r = slReport([ambiguousLoser, unresolvableWinner, longHeld]);
    expect(r.excludedLosers).toBe(1);
    expect(r.excludedWinners).toBe(1);
    expect(r.excluded).toBe(2);
  });

  it("reports SL coverage over losing trades and the loss gap", () => {
    const noSlLoser = trade({ netPnl: -200 });
    const noSlLoser2 = trade({ netPnl: -100 });
    const r = slReport([longHeld, longSlipped, noSlLoser, noSlLoser2]);
    expect(r.losingTrades).toBe(4);
    expect(r.losingWithSl).toBe(2);
    expect(r.losingWithoutSl).toBe(2);
    expect(r.slCoveragePct).toBe(50);
    expect(r.avgLossWithSl).toBe(-59.5); // (−49 − 70) / 2
    expect(r.avgLossWithoutSl).toBe(-150);
    expect(r.lossGapRs).toBe(90.5); // stop-recorded losers lost ₹90.5 less per trade
  });

  it("splits winners into never-risked vs near-stop, excluding unmeasured MAE", () => {
    // Stop distance 5/unit; tolerance 0.475.
    const neverRisked = trade({
      direction: "long", netPnl: 100, avgBuyPrice: 100, avgSellPrice: 110,
      slPlanned: 95, maePerUnit: 1,
    });
    const nearStop = trade({
      direction: "long", netPnl: 80, avgBuyPrice: 100, avgSellPrice: 108,
      slPlanned: 95, maePerUnit: 4.8, // within tolerance of the stop
    });
    const middling = trade({
      direction: "long", netPnl: 60, avgBuyPrice: 100, avgSellPrice: 106,
      slPlanned: 95, maePerUnit: 3.5, // neither bucket
    });
    const unmeasured = trade({
      direction: "long", netPnl: 40, avgBuyPrice: 100, avgSellPrice: 104, slPlanned: 95,
    });
    const r = slReport([neverRisked, nearStop, middling, unmeasured]);
    expect(r.winnersWithSl).toBe(4);
    expect(r.winnersMeasured).toBe(3);
    expect(r.winnersNeverRisked).toBe(1);
    expect(r.winnersNearStop).toBe(1);
  });

  it("returns zeros and nulls on empty input — no NaN anywhere", () => {
    const r = slReport([]);
    expect(r.closed).toBe(0);
    expect(r.slCoveragePct).toBeNull();
    expect(r.avgSlippageRs).toBeNull();
    expect(r.avgSlippageR).toBeNull();
    expect(r.avgLossWithSl).toBeNull();
    expect(r.lossGapRs).toBeNull();
    for (const v of Object.values(r)) {
      if (typeof v === "number") expect(Number.isNaN(v)).toBe(false);
    }
  });

  it("ignores open trades entirely", () => {
    const r = slReport([trade({ isOpen: true, netPnl: -50, slPlanned: 95, avgBuyPrice: 100 })]);
    expect(r.closed).toBe(0);
    expect(r.withSl).toBe(0);
  });
});

describe("slBySetup", () => {
  it("groups by setup with an (untagged) bucket and flags small samples", () => {
    const tagged = Array.from({ length: MIN_SAMPLE }, () =>
      trade({ ...longSlipped, setupTag: "breakout" }),
    );
    const untagged = [longHeld]; // no setupTag
    const stats = slBySetup([...tagged, ...untagged]);
    const breakout = stats.find((s) => s.key === "breakout")!;
    const other = stats.find((s) => s.key === "(untagged)")!;
    expect(breakout.closedWithSl).toBe(MIN_SAMPLE);
    expect(breakout.smallSample).toBe(false);
    expect(breakout.slippedPast).toBe(MIN_SAMPLE);
    expect(breakout.totalSlippageRs).toBe(20 * MIN_SAMPLE);
    expect(other.smallSample).toBe(true);
    expect(other.heldToStop).toBe(1);
    // Worst slippage first.
    expect(stats[0].key).toBe("breakout");
  });

  it("skips trades without a recorded stop rather than bucketing them", () => {
    expect(slBySetup([trade({ netPnl: -10, setupTag: "breakout" })])).toEqual([]);
  });
});

describe("tslReport", () => {
  const tslWin = trade({ trailingSl: 105, netPnl: 100 });
  const tslLoss = trade({ trailingSl: 105, netPnl: -50 });
  const baseWin = trade({ netPnl: 80 });
  const baseLoss = trade({ netPnl: -40 });

  it("refuses the comparison below the sample floor", () => {
    const r = tslReport([tslWin, tslLoss, ...Array(MIN_SAMPLE).fill(baseWin)]);
    expect(r.withTsl).toBe(2);
    expect(r.tslWinRatePct).toBeNull();
    expect(r.tslExpectancy).toBeNull();
    expect(r.expectancyGapRs).toBeNull();
    expect(r.smallSample).toBe(true);
    // The baseline side cleared its own floor and still reports.
    expect(r.baselineExpectancy).toBe(80);
  });

  it("compares TSL vs non-TSL when both sides clear the floor", () => {
    const tslSide = [...Array(10).fill(tslWin), ...Array(10).fill(tslLoss)];
    const baseSide = [...Array(10).fill(baseWin), ...Array(10).fill(baseLoss)];
    const r = tslReport([...tslSide, ...baseSide]);
    expect(r.withTsl).toBe(20);
    expect(r.withoutTsl).toBe(20);
    expect(r.tslWinRatePct).toBe(50);
    expect(r.tslExpectancy).toBe(25); // (100 − 50) / 2
    expect(r.baselineExpectancy).toBe(20); // (80 − 40) / 2
    expect(r.expectancyGapRs).toBe(5);
    expect(r.smallSample).toBe(false);
  });

  it("handles empty input", () => {
    const r = tslReport([]);
    expect(r.closed).toBe(0);
    expect(r.expectancyGapRs).toBeNull();
    expect(r.smallSample).toBe(true);
  });
});
