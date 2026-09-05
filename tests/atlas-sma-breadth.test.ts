import { describe, expect, it } from "vitest";
import { computeSmaBreadth, computeSmaBreadthSet, isAboveSma, smaOf } from "@/lib/atlas/sma-breadth";
import type { Series } from "@/lib/atlas/types";

const DAY = 86_400_000;
const iso = (i: number) => new Date(Date.UTC(2026, 0, 5) + i * DAY).toISOString().slice(0, 10);

function series(symbol: string, closes: number[]): Series {
  return {
    symbol,
    bars: closes.map((c, i) => ({ symbol, date: iso(i), high: c, low: c, close: c, volume: 1000 })),
  };
}

describe("A2 — % above SMA, STRICTLY above", () => {
  it("computes the mean of the last N closes only", () => {
    expect(smaOf([1, 2, 3, 4, 5], 5)).toBe(3);
    expect(smaOf([100, 1, 2, 3, 4, 5], 5)).toBe(3);
    expect(smaOf([1, 2], 5)).toBeNull();
  });

  it("equality is NOT membership", () => {
    // Five flat closes: close == SMA exactly. "At or above" would count this.
    expect(isAboveSma([100, 100, 100, 100, 100], 5)).toBe(false);
    expect(isAboveSma([100, 100, 100, 100, 100.01], 5)).toBe(true);
    expect(isAboveSma([100, 100, 100, 100, 99.99], 5)).toBe(false);
  });

  it("counts members over the symbols that HAVE the history", () => {
    const universe = [
      series("ABOVE", [10, 10, 10, 10, 20]),
      series("BELOW", [10, 10, 10, 10, 5]),
      series("FLAT", [10, 10, 10, 10, 10]),
      series("YOUNG", [10, 10]),
    ];
    const r = computeSmaBreadth(universe, 5, universe.length);
    expect(r.metric.numerator).toBe(1);
    expect(r.metric.denominator).toBe(3);
    expect(r.metric.value_ppm).toBe(333_333);
    expect(r.insufficient).toEqual(["YOUNG"]);
    expect(r.metric.coverage_ppm).toBe(750_000);
    expect(r.deepestSessions).toBe(5);
  });

  it("is null with a reason when nothing has N sessions", () => {
    const universe = [series("YOUNG", [10, 11])];
    const r = computeSmaBreadth(universe, 200, universe.length);
    expect(r.metric.value_ppm).toBeNull();
    expect(r.metric.denominator).toBe(0);
    expect(r.metric.reason).toBe("insufficient_history");
    expect(r.deepestSessions).toBe(2);
  });

  it("computes every configured period", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
    const set = computeSmaBreadthSet([series("TREND", closes)], [20, 50, 200], 1);
    expect(set[20].metric.value_ppm).toBe(1_000_000);
    expect(set[50].metric.value_ppm).toBe(1_000_000);
    expect(set[200].metric.value_ppm).toBeNull();
    expect(set[200].metric.denominator).toBe(0);
  });
});
