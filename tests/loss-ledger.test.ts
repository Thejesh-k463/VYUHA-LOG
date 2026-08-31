import { describe, it, expect } from "vitest";
import { computeTaxTimeline, lossExpiryFy, type FyGrossGains } from "@/lib/analytics/capital-gains";
import { buildLossLedger } from "@/lib/analytics/loss-ledger";

const base = { stcg: 0, ltcg: 0, speculative: 0, nonSpeculative: 0, stcgRate: 0.2, ltcgRate: 0.125, ltcgExemption: 125000 };
const fy = (label: string, o: Partial<FyGrossGains>): FyGrossGains => ({ ...base, fy: label, ...o });

describe("lossExpiryFy — the 8/8/8/4-year carry-forward windows", () => {
  it("capital losses and non-speculative business losses live 8 years", () => {
    expect(lossExpiryFy("stcl", "2020-21")).toBe("2028-29");
    expect(lossExpiryFy("ltcl", "2020-21")).toBe("2028-29");
    expect(lossExpiryFy("nonSpeculative", "2020-21")).toBe("2028-29");
  });

  it("speculative business losses live only 4 years", () => {
    expect(lossExpiryFy("speculative", "2020-21")).toBe("2024-25");
  });

  it("agrees with the timeline's own pruning: usable IN the expiry FY, gone the FY after", () => {
    expect(lossExpiryFy("stcl", "2016-17")).toBe("2024-25");
    // Usable in the FY the helper names…
    const used = computeTaxTimeline([fy("2016-17", { stcg: -10000 }), fy("2024-25", { stcg: 10000 })]);
    expect(used[1].taxableStcg).toBe(0);
    expect(used[1].usedCarryForward).toEqual([{ bucket: "stcl", fyIncurred: "2016-17", amount: 10000 }]);
    // …and pruned the FY after.
    const gone = computeTaxTimeline([fy("2016-17", { stcg: -10000 }), fy("2025-26", { stcg: 10000 })]);
    expect(gone[1].taxableStcg).toBe(10000);
    expect(gone[1].usedCarryForward).toEqual([]);
    expect(gone[1].newCarryForward).toEqual([]);
  });

  it("agrees with pruning for the 4-year speculative window too", () => {
    expect(lossExpiryFy("speculative", "2020-21")).toBe("2024-25");
    const used = computeTaxTimeline([fy("2020-21", { speculative: -5000 }), fy("2024-25", { speculative: 5000 })]);
    expect(used[1].taxableSpeculative).toBe(0);
    const gone = computeTaxTimeline([fy("2020-21", { speculative: -5000 }), fy("2025-26", { speculative: 5000 })]);
    expect(gone[1].taxableSpeculative).toBe(5000);
  });
});

describe("buildLossLedger — surviving vintages as of the latest FY", () => {
  it("empty timeline → empty ledger", () => {
    expect(buildLossLedger([])).toEqual([]);
  });

  it("no losses anywhere → empty ledger", () => {
    const t = computeTaxTimeline([fy("2024-25", { stcg: 50000 })]);
    expect(buildLossLedger(t)).toEqual([]);
  });

  it("a fully absorbed vintage drops out", () => {
    const t = computeTaxTimeline([fy("2023-24", { stcg: -10000 }), fy("2024-25", { stcg: 10000 })]);
    expect(buildLossLedger(t)).toEqual([]);
  });

  it("partial absorption: original, absorbed and remaining reconcile", () => {
    const t = computeTaxTimeline([fy("2023-24", { stcg: -100000 }), fy("2024-25", { stcg: 30000 })]);
    expect(buildLossLedger(t)).toEqual([
      {
        bucket: "stcl",
        fyIncurred: "2023-24",
        originalAmount: 100000,
        absorbed: 30000,
        remaining: 70000,
        expiresAfterFy: "2031-32",
      },
    ]);
  });

  it("absorption across MULTIPLE later FYs sums into one absorbed figure", () => {
    const t = computeTaxTimeline([
      fy("2022-23", { stcg: -100000 }),
      fy("2023-24", { stcg: 25000 }),
      fy("2024-25", { stcg: 15000 }),
    ]);
    const ledger = buildLossLedger(t);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ bucket: "stcl", fyIncurred: "2022-23", originalAmount: 100000, absorbed: 40000, remaining: 60000 });
    expect(ledger[0].originalAmount).toBe(ledger[0].absorbed + ledger[0].remaining);
  });

  it("a vintage incurred in the LATEST FY appears untouched (absorbed 0)", () => {
    const t = computeTaxTimeline([fy("2024-25", { ltcg: -40000 })]);
    expect(buildLossLedger(t)).toEqual([
      { bucket: "ltcl", fyIncurred: "2024-25", originalAmount: 40000, absorbed: 0, remaining: 40000, expiresAfterFy: "2032-33" },
    ]);
  });

  it("an expired vintage never reaches the ledger", () => {
    // Speculative window is 4 years: a 2016-17 loss is long gone by 2025-26.
    const t = computeTaxTimeline([fy("2016-17", { speculative: -5000 }), fy("2025-26", { stcg: 1000 })]);
    expect(buildLossLedger(t)).toEqual([]);
  });

  it("multiple vintages sort oldest-first, then in bucket order", () => {
    const t = computeTaxTimeline([
      fy("2023-24", { nonSpeculative: -20000, speculative: -8000 }),
      fy("2024-25", { stcg: -12000 }),
    ]);
    const ledger = buildLossLedger(t);
    expect(ledger.map((r) => [r.fyIncurred, r.bucket])).toEqual([
      ["2023-24", "speculative"],
      ["2023-24", "nonSpeculative"],
      ["2024-25", "stcl"],
    ]);
    expect(ledger.find((r) => r.bucket === "speculative")!.expiresAfterFy).toBe("2027-28");
    expect(ledger.find((r) => r.bucket === "nonSpeculative")!.expiresAfterFy).toBe("2031-32");
  });
});
