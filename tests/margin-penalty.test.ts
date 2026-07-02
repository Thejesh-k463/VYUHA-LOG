import { describe, it, expect } from "vitest";
import { marginPenaltyByMonth, marginPenaltyTotal, type MarginPenaltyEntry } from "@/lib/analytics/margin-penalty";

describe("marginPenaltyByMonth", () => {
  it("groups by calendar month and sums", () => {
    const entries: MarginPenaltyEntry[] = [
      { date: "2026-06-05", amount: 300 },
      { date: "2026-06-20", amount: 150 },
      { date: "2026-07-02", amount: 400 },
    ];
    const rows = marginPenaltyByMonth(entries);
    expect(rows).toEqual([
      { month: "2026-06", count: 2, total: 450 },
      { month: "2026-07", count: 1, total: 400 },
    ]);
  });

  it("sorts months chronologically regardless of input order", () => {
    const entries: MarginPenaltyEntry[] = [
      { date: "2026-08-01", amount: 100 },
      { date: "2026-06-01", amount: 100 },
    ];
    const rows = marginPenaltyByMonth(entries);
    expect(rows.map((r) => r.month)).toEqual(["2026-06", "2026-08"]);
  });

  it("takes the absolute value regardless of stored sign", () => {
    const rows = marginPenaltyByMonth([{ date: "2026-06-05", amount: -300 }]);
    expect(rows[0].total).toBe(300);
  });

  it("returns an empty array for no entries", () => {
    expect(marginPenaltyByMonth([])).toEqual([]);
  });

  it("skips entries with no date", () => {
    const rows = marginPenaltyByMonth([{ date: "", amount: 100 }]);
    expect(rows).toEqual([]);
  });
});

describe("marginPenaltyTotal", () => {
  it("sums absolute magnitudes across all entries", () => {
    expect(marginPenaltyTotal([{ date: "2026-06-01", amount: -300 }, { date: "2026-07-01", amount: 150 }])).toBe(450);
  });

  it("returns 0 for no entries", () => {
    expect(marginPenaltyTotal([])).toBe(0);
  });
});
