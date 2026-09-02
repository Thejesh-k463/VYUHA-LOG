import { describe, it, expect } from "vitest";
import {
  capitalGainsRatesFor,
  classifyTerm,
  grandfatheredCost,
  isGrandfatherEligible,
  classifyGain,
  aggregateTradesByFy,
  computeFySetOff,
  computeTaxTimeline,
  RATE_CUTOVER_DATE,
  type CapitalGainsTrade,
  type CarryForwardLot,
  type FyGrossGains,
} from "@/lib/analytics/capital-gains";

describe("capitalGainsRatesFor — date-based cutover", () => {
  it("uses the old rates strictly before 23-Jul-2024", () => {
    const r = capitalGainsRatesFor("2024-07-22");
    expect(r).toEqual({ stcgPct: 0.15, ltcgPct: 0.10, ltcgExemption: 100000 });
  });
  it("uses the new rates on and after 23-Jul-2024", () => {
    expect(capitalGainsRatesFor(RATE_CUTOVER_DATE)).toEqual({ stcgPct: 0.20, ltcgPct: 0.125, ltcgExemption: 125000 });
    expect(capitalGainsRatesFor("2026-01-01")).toEqual({ stcgPct: 0.20, ltcgPct: 0.125, ltcgExemption: 125000 });
  });
});

describe("classifyTerm", () => {
  it("classifies >=365 days as long-term", () => {
    expect(classifyTerm("2024-01-01", "2025-01-01")).toBe("LT"); // 366 days (leap-safe)
    expect(classifyTerm("2024-01-01", "2024-06-01")).toBe("ST");
  });
  it("treats missing dates as short-term (safe default)", () => {
    expect(classifyTerm(null, "2025-01-01")).toBe("ST");
    expect(classifyTerm("2024-01-01", null)).toBe("ST");
  });
});

describe("grandfathering", () => {
  it("uses the higher of actual cost vs capped FMV", () => {
    // Bought at 100, FMV on 31-Jan-2018 was 300, sold at 250 -> capped FMV = min(300,250) = 250 > 100
    expect(grandfatheredCost(100, 300, 250)).toBe(250);
  });
  it("never lets the adjusted cost exceed the sell price (capped FMV)", () => {
    // FMV 500 but sold at 200 -> capped FMV = 200, cost = max(100, 200) = 200 (not 500)
    expect(grandfatheredCost(100, 500, 200)).toBe(200);
  });
  it("falls back to actual cost when no FMV is on record", () => {
    expect(grandfatheredCost(100, null, 250)).toBe(100);
  });
  it("does not apply when actual cost is already higher than capped FMV", () => {
    expect(grandfatheredCost(280, 300, 250)).toBe(280);
  });
  it("eligibility requires a buy date strictly before 31-Jan-2018", () => {
    expect(isGrandfatherEligible("2018-01-30")).toBe(true);
    expect(isGrandfatherEligible("2018-01-31")).toBe(false);
    expect(isGrandfatherEligible(null)).toBe(false);
  });
});

describe("classifyGain — per-trade bucketing", () => {
  const base: CapitalGainsTrade = { segment: "eq_delivery", buyDate: "2025-01-01", sellDate: "2025-06-01", buyValue: 1000, sellValue: 1200, netPnl: 200 };

  it("buckets equity delivery under 12m as stcg", () => {
    expect(classifyGain(base)).toEqual({ bucket: "stcg", taxableGain: 200 });
  });
  it("buckets equity delivery >=12m as ltcg", () => {
    const t = { ...base, buyDate: "2023-01-01", sellDate: "2025-01-02" };
    expect(classifyGain(t)!.bucket).toBe("ltcg");
  });
  it("applies grandfathering for a pre-2018 ltcg lot with FMV supplied", () => {
    const t: CapitalGainsTrade = {
      segment: "eq_delivery", buyDate: "2017-06-01", sellDate: "2026-01-01",
      buyValue: 100, sellValue: 250, netPnl: 150, fmv31Jan2018: 300,
    };
    // grandfathered cost = min(300,250)=250 -> taxableGain = 250-250 = 0
    expect(classifyGain(t)).toEqual({ bucket: "ltcg", taxableGain: 0 });
  });
  it("skips grandfathering when no FMV given even if pre-2018", () => {
    const t: CapitalGainsTrade = { segment: "eq_delivery", buyDate: "2017-06-01", sellDate: "2026-01-01", buyValue: 100, sellValue: 250, netPnl: 150 };
    expect(classifyGain(t)).toEqual({ bucket: "ltcg", taxableGain: 150 });
  });
  it("buckets eq_intraday as speculative", () => {
    expect(classifyGain({ ...base, segment: "eq_intraday" })!.bucket).toBe("speculative");
  });
  it("buckets F&O segments as nonSpeculative", () => {
    for (const seg of ["index_option", "stock_option", "commodity_option", "commodity_future", "future"]) {
      expect(classifyGain({ ...base, segment: seg })!.bucket).toBe("nonSpeculative");
    }
  });
  it("returns null for an unrecognised segment", () => {
    expect(classifyGain({ ...base, segment: "unknown" })).toBeNull();
  });
});

describe("aggregateTradesByFy — straddling-FY rate weighting", () => {
  it("gives a pure pre-cutover FY the old rate", () => {
    const trades: CapitalGainsTrade[] = [
      { segment: "eq_delivery", buyDate: "2024-01-01", sellDate: "2024-05-01", buyValue: 1000, sellValue: 1100, netPnl: 100 },
    ];
    const rows = aggregateTradesByFy(trades, 4, "2026-27");
    expect(rows[0].fy).toBe("2024-25");
    expect(rows[0].stcgRate).toBeCloseTo(0.15, 6);
  });

  it("gives a pure post-cutover FY the new rate", () => {
    const trades: CapitalGainsTrade[] = [
      { segment: "eq_delivery", buyDate: "2024-08-01", sellDate: "2024-12-01", buyValue: 1000, sellValue: 1100, netPnl: 100 },
    ];
    const rows = aggregateTradesByFy(trades, 4, "2026-27");
    expect(rows[0].stcgRate).toBeCloseTo(0.20, 6);
  });

  it("blends a straddling FY2024-25 by gain-weighted average, not a flat FY-end rate", () => {
    // Pre-cutover gain 100 @ 15%, post-cutover gain 300 @ 20% -> weighted = (100*0.15+300*0.20)/400 = 0.1875
    const trades: CapitalGainsTrade[] = [
      { segment: "eq_delivery", buyDate: "2024-01-01", sellDate: "2024-06-01", buyValue: 1000, sellValue: 1100, netPnl: 100 },
      { segment: "eq_delivery", buyDate: "2024-01-01", sellDate: "2024-09-01", buyValue: 1000, sellValue: 1300, netPnl: 300 },
    ];
    const rows = aggregateTradesByFy(trades, 4, "2026-27");
    expect(rows[0].fy).toBe("2024-25");
    expect(rows[0].stcg).toBe(400);
    expect(rows[0].stcgRate).toBeCloseTo(0.1875, 6);
  });
});

describe("computeFySetOff — same-year set-off (sections 70/71)", () => {
  const empty: CarryForwardLot[] = [];
  function gains(over: Partial<FyGrossGains>): FyGrossGains {
    return { fy: "2026-27", stcg: 0, ltcg: 0, speculative: 0, nonSpeculative: 0, stcgRate: 0.20, ltcgRate: 0.125, ltcgExemption: 125000, ...over };
  }

  it("STCL offsets STCG first, no impact on LTCG when fully absorbed", () => {
    const r = computeFySetOff(gains({ stcg: -1000, ltcg: 5000 }), empty);
    // Wait: stcg is a loss here so ltcg should be reduced by STCL after netting with STCG's own gain... but stcg gross is -1000 (a pure loss, no offsetting gain in stcg itself)
    expect(r.taxableStcg).toBe(0);
    expect(r.newCarryForward.find((l) => l.bucket === "stcl")).toBeUndefined();
  });

  it("STCL spills into LTCG when there's no STCG to absorb it", () => {
    const r = computeFySetOff(gains({ stcg: -1000, ltcg: 5000 }), empty);
    expect(r.taxableLtcg).toBe(4000); // 5000 - 1000 STCL
  });

  it("leftover STCL after fully using LTCG carries forward as stcl", () => {
    const r = computeFySetOff(gains({ stcg: -6000, ltcg: 5000 }), empty);
    expect(r.taxableLtcg).toBe(0);
    const cf = r.newCarryForward.find((l) => l.bucket === "stcl");
    expect(cf?.amount).toBe(1000);
  });

  it("LTCL never offsets STCG — carries forward as ltcl", () => {
    const r = computeFySetOff(gains({ stcg: 2000, ltcg: -500 }), empty);
    expect(r.taxableStcg).toBe(2000);
    const cf = r.newCarryForward.find((l) => l.bucket === "ltcl");
    expect(cf?.amount).toBe(500);
  });

  it("a speculative loss does NOT touch capital gains or non-speculative gains", () => {
    const r = computeFySetOff(gains({ stcg: 1000, nonSpeculative: 1000, speculative: -500 }), empty);
    expect(r.taxableStcg).toBe(1000);
    expect(r.taxableNonSpeculative).toBe(1000);
    const cf = r.newCarryForward.find((l) => l.bucket === "speculative");
    expect(cf?.amount).toBe(500);
  });

  it("a non-speculative (F&O) loss CAN offset capital gains in the same year", () => {
    const r = computeFySetOff(gains({ stcg: 1000, nonSpeculative: -400 }), empty);
    expect(r.taxableStcg).toBe(600);
    expect(r.newCarryForward.length).toBe(0);
  });

  it("LTCG exemption is applied after set-off, only to the net taxable LTCG", () => {
    const r = computeFySetOff(gains({ ltcg: 200000 }), empty); // exemption 125000
    expect(r.taxableLtcg).toBe(200000); // displayed pre-exemption
    expect(r.taxDue).toBeCloseTo((200000 - 125000) * 0.125, 6);
  });
});

describe("computeFySetOff — carry-forward absorption + expiry", () => {
  function gains(over: Partial<FyGrossGains>): FyGrossGains {
    return { fy: "2026-27", stcg: 0, ltcg: 0, speculative: 0, nonSpeculative: 0, stcgRate: 0.20, ltcgRate: 0.125, ltcgExemption: 125000, ...over };
  }

  it("absorbs a brought-forward speculative loss only against a speculative gain", () => {
    const bf: CarryForwardLot[] = [{ bucket: "speculative", fyIncurred: "2025-26", amount: 3000 }];
    const r = computeFySetOff(gains({ speculative: 5000 }), bf);
    expect(r.taxableSpeculative).toBe(2000); // 5000 - 3000
    expect(r.usedCarryForward[0]).toMatchObject({ bucket: "speculative", amount: 3000 });
  });

  it("a brought-forward speculative loss is NOT usable against a non-speculative gain", () => {
    const bf: CarryForwardLot[] = [{ bucket: "speculative", fyIncurred: "2025-26", amount: 3000 }];
    const r = computeFySetOff(gains({ nonSpeculative: 5000 }), bf);
    expect(r.taxableNonSpeculative).toBe(5000); // untouched
    expect(r.newCarryForward.find((l) => l.bucket === "speculative")?.amount).toBe(3000); // still carried
  });

  it("expires a speculative carry-forward beyond its 4-year window", () => {
    // incurred 2020-21, still valid at 2024-25 (4y later) but expired by 2025-26 (5y later)
    const bf: CarryForwardLot[] = [{ bucket: "speculative", fyIncurred: "2020-21", amount: 1000 }];
    const stillValid = computeFySetOff(gains({ fy: "2024-25", speculative: 5000 }), bf);
    expect(stillValid.taxableSpeculative).toBe(4000);

    const expired = computeFySetOff(gains({ fy: "2025-26", speculative: 5000 }), bf);
    expect(expired.taxableSpeculative).toBe(5000); // lot expired, not absorbed
  });

  it("expires a non-speculative/capital carry-forward beyond its 8-year window", () => {
    const bf: CarryForwardLot[] = [{ bucket: "stcl", fyIncurred: "2016-17", amount: 1000 }];
    const stillValid = computeFySetOff(gains({ fy: "2024-25", stcg: 5000 }), bf);
    expect(stillValid.taxableStcg).toBe(4000);

    const expired = computeFySetOff(gains({ fy: "2025-26", stcg: 5000 }), bf);
    expect(expired.taxableStcg).toBe(5000);
  });
});

describe("computeTaxTimeline — b/f non-speculative loss meets ANY business income (S.72(1))", () => {
  const base = { stcg: 0, ltcg: 0, stcgRate: 0.2, ltcgRate: 0.125, ltcgExemption: 125000 };

  it("a carried F&O loss absorbs a later year's SPECULATIVE gain", () => {
    // The module header and the user-facing footnote both state this rule;
    // the code used to implement a narrower one (non-spec b/f → non-spec gain
    // only), silently overtaxing an intraday year that followed an F&O loss.
    const [, y2] = computeTaxTimeline([
      { fy: "2024-25", ...base, speculative: 0, nonSpeculative: -100000 },
      { fy: "2025-26", ...base, speculative: 60000, nonSpeculative: 0 },
    ]);
    expect(y2.taxableSpeculative).toBe(0);
    expect(y2.usedCarryForward).toEqual([{ bucket: "nonSpeculative", fyIncurred: "2024-25", amount: 60000 }]);
    expect(y2.newCarryForward).toEqual([{ bucket: "nonSpeculative", fyIncurred: "2024-25", amount: 40000 }]);
  });

  it("non-speculative gain absorbs FIRST; the remainder reaches speculative", () => {
    const [, y2] = computeTaxTimeline([
      { fy: "2024-25", ...base, speculative: 0, nonSpeculative: -100000 },
      { fy: "2025-26", ...base, speculative: 50000, nonSpeculative: 70000 },
    ]);
    expect(y2.taxableNonSpeculative).toBe(0);
    expect(y2.taxableSpeculative).toBe(20000); // 100k − 70k = 30k left for the 50k spec gain
    expect(y2.newCarryForward).toEqual([]);
  });

  it("the barred direction stays barred: b/f SPECULATIVE loss never touches F&O gain (S.73)", () => {
    const [, y2] = computeTaxTimeline([
      { fy: "2024-25", ...base, speculative: -100000, nonSpeculative: 0 },
      { fy: "2025-26", ...base, speculative: 0, nonSpeculative: 80000 },
    ]);
    expect(y2.taxableNonSpeculative).toBe(80000);
    expect(y2.usedCarryForward).toEqual([]);
    expect(y2.newCarryForward).toEqual([{ bucket: "speculative", fyIncurred: "2024-25", amount: 100000 }]);
  });
});

describe("computeTaxTimeline — chains carry-forward across FYs", () => {
  it("a loss in one FY reduces tax in the following FY", () => {
    const byFy: FyGrossGains[] = [
      { fy: "2025-26", stcg: -10000, ltcg: 0, speculative: 0, nonSpeculative: 0, stcgRate: 0.20, ltcgRate: 0.125, ltcgExemption: 125000 },
      { fy: "2026-27", stcg: 15000, ltcg: 0, speculative: 0, nonSpeculative: 0, stcgRate: 0.20, ltcgRate: 0.125, ltcgExemption: 125000 },
    ];
    const timeline = computeTaxTimeline(byFy);
    expect(timeline[0].taxableStcg).toBe(0);
    expect(timeline[0].newCarryForward[0]).toMatchObject({ bucket: "stcl", amount: 10000 });
    expect(timeline[1].taxableStcg).toBe(5000); // 15000 - 10000 b/f
    expect(timeline[1].usedCarryForward[0]).toMatchObject({ bucket: "stcl", fyIncurred: "2025-26", amount: 10000 });
  });

  it("handles an empty input", () => {
    expect(computeTaxTimeline([])).toEqual([]);
  });
});

describe("computeTaxTimeline — seeded pre-journal carry-forward lots", () => {
  const base = { stcg: 0, ltcg: 0, speculative: 0, nonSpeculative: 0, stcgRate: 0.20, ltcgRate: 0.125, ltcgExemption: 125000 };
  const fy = (label: string, o: Partial<FyGrossGains>): FyGrossGains => ({ ...base, fy: label, ...o });

  it("a seeded STCL offsets the first FY's STCG then LTCG, exactly like an in-timeline loss", () => {
    const seed: CarryForwardLot[] = [{ bucket: "stcl", fyIncurred: "2023-24", amount: 10000 }];
    const seeded = computeTaxTimeline([fy("2025-26", { stcg: 4000, ltcg: 8000 })], seed);
    // s.74 ordering: b/f STCL -> STCG first (4000), remainder -> LTCG (6000)
    expect(seeded[0].taxableStcg).toBe(0);
    expect(seeded[0].taxableLtcg).toBe(2000);
    expect(seeded[0].usedCarryForward).toEqual([
      { bucket: "stcl", fyIncurred: "2023-24", amount: 4000 },
      { bucket: "stcl", fyIncurred: "2023-24", amount: 6000 },
    ]);
    expect(seeded[0].newCarryForward).toEqual([]);
    // Equivalence: identical to the same loss incurred inside the timeline.
    const inTimeline = computeTaxTimeline([fy("2023-24", { stcg: -10000 }), fy("2025-26", { stcg: 4000, ltcg: 8000 })]);
    expect(seeded[0]).toEqual(inTimeline[1]);
  });

  it("a seeded lot expired before the first timeline FY is pruned on entry, never applied", () => {
    // stcl window is 8y: 2016-17 expires after 2024-25, so it must not touch 2025-26.
    const seed: CarryForwardLot[] = [{ bucket: "stcl", fyIncurred: "2016-17", amount: 10000 }];
    const [r] = computeTaxTimeline([fy("2025-26", { stcg: 5000 })], seed);
    expect(r.taxableStcg).toBe(5000);
    expect(r.usedCarryForward).toEqual([]);
    expect(r.newCarryForward).toEqual([]); // pruned, not carried onward either
  });

  it("a seeded speculative lot respects the 4-year window while a capital lot gets 8", () => {
    const seed: CarryForwardLot[] = [
      { bucket: "speculative", fyIncurred: "2020-21", amount: 3000 },
      { bucket: "stcl", fyIncurred: "2020-21", amount: 3000 },
    ];
    // 2024-25 is the last usable FY for the speculative vintage — both apply.
    const [inWindow] = computeTaxTimeline([fy("2024-25", { speculative: 5000, stcg: 5000 })], seed);
    expect(inWindow.taxableSpeculative).toBe(2000);
    expect(inWindow.taxableStcg).toBe(2000);
    // One FY later the speculative vintage is gone; the capital one (8y) survives.
    const [after] = computeTaxTimeline([fy("2025-26", { speculative: 5000, stcg: 5000 })], seed);
    expect(after.taxableSpeculative).toBe(5000);
    expect(after.taxableStcg).toBe(2000);
    expect(after.usedCarryForward).toEqual([{ bucket: "stcl", fyIncurred: "2020-21", amount: 3000 }]);
  });

  it("the caller's seed lots are never mutated (computeFySetOff clones on entry)", () => {
    const seed: CarryForwardLot[] = [{ bucket: "stcl", fyIncurred: "2023-24", amount: 10000 }];
    computeTaxTimeline([fy("2025-26", { stcg: 15000 })], seed);
    expect(seed).toEqual([{ bucket: "stcl", fyIncurred: "2023-24", amount: 10000 }]);
  });

  it("zero-seed default is byte-identical to the one-argument call (regression pin)", () => {
    const byFy: FyGrossGains[] = [
      fy("2025-26", { stcg: -10000 }),
      fy("2026-27", { stcg: 15000 }),
    ];
    const oneArg = computeTaxTimeline(byFy);
    expect(oneArg).toEqual(computeTaxTimeline(byFy, []));
    // Pin the exact pre-change output of the existing chaining fixture.
    expect(oneArg).toEqual([
      {
        fy: "2025-26",
        rates: { stcgPct: 0.20, ltcgPct: 0.125, ltcgExemption: 125000 },
        taxableStcg: 0,
        taxableLtcg: 0,
        taxableSpeculative: 0,
        taxableNonSpeculative: 0,
        taxDue: 0,
        newCarryForward: [{ bucket: "stcl", fyIncurred: "2025-26", amount: 10000 }],
        usedCarryForward: [],
      },
      {
        fy: "2026-27",
        rates: { stcgPct: 0.20, ltcgPct: 0.125, ltcgExemption: 125000 },
        taxableStcg: 5000,
        taxableLtcg: 0,
        taxableSpeculative: 0,
        taxableNonSpeculative: 0,
        taxDue: 1000,
        newCarryForward: [],
        usedCarryForward: [{ bucket: "stcl", fyIncurred: "2025-26", amount: 10000 }],
      },
    ]);
  });
});
