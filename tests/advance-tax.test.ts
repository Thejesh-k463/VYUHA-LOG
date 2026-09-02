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

// s.408 read with s.58 (old S.211(1)(b) with S.44AD): a presumptive-scheme
// assessee pays the whole advance tax in ONE instalment by 15 March; s.425 then
// charges a single month at 1% on any shortfall after that date. Caller-asserted.
describe("computeAdvanceTax — presumptive (s.58) single instalment", () => {
  it("collapses the ladder to one instalment: 100% by 15 Mar", () => {
    const p = computeAdvanceTax({ estimatedAnnualTax: 100000, taxPaidToDate: 0, today: "2026-06-24", presumptive: true });
    expect(p.fyLabel).toBe("2026-27");
    expect(p.instalments).toHaveLength(1);
    expect(p.instalments[0].label).toBe("15 Mar");
    expect(p.instalments[0].dueDate).toBe("2027-03-15");
    expect(p.instalments[0].cumPct).toBe(100);
    expect(p.instalments[0].cumRequired).toBe(100000);
    expect(p.instalments[0].safeHarbourPct).toBeNull();
  });

  it("shortfall BEFORE 15 Mar → nothing due, no interest", () => {
    // 20 Dec: under the normal ladder Q1-Q3 would all be due and charging.
    const p = computeAdvanceTax({ estimatedAnnualTax: 100000, taxPaidToDate: 0, today: "2026-12-20", presumptive: true });
    expect(p.instalments[0].isDue).toBe(false);
    expect(p.interest234C).toBe(0);
    expect(p.totalShortfallNow).toBe(0);
    expect(p.nextDue?.label).toBe("15 Mar");
  });

  it("shortfall AFTER 15 Mar → exactly one instalment's interest (1 month × 1%)", () => {
    const p = computeAdvanceTax({ estimatedAnnualTax: 100000, taxPaidToDate: 40000, today: "2027-03-20", presumptive: true });
    expect(p.instalments[0].isDue).toBe(true);
    expect(p.instalments[0].shortfall).toBe(60000);
    expect(p.instalments[0].monthsForInterest).toBe(1);
    expect(p.interest234C).toBe(600); // 60000 × 1% × 1 month — never the 3/3/3/1 ladder
    expect(p.nextDue).toBeNull();
  });

  it("paid in full by 15 Mar → no interest at all", () => {
    const p = computeAdvanceTax({ estimatedAnnualTax: 100000, taxPaidToDate: 100000, today: "2027-03-20", presumptive: true });
    expect(p.interest234C).toBe(0);
    expect(p.instalments[0].shortfall).toBe(0);
    expect(p.underpaid234B).toBe(false);
  });

  it("names the election on screen, cited to the governing Act", () => {
    const p = computeAdvanceTax({ estimatedAnnualTax: 100000, taxPaidToDate: 0, today: "2026-12-20", presumptive: true });
    // FY 2026-27 → Income-tax Act, 2025: presumptive is s.58, instalments s.408.
    expect(p.notes.some((n) => n.includes("s.58") && n.includes("s.408"))).toBe(true);
  });

  it("s.425(4) relief still shrinks the interest base under the election", () => {
    const p = computeAdvanceTax({
      estimatedAnnualTax: 100000, taxPaidToDate: 0, today: "2027-03-20",
      presumptive: true, reliefEligibleTax: 40000, reliefTaxPaidInFull: true,
    });
    expect(p.reliefApplied).toBe(40000);
    expect(p.interest234C).toBe(600); // (100000−40000) × 1% × 1 month
    // Payment obligation stays on the full figure.
    expect(p.instalments[0].cumRequired).toBe(100000);
  });
});

// v3.7 WS4 — the dated challan ledger. Without `payments` the engine applies
// ONE cumulative scalar to every rung, so a March payment clears a June
// shortfall that was real. With it, each rung sees only what was paid on or
// before its own due date. s.408(3) draws the outer line: anything paid by
// 31 March is advance tax, anything after it is not.
describe("computeAdvanceTax — dated payments", () => {
  const est = { estimatedAnnualTax: 100000, taxPaidToDate: 0 } as const;

  it("without payments, every rung still sees the same scalar — the simplification, stated as data", () => {
    const p = computeAdvanceTax({ estimatedAnnualTax: 100000, taxPaidToDate: 45000, today: "2027-03-20" });
    expect(p.instalments.map((i) => i.paidAsOfDue)).toEqual([45000, 45000, 45000, 45000]);
  });

  it("each rung is measured against what was paid ON OR BEFORE its due date", () => {
    const p = computeAdvanceTax({
      ...est, today: "2027-03-20",
      payments: [
        { date: "2026-06-10", amount: 15000 },
        { date: "2026-09-10", amount: 30000 },
        { date: "2026-12-10", amount: 30000 },
        { date: "2027-03-10", amount: 25000 },
      ],
    });
    expect(p.instalments.map((i) => i.paidAsOfDue)).toEqual([15000, 45000, 75000, 100000]);
    expect(p.instalments.map((i) => i.shortfall)).toEqual([0, 0, 0, 0]);
    expect(p.interest234C).toBe(0);
    expect(p.taxPaidToDate).toBe(100000); // the FY total replaces the scalar
    expect(p.paidPct).toBe(100);
    expect(p.underpaid234B).toBe(false);
  });

  it("a late payment leaves the earlier rungs short — and charges what the scalar path waived", () => {
    const payments = [{ date: "2027-03-10", amount: 45000 }];
    const dated = computeAdvanceTax({ ...est, today: "2027-03-20", payments });
    const scalar = computeAdvanceTax({ estimatedAnnualTax: 100000, taxPaidToDate: 45000, today: "2027-03-20" });

    // The scalar path back-dates ₹45,000 to 15 June, which clears BOTH safe
    // harbours and waives the first two instalments outright.
    expect(scalar.instalments[0].safeHarbourMet).toBe(true);
    expect(scalar.instalments[1].safeHarbourMet).toBe(true);
    expect(scalar.instalments.map((i) => i.shortfall)).toEqual([0, 0, 30000, 55000]);
    expect(scalar.interest234C).toBe(900 + 550);

    // Dated: nothing at all stood paid on 15 June or 15 September.
    expect(dated.instalments.map((i) => i.paidAsOfDue)).toEqual([0, 0, 0, 45000]);
    expect(dated.instalments[0].safeHarbourMet).toBe(false);
    expect(dated.instalments[1].safeHarbourMet).toBe(false);
    expect(dated.instalments.map((i) => i.shortfall)).toEqual([15000, 45000, 75000, 55000]);
    expect(dated.instalments.map((i) => i.interest234C)).toEqual([450, 1350, 2250, 550]);
    expect(dated.interest234C).toBe(4600);
    // Same money, same year, ₹3,150 of interest the scalar path never charged.
    expect(dated.interest234C - scalar.interest234C).toBe(3150);
  });

  it("the s.425(2) safe harbour is decided by DATE, not by the year's total", () => {
    const inTime = computeAdvanceTax({ ...est, today: "2026-06-24", payments: [{ date: "2026-06-14", amount: 12000 }] });
    expect(inTime.instalments[0].safeHarbourMet).toBe(true);
    expect(inTime.instalments[0].interest234C).toBe(0);
    expect(inTime.instalments[0].shortfall).toBe(3000); // the obligation is still reported

    // Paid ON the due date still counts — "on or before".
    const onTheDay = computeAdvanceTax({ ...est, today: "2026-06-24", payments: [{ date: "2026-06-15", amount: 12000 }] });
    expect(onTheDay.instalments[0].safeHarbourMet).toBe(true);

    // One day late: the same ₹12,000, no harbour, interest on the full rung.
    const late = computeAdvanceTax({ ...est, today: "2026-06-24", payments: [{ date: "2026-06-16", amount: 12000 }] });
    expect(late.instalments[0].safeHarbourMet).toBe(false);
    expect(late.instalments[0].paidAsOfDue).toBe(0);
    expect(late.instalments[0].shortfall).toBe(15000);
    expect(late.instalments[0].interest234C).toBe(450);
    expect(late.taxPaidToDate).toBe(12000);
    // "Shortfall now" is measured at TODAY, not at the due date — the money did arrive.
    expect(late.totalShortfallNow).toBe(3000);
  });

  it("a payment after 31 March is not advance tax, and the note says so", () => {
    const p = computeAdvanceTax({
      ...est, today: "2027-03-20",
      payments: [{ date: "2026-06-10", amount: 60000 }, { date: "2027-04-05", amount: 40000 }],
    });
    expect(p.taxPaidToDate).toBe(60000); // NOT 100000
    expect(p.instalments.map((i) => i.paidAsOfDue)).toEqual([60000, 60000, 60000, 60000]);
    expect(p.instalments.map((i) => i.interest234C)).toEqual([0, 0, 450, 400]);
    expect(p.underpaid234B).toBe(true);
    const note = p.notes.find((n) => n.includes("2027-04-05"));
    expect(note).toBeDefined();
    expect(note).toContain("self-assessment");
    expect(note).toContain("31 March");
    expect(note).toContain("₹40,000");
    expect(note).toContain("s.408"); // cited to the governing Act, never "S.211"
  });

  // The regression that matters: dating payments must not move a single number
  // when the dating makes no difference.
  it("scalar and dated paths agree when every payment is dated before 15 June", () => {
    const payments = [{ date: "2026-04-10", amount: 8000 }, { date: "2026-06-01", amount: 4000 }];
    for (const today of ["2026-06-24", "2026-11-01", "2027-03-20"]) {
      const dated = computeAdvanceTax({ ...est, today, payments });
      const scalar = computeAdvanceTax({ estimatedAnnualTax: 100000, taxPaidToDate: 12000, today });
      expect({ ...dated, notes: undefined }).toEqual({ ...scalar, notes: undefined });
      // The dated path only ADDS prose — it never drops a statutory caveat.
      for (const n of scalar.notes) expect(dated.notes).toContain(n);
    }
  });

  it("names the dated basis on screen rather than changing the figures silently", () => {
    const p = computeAdvanceTax({ ...est, today: "2027-03-20", payments: [{ date: "2026-06-10", amount: 15000 }] });
    expect(p.notes.some((n) => n.includes("DATED payments"))).toBe(true);
    expect(p.notes.some((n) => n.includes("1 payment"))).toBe(true);
  });

  // An EMPTY ledger is a ledger that has SAID NOTHING (invariant 6) — which is
  // exactly what challanTotalsByFy returns for an FY with no challans in it. It
  // used to be read as a positive "₹0 paid, dated", which threw away the figure
  // the caller had typed and charged interest on money the user had told us
  // about. The guard now sits at the boundary, not at whichever call site
  // remembers to write `ledger.count > 0`.
  it("an EMPTY payments array is ABSENT, not ₹0 — it never overrules taxPaidToDate", () => {
    const empty = computeAdvanceTax({ estimatedAnnualTax: 1000000, taxPaidToDate: 900000, today: "2027-03-20", payments: [] });
    const none = computeAdvanceTax({ estimatedAnnualTax: 1000000, taxPaidToDate: 900000, today: "2027-03-20" });

    // Indistinguishable from not passing `payments` at all — notes included, so
    // the plan cannot even claim a "DATED payments" basis it does not have.
    expect(empty).toEqual(none);

    expect(empty.taxPaidToDate).toBe(900000); // NOT 0
    expect(empty.paidPct).toBe(90);
    expect(empty.instalments.map((i) => i.paidAsOfDue)).toEqual([900000, 900000, 900000, 900000]);
    // Only the March rung is short: ₹1,00,000 × 1% × 1 month. Read as "₹0 paid"
    // this was ₹50,500 — 4,500 + 13,500 + 22,500 + 10,000 on a full ladder.
    expect(empty.interest234C).toBe(1000);
    expect(empty.underpaid234B).toBe(false);
    expect(empty.notes.some((n) => n.includes("DATED payments"))).toBe(false);
  });

  it("ONE dated payment still switches the engine to the dated basis", () => {
    // The empty-is-absent guard must not swallow a real ledger of one row.
    const p = computeAdvanceTax({ estimatedAnnualTax: 1000000, taxPaidToDate: 900000, today: "2027-03-20", payments: [{ date: "2027-03-10", amount: 450000 }] });
    expect(p.taxPaidToDate).toBe(450000); // the ledger replaces the scalar
    expect(p.instalments.map((i) => i.paidAsOfDue)).toEqual([0, 0, 0, 450000]);
    expect(p.notes.some((n) => n.includes("DATED payments"))).toBe(true);
  });

  it("works under the presumptive election too — one rung, its own due date", () => {
    const late = computeAdvanceTax({
      ...est, today: "2027-03-20", presumptive: true,
      payments: [{ date: "2027-03-20", amount: 100000 }],
    });
    expect(late.instalments[0].paidAsOfDue).toBe(0); // paid AFTER 15 Mar
    expect(late.interest234C).toBe(1000); // 100000 × 1% × 1 month
    const onTime = computeAdvanceTax({
      ...est, today: "2027-03-20", presumptive: true,
      payments: [{ date: "2027-03-14", amount: 100000 }],
    });
    expect(onTime.interest234C).toBe(0);
  });
});
