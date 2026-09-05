import { describe, expect, it } from "vitest";
import {
  classificationCoverage,
  computeGroupBreadth,
  computeGroupReturns,
  groupBySector,
} from "@/lib/atlas/groups";
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

  it("A8 is the equal-weighted mean of VALID constituents, with count and coverage", () => {
    const rows = computeGroupReturns(groupBySector(universe, sectorOf), { key: "1d", sessions: 1 });
    const banks = rows.find((r) => r.group === "Banks")!;
    expect(banks.metric.value_ppm).toBe(150_000); // mean(+10%, +20%)
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
});
