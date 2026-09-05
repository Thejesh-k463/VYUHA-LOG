import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHANDELIER_ATR_MULT_PERMILLE,
  initTrail,
  runTrail,
  trailSuggestions,
  updateTrail,
  type TrailBar,
} from "@/lib/live/trail";
import { wilderAtrSeriesP3 } from "@/lib/live/tracker-row";
import type { Bar } from "@/lib/live/types";

/**
 * Trailing levels — 03 §5, spec §4.3. Integer paise.
 *
 * Three properties, each proven rather than asserted in a comment:
 *   1. MONOTONE under a SHUFFLED bar sequence (the max/min is enforced once);
 *   2. IDEMPOTENT for a repeated bar;
 *   3. it reads the PREVIOUS bar's ATR, never the current bar's — the one
 *      property that passes on backfilled data and fails live if it is wrong.
 */

const day = (i: number) => `2026-0${Math.floor(i / 28) + 1}-${String((i % 28) + 1).padStart(2, "0")}`;

const tbar = (i: number, closeP: number, over: Partial<TrailBar> = {}): TrailBar => ({
  date: day(i),
  highP: over.highP ?? closeP,
  lowP: over.lowP ?? closeP,
  closeP,
  atrP3Prev: over.atrP3Prev ?? 1_000_000, // 1_000 paise of ATR
  maPrev: over.maPrev ?? null,
});

const bar = (i: number, closeP: number, o: Partial<Bar> = {}): Bar => ({
  date: day(i),
  openP: o.openP ?? closeP,
  highP: o.highP ?? closeP,
  lowP: o.lowP ?? closeP,
  closeP,
  volume: o.volume ?? 1_000,
});

describe("updateTrail — monotonicity", () => {
  it("a long's level never falls, whatever order the bars arrive in", () => {
    const bars = [10_000, 12_000, 9_000, 15_000, 11_000, 8_000, 14_000].map((c, i) => tbar(i, c));
    for (const order of [bars, [...bars].reverse(), [bars[3], bars[0], bars[5], bars[1], bars[6], bars[2], bars[4]]]) {
      let state = initTrail("long", 10_000, "chandelier", { chandelierBars: 3 });
      let prev = -Infinity;
      for (const b of order) {
        state = updateTrail(state, b);
        if (state.levelP !== null) {
          expect(state.levelP).toBeGreaterThanOrEqual(prev);
          prev = state.levelP;
        }
      }
    }
  });

  it("a short's level never rises, whatever order the bars arrive in", () => {
    const bars = [10_000, 12_000, 9_000, 15_000, 11_000, 8_000, 14_000].map((c, i) => tbar(i, c));
    for (const order of [bars, [...bars].reverse()]) {
      let state = initTrail("short", 10_000, "chandelier", { chandelierBars: 3 });
      let prev = Infinity;
      for (const b of order) {
        state = updateTrail(state, b);
        if (state.levelP !== null) {
          expect(state.levelP).toBeLessThanOrEqual(prev);
          prev = state.levelP;
        }
      }
    }
  });

  it("the ratchet holds when price falls back: the level stays where it got to", () => {
    const state = runTrail(initTrail("long", 10_000, "chandelier", { chandelierBars: 3 }), [
      tbar(0, 10_000, { highP: 10_000 }),
      tbar(1, 20_000, { highP: 20_000 }),
      tbar(2, 10_500, { highP: 10_500 }),
      tbar(3, 10_100, { highP: 10_100 }),
    ]);
    expect(state.levelP).toBe(20_000 - 3_000); // the 20_000 high, less 3 × 1_000 ATR
  });
});

describe("updateTrail — idempotence", () => {
  it("replaying the SAME session changes nothing", () => {
    const b = tbar(1, 20_000, { highP: 20_000 });
    const once = updateTrail(initTrail("long", 10_000, "chandelier"), b);
    const twice = updateTrail(once, b);
    expect(twice).toBe(once); // same object: nothing was recomputed
    expect(twice.barsSeen).toBe(1);
  });

  it("replaying it ten times gives the identical level and bar count", () => {
    let s = initTrail("long", 10_000, "chandelier");
    s = updateTrail(s, tbar(0, 10_000, { highP: 10_000 }));
    const after = updateTrail(s, tbar(1, 20_000, { highP: 20_000 }));
    let repeated = after;
    for (let i = 0; i < 10; i++) repeated = updateTrail(repeated, tbar(1, 20_000, { highP: 20_000 }));
    expect(repeated.levelP).toBe(after.levelP);
    expect(repeated.barsSeen).toBe(after.barsSeen);
  });
});

describe("trailSuggestions — it reads the PREVIOUS bar's ATR", () => {
  /**
   * The discriminating experiment. Two identical 40-session series; in the
   * second, the LAST bar's high is raised by ₹50.00. The chandelier level must
   * move by exactly that ₹50.00, because the ATR term comes from the bar
   * BEFORE and cannot have changed. An implementation that used the current
   * bar's ATR would widen the ATR term (that last bar's true range exploded)
   * and the level would move by less — or, once the monotone clamp caught it,
   * not at all.
   */
  it("raising the last bar's high moves the level by exactly that amount", () => {
    const base: Bar[] = Array.from({ length: 40 }, (_, i) => bar(i, 10_000, { highP: 10_050, lowP: 9_950 }));
    const raised = base.map((b, i) => (i === base.length - 1 ? { ...b, highP: b.highP! + 5_000 } : b));

    const common = { side: "long" as const, entryP: 10_000, currentStopP: null, riskPerShareP: null, qty: 0, chandelierBars: 22, atrLength: 22 };
    const a = trailSuggestions({ ...common, bars: base }).chandelier.levelP;
    const b = trailSuggestions({ ...common, bars: raised }).chandelier.levelP;

    expect(a).not.toBeNull();
    expect(b! - a!).toBe(5_000);
  });

  it("the ATR used is the series value at index t−1, to the paise", () => {
    const bars: Bar[] = Array.from({ length: 40 }, (_, i) => bar(i, 10_000, { highP: 10_050, lowP: 9_950 }));
    const atr = wilderAtrSeriesP3(bars, 22);
    const prevAtr = atr[bars.length - 2]!;
    const level = trailSuggestions({
      side: "long",
      entryP: 10_000,
      bars,
      currentStopP: null,
      riskPerShareP: null,
      qty: 0,
      chandelierBars: 22,
      atrLength: 22,
    }).chandelier.levelP;
    // Highest high of the window is 10_050 throughout; offset = atr × 3.0.
    expect(level).toBe(10_050 - Math.floor((prevAtr * DEFAULT_CHANDELIER_ATR_MULT_PERMILLE) / 1_000_000));
  });

  it("is null — not 0 — when there is too little history for an ATR", () => {
    const bars: Bar[] = Array.from({ length: 5 }, (_, i) => bar(i, 10_000));
    const s = trailSuggestions({ side: "long", entryP: 10_000, bars, currentStopP: null, riskPerShareP: null, qty: 0 });
    expect(s.chandelier.levelP).toBeNull();
    expect(s.ma.levelP).toBeNull();
    expect(s.chandelier.sessions).toBe(5);
  });
});

describe("trailSuggestions — the MA trail", () => {
  it("uses the 21-session mean as of the previous bar", () => {
    const bars: Bar[] = Array.from({ length: 30 }, (_, i) => bar(i, 10_000));
    const s = trailSuggestions({ side: "long", entryP: 10_000, bars, currentStopP: null, riskPerShareP: null, qty: 0, maLength: 21 });
    expect(s.ma.levelP).toBe(10_000);
    expect(s.ma.params.maLength).toBe(21);
  });

  it("says whether the level is beyond the stop in force, and null when there is none", () => {
    const bars: Bar[] = Array.from({ length: 30 }, (_, i) => bar(i, 10_000));
    expect(trailSuggestions({ side: "long", entryP: 10_000, bars, currentStopP: 9_000, riskPerShareP: null, qty: 0 }).ma.beyondCurrentStop).toBe(true);
    expect(trailSuggestions({ side: "long", entryP: 10_000, bars, currentStopP: 11_000, riskPerShareP: null, qty: 0 }).ma.beyondCurrentStop).toBe(false);
    expect(trailSuggestions({ side: "long", entryP: 10_000, bars, currentStopP: null, riskPerShareP: null, qty: 0 }).ma.beyondCurrentStop).toBeNull();
  });
});

describe("trailSuggestions — the R ladder", () => {
  const bars: Bar[] = Array.from({ length: 30 }, (_, i) => bar(i, 12_500));

  it("is NULL, not an empty ladder, when risk per share is unknown", () => {
    const s = trailSuggestions({ side: "long", entryP: 10_000, bars, currentStopP: null, riskPerShareP: null, qty: 99 });
    expect(s.rLadder).toBeNull();
  });

  it("places a third of the quantity at 1R, 2R and 3R", () => {
    const s = trailSuggestions({ side: "long", entryP: 10_000, bars, currentStopP: null, riskPerShareP: 1_000, qty: 99 });
    expect(s.rLadder!.map((x) => x.priceP)).toEqual([11_000, 12_000, 13_000]);
    expect(s.rLadder!.map((x) => x.qty)).toEqual([33, 33, 33]);
  });

  it("gives the remainder to the last step, so the steps sum to the whole position", () => {
    const s = trailSuggestions({ side: "long", entryP: 10_000, bars, currentStopP: null, riskPerShareP: 1_000, qty: 100 });
    expect(s.rLadder!.map((x) => x.qty)).toEqual([33, 33, 34]);
    expect(s.rLadder!.reduce((a, x) => a + x.qty, 0)).toBe(100);
  });

  it("marks the steps the latest close has already traded through", () => {
    const s = trailSuggestions({ side: "long", entryP: 10_000, bars, currentStopP: null, riskPerShareP: 1_000, qty: 99 });
    expect(s.rLadder!.map((x) => x.reached)).toEqual([true, true, false]); // last close 12_500
  });

  it("mirrors for shorts: the ladder steps DOWN from entry", () => {
    const s = trailSuggestions({ side: "short", entryP: 10_000, bars, currentStopP: null, riskPerShareP: 1_000, qty: 99 });
    expect(s.rLadder!.map((x) => x.priceP)).toEqual([9_000, 8_000, 7_000]);
  });
});
