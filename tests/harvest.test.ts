import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  computeHarvest,
  fyWindowFor,
  ltcgExemptionHeadroom,
  partialLot,
  type OpenLot,
} from "@/lib/analytics/harvest";
import { capitalGainsRatesFor } from "@/lib/analytics/capital-gains";

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

  it("counts days to FY end and resolves the rate card BY DATE", () => {
    const r = computeHarvest([], 0, 0, "2027-03-01", "2027-03-31");
    expect(r.daysToFyEnd).toBe(30);
    expect(r.rates).toEqual(capitalGainsRatesFor("2027-03-01"));
  });

  // The defect this replaced: harvest.ts held its own frozen post-2024 rate pair
  // while capital-gains.ts resolved by date, so a pre-cutover sale was priced at
  // post-cutover rates on this screen alone.
  it("uses the PRE-cutover schedule for a sale before 23 Jul 2024", () => {
    const r = computeHarvest([], 0, 0, "2024-06-01", "2025-03-31");
    expect(r.rates).toEqual(capitalGainsRatesFor("2024-06-01"));
    expect(r.rates.stcgPct).toBe(0.15);
    expect(r.rates.ltcgExemption).toBe(100000);
  });
});

describe("fyWindowFor — FY end derived from fyStartMonth, not a 31-Mar literal", () => {
  it("April FY: start 1-Apr, end 31-Mar of the following year", () => {
    expect(fyWindowFor("2026-09-01", 4)).toEqual({
      fyStartYear: 2026, fyStart: "2026-04-01", fyEnd: "2027-03-31", fyLabel: "2026-27",
    });
  });

  it("a date before the start month falls into the PREVIOUS FY", () => {
    expect(fyWindowFor("2026-02-10", 4)).toEqual({
      fyStartYear: 2025, fyStart: "2025-04-01", fyEnd: "2026-03-31", fyLabel: "2025-26",
    });
  });

  it("calendar-year FY (start month 1) ends 31-Dec — the case the literal got wrong", () => {
    expect(fyWindowFor("2026-09-01", 1)).toEqual({
      fyStartYear: 2026, fyStart: "2026-01-01", fyEnd: "2026-12-31", fyLabel: "2026-27",
    });
  });

  it("July FY ends 30-Jun (a 30-day month, not assumed 31)", () => {
    const w = fyWindowFor("2026-08-15", 7);
    expect(w.fyStart).toBe("2026-07-01");
    expect(w.fyEnd).toBe("2027-06-30");
  });

  it("the first day of the FY belongs to it", () => {
    expect(fyWindowFor("2026-04-01", 4).fyStartYear).toBe(2026);
  });
});

describe("ltcgExemptionHeadroom — an upper bound, never a negative", () => {
  it("no realised LTCG → the whole exemption remains", () => {
    expect(ltcgExemptionHeadroom(0, 125000)).toBe(125000);
  });

  it("partial use leaves the difference", () => {
    expect(ltcgExemptionHeadroom(50000, 125000)).toBe(75000);
  });

  it("floors at 0 once realised LTCG exceeds the exemption", () => {
    expect(ltcgExemptionHeadroom(300000, 125000)).toBe(0);
  });

  it("a realised long-term LOSS does not enlarge the headroom beyond the threshold", () => {
    expect(ltcgExemptionHeadroom(-40000, 125000)).toBe(125000);
  });
});

describe("partialLot — proportional what-if slice of a weighted-average lot", () => {
  const l = lot(1, "A", "ST", -50000); // qty 100

  it("scales unrealised P&L by the simulated fraction", () => {
    const p = partialLot(l, 40);
    expect(p.qty).toBe(40);
    expect(p.unrealised).toBe(-20000);
  });

  it("clamps to the lot's own quantity and floors fractional units", () => {
    expect(partialLot(l, 250).qty).toBe(100);
    expect(partialLot(l, 250).unrealised).toBe(-50000);
    expect(partialLot(l, 12.9).qty).toBe(12);
    expect(partialLot(l, -5).qty).toBe(0);
    expect(partialLot(l, -5).unrealised).toBe(0); // normalised, not -0
  });

  it("a zero-qty lot never divides by zero", () => {
    const z = { ...l, qty: 0 };
    expect(partialLot(z, 10).unrealised).toBe(0);
  });

  it("feeding partial lots back through computeHarvest offsets only the slice", () => {
    // Half of a 50k ST loss against 40k STCG → 25k offsets, nothing left over
    // beyond the gains, 15k STCG still exposed.
    const r = computeHarvest([partialLot(l, 50)], 40000, 0, "2026-12-01", "2027-03-31");
    expect(r.stLoss).toBe(25000);
    expect(r.stclVsStcg).toBe(25000);
    expect(r.carryForward).toBe(0);
    expect(r.taxSaved).toBe(5000); // 25000 × 20%
  });
});

// The realised STCG/LTCG the page feeds computeHarvest must be NET (post-
// charge) — the basis /reports/tax states and taxByFy/classifyGain use.
// Summing gross here once showed the same FY two different realised-gain
// figures across the two tax surfaces (audit A4, 2026-09-01).
describe("harvest page — realised gains are net, matching /reports/tax", () => {
  const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

  it("sums realised STCG/LTCG from netPnl and never reads grossPnl", () => {
    const src = read("app/reports/harvest/page.tsx");
    expect(src).toMatch(/realisedStcg \+= t\.netPnl/);
    expect(src).toMatch(/realisedLtcg \+= t\.netPnl/);
    expect(src).not.toContain("grossPnl");
  });

  it("derives the FY window from settings.fyStartMonth, never a -03-31 literal", () => {
    const src = read("app/reports/harvest/page.tsx");
    expect(src).toContain("fyWindowFor(today, fyStartMonth)");
    expect(src).not.toMatch(/-03-31`/); // the old `${fyStartYear + 1}-03-31`
  });

  it("the what-if simulator starts with NOTHING selected and says so", () => {
    // Selection is USER-initiated by design contract (tax-levers.ts (C)):
    // a pre-ticked lot is a ranked recommendation wearing a checkbox.
    const src = read("components/reports/harvest-sim.tsx");
    expect(src).toContain("useState<Record<number, number>>({})");
    expect(src).toContain("Nothing is pre-selected");
    expect(src).toContain("LTCG_THRESHOLD_CAVEAT"); // headroom KPI never renders bare
  });

  it("the harvest projection carries netPnl and dropped grossPnl", () => {
    const q = read("lib/queries/trades.ts");
    const block = q.slice(q.indexOf("const HARVEST_FIELDS"), q.indexOf("HarvestTrade"));
    expect(block.length).toBeGreaterThan(0); // both anchors found, in order
    expect(block).toContain('"netPnl"');
    expect(block).not.toContain('"grossPnl"'); // Pick<> then rejects t.grossPnl at compile time
  });
});
