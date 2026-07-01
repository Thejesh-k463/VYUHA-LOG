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
