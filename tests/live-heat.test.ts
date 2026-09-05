import { describe, expect, it } from "vitest";
import { portfolioHeat, sectorConcentration, type HeatRow } from "@/lib/live/heat";

/**
 * Portfolio heat, exposure and concentration — spec §2.3, 03 §1.9.
 *
 * Integer paise throughout. The null cases are the reason this file exists:
 * with no capital configured, heat is NULL. "0% heat" is a statement about the
 * user's account that Vyuha has no basis to make (invariant 6).
 */

const row = (over: Partial<HeatRow> = {}): HeatRow => ({
  id: 1,
  riskAtStopP: 1_000_000, // ₹10,000.00
  investedP: 25_000_000, // ₹2,50,000.00
  sector: "IT",
  sectorTier: "user",
  ...over,
});

const CAPITAL = 100_000_000; // ₹10,00,000.00

describe("portfolioHeat", () => {
  it("is Σ risk / capital in ppm", () => {
    const h = portfolioHeat([row({ id: 1 }), row({ id: 2 })], CAPITAL);
    expect(h.heatPpm).toBe(20_000); // 2 × ₹10,000 on ₹10,00,000 = 2%
    expect(h.openRiskP).toBe(2_000_000);
  });

  it("floors PER ROW, so a rounding artefact can never push heat over a ceiling", () => {
    // 3 rows of 7 paise on a 3-paise capital base is nonsense money but exact
    // arithmetic: floor per row gives 3 × 2_333_333 and not 7_000_000.
    const rows = [row({ id: 1, riskAtStopP: 7 }), row({ id: 2, riskAtStopP: 7 }), row({ id: 3, riskAtStopP: 7 })];
    expect(portfolioHeat(rows, 3).heatPpm).toBe(3 * 2_333_333);
  });

  it("returns NULL, not 0, when capital is unconfigured", () => {
    const h = portfolioHeat([row()], null);
    expect(h.heatPpm).toBeNull();
    expect(h.heatPpm).not.toBe(0);
    expect(h.exposure.ppm).toBeNull();
    expect(h.exposure.denominator).toBeNull();
    // The facts that do not need capital are still published.
    expect(h.openRiskP).toBe(1_000_000);
    expect(h.exposureP).toBe(25_000_000);
  });

  it("treats a capital of 0 as unconfigured rather than as a zero base", () => {
    expect(portfolioHeat([row()], 0).heatPpm).toBeNull();
  });

  it("excludes rows with no stop and PUBLISHES how many, so heat is not read as complete", () => {
    const h = portfolioHeat([row({ id: 1 }), row({ id: 2, riskAtStopP: null })], CAPITAL);
    expect(h.heatPpm).toBe(10_000); // only the row that has a stop
    expect(h.rowsWithoutStop).toBe(1);
    expect(h.rowsCounted).toBe(2);
    // The stop-less row still counts toward exposure — it is deployed money.
    expect(h.exposureP).toBe(50_000_000);
  });

  it("an empty book has 0 heat against known capital, and null against none", () => {
    expect(portfolioHeat([], CAPITAL).heatPpm).toBe(0);
    expect(portfolioHeat([], null).heatPpm).toBeNull();
  });

  it("asserts no ceiling of its own: overCeiling is null until the user sets one", () => {
    expect(portfolioHeat([row()], CAPITAL).ceilingPpm).toBeNull();
    expect(portfolioHeat([row()], CAPITAL).overCeiling).toBeNull();
    expect(portfolioHeat([row()], CAPITAL, 60_000).overCeiling).toBe(false);
    expect(portfolioHeat([row({ riskAtStopP: 7_000_000 })], CAPITAL, 60_000).overCeiling).toBe(true);
  });

  it("overCeiling stays null when capital is unknown, even with a ceiling set", () => {
    expect(portfolioHeat([row()], null, 60_000).overCeiling).toBeNull();
  });

  it("exposure is Σ invested / capital", () => {
    const h = portfolioHeat([row({ id: 1 }), row({ id: 2 })], CAPITAL);
    expect(h.exposure.ppm).toBe(500_000); // 50% deployed
    expect(h.exposure.denominator).toBe(CAPITAL);
  });
});

describe("sectorConcentration", () => {
  it("is Σ exposure by node / Σ exposure, with the constituent count and tier", () => {
    const rows = [
      row({ id: 1, sector: "IT", investedP: 30_000_000 }),
      row({ id: 2, sector: "IT", investedP: 10_000_000 }),
      row({ id: 3, sector: "Banks", sectorTier: "index", investedP: 60_000_000 }),
    ];
    const c = sectorConcentration(rows);
    expect(c.map((n) => n.group)).toEqual(["Banks", "IT"]); // exposure descending
    expect(c[0].share.ppm).toBe(600_000);
    expect(c[0].constituents).toBe(1);
    expect(c[0].tier).toBe("index");
    expect(c[1].share.ppm).toBe(400_000);
    expect(c[1].constituents).toBe(2);
    expect(c[1].share.denominator).toBe(100_000_000);
  });

  it("keeps unclassified rows as their OWN node instead of inflating the others", () => {
    const rows = [row({ id: 1, sector: "IT", investedP: 50_000_000 }), row({ id: 2, sector: null, sectorTier: null, investedP: 50_000_000 })];
    const c = sectorConcentration(rows);
    expect(c).toHaveLength(2);
    expect(c.find((n) => n.group === null)?.share.ppm).toBe(500_000);
    expect(c.find((n) => n.group === "IT")?.share.ppm).toBe(500_000);
  });

  it("an empty book yields no rows at all — never an even split", () => {
    expect(sectorConcentration([])).toEqual([]);
  });

  it("a book with zero exposure publishes null shares, not 0 and not 100%", () => {
    const c = sectorConcentration([row({ investedP: 0 })]);
    expect(c[0].share.ppm).toBeNull();
    expect(c[0].share.denominator).toBeNull();
  });
});
