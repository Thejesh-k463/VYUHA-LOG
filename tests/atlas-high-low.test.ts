import { describe, expect, it } from "vitest";
import { computeHighLow, highLowLabel, symbolHighLow } from "@/lib/atlas/high-low";
import type { Series } from "@/lib/atlas/types";

const DAY = 86_400_000;
const iso = (i: number) => new Date(Date.UTC(2026, 0, 5) + i * DAY).toISOString().slice(0, 10);

function series(symbol: string, closes: number[]): Series {
  return {
    symbol,
    bars: closes.map((c, i) => ({ symbol, date: iso(i), high: c, low: c, close: c, volume: 1000 })),
  };
}

const flat = (n: number, v = 100) => Array.from({ length: n }, () => v);

describe("A3 / A4 — new 52w highs and lows", () => {
  it("flags a new high and a new low over the window", () => {
    const up = symbolHighLow(series("UP", [...flat(24), 150]));
    expect(up).toMatchObject({ isHigh: true, isLow: false, sessions: 25 });
    const down = symbolHighLow(series("DOWN", [...flat(24), 50]));
    expect(down).toMatchObject({ isHigh: false, isLow: true });
  });

  it("does NOT flag a bar inside the range", () => {
    const inside = symbolHighLow(series("MID", [90, 110, ...flat(22), 100]));
    expect(inside).toMatchObject({ isHigh: false, isLow: false });
  });

  it("refuses an opinion under 20 sessions", () => {
    expect(symbolHighLow(series("YOUNG", [...flat(18), 150]))).toBeNull();
    expect(symbolHighLow(series("JUST", [...flat(19), 150]))).toMatchObject({ isHigh: true, sessions: 20 });
  });

  it("caps the window at 252 sessions, so an older peak does not block a new high", () => {
    // A 999 print 300 sessions ago is OUTSIDE a 252-session window.
    const closes = [999, ...flat(299), 150];
    const capped = symbolHighLow(series("OLD", closes));
    expect(capped).toMatchObject({ isHigh: true, sessions: 252 });
    const uncapped = symbolHighLow(series("OLD", closes), { lookback: 1000 });
    expect(uncapped).toMatchObject({ isHigh: false });
  });

  it("only a full 252-session window may be labelled 52w", () => {
    expect(highLowLabel(252)).toBe("52w");
    expect(highLowLabel(251)).toBe("251d");
    expect(highLowLabel(43)).toBe("43d");
    const shallow = computeHighLow([series("A", [...flat(29), 150])], 1);
    expect(shallow.label).toBe("30d");
  });

  it("nets highs against lows over one denominator", () => {
    const universe = [
      series("H1", [...flat(24), 150]),
      series("H2", [...flat(24), 160]),
      series("L1", [...flat(24), 40]),
      series("YOUNG", [100, 101]),
    ];
    const r = computeHighLow(universe, universe.length);
    expect(r.counts).toEqual({ highs: 2, lows: 1, valid: 3 });
    expect(r.netHighLow.value).toBe(1);
    expect(r.netHighLow.denominator).toBe(3);
    expect(r.newHighs.value_ppm).toBe(666_667);
    expect(r.insufficient).toEqual(["YOUNG"]);
  });

  it("is null, not 0, when no symbol has 20 sessions", () => {
    const r = computeHighLow([series("YOUNG", [100, 101])], 1);
    expect(r.newHighs.value_ppm).toBeNull();
    expect(r.netHighLow.value).toBeNull();
    expect(r.netHighLow.reason).toBe("insufficient_history");
  });
});
