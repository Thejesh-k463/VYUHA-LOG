import { describe, expect, it } from "vitest";
import { classifyDirection, computeBreadth, lastPair } from "@/lib/atlas/breadth";
import type { Series } from "@/lib/atlas/types";

const DAY = 86_400_000;
const iso = (i: number) => new Date(Date.UTC(2026, 0, 5) + i * DAY).toISOString().slice(0, 10);

function series(symbol: string, closes: number[]): Series {
  return {
    symbol,
    bars: closes.map((c, i) => ({ symbol, date: iso(i), high: c, low: c, close: c, volume: 1000 })),
  };
}

describe("A1 — advance / decline / unchanged", () => {
  it("classifies a pair of closes in both directions and at equality", () => {
    expect(classifyDirection(100, 101)).toBe("advance");
    expect(classifyDirection(100, 99)).toBe("decline");
    expect(classifyDirection(100, 100)).toBe("unchanged");
  });

  it("counts each direction and publishes shares over the VALID denominator", () => {
    const universe = [
      series("UP1", [100, 101]),
      series("UP2", [100, 120]),
      series("DOWN1", [100, 99]),
      series("FLAT1", [100, 100]),
    ];
    const r = computeBreadth(universe, universe.length);
    expect(r.counts).toEqual({ advancing: 2, declining: 1, unchanged: 1, valid: 4 });
    expect(r.advancing.value_ppm).toBe(500_000);
    expect(r.declining.value_ppm).toBe(250_000);
    expect(r.unchanged.value_ppm).toBe(250_000);
    expect(r.advancing.denominator).toBe(4);
    expect(r.advancing.coverage_ppm).toBe(1_000_000);
  });

  it("a one-bar symbol is insufficient history, NOT 'unchanged'", () => {
    const universe = [series("UP1", [100, 101]), series("NEW", [100])];
    const r = computeBreadth(universe, universe.length);
    expect(r.insufficient).toEqual(["NEW"]);
    expect(r.counts).toEqual({ advancing: 1, declining: 0, unchanged: 0, valid: 1 });
    // The denominator is the symbols that could be classified, not the universe.
    expect(r.advancing.denominator).toBe(1);
    expect(r.advancing.coverage_ppm).toBe(500_000);
  });

  it("returns null, never 0, when nothing has two sessions (invariant 6)", () => {
    const universe = [series("NEW1", [100]), series("NEW2", [50])];
    const r = computeBreadth(universe, universe.length);
    expect(r.advancing.value_ppm).toBeNull();
    expect(r.advancing.denominator).toBe(0);
    expect(r.advancing.reason).toBe("insufficient_history");
  });

  it("lastPair reads the last two closes only", () => {
    expect(lastPair(series("X", [10, 20, 30]))).toEqual({ previous: 20, current: 30 });
    expect(lastPair(series("X", [10]))).toBeNull();
  });
});
