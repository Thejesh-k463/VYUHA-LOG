import { describe, expect, it } from "vitest";
import {
  classificationCoverage,
  computeGroupBreadth,
  computeGroupReturns,
  computeGroupTable,
  groupBySector,
  turnoverOf,
  turnoverShare,
  volumeSplit,
} from "@/lib/atlas/groups";
import { computeRelativeStrength } from "@/lib/atlas/rs";
import type { SectorRef, Series } from "@/lib/atlas/types";

const DAY = 86_400_000;
const iso = (i: number) => new Date(Date.UTC(2026, 0, 5) + i * DAY).toISOString().slice(0, 10);

function series(symbol: string, closes: number[]): Series {
  return {
    symbol,
    bars: closes.map((c, i) => ({ symbol, date: iso(i), high: c, low: c, close: c, volume: 1000 })),
  };
}

const MAP: Record<string, SectorRef> = {
  HDFCBANK: { sector: "Banks", tier: "high", source: "taxonomy" },
  ICICIBANK: { sector: "Banks", tier: "high", source: "taxonomy" },
  KOTAKBANK: { sector: "Banks", tier: "index", source: "index" },
  SUNPHARMA: { sector: "Pharma", tier: "user", source: "user" },
};
const sectorOf = (symbol: string): SectorRef | null => MAP[symbol] ?? null;

const universe = [
  series("HDFCBANK", [100, 110]), // +10%
  series("ICICIBANK", [100, 120]), // +20%
  series("KOTAKBANK", [100]), // no direction, no return
  series("SUNPHARMA", [100, 90]), // -10%
  series("UNKNOWNCO", [100, 105]),
];

describe("A8 / A9 / A12 — groups by resolved sector", () => {
  it("groups by the caller's resolution and lists the unclassified", () => {
    const g = groupBySector(universe, sectorOf);
    expect(g.groups.map((x) => x.group)).toEqual(["Banks", "Pharma"]);
    expect(g.groups[0].members.map((m) => m.symbol)).toEqual(["HDFCBANK", "ICICIBANK", "KOTAKBANK"]);
    expect(g.groups[0].tiers).toEqual({ high: 2, index: 1 });
    expect(g.unclassified).toEqual(["UNKNOWNCO"]);
  });

  it("A8 is the MEDIAN (every member counts once) of VALID constituents (AQ18), with count and coverage", () => {
    const rows = computeGroupReturns(groupBySector(universe, sectorOf), { key: "1d", sessions: 1 });
    const banks = rows.find((r) => r.group === "Banks")!;
    expect(banks.metric.value_ppm).toBe(150_000); // median(+10%, +20%) — the median of two IS their mean
    expect(banks.constituents).toBe(2);
    expect(banks.members).toBe(3);
    expect(banks.metric.coverage_ppm).toBe(666_667);
    expect(banks.insufficient).toEqual(["KOTAKBANK"]);
    const pharma = rows.find((r) => r.group === "Pharma")!;
    expect(pharma.metric.value_ppm).toBe(-100_000);
    expect(pharma.constituents).toBe(1);
  });

  it("A8 is not weighted by price — a big number does not outvote a small one", () => {
    const twoSizes = [series("HDFCBANK", [1000, 1100]), series("ICICIBANK", [10, 12])];
    const rows = computeGroupReturns(groupBySector(twoSizes, sectorOf), { key: "1d", sessions: 1 });
    expect(rows[0].metric.value_ppm).toBe(150_000); // mean(+10%, +20%), not price-weighted
  });

  it("A9 is advancing over valid constituents, per group", () => {
    const rows = computeGroupBreadth(groupBySector(universe, sectorOf));
    const banks = rows.find((r) => r.group === "Banks")!;
    expect(banks.advancing.numerator).toBe(2);
    expect(banks.advancing.denominator).toBe(2);
    expect(banks.advancing.value_ppm).toBe(1_000_000);
    expect(banks.members).toBe(3);
    const pharma = rows.find((r) => r.group === "Pharma")!;
    expect(pharma.advancing.value_ppm).toBe(0);
    expect(pharma.breadth.counts.declining).toBe(1);
  });

  it("A12 publishes classification coverage and where it came from", () => {
    const g = groupBySector(universe, sectorOf);
    const cov = classificationCoverage(g, universe.length);
    expect(cov.classified.numerator).toBe(4);
    expect(cov.classified.denominator).toBe(5);
    expect(cov.classified.value_ppm).toBe(800_000);
    expect(cov.groups).toBe(2);
    expect(cov.tiers).toEqual({ high: 2, index: 1, user: 1 });
    expect(cov.unclassified).toEqual(["UNKNOWNCO"]);
  });

  it("nothing classified is 0% of a real universe, but an EMPTY universe is null", () => {
    const g = groupBySector([series("UNKNOWNCO", [100, 105])], sectorOf);
    const cov = classificationCoverage(g, 1);
    expect(cov.classified.value_ppm).toBe(0);
    expect(cov.classified.denominator).toBe(1);
    expect(cov.groups).toBe(0);
    expect(computeGroupReturns(g, { key: "1d", sessions: 1 })).toEqual([]);

    const empty = classificationCoverage(groupBySector([], sectorOf), 0);
    expect(empty.classified.value_ppm).toBeNull();
    expect(empty.classified.reason).toBe("empty_denominator");
  });

  it("the statistic is a parameter: median and mean differ on three constituents, and mean is never the silent default", () => {
    const three = [series("HDFCBANK", [100, 110]), series("ICICIBANK", [100, 120]), series("KOTAKBANK", [100, 160])];
    const g = groupBySector(three, sectorOf);
    expect(computeGroupReturns(g, { key: "1d", sessions: 1 })[0].metric.value_ppm).toBe(200_000); // median(+10, +20, +60)
    expect(computeGroupReturns(g, { key: "1d", sessions: 1 }, new Map(), "median")[0].metric.value_ppm).toBe(200_000);
    expect(computeGroupReturns(g, { key: "1d", sessions: 1 }, new Map(), "mean")[0].metric.value_ppm).toBe(300_000); // mean = +30%
  });
});

describe("v4.6.0 W5 — the breadth family per group (AQ5 / AQ8) and the two volume shares (AQ9)", () => {
  const N = 66;
  const walk = (start: number, step: number, n = N) => Array.from({ length: n }, (_, i) => start + step * i);
  // From 1,000 so the steepest faller (−4 × 65) stays well above zero.
  const bank = (sym: string, step: number, volume = 200_000): Series => ({
    symbol: sym,
    bars: walk(1000, step).map((c, i) => ({ symbol: sym, date: iso(i), high: c, low: c, close: c, volume })),
  });
  const big = ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9"].map((s, i) => bank(s, i - 4)); // slopes −4 … +4
  const two = [bank("P1", 1), bank("P2", -1, 50_000)];
  const refs: Record<string, SectorRef> = {};
  for (const b of big) refs[b.symbol] = { sector: "Banks", tier: "high" };
  for (const p of two) refs[p.symbol] = { sector: "Pharma", tier: "high" };
  const all = [...big, ...two];
  const grouping = groupBySector(all, (s) => refs[s] ?? null);
  const ctx = {
    gapsBySymbol: new Map(),
    windows: [{ key: "1w" as const, sessions: 5 }, { key: "1m" as const, sessions: 21 }],
    year: 2026,
    smaPeriods: [20, 50] as const,
    volumeBaseline: 20,
    rs: computeRelativeStrength(all),
    universeTurnoverRupees: turnoverOf(all).rupees,
    statistic: "median" as const,
  };

  it("computes at 3 members, ranks at 8 (AQ26), and persists median AND mean per window", () => {
    const rows = computeGroupTable(grouping, ctx);
    const banks = rows.find((r) => r.group === "Banks")!;
    const pharma = rows.find((r) => r.group === "Pharma")!;
    expect(banks.members).toBe(9);
    expect(banks.priced).toBe(9);
    expect(banks.computable).toBe(true);
    expect(banks.rankable).toBe(true);
    expect(banks.returns["1m"].median.value_ppm).toBe(0); // the middle bank is flat
    // The mean is NOT 0: close[t]/close[t−21] − 1 is not antisymmetric in the
    // slope, which is exactly why the two statistics are both persisted (AQ18).
    expect(banks.returns["1m"].mean.value_ppm).not.toBeNull();
    expect(banks.returns["1m"].mean.denominator).toBe(9);
    expect(banks.returns["1m"].mean.value_ppm).not.toBe(banks.returns["1m"].median.value_ppm);
    expect(banks.returns["1w"].constituents).toBe(9);
    expect(pharma.members).toBe(2);
    expect(pharma.computable).toBe(false);
    expect(pharma.rankable).toBe(false);
    expect(pharma.returns["1m"].median.value_ppm).toBeNull();
    expect(pharma.returns["1m"].median.reason).toBe("insufficient_members");
    expect(pharma.rs.reason).toBe("insufficient_members");
    expect(pharma.turnoverShare.reason).toBe("insufficient_members");
  });

  it("carries the whole family per group with each figure's own denominator", () => {
    const banks = computeGroupTable(grouping, ctx).find((r) => r.group === "Banks")!;
    expect(banks.breadth.counts).toEqual({ advancing: 4, declining: 4, unchanged: 1, valid: 9 });
    expect(banks.aboveSma[20].denominator).toBe(9);
    expect(banks.aboveSma[20].numerator).toBe(4); // the four risers are above their SMA20
    expect(banks.aboveSma[50].denominator).toBe(9);
    // Four risers at a 66-session high, four fallers at a low — and the FLAT
    // bank is both (last >= max AND last <= min), as high-low.ts defines it.
    expect(banks.newHighs.numerator).toBe(5);
    expect(banks.newLows.numerator).toBe(5);
    expect(banks.netHighLow.value).toBe(0);
    expect(banks.atHighShare.value_ppm).toBe(555_556);
    expect(banks.highLowLabel).toBe("66d");
    expect(banks.rsiThresholds).toEqual({ period: 14, low: 30, high: 70 });
    expect(banks.rsiHigh.value).toBe(4);
    expect(banks.rsiLow.value).toBe(4);
    expect(banks.rs.denominator).toBeGreaterThanOrEqual(3);
    expect(banks.ytd.median.value_ppm).not.toBeNull();
    expect(banks.ytd.mean.value_ppm).not.toBeNull();
    expect(banks.volumeExpansion.value_ppm).toBe(1_000_000); // flat volume: exactly the baseline
    expect(banks.volumeAdvancingShare.value_ppm).toBe(500_000); // equal volumes, four up four down
    // Turnover share: 9 of 11 symbols at 200,000 volume, one of the two others at 50,000.
    expect(banks.turnoverShare.numerator).toBe(Math.round(turnoverOf(big).rupees));
    expect(banks.turnoverShare.denominator).toBe(Math.round(turnoverOf(all).rupees));
    expect(banks.turnoverShare.coverage_ppm).toBe(1_000_000);
  });

  it("volume split: Σ volume of advancers over Σ of advancers + decliners; unchanged carries no side; no volume is NAMED", () => {
    const split = volumeSplit(
      [bank("UP", 1, 300_000), bank("DOWN", -1, 100_000), bank("FLAT", 0, 5_000_000), bank("NOVOL", 1, null as unknown as number)],
      4,
    );
    expect(split.advancingVolume).toBe(300_000);
    expect(split.decliningVolume).toBe(100_000);
    expect(split.advancingShare.value_ppm).toBe(750_000);
    expect(split.advancingShare.numerator).toBe(300_000);
    expect(split.advancingShare.denominator).toBe(400_000);
    expect(split.valid).toBe(2);
    expect(split.noVolume).toEqual(["NOVOL"]);
    expect(volumeSplit([bank("FLAT", 0)], 1).advancingShare.value_ppm).toBeNull();
  });

  it("turnover share is rupees over rupees on the anchor bar, coverage = members with a volume", () => {
    const share = turnoverShare(two, turnoverOf(all).rupees);
    const last = (s: Series) => s.bars[s.bars.length - 1];
    const twoRupees = last(two[0]).close * 200_000 + last(two[1]).close * 50_000;
    expect(share.numerator).toBe(Math.round(twoRupees));
    expect(share.value_ppm).toBe(Math.round((twoRupees * 1_000_000) / turnoverOf(all).rupees));
    expect(turnoverShare([bank("NOVOL", 1, null as unknown as number)], 1_000).reason).toBe("no_baseline");
    expect(turnoverShare(two, 0).reason).toBe("empty_denominator");
  });
});
