import { describe, expect, it } from "vitest";
import {
  computeReturns,
  computeYtd,
  detectCorporateActionGaps,
  gapInWindow,
  marketMoveByDate,
  symbolReturnPpm,
  symbolYtd,
} from "@/lib/atlas/returns";
import type { Series } from "@/lib/atlas/types";

const DAY = 86_400_000;
const iso = (i: number, base = Date.UTC(2026, 0, 5)) => new Date(base + i * DAY).toISOString().slice(0, 10);

function series(symbol: string, closes: number[], base?: number): Series {
  return {
    symbol,
    bars: closes.map((c, i) => ({ symbol, date: iso(i, base), high: c, low: c, close: c, volume: 1000 })),
  };
}

describe("A5 — Return(N) and its denominator", () => {
  it("is close[t]/close[t-N] - 1 in ppm, both signs", () => {
    expect(symbolReturnPpm(series("UP", [100, 0, 0, 0, 0, 110]), 5)).toBe(100_000);
    expect(symbolReturnPpm(series("DOWN", [100, 0, 0, 0, 0, 90]), 5)).toBe(-100_000);
  });

  it("needs N+1 valid closes — N closes is not enough", () => {
    expect(symbolReturnPpm(series("FIVE", [1, 2, 3, 4, 5]), 5)).toBeNull();
    expect(symbolReturnPpm(series("SIX", [100, 1, 1, 1, 1, 105]), 5)).toBe(50_000);
    expect(symbolReturnPpm(series("ZEROBASE", [0, 1, 1, 1, 1, 105]), 5)).toBeNull();
  });

  it("counts only symbols with N+1 closes in the denominator", () => {
    const universe = [
      series("A", [100, 1, 1, 1, 1, 110]), // +10%
      series("B", [100, 1, 1, 1, 1, 90]), // -10%
      series("YOUNG", [100, 105]),
    ];
    const r = computeReturns(universe, universe.length, new Map(), [{ key: "1w", sessions: 5 }]);
    expect(r["1w"].metric.denominator).toBe(2);
    expect(r["1w"].metric.value_ppm).toBe(0);
    expect(r["1w"].insufficient).toEqual(["YOUNG"]);
    expect(r["1w"].metric.coverage_ppm).toBe(666_667);
  });

  it("is null with a reason when no symbol qualifies", () => {
    const r = computeReturns([series("YOUNG", [100, 105])], 1, new Map(), [{ key: "3m", sessions: 63 }]);
    expect(r["3m"].metric.value_ppm).toBeNull();
    expect(r["3m"].metric.denominator).toBe(0);
    expect(r["3m"].metric.reason).toBe("insufficient_history");
  });
});

describe("A6 — YTD and which anchor it used", () => {
  const dec31 = Date.UTC(2025, 11, 29); // 29, 30, 31 Dec then January

  it("prefers the last completed close BEFORE the calendar year", () => {
    const s = series("A", [100, 101, 200, 220], dec31); // 31 Dec close = 200? no: index 2 is 31 Dec
    const ytd = symbolYtd(s, 2026);
    expect(ytd).toEqual({ value_ppm: 100_000, anchorKind: "prior_year_close", anchorDate: "2025-12-31" });
  });

  it("falls back to the first close OF the year and says so", () => {
    const s = series("B", [100, 110], Date.UTC(2026, 0, 2));
    const ytd = symbolYtd(s, 2026);
    expect(ytd).toEqual({ value_ppm: 100_000, anchorKind: "first_close_of_year", anchorDate: "2026-01-02" });
  });

  it("publishes how many symbols used each anchor rule", () => {
    const universe = [series("A", [100, 101, 200, 220], dec31), series("B", [100, 110], Date.UTC(2026, 0, 2))];
    const r = computeYtd(universe, 2026, universe.length);
    expect(r.anchorKinds).toEqual({ prior_year_close: 1, first_close_of_year: 1 });
    expect(r.metric.denominator).toBe(2);
    expect(r.metric.value_ppm).toBe(100_000);
  });
});

describe("the corporate-action guard", () => {
  it("flags a 1:5 split gap and reports its size", () => {
    const split = series("SPLIT", [500, 500, 100, 101]);
    const gaps = detectCorporateActionGaps(split);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].ratioPpm).toBe(-800_000);
    expect(gaps[0].date).toBe(iso(2));
  });

  it("does NOT flag an ordinary move below the threshold", () => {
    expect(detectCorporateActionGaps(series("NORMAL", [100, 130, 100]))).toEqual([]);
  });

  it("does NOT flag a move the whole market made — that is a market event, not a split", () => {
    const market = new Map([[iso(2), -900_000]]);
    expect(detectCorporateActionGaps(series("CRASH", [500, 500, 50]), { marketMovePpmByDate: market })).toEqual([]);
    // the same symbol with a quiet market IS flagged
    expect(detectCorporateActionGaps(series("CRASH", [500, 500, 50]))).toHaveLength(1);
  });

  it("computes the market baseline as the median move per session", () => {
    const universe = [series("A", [100, 50]), series("B", [100, 50]), series("C", [100, 200])];
    expect(marketMoveByDate(universe).get(iso(1))).toBe(-500_000);
  });

  it("only excludes the windows the gap actually falls inside", () => {
    // Gap on session 1 of a 7-session series: inside the 5-session window? no.
    const s = series("SPLIT", [500, 100, 101, 102, 103, 104, 105]);
    const gaps = detectCorporateActionGaps(s);
    expect(gaps).toHaveLength(1);
    expect(gapInWindow(s, 5, gaps)).toBe(false);
    expect(gapInWindow(s, 6, gaps)).toBe(true);
  });

  it("drops a flagged symbol from the return window and keeps the denominator honest", () => {
    const universe = [
      series("A", [100, 1, 1, 1, 1, 110]),
      series("SPLIT", [500, 1, 1, 1, 1, 100]),
    ];
    const gaps = new Map([["SPLIT", detectCorporateActionGaps(universe[1])]]);
    const r = computeReturns(universe, universe.length, gaps, [{ key: "1w", sessions: 5 }]);
    expect(r["1w"].corporateActionExcluded).toEqual(["SPLIT"]);
    expect(r["1w"].metric.denominator).toBe(1);
    expect(r["1w"].metric.value_ppm).toBe(100_000);
  });

  it("drops a flagged symbol from YTD over the same span", () => {
    const base = Date.UTC(2025, 11, 31);
    const universe = [series("SPLIT", [500, 100, 101], base)];
    const gaps = new Map([["SPLIT", detectCorporateActionGaps(universe[0])]]);
    const r = computeYtd(universe, 2026, 1, gaps);
    expect(r.corporateActionExcluded).toEqual(["SPLIT"]);
    expect(r.metric.value_ppm).toBeNull();
  });
});
