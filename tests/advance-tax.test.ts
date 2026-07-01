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
