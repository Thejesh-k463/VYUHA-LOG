import { describe, it, expect } from "vitest";
import { computeAdvanceTax } from "@/lib/analytics/advance-tax";

describe("computeAdvanceTax — schedule", () => {
  // Mid-FY: 24 Jun 2026 → Q1 (15 Jun) is due, rest upcoming. FY 2026-27.
  const p = computeAdvanceTax({ estimatedAnnualTax: 100000, taxPaidToDate: 0, today: "2026-06-24" });

  it("derives the FY and the four cumulative instalments", () => {
    expect(p.fyLabel).toBe("2026-27");
    expect(p.instalments.map((i) => i.cumPct)).toEqual([15, 45, 75, 100]);
    expect(p.instalments.map((i) => i.cumRequired)).toEqual([15000, 45000, 75000, 100000]);
    expect(p.instalments.map((i) => i.instalmentAmount)).toEqual([15000, 30000, 30000, 25000]);
  });

  it("marks Q1 due and flags the shortfall + 234C interest", () => {
    const q1 = p.instalments[0];
    expect(q1.isDue).toBe(true);
    expect(q1.shortfall).toBe(15000); // nothing paid
    expect(q1.interest234C).toBe(450); // 1% × 3 months × 15000
    expect(p.instalments[1].isDue).toBe(false); // 15 Sep not yet due
    expect(p.nextDue?.label).toBe("15 Sep");
  });

  it("before 15 Jun nothing is due", () => {
    const e = computeAdvanceTax({ estimatedAnnualTax: 100000, taxPaidToDate: 0, today: "2026-05-01" });
    expect(e.instalments.every((i) => !i.isDue)).toBe(true);
    expect(e.interest234C).toBe(0);
    expect(e.nextDue?.label).toBe("15 Jun");
  });

  it("paying the cumulative requirement removes the shortfall", () => {
    const paid = computeAdvanceTax({ estimatedAnnualTax: 100000, taxPaidToDate: 15000, today: "2026-06-24" });
    expect(paid.instalments[0].shortfall).toBe(0);
    expect(paid.interest234C).toBe(0);
    expect(paid.paidPct).toBe(15);
  });
});

describe("computeAdvanceTax — year-end & 234B flag", () => {
  it("the last instalment uses 1 month for 234C", () => {
    // 20 Mar 2027: all four due, nothing paid. (FY 2026-27, Mar 15 has passed.)
    const p = computeAdvanceTax({ estimatedAnnualTax: 100000, taxPaidToDate: 0, today: "2027-03-20" });
    expect(p.instalments.every((i) => i.isDue)).toBe(true);
    // 234C: 15000×3% + 45000×3% + 75000×3% + 100000×1% = 450+1350+2250+1000
    expect(p.interest234C).toBe(450 + 1350 + 2250 + 1000);
    expect(p.underpaid234B).toBe(true); // nothing paid → would attract 234B
  });

  it("90%+ paid clears the 234B flag", () => {
    const p = computeAdvanceTax({ estimatedAnnualTax: 100000, taxPaidToDate: 90000, today: "2027-03-20" });
    expect(p.underpaid234B).toBe(false);
  });

  it("zero tax → empty plan, no interest", () => {
    const p = computeAdvanceTax({ estimatedAnnualTax: 0, taxPaidToDate: 0, today: "2026-06-24" });
    expect(p.totalWithInterest).toBe(0);
    expect(p.interest234C).toBe(0);
    expect(p.paidPct).toBe(0);
    expect(p.underpaid234B).toBe(false);
  });
});

// s.425(2) of the Income-tax Act, 2025 (the old §234C proviso), verified against
// the Gazette text and unamended by the Finance Act, 2026:
//   no interest if ≥12% is paid by 15 June, or ≥36% by 15 September.
// FIRST TWO INSTALMENTS ONLY — there is no tolerance for December or March.
// This was previously unimplemented, so the planner charged interest the statute
// does not.
describe("computeAdvanceTax — s.425(2) safe harbour", () => {
  it("12% by 15 June waives Q1 interest even though 15% was required", () => {
    const p = computeAdvanceTax({ estimatedAnnualTax: 100000, taxPaidToDate: 12000, today: "2026-06-24" });
    const q1 = p.instalments[0];
    expect(q1.safeHarbourPct).toBe(12);
    expect(q1.safeHarbourMet).toBe(true);
    // The ₹3,000 shortfall is still REPORTED — the payment obligation is real…
    expect(q1.shortfall).toBe(3000);
    // …but no interest arises on it.
    expect(q1.interest234C).toBe(0);
    expect(p.interest234C).toBe(0);
  });

  it("just under 12% does not qualify, and interest runs on the full shortfall", () => {
    const p = computeAdvanceTax({ estimatedAnnualTax: 100000, taxPaidToDate: 11999, today: "2026-06-24" });
    expect(p.instalments[0].safeHarbourMet).toBe(false);
    expect(p.instalments[0].interest234C).toBe(90); // (15000 − 11999) × 3%
  });

  it("36% by 15 September waives Q2", () => {
    const p = computeAdvanceTax({ estimatedAnnualTax: 100000, taxPaidToDate: 36000, today: "2026-09-20" });
    expect(p.instalments[1].safeHarbourPct).toBe(36);
    expect(p.instalments[1].safeHarbourMet).toBe(true);
    expect(p.instalments[1].interest234C).toBe(0);
  });

  it("December and March have NO safe harbour", () => {
    const p = computeAdvanceTax({ estimatedAnnualTax: 100000, taxPaidToDate: 74000, today: "2027-03-20" });
    expect(p.instalments[2].safeHarbourPct).toBeNull();
    expect(p.instalments[3].safeHarbourPct).toBeNull();
    expect(p.instalments[2].safeHarbourMet).toBe(false);
    expect(p.instalments[3].safeHarbourMet).toBe(false);
    // Q1 and Q2 are waived (74000 clears both 12% and 36%), Q3/Q4 are not.
    expect(p.instalments[2].interest234C).toBe(30); // (75000 − 74000) × 3%
    expect(p.instalments[3].interest234C).toBe(260); // (100000 − 74000) × 1%
  });

  it("names the waiver on screen rather than silently zeroing a number", () => {
    const p = computeAdvanceTax({ estimatedAnnualTax: 100000, taxPaidToDate: 12000, today: "2026-06-24" });
    expect(p.notes.some((n) => n.includes("safe harbour"))).toBe(true);
    expect(p.notes.some((n) => n.includes("s.425"))).toBe(true);
  });
});

// s.425(4): relief for a shortfall caused by underestimating capital gains,
// dividend, casual income, or FIRST-TIME business income — but ONLY if the tax
// on it is paid in full by 31 March. The conditions are conjunctive.
describe("computeAdvanceTax — s.425(4) relief", () => {
  const base = { estimatedAnnualTax: 100000, taxPaidToDate: 0, today: "2027-03-20" } as const;

  it("is NOT applied unless the payment condition is asserted", () => {
    const p = computeAdvanceTax({ ...base, reliefEligibleTax: 40000 });
    expect(p.reliefApplied).toBe(0);
    expect(p.interest234C).toBe(450 + 1350 + 2250 + 1000);
  });

  it("excludes the relieved tax from the interest base once asserted", () => {
    const p = computeAdvanceTax({ ...base, reliefEligibleTax: 40000, reliefTaxPaidInFull: true });
    expect(p.reliefApplied).toBe(40000);
    // Interest now runs on a ₹60,000 base: 9000×3% + 27000×3% + 45000×3% + 60000×1%
    expect(p.interest234C).toBe(270 + 810 + 1350 + 600);
  });

  it("leaves the PAYMENT obligation on the full figure — relief is interest-only", () => {
    const p = computeAdvanceTax({ ...base, reliefEligibleTax: 40000, reliefTaxPaidInFull: true });
    expect(p.instalments.map((i) => i.cumRequired)).toEqual([15000, 45000, 75000, 100000]);
    expect(p.totalShortfallNow).toBe(100000);
  });

  it("cannot relieve more tax than the year actually carries", () => {
    const p = computeAdvanceTax({ ...base, reliefEligibleTax: 500000, reliefTaxPaidInFull: true });
    expect(p.reliefApplied).toBe(100000);
    expect(p.interest234C).toBe(0);
  });

  it("warns about the first-time-business-income trap when unapplied", () => {
    const p = computeAdvanceTax(base);
    expect(p.notes.some((n) => n.includes("FIRST TIME"))).toBe(true);
  });

  it("says plainly that s.424 is not reduced by the relief", () => {
    const p = computeAdvanceTax({ ...base, reliefEligibleTax: 40000, reliefTaxPaidInFull: true });
    expect(p.notes.some((n) => n.includes("s.424"))).toBe(true);
    expect(p.underpaid234B).toBe(true);
  });
});
