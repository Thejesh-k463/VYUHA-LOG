import { describe, it, expect } from "vitest";
import {
  computeKpis,
  dailyPnl,
  equityCurve,
  bySegment,
  bySetup,
  type AnalyticsTrade,
} from "@/lib/analytics/metrics";
import { benjaminiYekutieli, proportionPValue } from "@/lib/analytics/inference";

function t(p: Partial<AnalyticsTrade>): AnalyticsTrade {
  return {
    broker: "dhan", bucket: "active", segment: "index_option",
    netPnl: 0, grossPnl: 0, chargesTotal: 0, rMultiple: null, isOpen: false,
    sellDate: "2026-06-01", buyDate: "2026-06-01", setupTag: null,
    // The three `edgeMeasurable` reads, REQUIRED on `AnalyticsTrade` since the
    // wave 2O seam pass (defect 1). Stated as the values the optional fields read
    // as before (`acquisition` null → priced whatever `buyValue` says), so every
    // figure below is unchanged; the `unpriced()` helpers override them.
    acquisition: null, acquisitionPrice: null, buyValue: 0,
    ...p,
  };
}

const sample: AnalyticsTrade[] = [
  t({ sellDate: "2026-06-01", netPnl: 1000, grossPnl: 1100, chargesTotal: 100, rMultiple: 1.0 }),
  t({ sellDate: "2026-06-02", netPnl: -500, grossPnl: -400, chargesTotal: 100, rMultiple: -0.5 }),
  t({ sellDate: "2026-06-02", netPnl: 2000, grossPnl: 2100, chargesTotal: 100, rMultiple: 2.0 }),
  t({ sellDate: "2026-06-03", netPnl: -1500, grossPnl: -1400, chargesTotal: 100, rMultiple: -1.5 }),
  t({ isOpen: true, sellDate: null, netPnl: -50, grossPnl: 0, chargesTotal: 50 }),
];

describe("computeKpis", () => {
  const k = computeKpis(sample);
  it("counts closed vs open", () => {
    expect(k.closedCount).toBe(4);
    expect(k.openCount).toBe(1);
  });
  it("realised totals (closed only)", () => {
    expect(k.netPnl).toBe(1000);
    expect(k.grossPnl).toBe(1400);
    expect(k.charges).toBe(400);
    expect(k.chargePctOfGross).toBeCloseTo(28.57, 1);
  });
  it("win rate, profit factor, expectancy, avg R", () => {
    expect(k.winRate).toBe(0.5);
    expect(k.profitFactor).toBe(1.5); // 3000 / 2000
    expect(k.expectancy).toBe(250); // 1000 / 4
    expect(k.avgR).toBe(0.25);
    expect(k.avgWin).toBe(1500);
    expect(k.avgLoss).toBe(-1000);
  });
  it("max drawdown & streaks", () => {
    expect(k.maxDrawdown).toBe(1500);
    expect(k.maxWinStreak).toBe(1);
    expect(k.maxLossStreak).toBe(1);
    expect(k.currentStreak).toBe(-1);
  });
});

/**
 * The five ratios state NOTHING when their denominator is 0 (wave 2O / D1).
 *
 * They returned a figure the book cannot support: "Win rate 0.0%" and
 * "Expectancy ₹0" on a book whose closed trades all lack a cost basis,
 * "Avg loss ₹0" on a book with no loser, "Charges leak 0%" on a book whose
 * gross is exactly 0. `avgR` already returned null; these now follow it, and
 * `help-content.ts` already promised it. `profitFactor` keeps its own
 * Infinity/0 rule — outside the ruling.
 */
describe("computeKpis states null, never a fabricated ratio", () => {
  const unpriced = (p: Partial<AnalyticsTrade>) => t({ acquisition: "ipo", buyValue: 0, ...p });

  it("an all-unpriced closed book: the five are null while the cash is real", () => {
    const k = computeKpis([
      unpriced({ netPnl: 21881, grossPnl: 21904, chargesTotal: 23 }),
      unpriced({ netPnl: 3381, grossPnl: 3404, chargesTotal: 23 }),
    ]);
    expect(k.closedCount).toBe(2);
    expect(k.unpricedCount).toBe(2);
    expect(k.winRate).toBeNull();
    expect(k.expectancy).toBeNull();
    expect(k.avgWin).toBeNull();
    expect(k.avgLoss).toBeNull();
    expect(k.chargePctOfGross).not.toBeNull(); // gross is 25308, a real denominator
    // Cash is untouched, and profitFactor keeps its own rule.
    expect(k.netPnl).toBe(25262);
    expect(k.charges).toBe(46);
    expect(k.profitFactor).toBe(0);
    expect(k.wins).toBe(0);
  });

  it("an empty book: five nulls, no NaN, profitFactor 0", () => {
    const k = computeKpis([]);
    expect([k.winRate, k.expectancy, k.avgWin, k.avgLoss, k.chargePctOfGross]).toEqual([
      null, null, null, null, null,
    ]);
    expect(k.profitFactor).toBe(0);
    expect(k.closedCount).toBe(0);
    expect(k.netPnl).toBe(0);
  });

  it("one winner and no loser: avgLoss is null, avgWin is a figure", () => {
    const k = computeKpis([t({ netPnl: 1200, grossPnl: 1300, chargesTotal: 100 })]);
    expect(k.avgWin).toBe(1200);
    expect(k.avgLoss).toBeNull();
    expect(k.winRate).toBe(1);
    expect(k.expectancy).toBe(1200);
    expect(k.profitFactor).toBe(Infinity);
  });

  it("gross exactly 0 with charges paid: the charge share is null, not 0%", () => {
    const k = computeKpis([
      t({ netPnl: 900, grossPnl: 1000, chargesTotal: 100 }),
      t({ netPnl: -1100, grossPnl: -1000, chargesTotal: 100 }),
    ]);
    expect(k.grossPnl).toBe(0);
    expect(k.charges).toBe(200);
    expect(k.chargePctOfGross).toBeNull();
    // …and the ratios that DO have a denominator still state figures.
    expect(k.winRate).toBe(0.5);
    expect(k.expectancy).toBe(-100);
  });
});

describe("tie-out invariants", () => {
  it("daily P&L sums to realised net", () => {
    const total = [...dailyPnl(sample).values()].reduce((a, b) => a + b, 0);
    expect(Math.round(total)).toBe(1000);
  });
  it("equity curve final cumulative equals realised net", () => {
    const curve = equityCurve(sample);
    expect(curve[curve.length - 1].cum).toBe(1000);
    expect(curve.some((p) => p.drawdown < 0)).toBe(true);
  });
});

describe("groupBy", () => {
  it("groups by segment with correct nets", () => {
    const mixed = [
      t({ segment: "index_option", netPnl: 500 }),
      t({ segment: "index_option", netPnl: -200 }),
      t({ segment: "eq_delivery", bucket: "equity", netPnl: 1000 }),
    ];
    const g = bySegment(mixed);
    expect(g.find((x) => x.key === "index_option")?.net).toBe(300);
    expect(g.find((x) => x.key === "eq_delivery")?.net).toBe(1000);
    expect(g[0].key).toBe("eq_delivery"); // sorted by net desc
  });
});

/**
 * ONE win-rate rule (wave 2O / D2).
 *
 * `groupBy` used to count wins over every closed trade in the group and divide
 * by `list.length`, while `computeKpis` skipped the unpriced ones in the
 * numerator AND the denominator — so /reports/edge printed an all-closed rate
 * beside the dashboard's priced one, and a setup whose only rows were basis-less
 * sales with positive cash read "100.0%". Cash still counts over every closed
 * trade (`net`/`gross`/`charges`); only the RATIOS are protected, and `count`
 * stays the hygiene count the "Trades" column shows.
 */
describe("groupBy counts its ratios over PRICED trades, like computeKpis", () => {
  /** A closed sale whose purchase is not in the data: real cash, no cost basis. */
  const unpriced = (p: Partial<AnalyticsTrade>) => t({ acquisition: "ipo", buyValue: 0, ...p });

  it("(1) one priced loser beside an unpriced sale — a genuine 0, not a blank", () => {
    const g = bySetup([
      t({ setupTag: "breakout", netPnl: -300, grossPnl: -250, chargesTotal: 50 }),
      unpriced({ setupTag: "breakout", netPnl: 900, grossPnl: 950, chargesTotal: 50 }),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].count).toBe(2);
    expect(g[0].pricedCount).toBe(1);
    expect(g[0].wins).toBe(0);
    expect(g[0].winRate).toBe(0);
    // Cash is unaffected by the basis: both rows count.
    expect(g[0].net).toBe(600);
    expect(g[0].pricedNet).toBe(-300);
  });

  it("(2) a group of only unpriced rows with positive cash is a BLANK, never 100%", () => {
    const g = bySetup([
      unpriced({ setupTag: "ipo-flip", netPnl: 4000, grossPnl: 4100, chargesTotal: 100 }),
      unpriced({ setupTag: "ipo-flip", netPnl: 1000, grossPnl: 1050, chargesTotal: 50 }),
    ]);
    expect(g[0].count).toBe(2);
    expect(g[0].pricedCount).toBe(0);
    expect(g[0].wins).toBe(0);
    expect(g[0].winRate).toBeNull();
    expect(g[0].net).toBe(5000);
    expect(g[0].pricedNet).toBe(0);
  });

  it("(3) the book rate over Σ pricedCount IS computeKpis's win rate, on the same rows", () => {
    const rows = [
      t({ setupTag: "breakout", netPnl: 700 }),
      t({ setupTag: "breakout", netPnl: -200 }),
      t({ setupTag: "pullback", netPnl: 500 }),
      t({ setupTag: "pullback", netPnl: -100 }),
      t({ setupTag: "pullback", netPnl: -400 }),
      unpriced({ setupTag: "ipo-flip", netPnl: 2500 }),
      t({ isOpen: true, sellDate: null, setupTag: "breakout", netPnl: 0 }),
    ];
    const g = bySetup(rows);
    const bookWins = g.reduce((s, r) => s + r.wins, 0);
    const bookCount = g.reduce((s, r) => s + r.pricedCount, 0);
    const k = computeKpis(rows);
    expect(bookCount).toBe(k.closedCount - k.unpricedCount);
    expect(bookWins).toBe(k.wins);
    expect(bookWins / bookCount).toBe(k.winRate);
    // …and every group's own count is still the hygiene count.
    expect(g.reduce((s, r) => s + r.count, 0)).toBe(k.closedCount);
    for (const r of g) expect(r.count, r.key).toBe(r.pricedCount + (r.key === "ipo-flip" ? 1 : 0));
  });

  it("(4) every group unpriced → no book rate at all, and no NaN anywhere", () => {
    const g = bySetup([unpriced({ setupTag: "a", netPnl: 100 }), unpriced({ setupTag: "b", netPnl: -100 })]);
    const bookCount = g.reduce((s, r) => s + r.pricedCount, 0);
    expect(bookCount).toBe(0);
    expect(bookCount > 0 ? 0 / bookCount : null).toBeNull();
    for (const r of g) expect(r.winRate).toBeNull();
  });

  it("excluding the pricedCount-0 rows from Benjamini-Yekutieli CHANGES the verdicts", () => {
    // /reports/edge corrects the whole table together, so m is the number of
    // rows tested. A p-value on n = 0 is not a test: leaving those rows in
    // inflated m and raised every real row's threshold out of reach.
    const rows: AnalyticsTrade[] = [];
    for (let i = 0; i < 20; i++) rows.push(t({ setupTag: "good", netPnl: i < 16 ? 100 : -100 }));
    for (let i = 0; i < 20; i++) rows.push(t({ setupTag: "bad", netPnl: i < 4 ? 100 : -100 }));
    rows.push(unpriced({ setupTag: "ipo-a", netPnl: 900 }), unpriced({ setupTag: "ipo-b", netPnl: 800 }));

    const g = bySetup(rows);
    const bookRate = g.reduce((s, r) => s + r.wins, 0) / g.reduce((s, r) => s + r.pricedCount, 0);
    expect(bookRate).toBe(0.5);
    const pFor = (r: (typeof g)[number]) => proportionPValue(r.wins, r.pricedCount, bookRate);
    expect(pFor(g.find((r) => r.key === "good")!)).toBeCloseTo(0.0139, 4);

    const all = new Map(
      benjaminiYekutieli(g.map((r) => ({ item: r.key, p: pFor(r) }))).map((c) => [c.item, c.significant]),
    );
    const priced = new Map(
      benjaminiYekutieli(
        g.filter((r) => r.pricedCount > 0).map((r) => ({ item: r.key, p: pFor(r) })),
      ).map((c) => [c.item, c.significant]),
    );
    expect(all.get("good"), "m = 4 with the two n=0 rows in: not distinguishable").toBe(false);
    expect(all.get("bad")).toBe(false);
    expect(priced.get("good"), "m = 2 once they are excluded: significant").toBe(true);
    expect(priced.get("bad")).toBe(true);
    expect(priced.size).toBe(2);
  });
});
