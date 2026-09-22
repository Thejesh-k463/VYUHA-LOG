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

/**
 * v4.5.0 — `FyGrossGains` no longer has `stcg`/`ltcg`. One "STCG" number merged
 * a concessional s.111A gain with a slab-rate one and with an s.50AA-deemed
 * one; one "LTCG" merged a s.112A gain with an s.112 gain needing an indexed
 * cost this release cannot compute. Every fixture below therefore says WHICH.
 * The SET-OFF arithmetic itself is unchanged and runs on the aggregate short-
 * and long-term totals (sections 70/71), which is why a fixture that used to
 * say `stcg: N` says `stcg111A: N` and gets the identical answer.
 */
const ZERO_BUCKETS = { stcg111A: 0, stcgOther: 0, ltcg112A: 0, ltcg112: 0, cgUndetermined: 0, notDeductedMtf: 0, sttAddedBack: 0, blankReasons: [] as string[] };

describe("capitalGainsRatesFor — date-based cutover", () => {
  it("uses the old rates strictly before 23-Jul-2024", () => {
    const r = capitalGainsRatesFor("2024-07-22");
    expect(r).toEqual({ stcgPct: 0.15, ltcgPct: 0.10, ltcgExemption: 100000, stcgBlank: false, ltcgBlank: false });
  });
  it("uses the new rates on and after 23-Jul-2024", () => {
    expect(capitalGainsRatesFor(RATE_CUTOVER_DATE)).toEqual({ stcgPct: 0.20, ltcgPct: 0.125, ltcgExemption: 125000, stcgBlank: false, ltcgBlank: false });
    expect(capitalGainsRatesFor("2026-01-01")).toEqual({ stcgPct: 0.20, ltcgPct: 0.125, ltcgExemption: 125000, stcgBlank: false, ltcgBlank: false });
  });

  /**
   * P4 (v4.5.0). This function held exactly TWO schedules split at 23-Jul-2024,
   * so every sale before that date was priced at 15% short / 10% long — the FA
   * 2008 rate and the FA 2018 rate, applied to years in which neither existed.
   * It now reads the same band table `resolveCgHead` reads, and where the
   * primary-source folder carries no rate the number is 0 WITH the matching
   * `…Blank` flag set, so a caller prints blank rather than ₹0 (invariant 6).
   */
  it("prices a pre-FA2008 sale at the s.111A rate actually in force, and the exempt long-term head at 0", () => {
    // 2007-06-01: s.111A as INSERTED by the Finance (No. 2) Act 2004 s.26 — 10%,
    // not the 15% FA 2008 s.21 substituted for transfers from 1-4-2008.
    // Long-term: S.10(38) EXEMPT, so 0 is the right answer and ltcgBlank is FALSE.
    expect(capitalGainsRatesFor("2007-06-01")).toEqual({
      stcgPct: 0.10, ltcgPct: 0, ltcgExemption: 0, stcgBlank: false, ltcgBlank: false,
    });
    expect(capitalGainsRatesFor("2010-06-01")).toEqual({
      stcgPct: 0.15, ltcgPct: 0, ltcgExemption: 0, stcgBlank: false, ltcgBlank: false,
    });
  });

  it("states NO rate at all before Chapter VII (STT) commenced on 1-10-2004", () => {
    // Short-term was at the SLAB rate (unknown to this journal) and long-term
    // was S.112 on an INDEXED cost with no CII bundled — both BLANK, and the
    // flags are what stop a caller printing ₹0 of tax.
    const r = capitalGainsRatesFor("2004-09-30");
    expect(r.stcgBlank).toBe(true);
    expect(r.ltcgBlank).toBe(true);
    expect(r.stcgPct).toBe(0);
    expect(r.ltcgPct).toBe(0);
    // The day Chapter VII commenced, the short-term rate becomes statable.
    expect(capitalGainsRatesFor("2004-10-01").stcgBlank).toBe(false);
  });
});

describe("classifyTerm", () => {
  /**
   * v4.5.0 (T3). The premise of the old pin — ">= 365 days is long-term" — is
   * WRONG LAW and is re-pinned to the statute here. S.2(42A) says MONTHS, and
   * the General Clauses Act, 1897 s.3(35) defines a month as a calendar month
   * reckoned from a date (`indiacode-general-clauses-act-1897-s3-definitions-item.json`).
   * Bought 1-Jan-2024, a sale on 1-Jan-2025 is 366 days but is NOT past the
   * same calendar date twelve months on, so it is still SHORT-term; 2-Jan-2025
   * is the first long-term day.
   */
  it("needs the transfer to be PAST the same calendar date 12 months on, not 365 days later", () => {
    expect(classifyTerm("2024-01-01", "2025-01-01")).toBe("ST"); // 366 days — still short
    expect(classifyTerm("2024-01-01", "2025-01-02")).toBe("LT");
    expect(classifyTerm("2024-01-01", "2024-06-01")).toBe("ST");
  });
  it("treats missing dates as short-term (safe default)", () => {
    expect(classifyTerm(null, "2025-01-01")).toBe("ST");
    expect(classifyTerm("2024-01-01", null)).toBe("ST");
  });

  /**
   * v4.3.0 fix wave 2M (seam round, found by S-IPO): a LEGACY day-first date —
   * `ipos.allotment_date` was stored raw until 2M, and `setAcquisitionAction`
   * wrote a typed date into buy_date unvalidated — reached `new Date("20-02-2026T00:00:00")`,
   * an Invalid Date, so the day count was NaN and `NaN >= 365` labelled every
   * such lot SHORT-term; `capitalGainsRatesFor` compared the same string
   * character by character and picked the PRE-cutover schedule for a 2026 sale.
   * Both now read the calendar through `normalizeDate`; a date that does not
   * resolve keeps the module's own conservative answer for a missing one (ST).
   */
  it("reads a legacy day-first date as the day it names (2M)", () => {
    expect(classifyTerm("20-02-2024", "2025-03-02")).toBe("LT"); // 376 days
    expect(classifyTerm("2024-02-20", "02-03-2025")).toBe("LT");
    expect(classifyTerm("20-02-2026", "02-03-2026")).toBe("ST"); // 10 days
    expect(classifyTerm("2026-02-31", "2026-03-02")).toBe("ST"); // not a day → the missing-date answer
    expect(capitalGainsRatesFor("23-07-2026")).toEqual(capitalGainsRatesFor("2026-07-23"));
    expect(capitalGainsRatesFor("23-07-2026").stcgPct).toBe(0.2);
    expect(isGrandfatherEligible("20-02-2019")).toBe(false); // text compare said "-" < "8" → eligible
    expect(isGrandfatherEligible("20-02-2017")).toBe(true);
    expect(isGrandfatherEligible("2017-02-31")).toBe(false);
    // fyOf (module-private) through the aggregate: a day-first sell date used to land in "NaN-aN".
    const rows = aggregateTradesByFy([{ segment: "eq_delivery", assetClass: "share", buyDate: "2024-02-20", sellDate: "02-03-2026", buyValue: 1000, sellValue: 1500, netPnl: 500 }], 4, "2027-28");
    expect(rows.map((r) => r.fy)).toEqual(["2025-26"]);
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
  /**
   * v4.5.0. The old pin's premise ("strictly before 31-Jan-2018") is WRONG LAW.
   * S.55(2)(ac) reads "acquired before the 1st day of February, 2018"
   * (`egazette-184302-finance-act-2018-act13.pdf`), so a lot acquired ON
   * 31-Jan-2018 IS eligible — the very day whose FMV the section uses. The
   * predecessor compared against `"2018-01-31"` and excluded exactly that day.
   */
  it("eligibility requires a buy date before 1-Feb-2018 — 31-Jan-2018 itself IS eligible", () => {
    expect(isGrandfatherEligible("2018-01-30")).toBe(true);
    expect(isGrandfatherEligible("2018-01-31")).toBe(true);
    expect(isGrandfatherEligible("2018-02-01")).toBe(false);
    expect(isGrandfatherEligible(null)).toBe(false);
  });
});

describe("classifyGain — per-trade bucketing", () => {
  const base: CapitalGainsTrade = { segment: "eq_delivery", assetClass: "share", buyDate: "2025-01-01", sellDate: "2025-06-01", buyValue: 1000, sellValue: 1200, netPnl: 200 };

  it("buckets equity delivery under 12m as s.111A short-term", () => {
    const g = classifyGain(base)!;
    // v4.5.0: the bucket names the SECTION. "stcg" merged a concessional 111A
    // gain with a slab-rate one and an s.50AA-deemed one.
    expect(g.bucket).toBe("stcg111A");
    expect(g.taxableGain).toBe(200);
    expect(g.addedBackStt).toBe(0);
    expect(g.addedBackMtf).toBe(0);
    expect(g.head!.cell).toBe("E-ST20"); // transfer 1-Jun-2025 — FA (No. 2) 2024 band
    expect(g.head!.ratePct).toBe(0.20);
  });
  it("buckets equity delivery held past 12 calendar months as s.112A long-term", () => {
    const t = { ...base, buyDate: "2023-01-01", sellDate: "2025-01-02" };
    expect(classifyGain(t)!.bucket).toBe("ltcg112A");
  });
  it("buckets a NON-equity-oriented unit as slab short / s.112 long — never 111A/112A", () => {
    // A gold ETF unit bought 1-1-2022 and sold 1-6-2025: 36 months was required
    // only up to 22-7-2024; this transfer is after FA (No.2) 2024, so 12 months
    // applies and it is LONG-term under S.112 at 12.5% WITHOUT indexation.
    const gold = classifyGain({ ...base, assetClass: "otherUnit", buyDate: "2022-01-01" })!;
    expect(gold.bucket).toBe("ltcg112");
    expect(gold.head!.cell).toBe("O-LT-b");
    expect(gold.head!.ratePct).toBe(0.125);
    // Held 5 months: short-term at SLAB, which this journal cannot state.
    const short = classifyGain({ ...base, assetClass: "otherUnit" })!;
    expect(short.bucket).toBe("stcgOther");
    expect(short.head!.ratePct).toBeNull();
  });
  it("buckets an undetermined asset class into cgUndetermined with a blank head", () => {
    const g = classifyGain({ ...base, assetClass: "undetermined" })!;
    expect(g.bucket).toBe("cgUndetermined");
    expect(g.head!.head).toBe("undetermined");
    expect(g.head!.term).toBeNull();
    expect(g.head!.ratePct).toBeNull();
  });
  it("applies grandfathering for a pre-2018 ltcg lot with FMV supplied", () => {
    const t: CapitalGainsTrade = {
      segment: "eq_delivery", assetClass: "share", buyDate: "2017-06-01", sellDate: "2026-01-01",
      buyValue: 100, sellValue: 250, netPnl: 150, fmv31Jan2018: 300,
    };
    // grandfathered cost = min(300,250)=250 -> taxableGain = 150 - (250-100) = 0
    expect(classifyGain(t)).toEqual({ bucket: "ltcg112A", head: expect.objectContaining({ cell: "E-LT125", grandfatherEligible: true }), taxableGain: 0, addedBackStt: 0, addedBackMtf: 0 });
  });
  it("skips grandfathering when no FMV given even if pre-2018", () => {
    const t: CapitalGainsTrade = { segment: "eq_delivery", assetClass: "share", buyDate: "2017-06-01", sellDate: "2026-01-01", buyValue: 100, sellValue: 250, netPnl: 150 };
    expect(classifyGain(t)!.taxableGain).toBe(150);
    expect(classifyGain(t)!.bucket).toBe("ltcg112A");
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

  /**
   * Second-pass ruling (a): STT is added back in the CAPITAL-GAINS buckets ONLY.
   * The proviso to S.48 (s.72(3)(b) of the 2025 Act) forbids deducting STT
   * against a capital gain; S.36(1)(xv) keeps it deductible for the two BUSINESS
   * heads. So an intraday or F&O row's figure must be BYTE-IDENTICAL to what it
   * was before this wave, with or without an `sttCtt` on it.
   */
  it("adds STT and the financing charges back in the CG buckets and NOWHERE else", () => {
    const withCharges = { ...base, sttCtt: 12.5, mtfInterest: 30, pledgeCharges: 7.5 };
    // Delivery: gross for tax = net 200 + STT 12.50 + (MTF 30 + pledge 7.50) = 250.
    const d = classifyGain(withCharges)!;
    expect(d.taxableGain).toBe(250);
    expect(d.addedBackStt).toBe(12.5);
    expect(d.addedBackMtf).toBe(37.5);
    // Intraday and F&O: identical to the same row with no charge fields at all.
    for (const seg of ["eq_intraday", "future", "index_option"]) {
      expect(classifyGain({ ...withCharges, segment: seg })).toEqual(classifyGain({ ...base, segment: seg }));
      expect(classifyGain({ ...withCharges, segment: seg })!.taxableGain).toBe(200);
    }
  });

  it("the MTF add-back is a FLOOR — its GST is not separable and is NOT added back", () => {
    // `trades.gst_paise` is ONE column whose base is brokerage + exchange + sebi
    // + ipft + dp + pledge (schema:653). Splitting out the MTF/pledge share would
    // be an invented rate (invariants 3 and 6), so only the principal is restored.
    const g = classifyGain({ ...base, mtfInterest: 100, pledgeCharges: 0 })!;
    expect(g.addedBackMtf).toBe(100); // NOT 118 — no 18% GST is fabricated
    expect(g.taxableGain).toBe(300);
  });

  it("a negative or missing charge field never REDUCES the gain", () => {
    expect(classifyGain({ ...base, sttCtt: -50, mtfInterest: -5 })!.taxableGain).toBe(200);
    expect(classifyGain({ ...base, sttCtt: undefined })!.taxableGain).toBe(200);
  });
});

describe("aggregateTradesByFy — straddling-FY rate weighting", () => {
  it("gives a pure pre-cutover FY the old rate", () => {
    const trades: CapitalGainsTrade[] = [
      { segment: "eq_delivery", assetClass: "share", buyDate: "2024-01-01", sellDate: "2024-05-01", buyValue: 1000, sellValue: 1100, netPnl: 100 },
    ];
    const rows = aggregateTradesByFy(trades, 4, "2026-27");
    expect(rows[0].fy).toBe("2024-25");
    expect(rows[0].stcgRate).toBeCloseTo(0.15, 6);
  });

  it("gives a pure post-cutover FY the new rate", () => {
    const trades: CapitalGainsTrade[] = [
      { segment: "eq_delivery", assetClass: "share", buyDate: "2024-08-01", sellDate: "2024-12-01", buyValue: 1000, sellValue: 1100, netPnl: 100 },
    ];
    const rows = aggregateTradesByFy(trades, 4, "2026-27");
    expect(rows[0].stcgRate).toBeCloseTo(0.20, 6);
  });

  it("blends a straddling FY2024-25 by gain-weighted average, not a flat FY-end rate", () => {
    // Pre-cutover gain 100 @ 15%, post-cutover gain 300 @ 20% -> weighted = (100*0.15+300*0.20)/400 = 0.1875
    const trades: CapitalGainsTrade[] = [
      { segment: "eq_delivery", assetClass: "share", buyDate: "2024-01-01", sellDate: "2024-06-01", buyValue: 1000, sellValue: 1100, netPnl: 100 },
      { segment: "eq_delivery", assetClass: "share", buyDate: "2024-01-01", sellDate: "2024-09-01", buyValue: 1000, sellValue: 1300, netPnl: 300 },
    ];
    const rows = aggregateTradesByFy(trades, 4, "2026-27");
    expect(rows[0].fy).toBe("2024-25");
    // Both rows are equity delivery held under 12 months, so both are s.111A.
    expect(rows[0].stcg111A).toBe(400);
    expect(rows[0].stcgOther).toBe(0);
    expect(rows[0].stcgRate).toBeCloseTo(0.1875, 6);
  });

  /**
   * Second-pass ruling (b): the per-FY "MTF interest / pledge charges not
   * deducted" figure is exactly Σ(mtfInterest + pledgeCharges) over that FY's
   * capital-gains rows — no GST, no apportionment, no rate.
   */
  it("reports notDeductedMtf and sttAddedBack as plain sums over the FY's CG rows", () => {
    const rows = aggregateTradesByFy([
      { segment: "eq_mtf", assetClass: "share", buyDate: "2025-01-01", sellDate: "2025-06-01", buyValue: 1000, sellValue: 1100, netPnl: 100, sttCtt: 10, mtfInterest: 40, pledgeCharges: 5 },
      { segment: "eq_delivery", assetClass: "share", buyDate: "2025-02-01", sellDate: "2025-07-01", buyValue: 1000, sellValue: 1100, netPnl: 100, sttCtt: 2.5 },
      // A business row carrying the same fields contributes NOTHING to either.
      { segment: "future", assetClass: "share", buyDate: "2025-02-01", sellDate: "2025-07-01", buyValue: 1000, sellValue: 1100, netPnl: 100, sttCtt: 99, mtfInterest: 99 },
    ], 4, "2026-27");
    expect(rows[0].fy).toBe("2025-26");
    expect(rows[0].notDeductedMtf).toBe(45); // 40 + 5
    expect(rows[0].sttAddedBack).toBe(12.5); // 10 + 2.50
    expect(rows[0].stcg111A).toBe(257.5); // (100+10+45) + (100+2.50)
    expect(rows[0].nonSpeculative).toBe(100); // untouched by either add-back
  });

  it("a slab-rate or undetermined row is weighted into NO rate and blanks the year", () => {
    const rows = aggregateTradesByFy([
      { segment: "eq_delivery", assetClass: "share", buyDate: "2025-01-01", sellDate: "2025-06-01", buyValue: 1000, sellValue: 1100, netPnl: 100 },
      { segment: "eq_delivery", assetClass: "undetermined", buyDate: "2025-01-01", sellDate: "2025-06-01", buyValue: 1000, sellValue: 1100, netPnl: 900 },
    ], 4, "2026-27");
    expect(rows[0].stcg111A).toBe(100);
    expect(rows[0].cgUndetermined).toBe(900);
    // The 900 carries NO rate, so it is not averaged in as 0% — the weighted
    // short-term rate is the 111A row's own 20%, not 100*0.2/1000 = 2%.
    expect(rows[0].stcgRate).toBeCloseTo(0.20, 6);
    expect(rows[0].blankReasons.length).toBeGreaterThan(0);
  });
});

describe("computeFySetOff — same-year set-off (sections 70/71)", () => {
  const empty: CarryForwardLot[] = [];
  function gains(over: Partial<FyGrossGains>): FyGrossGains {
    return { fy: "2026-27", ...ZERO_BUCKETS, speculative: 0, nonSpeculative: 0, stcgRate: 0.20, ltcgRate: 0.125, ltcgExemption: 125000, ...over };
  }

  it("STCL offsets STCG first, no impact on LTCG when fully absorbed", () => {
    const r = computeFySetOff(gains({ stcg111A: -1000, ltcg112A: 5000 }), empty);
    // Wait: stcg is a loss here so ltcg should be reduced by STCL after netting with STCG's own gain... but stcg gross is -1000 (a pure loss, no offsetting gain in stcg itself)
    expect(r.taxableStcg).toBe(0);
    expect(r.newCarryForward.find((l) => l.bucket === "stcl")).toBeUndefined();
  });

  it("STCL spills into LTCG when there's no STCG to absorb it", () => {
    const r = computeFySetOff(gains({ stcg111A: -1000, ltcg112A: 5000 }), empty);
    expect(r.taxableLtcg).toBe(4000); // 5000 - 1000 STCL
  });

  it("leftover STCL after fully using LTCG carries forward as stcl", () => {
    const r = computeFySetOff(gains({ stcg111A: -6000, ltcg112A: 5000 }), empty);
    expect(r.taxableLtcg).toBe(0);
    const cf = r.newCarryForward.find((l) => l.bucket === "stcl");
    expect(cf?.amount).toBe(1000);
  });

  it("LTCL never offsets STCG — carries forward as ltcl", () => {
    const r = computeFySetOff(gains({ stcg111A: 2000, ltcg112A: -500 }), empty);
    expect(r.taxableStcg).toBe(2000);
    const cf = r.newCarryForward.find((l) => l.bucket === "ltcl");
    expect(cf?.amount).toBe(500);
  });

  it("a speculative loss does NOT touch capital gains or non-speculative gains", () => {
    const r = computeFySetOff(gains({ stcg111A: 1000, nonSpeculative: 1000, speculative: -500 }), empty);
    expect(r.taxableStcg).toBe(1000);
    expect(r.taxableNonSpeculative).toBe(1000);
    const cf = r.newCarryForward.find((l) => l.bucket === "speculative");
    expect(cf?.amount).toBe(500);
  });

  it("a non-speculative (F&O) loss CAN offset capital gains in the same year", () => {
    const r = computeFySetOff(gains({ stcg111A: 1000, nonSpeculative: -400 }), empty);
    expect(r.taxableStcg).toBe(600);
    expect(r.newCarryForward.length).toBe(0);
  });

  it("LTCG exemption is applied after set-off, only to the net taxable LTCG", () => {
    const r = computeFySetOff(gains({ ltcg112A: 200000 }), empty); // exemption 125000
    expect(r.taxableLtcg).toBe(200000); // displayed pre-exemption
    expect(r.taxDue).toBeCloseTo((200000 - 125000) * 0.125, 6);
  });
});

describe("computeFySetOff — carry-forward absorption + expiry", () => {
  function gains(over: Partial<FyGrossGains>): FyGrossGains {
    return { fy: "2026-27", ...ZERO_BUCKETS, speculative: 0, nonSpeculative: 0, stcgRate: 0.20, ltcgRate: 0.125, ltcgExemption: 125000, ...over };
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
    const stillValid = computeFySetOff(gains({ fy: "2024-25", stcg111A: 5000 }), bf);
    expect(stillValid.taxableStcg).toBe(4000);

    const expired = computeFySetOff(gains({ fy: "2025-26", stcg111A: 5000 }), bf);
    expect(expired.taxableStcg).toBe(5000);
  });
});

describe("computeTaxTimeline — b/f non-speculative loss meets ANY business income (S.72(1))", () => {
  const base = { ...ZERO_BUCKETS, stcgRate: 0.2, ltcgRate: 0.125, ltcgExemption: 125000 };

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
      { fy: "2025-26", ...ZERO_BUCKETS, stcg111A: -10000, speculative: 0, nonSpeculative: 0, stcgRate: 0.20, ltcgRate: 0.125, ltcgExemption: 125000 },
      { fy: "2026-27", ...ZERO_BUCKETS, stcg111A: 15000, speculative: 0, nonSpeculative: 0, stcgRate: 0.20, ltcgRate: 0.125, ltcgExemption: 125000 },
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
  const base = { ...ZERO_BUCKETS, speculative: 0, nonSpeculative: 0, stcgRate: 0.20, ltcgRate: 0.125, ltcgExemption: 125000 };
  const fy = (label: string, o: Partial<FyGrossGains>): FyGrossGains => ({ ...base, fy: label, ...o });

  it("a seeded STCL offsets the first FY's STCG then LTCG, exactly like an in-timeline loss", () => {
    const seed: CarryForwardLot[] = [{ bucket: "stcl", fyIncurred: "2023-24", amount: 10000 }];
    const seeded = computeTaxTimeline([fy("2025-26", { stcg111A: 4000, ltcg112A: 8000 })], seed);
    // s.74 ordering: b/f STCL -> STCG first (4000), remainder -> LTCG (6000)
    expect(seeded[0].taxableStcg).toBe(0);
    expect(seeded[0].taxableLtcg).toBe(2000);
    expect(seeded[0].usedCarryForward).toEqual([
      { bucket: "stcl", fyIncurred: "2023-24", amount: 4000 },
      { bucket: "stcl", fyIncurred: "2023-24", amount: 6000 },
    ]);
    expect(seeded[0].newCarryForward).toEqual([]);
    // Equivalence: identical to the same loss incurred inside the timeline.
    const inTimeline = computeTaxTimeline([fy("2023-24", { stcg111A: -10000 }), fy("2025-26", { stcg111A: 4000, ltcg112A: 8000 })]);
    expect(seeded[0]).toEqual(inTimeline[1]);
  });

  it("a seeded lot expired before the first timeline FY is pruned on entry, never applied", () => {
    // stcl window is 8y: 2016-17 expires after 2024-25, so it must not touch 2025-26.
    const seed: CarryForwardLot[] = [{ bucket: "stcl", fyIncurred: "2016-17", amount: 10000 }];
    const [r] = computeTaxTimeline([fy("2025-26", { stcg111A: 5000 })], seed);
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
    const [inWindow] = computeTaxTimeline([fy("2024-25", { speculative: 5000, stcg111A: 5000 })], seed);
    expect(inWindow.taxableSpeculative).toBe(2000);
    expect(inWindow.taxableStcg).toBe(2000);
    // One FY later the speculative vintage is gone; the capital one (8y) survives.
    const [after] = computeTaxTimeline([fy("2025-26", { speculative: 5000, stcg111A: 5000 })], seed);
    expect(after.taxableSpeculative).toBe(5000);
    expect(after.taxableStcg).toBe(2000);
    expect(after.usedCarryForward).toEqual([{ bucket: "stcl", fyIncurred: "2020-21", amount: 3000 }]);
  });

  it("the caller's seed lots are never mutated (computeFySetOff clones on entry)", () => {
    const seed: CarryForwardLot[] = [{ bucket: "stcl", fyIncurred: "2023-24", amount: 10000 }];
    computeTaxTimeline([fy("2025-26", { stcg111A: 15000 })], seed);
    expect(seed).toEqual([{ bucket: "stcl", fyIncurred: "2023-24", amount: 10000 }]);
  });

  it("zero-seed default is byte-identical to the one-argument call (regression pin)", () => {
    const byFy: FyGrossGains[] = [
      fy("2025-26", { stcg111A: -10000 }),
      fy("2026-27", { stcg111A: 15000 }),
    ];
    const oneArg = computeTaxTimeline(byFy);
    expect(oneArg).toEqual(computeTaxTimeline(byFy, []));
    // Pin the exact output of the existing chaining fixture. Every ₹ figure is
    // unchanged from before v4.5.0 — the shape gained `gross` (the per-bucket
    // figures, so a page can show them even when the year's total is blank),
    // `taxDueBlankReasons` and the two `…Blank` rate flags. Both FYs here hold
    // only s.111A gains, so nothing blanks and taxDue stays a number:
    // 2026-27 = 5000 × 0.20 = 1000.
    expect(oneArg).toEqual([
      {
        fy: "2025-26",
        rates: { stcgPct: 0.20, ltcgPct: 0.125, ltcgExemption: 125000, stcgBlank: false, ltcgBlank: false },
        gross: byFy[0],
        taxableStcg: 0,
        taxableLtcg: 0,
        taxableSpeculative: 0,
        taxableNonSpeculative: 0,
        taxDue: 0,
        taxDueBlankReasons: [],
        newCarryForward: [{ bucket: "stcl", fyIncurred: "2025-26", amount: 10000 }],
        usedCarryForward: [],
      },
      {
        fy: "2026-27",
        rates: { stcgPct: 0.20, ltcgPct: 0.125, ltcgExemption: 125000, stcgBlank: false, ltcgBlank: false },
        gross: byFy[1],
        taxableStcg: 5000,
        taxableLtcg: 0,
        taxableSpeculative: 0,
        taxableNonSpeculative: 0,
        taxDue: 1000,
        taxDueBlankReasons: [],
        newCarryForward: [],
        usedCarryForward: [{ bucket: "stcl", fyIncurred: "2025-26", amount: 10000 }],
      },
    ]);
  });

  /**
   * Owner answer T3 (2026-09-22): a year that holds a SLAB-rate bucket, an
   * undetermined head, or an s.112 cell needing a CII this release does not
   * bundle states NO capital-gains total — but every per-bucket AMOUNT still
   * shows, with a named reason. A partial total that reads as complete is the
   * failure mode invariant 6 exists to prevent.
   */
  it("blanks the YEAR's tax total for a slab-rate or undetermined bucket, keeping the amounts", () => {
    const [slab] = computeTaxTimeline([fy("2025-26", { stcg111A: 10000, stcgOther: 4000 })]);
    expect(slab.taxDue).toBeNull();
    expect(slab.taxDueBlankReasons.length).toBe(1);
    expect(slab.taxDueBlankReasons[0]).toContain("SLAB-rate short-term");
    expect(slab.gross.stcgOther).toBe(4000); // the amount is still stated
    expect(slab.taxableStcg).toBe(14000); // and so is the taxable total

    const [undet] = computeTaxTimeline([fy("2025-26", { stcg111A: 10000, cgUndetermined: 500 })]);
    expect(undet.taxDue).toBeNull();
    expect(undet.taxDueBlankReasons[0]).toContain("cannot determine");
    // `cgUndetermined` is OUTSIDE both set-off totals: a gain whose head is
    // unknown cannot be known to be short- or long-term either.
    expect(undet.taxableStcg).toBe(10000);

    // A year with neither still states its total: 10000 × 0.20 = 2000.
    const [clean] = computeTaxTimeline([fy("2025-26", { stcg111A: 10000 })]);
    expect(clean.taxDue).toBe(2000);
    expect(clean.taxDueBlankReasons).toEqual([]);
  });

  it("a blankReason carried in from the aggregation blanks the total too", () => {
    const [r] = computeTaxTimeline([fy("2025-26", { ltcg112: 9000, blankReasons: ["NO COST INFLATION INDEX is bundled with this release"] })]);
    expect(r.taxDue).toBeNull();
    expect(r.taxDueBlankReasons).toEqual(["NO COST INFLATION INDEX is bundled with this release"]);
    expect(r.gross.ltcg112).toBe(9000);
  });
});
