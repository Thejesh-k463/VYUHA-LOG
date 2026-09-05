import { describe, expect, it } from "vitest";
import { computeVolumeExpansion, volumeExpansionPpm } from "@/lib/atlas/volume";
import type { Series } from "@/lib/atlas/types";

const DAY = 86_400_000;
const iso = (i: number) => new Date(Date.UTC(2026, 0, 5) + i * DAY).toISOString().slice(0, 10);

function series(symbol: string, volumes: (number | null)[]): Series {
  return {
    symbol,
    bars: volumes.map((v, i) => ({ symbol, date: iso(i), high: 100, low: 100, close: 100, volume: v })),
  };
}

const flat = (n: number, v: number) => Array.from({ length: n }, () => v);

describe("A7 — volume expansion excludes the current bar from its own baseline", () => {
  it("a 5x day reads as 5x, not damped towards 1", () => {
    const s = series("SPIKE", [...flat(20, 1000), 5000]);
    expect(volumeExpansionPpm(s)).toBe(5_000_000);
    // Including the current bar in the baseline would give 5000 / mean(21 bars)
    // = 5000 / 1190.47… = 4.2x — a quietly wrong number with no error anywhere.
    expect(volumeExpansionPpm(s)).not.toBe(4_200_000);
  });

  it("a contracting day reads below 1", () => {
    expect(volumeExpansionPpm(series("QUIET", [...flat(20, 1000), 250]))).toBe(250_000);
  });

  it("needs 21 sessions, not 20", () => {
    expect(volumeExpansionPpm(series("SHORT", flat(20, 1000)))).toBeNull();
    expect(volumeExpansionPpm(series("JUST", [...flat(20, 1000), 1000]))).toBe(1_000_000);
  });

  it("refuses a null volume rather than treating it as zero", () => {
    const withHole = series("HOLE", [...flat(19, 1000), null, 2000]);
    expect(volumeExpansionPpm(withHole)).toBeNull();
    const nullToday = series("NOVOL", [...flat(20, 1000), null]);
    expect(volumeExpansionPpm(nullToday)).toBeNull();
  });

  it("refuses a zero baseline rather than dividing by it", () => {
    expect(volumeExpansionPpm(series("DEAD", [...flat(20, 0), 500]))).toBeNull();
  });

  it("publishes the median and the expanding share with their denominators", () => {
    const universe = [
      series("A", [...flat(20, 1000), 2000]),
      series("B", [...flat(20, 1000), 1000]),
      series("C", [...flat(20, 1000), 500]),
      series("YOUNG", flat(5, 1000)),
    ];
    const r = computeVolumeExpansion(universe, universe.length);
    expect(r.medianExpansion.value_ppm).toBe(1_000_000);
    expect(r.medianExpansion.denominator).toBe(3);
    expect(r.expandingShare.numerator).toBe(1);
    expect(r.expandingShare.value_ppm).toBe(333_333);
    expect(r.insufficient).toEqual(["YOUNG"]);
    expect(r.baselineSessions).toBe(20);
  });

  it("is null, not 0, when nothing has the baseline", () => {
    const r = computeVolumeExpansion([series("YOUNG", flat(5, 1000))], 1);
    expect(r.medianExpansion.value_ppm).toBeNull();
    expect(r.medianExpansion.reason).toBe("insufficient_history");
  });
});
