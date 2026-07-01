import { describe, it, expect } from "vitest";
import { computeHarvest, CG_RATES, type OpenLot } from "@/lib/analytics/harvest";

const lot = (id: number, symbol: string, term: "ST" | "LT", unrealised: number): OpenLot => ({
  id, symbol, term, qty: 100, entry: 1000, mtm: 1000 + unrealised / 100, unrealised,
});

describe("computeHarvest — set-off rules", () => {
  it("STCL offsets STCG first, saving STCG-rate tax", () => {
    const r = computeHarvest([lot(1, "A", "ST", -50000)], 40000, 0, "2026-12-01", "2027-03-31");
    expect(r.stLoss).toBe(50000);
    expect(r.stclVsStcg).toBe(40000); // capped at the STCG available
    expect(r.carryForward).toBe(10000); // 10k loss left over
    expect(r.taxSaved).toBe(8000); // 40000 × 20%
    expect(r.candidates[0].status).toBe("partial"); // 40k of 50k offset
    expect(r.candidates[0].offsetAmount).toBe(40000);
  });

  it("leftover STCL spills onto LTCG (beyond the ₹1.25L exemption)", () => {
    // STCL 2,00,000 ; STCG 50,000 ; LTCG 3,00,000 (taxable 1.75L after exemption)
    const r = computeHarvest([lot(1, "A", "ST", -200000)], 50000, 300000, "2026-12-01", "2027-03-31");
    expect(r.stclVsStcg).toBe(50000);
    expect(r.stclVsLtcg).toBe(150000); // remaining 1.5L STCL onto LTCG
    expect(r.carryForward).toBe(0);
    // saved = 50000×20% + (175000 − 25000)×12.5% = 10000 + 18750
    expect(r.taxSaved).toBe(10000 + 18750);
  });

  it("LTCL offsets LTCG only", () => {
    const r = computeHarvest([lot(1, "A", "LT", -100000)], 0, 400000, "2026-12-01", "2027-03-31");
    expect(r.ltclVsLtcg).toBe(100000);
    expect(r.stclVsStcg).toBe(0);
    // LTCG 4L taxable 2.75L; after 1L offset → 1.75L taxable; saved = 100000 × 12.5%
    expect(r.taxSaved).toBe(12500);
  });

  it("LTCL cannot offset STCG", () => {
    const r = computeHarvest([lot(1, "A", "LT", -80000)], 60000, 0, "2026-12-01", "2027-03-31");
    expect(r.ltclVsLtcg).toBe(0); // no LTCG to offset
    expect(r.taxSaved).toBe(0);
    expect(r.carryForward).toBe(80000);
    expect(r.candidates[0].status).toBe("carry");
  });
});

describe("computeHarvest — candidates & misc", () => {
  it("ignores winners and ranks losers largest-first", () => {
    const r = computeHarvest(
      [lot(1, "WIN", "ST", 30000), lot(2, "SMALL", "ST", -10000), lot(3, "BIG", "ST", -40000)],
      100000, 0, "2026-12-01", "2027-03-31",
    );
    expect(r.candidates.map((c) => c.symbol)).toEqual(["BIG", "SMALL"]);
    expect(r.candidates.every((c) => c.status === "offsets")).toBe(true); // 50k loss < 100k gains
    expect(r.taxSaved).toBe(10000); // 50000 × 20%
  });

  it("no realised gains → everything carries forward, zero tax saved", () => {
    const r = computeHarvest([lot(1, "A", "ST", -25000), lot(2, "B", "LT", -15000)], 0, 0, "2026-12-01", "2027-03-31");
    expect(r.taxSaved).toBe(0);
    expect(r.carryForward).toBe(40000);
    expect(r.candidates.every((c) => c.status === "carry")).toBe(true);
  });

  it("counts days to FY end and carries the rate card", () => {
    const r = computeHarvest([], 0, 0, "2027-03-01", "2027-03-31");
    expect(r.daysToFyEnd).toBe(30);
    expect(r.rates).toBe(CG_RATES);
  });
});
