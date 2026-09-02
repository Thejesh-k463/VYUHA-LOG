import { describe, it, expect } from "vitest";
import { isoWeek, isoWeekLabel, isoWeekStart } from "@/lib/analytics/week";
import { disciplineByWeek, type DisciplineTrade } from "@/lib/analytics/discipline";
import { processScoreByWeek, type ProcessTrade } from "@/lib/analytics/process-score";

// `isoWeek()` was private to lib/analytics/discipline.ts until v3.7. Three
// callers now need it (the discipline table, the Process Score, and
// weekly_reviews.week_start), so it moved to lib/analytics/week.ts. These tests
// pin the boundaries and — the one that matters — that the extraction did not
// move a single trade into a different week.

describe("isoWeek — Monday/Sunday boundaries", () => {
  it("a Monday is its own week start", () => {
    // 2026-06-01 is a Monday.
    expect(isoWeekStart("2026-06-01")).toBe("2026-06-01");
    expect(isoWeekLabel("2026-06-01")).toBe("2026-W23");
  });

  it("the Sunday that ends the week still points at that Monday", () => {
    // 2026-06-07 is the Sunday of the same ISO week.
    expect(isoWeekStart("2026-06-07")).toBe("2026-06-01");
    expect(isoWeekLabel("2026-06-07")).toBe("2026-W23");
  });

  it("the next Monday opens the next week", () => {
    expect(isoWeekStart("2026-06-08")).toBe("2026-06-08");
    expect(isoWeekLabel("2026-06-08")).toBe("2026-W24");
  });

  it("every day of one week resolves to the SAME Monday", () => {
    const days = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05", "2026-06-06", "2026-06-07"];
    expect(new Set(days.map(isoWeekStart))).toEqual(new Set(["2026-06-01"]));
  });

  // The bug the extraction fixed: the Monday was built from LOCAL midnight and
  // then serialised with toISOString(), which is UTC — in any zone east of
  // Greenwich that lands on the previous day, so weekStart read as the SUNDAY.
  it("what it returns is genuinely a Monday, in this machine's timezone", () => {
    for (const d of ["2026-01-15", "2026-03-01", "2026-06-07", "2026-08-31", "2026-12-25", "2027-02-28"]) {
      const start = isoWeekStart(d);
      expect(new Date(start + "T00:00:00").getDay()).toBe(1); // 1 = Monday
      expect(start <= d).toBe(true);
    }
  });
});

describe("isoWeek — year boundaries", () => {
  // ISO-8601: a week belongs to the year that owns its THURSDAY.
  it("31 Dec 2025 belongs to 2026-W01, which starts in December", () => {
    expect(isoWeek("2025-12-31")).toEqual({ label: "2026-W01", monday: "2025-12-29" });
    expect(isoWeek("2026-01-01")).toEqual({ label: "2026-W01", monday: "2025-12-29" });
  });

  it("the week spanning 31 Dec / 1 Jan is ONE week, not two", () => {
    const spanning = ["2025-12-29", "2025-12-31", "2026-01-01", "2026-01-04"];
    expect(new Set(spanning.map(isoWeekLabel))).toEqual(new Set(["2026-W01"]));
    expect(new Set(spanning.map(isoWeekStart))).toEqual(new Set(["2025-12-29"]));
    // …and 5 Jan starts W02.
    expect(isoWeek("2026-01-05")).toEqual({ label: "2026-W02", monday: "2026-01-05" });
  });

  it("a 30 Dec Monday opens the NEXT year's W01", () => {
    expect(isoWeek("2024-12-30")).toEqual({ label: "2025-W01", monday: "2024-12-30" });
  });
});

// ---------------------------------------------------------------------------
// The extraction guard: identical bucketing, before and after.
// ---------------------------------------------------------------------------
// This is the v3.6 label arithmetic, copied verbatim out of the private
// isoWeek() that used to live in lib/analytics/discipline.ts. It is the
// "before" side of the comparison and must NOT be refactored to call the new
// module — the whole point is that it is an independent second opinion.
function legacyIsoWeekLabel(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const day = (d.getDay() + 6) % 7; // 0=Mon
  const monday = new Date(d);
  monday.setDate(d.getDate() - day);
  const thursday = new Date(monday);
  thursday.setDate(monday.getDate() + 3);
  const yearStart = new Date(thursday.getFullYear(), 0, 1);
  const week = Math.ceil((((thursday.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${thursday.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

// RECORDED NEWEST-FIRST, ON PURPOSE. Every production caller of these two
// bucketers feeds `getTrades()`, which is ordered newest-first, so the Map they
// build is populated newest week first and the trailing
// `.sort((a, b) => a.weekStart.localeCompare(b.weekStart))` is the ONLY thing
// putting the Review Desk's history strip and the weekly discipline table into
// reading order. A chronological fixture is already sorted by insertion, so
// deleting that sort would change nothing and the suite would stay green — the
// same trap tests/challans.test.ts records its rows newest-first to avoid.
const SELL_DATES = [
  "2027-01-03", "2026-12-28", // 2026-W53
  "2026-06-08", // 2026-W24
  "2026-06-07", "2026-06-01", // 2026-W23
  "2026-01-09", "2026-01-05", // 2026-W02
  "2026-01-04", "2026-01-01", "2025-12-31", "2025-12-29", // all 2026-W01
];

/** Oldest first — what both bucketers must return, whatever order they were fed. */
const EXPECTED_WEEKS = ["2026-W01", "2026-W02", "2026-W23", "2026-W24", "2026-W53"];
const EXPECTED_STARTS = ["2025-12-29", "2026-01-05", "2026-06-01", "2026-06-08", "2026-12-28"];

const trades: DisciplineTrade[] = SELL_DATES.map((sellDate, i) => ({
  sellDate,
  netPnl: i % 3 === 0 ? -1200 : 900,
  riskAmount: 5000,
  slPlanned: i % 2 === 0 ? 100 : null,
  targetPlanned: null,
  isOpen: false,
}));

describe("the extraction moved no trade into a different week", () => {
  it("disciplineByWeek buckets exactly what the v3.6 bucketer did", () => {
    const expected = new Map<string, number>();
    for (const d of SELL_DATES) expected.set(legacyIsoWeekLabel(d), (expected.get(legacyIsoWeekLabel(d)) ?? 0) + 1);

    const weeks = disciplineByWeek(trades, 9500, 25000);
    // A LITERAL expected sequence, never a sorted copy of the actual — and the
    // fixture spans a year boundary and a 53-week year on the way through.
    expect(weeks.map((w) => w.week)).toEqual(EXPECTED_WEEKS);
    expect(new Set(expected.keys())).toEqual(new Set(EXPECTED_WEEKS));
    expect(new Map(weeks.map((w) => [w.week, w.trades]))).toEqual(expected);
  });

  it("open trades and trades with no sell date are bucketed by neither", () => {
    const withNoise: DisciplineTrade[] = [
      ...trades,
      { sellDate: null, netPnl: 0, riskAmount: null, slPlanned: null, targetPlanned: null, isOpen: true },
      { sellDate: "2026-06-02", netPnl: 500, riskAmount: null, slPlanned: null, targetPlanned: null, isOpen: true },
    ];
    const weeks = disciplineByWeek(withNoise, 9500, 25000);
    expect(weeks.find((w) => w.week === "2026-W23")!.trades).toBe(2); // not 3
  });
});

describe("one bucketer — disciplineByWeek and processScoreByWeek agree", () => {
  it("identical trades land in identical weeks, in the same order", () => {
    const asProcess: ProcessTrade[] = trades.map((t) => ({
      ...t, playbookId: null, ruleViolations: null, reviewedAt: null,
    }));
    const a = disciplineByWeek(trades, 9500, 25000);
    const b = processScoreByWeek(asProcess, { perTradeCap: 9500, dailyStop: 25000 });
    expect(a.map((w) => [w.week, w.weekStart, w.trades])).toEqual(b.map((w) => [w.week, w.weekStart, w.trades]));
  });

  it("the fixture really is out of order — otherwise the next case proves nothing", () => {
    const asFed = [...new Set(SELL_DATES.map(isoWeekStart))];
    expect(asFed).not.toEqual([...asFed].sort());
    expect(asFed[0]).toBe(EXPECTED_STARTS[EXPECTED_STARTS.length - 1]); // newest week first in
  });

  it("both bucketers come back oldest first, from a book recorded newest-first", () => {
    // Literal sequences. `expect(starts).toEqual([...starts].sort())` — what
    // this replaces — compares the actual against a sorted copy of ITSELF and
    // is true for every possible input, including a reversed one.
    const asProcess: ProcessTrade[] = trades.map((t) => ({
      ...t, playbookId: null, ruleViolations: null, reviewedAt: null,
    }));
    const a = disciplineByWeek(trades, 9500, 25000);
    const b = processScoreByWeek(asProcess, { perTradeCap: 9500, dailyStop: 25000 });
    expect(a.map((w) => w.weekStart)).toEqual(EXPECTED_STARTS);
    expect(b.map((w) => w.weekStart)).toEqual(EXPECTED_STARTS);
    expect(a.map((w) => w.week)).toEqual(EXPECTED_WEEKS);
  });
});
