/**
 * closedSorted must be CHRONOLOGICAL inside a day, not "whatever order the query returned".
 *
 * Found 2026-09-17 on the owner's 42-trade options book (11 sessions, 3–7 same-day trades each):
 * the dashboard reads rows newest-first, the sort keyed on sell date alone is stable, so every
 * same-day run was walked backwards — "8 wins · best 11W" for a book whose entry order says
 * 7 wins · best 10W, and a drawdown measured over a reversed day.
 */
import { describe, expect, it } from "vitest";
import { closedSorted, computeKpis, type AnalyticsTrade } from "@/lib/analytics/metrics";

const base: Omit<AnalyticsTrade, "id" | "netPnl" | "sellDate" | "exitTime"> = {
  broker: "dhan", bucket: "active", segment: "stock_option", grossPnl: 0, chargesTotal: 0, rMultiple: null,
  isOpen: false, buyDate: "2026-09-11", setupTag: null, acquisition: null, acquisitionPrice: null, buyValue: 1000,
};
const t = (id: number, sellDate: string, netPnl: number, exitTime: string | null = null): AnalyticsTrade =>
  ({ ...base, id, sellDate, netPnl, exitTime });

// Entry order: 11 Sep W L L L L · 15 Sep W W W · 16 Sep W W  → current 5 wins, best 5W, worst 4L.
const chronological = [
  t(31, "2026-09-11", 387), t(32, "2026-09-11", -1530), t(33, "2026-09-11", -1530), t(34, "2026-09-11", -600), t(35, "2026-09-11", -2327),
  t(36, "2026-09-15", 4170), t(37, "2026-09-15", 8960), t(38, "2026-09-15", 2506),
  t(41, "2026-09-16", 1112), t(42, "2026-09-16", 4320),
];
const newestFirst = chronological.slice().reverse(); // what lib/queries/trades.ts hands the dashboard

describe("closedSorted — same-day tiebreak", () => {
  it("orders newest-first input by sell date, then id, so streaks read the day forwards", () => {
    expect(closedSorted(newestFirst).map((x) => x.id)).toEqual(chronological.map((x) => x.id));
    const k = computeKpis(newestFirst);
    expect([k.currentStreak, k.maxWinStreak, k.maxLossStreak]).toEqual([5, 5, 4]);
    // The pre-fix reading of the same rows (the reversed day): W after the losses → 6 wins in a row.
    const reversedDay = computeKpis(newestFirst.map((x, i) => ({ ...x, id: undefined, exitTime: null, __i: i })));
    expect(reversedDay.currentStreak).toBe(6);
  });

  it("prefers exit time over id when both are present (a broker export's intraday order)", () => {
    const rows = [t(2, "2026-09-11", 100, "15:20"), t(1, "2026-09-11", -50, "15:25")];
    expect(closedSorted(rows).map((x) => x.id)).toEqual([2, 1]);
  });

  it("keeps input order for rows that carry neither tiebreak (narrow fixtures)", () => {
    const rows = [t(0, "2026-09-11", 1), t(0, "2026-09-11", -1)].map((x) => ({ ...x, id: undefined, exitTime: undefined }));
    expect(closedSorted(rows).map((x) => x.netPnl)).toEqual([1, -1]);
  });

  it("drawdown walks the day in entry order too", () => {
    // Max drawdown is the most negative CONTIGUOUS run, so reversing a whole book leaves it alone —
    // but reversing INSIDE each day (the pre-fix behaviour) does not: entry order 11 Sep +5000 −3000,
    // 15 Sep −4000 +2000 has a −7000 run across the day boundary; day-reversed it is −4000.
    const days = [t(1, "2026-09-11", 5000), t(2, "2026-09-11", -3000), t(3, "2026-09-15", -4000), t(4, "2026-09-15", 2000)];
    expect(computeKpis(days.slice().reverse()).maxDrawdown).toBe(7000);
    const preFix = days.slice().reverse().map((x) => ({ ...x, id: undefined, exitTime: undefined }));
    expect(computeKpis(preFix).maxDrawdown).toBe(4000);
  });
});
