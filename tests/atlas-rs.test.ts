import { describe, expect, it } from "vitest";
import {
  anchorTurnover,
  computeRelativeStrength,
  groupRs,
  rankByValue,
  rankDelta,
  rankDeltaShortfallLine,
  rsiExtremes,
  wilderRsi,
} from "@/lib/atlas/rs";
import { detectCorporateActionGaps, symbolReturnPpm } from "@/lib/atlas/returns";
import { RS_MIN_BARS, RS_WEIGHTS, RS_WINDOWS, type Series } from "@/lib/atlas/types";

/**
 * Relative strength, RSI and rank Δ (v4.6.0 W5, AQ5 / AQ9 / AQ20 / AQ26).
 *
 * PURE: every case is arithmetic on hand-built series. The RSI figures are
 * computed BY HAND in the comments (not read back from the code) so the test
 * is a check, not an echo.
 */

const DAY = 86_400_000;
const iso = (i: number) => new Date(Date.UTC(2026, 0, 5) + i * DAY).toISOString().slice(0, 10);

function series(symbol: string, closes: number[], volume: number | null = 200_000): Series {
  return { symbol, bars: closes.map((c, i) => ({ symbol, date: iso(i), high: c, low: c, close: c, volume })) };
}
const linear = (n: number, start: number, step: number) => Array.from({ length: n }, (_, i) => start + step * i);

describe("Wilder RSI(14)", () => {
  // The classic 15-close example. Changes: -0.25 +0.06 -0.54 +0.72 +0.50 +0.27
  // +0.32 +0.42 +0.24 -0.19 +0.14 -0.42 +0.67 0.00. Gains sum 3.34 → avg 0.23857;
  // losses sum 1.40 → avg 0.10; RS 2.3857; RSI = 100 − 100/3.3857 = 70.47.
  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];

  it("matches the hand-computed first value", () => {
    expect(wilderRsi(closes)).toBeCloseTo(70.47, 1);
  });

  it("smooths the next bar Wilder's way, not as a fresh simple mean", () => {
    // Next close 46.00 (change −0.28): avg gain (0.23857×13 + 0)/14 = 0.22153;
    // avg loss (0.10×13 + 0.28)/14 = 0.11286; RS 1.9629; RSI = 66.25.
    expect(wilderRsi([...closes, 46.0])).toBeCloseTo(66.25, 1);
  });

  it("needs period + 1 closes, and is 100 / 0 at the one-sided extremes", () => {
    expect(wilderRsi(closes.slice(0, 14))).toBeNull();
    expect(wilderRsi(linear(20, 100, 1))).toBe(100);
    expect(wilderRsi(linear(20, 100, -1))).toBe(0);
    expect(wilderRsi(Array(20).fill(50))).toBe(50); // no gain, no loss: neither extreme
  });

  it("counts the extremes with a denominator and prints its thresholds", () => {
    const r = rsiExtremes(
      [series("UP", linear(20, 100, 1)), series("DOWN", linear(20, 100, -1)), series("FLAT", Array(20).fill(50)), series("YOUNG", [1, 2, 3])],
      4,
    );
    expect(r.valid).toBe(3);
    expect(r.insufficient).toEqual(["YOUNG"]);
    expect(r.low).toEqual({ value: 1, denominator: 3, coverage_ppm: 750_000 });
    expect(r.high).toEqual({ value: 1, denominator: 3, coverage_ppm: 750_000 });
    expect(r.thresholds).toEqual({ period: 14, low: 30, high: 70 });
    const none = rsiExtremes([series("YOUNG", [1, 2])], 1);
    expect(none.low.value).toBeNull();
    expect(none.low.reason).toBe("insufficient_history");
  });
});

describe("relative strength vs the cross-sectional median (AQ9 / AQ20)", () => {
  const N = RS_MIN_BARS + 2;
  const up = series("UP", linear(N, 100, 1));
  const flat = series("FLAT", Array(N).fill(100));
  const down = series("DOWN", linear(N, 100, -0.4));

  it("is Σ w_i × (r_i − median_i); the median symbol scores exactly 0", () => {
    const rs = computeRelativeStrength([up, flat, down]);
    expect(rs.eligible).toBe(3);
    expect(rs.priced).toBe(3);
    expect(rs.bySymbol.get("FLAT")!.rsPpm).toBe(0);
    for (const w of RS_WINDOWS) expect(rs.medians[String(w)]).toBe(0); // FLAT is the median in every window
    let expected = 0;
    RS_WINDOWS.forEach((w, i) => (expected += RS_WEIGHTS[i] * symbolReturnPpm(up, w)!));
    expect(rs.bySymbol.get("UP")!.rsPpm).toBe(Math.round(expected));
    expect(rs.bySymbol.get("DOWN")!.rsPpm!).toBeLessThan(0);
    expect(rs.windows).toEqual([5, 21, 63]);
    expect(rs.weights).toEqual([0.5, 0.3, 0.2]);
  });

  it("applies every floor, names the reason, and keeps the ineligible out of the median", () => {
    const cheap = series("CHEAP", linear(N, 10, 0.05)); // close < 20
    const thin = series("THIN", linear(N, 100, 1), 10); // turnover 100×10 = ₹1,000
    const noVol = series("NOVOL", linear(N, 100, 1), null);
    const young = series("YOUNG", linear(30, 100, 1));
    const rs = computeRelativeStrength([up, flat, down, cheap, thin, noVol, young]);
    expect(rs.eligible).toBe(3);
    expect(rs.priced).toBe(7);
    expect(rs.bySymbol.get("CHEAP")!.reason).toBe("below_price_floor");
    expect(rs.bySymbol.get("THIN")!.reason).toBe("below_turnover_floor");
    expect(rs.bySymbol.get("NOVOL")!.reason).toBe("no_baseline");
    expect(rs.bySymbol.get("YOUNG")!.reason).toBe("insufficient_history");
    for (const s of ["CHEAP", "THIN", "NOVOL", "YOUNG"]) expect(rs.bySymbol.get(s)!.rsPpm).toBeNull();
    // The median is still FLAT's 0: four ineligible up-movers did not drag it.
    expect(rs.medians["21"]).toBe(0);
    expect(rs.ineligible).toEqual({ below_price_floor: 1, below_turnover_floor: 1, no_baseline: 1, insufficient_history: 1 });
    expect(rs.floors).toEqual({ minTurnoverRupees: 10_000_000, minPrice: 20, minBars: 64 });
  });

  it("drops a symbol with a corporate-action gap inside the 63-session span", () => {
    const closes = linear(N, 500, 0);
    for (let i = N - 10; i < N; i++) closes[i] = 100; // a 1:5 split ten sessions back
    const split = series("SPLIT", closes);
    const gaps = new Map([["SPLIT", detectCorporateActionGaps(split)]]);
    expect(gaps.get("SPLIT")).toHaveLength(1);
    const rs = computeRelativeStrength([up, flat, down, split], {}, gaps);
    expect(rs.bySymbol.get("SPLIT")!.reason).toBe("corporate_action_unreconciled");
    expect(rs.eligible).toBe(3);
    // Without the map the split would have been "eligible" and printed as −80% RS.
    expect(computeRelativeStrength([up, flat, down, split]).bySymbol.get("SPLIT")!.eligible).toBe(true);
  });

  it("anchor turnover is close × volume of the LAST bar, null without a volume", () => {
    expect(anchorTurnover(series("A", [1, 2, 50], 1000))).toBe(50_000);
    expect(anchorTurnover(series("A", [1, 2, 50], null))).toBeNull();
  });
});

describe("group RS and the AQ26 floors", () => {
  const N = RS_MIN_BARS + 2;
  const members = [1, 2, 3, 4, 5].map((k) => series(`M${k}`, linear(N, 100, k * 0.2)));

  it("is the MEDIAN of member rs over the members that carry one", () => {
    const rs = computeRelativeStrength(members);
    const m = groupRs(members, rs);
    expect(m.denominator).toBe(5);
    expect(m.value_ppm).toBe(rs.bySymbol.get("M3")!.rsPpm); // the middle mover
    expect(m.coverage_ppm).toBe(1_000_000);
  });

  it("is null with insufficient_members under three eligible members", () => {
    const rs = computeRelativeStrength(members);
    const two = groupRs(members.slice(0, 2), rs);
    expect(two.value_ppm).toBeNull();
    expect(two.reason).toBe("insufficient_members");
    expect(two.denominator).toBe(2);
  });
});

describe("rank Δ (design review A1)", () => {
  it("ranks 1 = highest, ties by name, and leaves a null value unranked", () => {
    const r = rankByValue([
      { group: "B", value: 10 },
      { group: "A", value: 10 },
      { group: "C", value: 50 },
      { group: "D", value: null },
    ]);
    expect([...r.entries()]).toEqual([["C", 1], ["A", 2], ["B", 3]]);
  });

  it("is past − current (positive = climbed) and null — never 0 — for a group the past did not rank", () => {
    const today = rankByValue([{ group: "A", value: 3 }, { group: "B", value: 2 }, { group: "NEW", value: 1 }]);
    const past = rankByValue([{ group: "B", value: 3 }, { group: "A", value: 2 }]);
    expect(Object.fromEntries(rankDelta(today, past))).toEqual({ A: 1, B: -1, NEW: null });
    expect([...rankDelta(today, null).values()]).toEqual([null, null, null]);
  });

  it("prints the shortfall in DAILY SNAPSHOTS, never sessions", () => {
    const line = rankDeltaShortfallLine(4, 21);
    expect(line).toBe("rank Δ needs 21 daily snapshots under this formula set; you have 4 (one is written each day Atlas is opened with new bars)");
    expect(line).not.toMatch(/stored sessions/);
  });
});
