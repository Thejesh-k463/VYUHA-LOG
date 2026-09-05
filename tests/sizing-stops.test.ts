import { describe, it, expect } from "vitest";
import {
  stopAtr,
  stopStructure,
  stopPercent,
  roundTickAwayFromEntry,
  circuitBandFlag,
  tickSizeForPrice,
  tickRevisionOn,
  stopDistanceInNPermille,
  validateStop,
  CONTRACT_GRID_AS_OF,
} from "@/lib/risk/stops";

const ENTRY_P = 285_000; // Rs 2,850
const ATR_P3 = 8_500_000; // Rs 85.00 carried as paise x 1000

describe("stopAtr", () => {
  it("the Turtle 2N stop on an Rs 85 ATR is Rs 2,680", () => {
    const r = stopAtr({ entryP: ENTRY_P, atrP3: ATR_P3, multPermille: 2000, source: "turtle" });
    expect(r.ok).toBe(true);
    expect(r.stopP).toBe(268_000);
    expect(r.distanceP).toBe(17_000);
    expect(r.source).toBe("turtle");
  });

  it("a short's ATR stop sits above entry and reports the same distance", () => {
    const r = stopAtr({ entryP: ENTRY_P, atrP3: ATR_P3, multPermille: 2000, side: "short" });
    expect(r.stopP).toBe(302_000);
    expect(r.distanceP).toBe(17_000);
    expect(r.source).toBe("atr");
  });

  it("floors the distance rather than rounding it", () => {
    // 2.5 x Rs 85.007 = Rs 212.5175 -> 21251 paise, floored.
    const r = stopAtr({ entryP: ENTRY_P, atrP3: 8_500_700, multPermille: 2500 });
    expect(r.distanceP).toBe(21_251);
  });

  it("a missing ATR is a typed error, not a NaN level", () => {
    const r = stopAtr({ entryP: ENTRY_P, atrP3: 0, multPermille: 2000 });
    expect(r).toMatchObject({ ok: false, stopP: null, error: "non-positive-atr" });
  });
});

describe("stopStructure", () => {
  it("places the level a quarter-ATR below the swing low by convention", () => {
    const r = stopStructure({ entryP: ENTRY_P, pivotP: 262_000, atrP3: ATR_P3 });
    expect(r.stopP).toBe(262_000 - 2125); // Rs 21.25 buffer
    expect(r.source).toBe("structure");
  });

  it("an explicit buffer overrides the convention", () => {
    expect(stopStructure({ entryP: ENTRY_P, pivotP: 262_000, bufferP: 500, atrP3: ATR_P3 }).stopP).toBe(261_500);
  });

  it("a pivot at or above entry for a long is a typed error", () => {
    expect(stopStructure({ entryP: ENTRY_P, pivotP: 290_000, bufferP: 0 }).error).toBe("stop-not-below-entry");
    expect(stopStructure({ entryP: ENTRY_P, pivotP: ENTRY_P, bufferP: 0 }).error).toBe("stop-equals-entry");
  });
});

describe("stopPercent", () => {
  it("an 8% stop below Rs 2,850 is Rs 2,622", () => {
    const r = stopPercent({ entryP: ENTRY_P, pctPpm: 80_000 });
    expect(r.stopP).toBe(262_200);
    expect(r.source).toBe("percent");
  });

  it("a short's percentage stop mirrors above entry", () => {
    expect(stopPercent({ entryP: ENTRY_P, pctPpm: 80_000, side: "short" }).stopP).toBe(307_800);
  });
});

describe("roundTickAwayFromEntry", () => {
  it("widens a long's stop down to the 5-paisa grid", () => {
    // Rs 2,600.13 -> Rs 2,600.10, further from entry, never closer.
    const r = roundTickAwayFromEntry({ stopP: 260_013, entryP: ENTRY_P, tickP: 5 });
    expect(r.stopP).toBe(260_010);
    expect(r.stopP as number).toBeLessThan(260_013);
  });

  it("widens a short's stop up to the grid", () => {
    const r = roundTickAwayFromEntry({ stopP: 310_013, entryP: ENTRY_P, tickP: 5 });
    expect(r.stopP).toBe(310_015);
    expect(r.stopP as number).toBeGreaterThan(310_013);
  });

  it("leaves a level already on the grid unchanged", () => {
    expect(roundTickAwayFromEntry({ stopP: 260_010, entryP: ENTRY_P, tickP: 5 }).stopP).toBe(260_010);
  });

  it("never tightens: the distance from entry only ever grows", () => {
    for (let stop = 259_991; stop <= 260_030; stop += 1) {
      const r = roundTickAwayFromEntry({ stopP: stop, entryP: ENTRY_P, tickP: 5 });
      expect(ENTRY_P - (r.stopP as number)).toBeGreaterThanOrEqual(ENTRY_P - stop);
    }
    for (let stop = 309_991; stop <= 310_030; stop += 1) {
      const r = roundTickAwayFromEntry({ stopP: stop, entryP: ENTRY_P, tickP: 5 });
      expect((r.stopP as number) - ENTRY_P).toBeGreaterThanOrEqual(stop - ENTRY_P);
    }
  });

  it("a zero tick is a typed error", () => {
    expect(roundTickAwayFromEntry({ stopP: 260_013, entryP: ENTRY_P, tickP: 0 }).error).toBe("non-positive-tick");
  });
});

describe("tick grid is dated", () => {
  it("a sub-Rs 250 scrip ticks at 1 paisa today, Rs 250 and above at 5", () => {
    expect(tickSizeForPrice(18_000)).toBe(1); // Rs 180
    expect(tickSizeForPrice(24_999)).toBe(1);
    expect(tickSizeForPrice(25_000)).toBe(5); // Rs 250
    expect(tickSizeForPrice(285_000)).toBe(5);
  });

  it("before 10 Jun 2024 the whole board ticked at 5 paise", () => {
    const old = tickRevisionOn("2024-06-09");
    expect(tickSizeForPrice(18_000, old.bands)).toBe(5);
    expect(tickRevisionOn("2024-06-10").effectiveFrom).toBe("2024-06-10");
    expect(CONTRACT_GRID_AS_OF).toBe("2026-09-05");
  });
});

describe("circuitBandFlag", () => {
  it("flags a level outside today's band without blocking it", () => {
    const band = circuitBandFlag({ prevCloseP: 285_000, bandPpm: 100_000, priceP: 250_000 });
    expect(band.lowerP).toBe(256_500);
    expect(band.upperP).toBe(313_500);
    expect(band.withinBand).toBe(false);
    expect(band.flags).toContain("outside-price-band");
  });

  it("a level inside the band carries no flag", () => {
    const band = circuitBandFlag({ prevCloseP: 285_000, bandPpm: 100_000, priceP: 260_000 });
    expect(band.withinBand).toBe(true);
    expect(band.flags).toEqual([]);
  });

  it("the band edges are inclusive", () => {
    expect(circuitBandFlag({ prevCloseP: 285_000, bandPpm: 100_000, priceP: 256_500 }).withinBand).toBe(true);
    expect(circuitBandFlag({ prevCloseP: 285_000, bandPpm: 100_000, priceP: 256_499 }).withinBand).toBe(false);
  });
});

describe("stop distance measured in N", () => {
  it("Rs 250 over an Rs 85 ATR is 2.94 N", () => {
    expect(stopDistanceInNPermille(25_000, ATR_P3)).toBe(2941);
  });

  it("returns null without an ATR — a missing denominator is not a ratio of zero", () => {
    expect(stopDistanceInNPermille(25_000, 0)).toBeNull();
  });
});

describe("validateStop", () => {
  it("rejects a long stop at or above entry and a short stop at or below", () => {
    expect(validateStop(ENTRY_P, 290_000, "long", "manual").error).toBe("stop-not-below-entry");
    expect(validateStop(ENTRY_P, 280_000, "short", "manual").error).toBe("stop-not-above-entry");
    expect(validateStop(ENTRY_P, ENTRY_P, "long", "manual").error).toBe("stop-equals-entry");
    expect(validateStop(0, 100, "long", "manual").error).toBe("non-positive-entry");
  });
});
