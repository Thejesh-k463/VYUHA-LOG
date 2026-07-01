import { describe, it, expect } from "vitest";
import {
  splitBonusMultiplier,
  adjustForSplitOrBonus,
  dividendIncome,
  parseCorporateActionList,
} from "@/lib/analytics/corporate-actions";

describe("splitBonusMultiplier", () => {
  it("computes a 1:5 split as multiplier 5", () => {
    expect(splitBonusMultiplier("split", 1, 5)).toBe(5);
  });
  it("computes a 1:1 bonus as multiplier 2 (shares double)", () => {
    expect(splitBonusMultiplier("bonus", 1, 1)).toBe(2);
  });
  it("computes a 2:1 bonus (1 bonus per 2 held) as multiplier 1.5", () => {
    expect(splitBonusMultiplier("bonus", 2, 1)).toBe(1.5);
  });
  it("returns 1 (no-op) for invalid inputs", () => {
    expect(splitBonusMultiplier("split", 0, 5)).toBe(1);
    expect(splitBonusMultiplier("split", 1, 0)).toBe(1);
  });
});

describe("adjustForSplitOrBonus", () => {
  const pos = { qty: 100, avgPrice: 500, slPlanned: 450, trailingSl: 470, targetPlanned: 600 };

  it("preserves invested value for a 1:5 split", () => {
    const adj = adjustForSplitOrBonus(pos, 5);
    expect(adj.qty).toBe(500);
    expect(adj.avgPrice).toBe(100);
    expect(adj.qty * adj.avgPrice).toBeCloseTo(pos.qty * pos.avgPrice, 6);
  });

  it("scales every stop/target level proportionally", () => {
    const adj = adjustForSplitOrBonus(pos, 5);
    expect(adj.slPlanned).toBe(90); // 450/5
    expect(adj.trailingSl).toBe(94); // 470/5
    expect(adj.targetPlanned).toBe(120); // 600/5
  });

  it("preserves the ₹ stop-distance (risk amount) after adjustment", () => {
    const before = Math.abs(pos.avgPrice - pos.slPlanned!) * pos.qty;
    const adj = adjustForSplitOrBonus(pos, 5);
    const after = Math.abs(adj.avgPrice - adj.slPlanned!) * adj.qty;
    expect(after).toBeCloseTo(before, 6);
  });

  it("leaves null stop/target levels as null", () => {
    const adj = adjustForSplitOrBonus({ qty: 100, avgPrice: 500, slPlanned: null, trailingSl: null, targetPlanned: null }, 2);
    expect(adj.slPlanned).toBeNull();
    expect(adj.trailingSl).toBeNull();
    expect(adj.targetPlanned).toBeNull();
  });

  it("is a no-op for an invalid multiplier", () => {
    expect(adjustForSplitOrBonus(pos, 0)).toEqual(pos);
    expect(adjustForSplitOrBonus(pos, NaN)).toEqual(pos);
  });

  it("a 1:1 bonus doubles qty and halves avg price", () => {
    const adj = adjustForSplitOrBonus(pos, splitBonusMultiplier("bonus", 1, 1));
    expect(adj.qty).toBe(200);
    expect(adj.avgPrice).toBe(250);
  });
});

describe("dividendIncome", () => {
  it("computes gross dividend for a held quantity", () => {
    expect(dividendIncome(100, 19)).toBe(1900);
  });
  it("returns 0 for non-positive inputs", () => {
    expect(dividendIncome(0, 19)).toBe(0);
    expect(dividendIncome(100, 0)).toBe(0);
    expect(dividendIncome(-5, 19)).toBe(0);
  });
});

describe("parseCorporateActionList", () => {
  it("parses split/bonus rows with a ratio", () => {
    const rows = parseCorporateActionList("TCS, split, 01-Aug-2026, 1:5\nRELIANCE, bonus, 2026-09-01, 1:1");
    expect(rows).toEqual([
      { symbol: "TCS", type: "split", exDate: "2026-08-01", fromUnits: 1, toUnits: 5, dividendPerShare: null, note: null },
      { symbol: "RELIANCE", type: "bonus", exDate: "2026-09-01", fromUnits: 1, toUnits: 1, dividendPerShare: null, note: null },
    ]);
  });

  it("parses dividend rows with a plain per-share amount", () => {
    const rows = parseCorporateActionList("HDFCBANK, dividend, 2026-07-15, 19");
    expect(rows).toEqual([
      { symbol: "HDFCBANK", type: "dividend", exDate: "2026-07-15", fromUnits: null, toUnits: null, dividendPerShare: 19, note: null },
    ]);
  });

  it("carries a trailing note column", () => {
    const rows = parseCorporateActionList("TCS, split, 2026-08-01, 1:5, FY26 stock split announcement");
    expect(rows[0].note).toBe("FY26 stock split announcement");
  });

  it("skips comments, malformed rows, and unknown types", () => {
    const rows = parseCorporateActionList(
      ["# a comment", "BADROW, split", "TCS, merger, 2026-08-01, 1:5", "TCS, split, 2026-08-01, 1:5"].join("\n"),
    );
    expect(rows.length).toBe(1);
    expect(rows[0].symbol).toBe("TCS");
  });

  it("rejects a malformed ratio for split/bonus", () => {
    const rows = parseCorporateActionList("TCS, split, 2026-08-01, garbage");
    expect(rows).toEqual([]);
  });
});
