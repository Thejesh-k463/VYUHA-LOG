import { describe, expect, it } from "vitest";
import {
  aggregateGoals,
  aggregateGoalProgress,
  daysBetween,
  goalProgress,
  trailingRunRate,
  type AccountGoalFacts,
  type GoalBucket,
  type GoalFacts,
  type RealisedDay,
} from "@/lib/analytics/goal";

/**
 * WS2 — goal maths (pure, invariant 2). Everything here is RUPEES: the
 * moneyPaise column type converts at the DB boundary, and the query test
 * (tests/goals.test.ts) proves that round-trip; this file proves the maths on
 * the rupee values it receives.
 */

const TODAY = "2026-09-02";

const absGoal = (over: Partial<GoalFacts> = {}): GoalFacts => ({
  bucket: "equity",
  kind: "absolute",
  targetAmount: 2000000,
  pctTarget: null,
  baselineCapital: 1500000,
  baselineDate: "2026-07-01",
  targetDate: null,
  ...over,
});

const pctGoal = (over: Partial<GoalFacts> = {}): GoalFacts => ({
  bucket: "total",
  kind: "pct_profit",
  targetAmount: null,
  pctTarget: 20,
  baselineCapital: 1000000,
  baselineDate: "2026-07-01",
  targetDate: null,
  ...over,
});

// ₹50,000 realised inside the baseline window, ₹10,000 before it.
const realised: RealisedDay[] = [
  { date: "2026-06-15", net: 10000 }, // pre-baseline — must not count as progress
  { date: "2026-07-10", net: 30000 },
  { date: "2026-08-20", net: 25000 },
  { date: "2026-08-30", net: -5000 },
];

describe("absolute goals with a frozen baseline", () => {
  it("walks the frozen baseline through realised P&L since the baseline date", () => {
    const p = goalProgress(absGoal(), { currentCapital: 1500000, realised, today: TODAY });
    expect(p.measurable).toBe(true);
    expect(p.targetLevel).toBe(2000000);
    expect(p.achieved).toBe(1550000); // 15L + 50k since baseline; the June 10k is excluded
    expect(p.progressAmount).toBe(50000);
    expect(p.progressPct).toBe(10); // 50k of the 5L baseline→target span
    expect(p.gapAmount).toBe(450000);
    expect(p.status).toBe("inProgress");
  });

  it("capital EDITS after creation are not progress — currentCapital is ignored when a baseline exists", () => {
    const bumped = goalProgress(absGoal(), { currentCapital: 9999999, realised, today: TODAY });
    const normal = goalProgress(absGoal(), { currentCapital: 1500000, realised, today: TODAY });
    expect(bumped.achieved).toBe(normal.achieved);
  });

  it("reports achieved when the walk reaches the target", () => {
    const p = goalProgress(absGoal({ targetAmount: 1540000 }), { currentCapital: null, realised, today: TODAY });
    expect(p.status).toBe("achieved");
    expect(p.gapAmount).toBeLessThanOrEqual(0);
  });
});

describe("absolute goals without a baseline (capital unknown at creation)", () => {
  it("falls back to the current capital statement", () => {
    const p = goalProgress(absGoal({ baselineCapital: null }), { currentCapital: 1600000, realised, today: TODAY });
    expect(p.measurable).toBe(true);
    expect(p.achieved).toBe(1600000);
    expect(p.progressAmount).toBeNull(); // no baseline to diff against
    expect(p.progressPct).toBe(80); // share of the level attained
    expect(p.gapAmount).toBe(400000);
  });

  it("is NOT measurable when current capital is unknown too — never a 0 (invariant 6)", () => {
    const p = goalProgress(absGoal({ baselineCapital: null }), { currentCapital: null, realised, today: TODAY });
    expect(p.measurable).toBe(false);
    expect(p.reason).toBe("capital-unknown");
    expect(p.status).toBe("notMeasurable");
    expect(p.progressPct).toBeNull();
    expect(p.gapAmount).toBeNull();
    // Run-rates are realised-series facts and survive an unmeasurable goal.
    expect(p.runRate30).not.toBeNull();
  });
});

describe("%-profit goals", () => {
  it("resolves the target level off the frozen baseline", () => {
    const p = goalProgress(pctGoal(), { currentCapital: 1000000, realised, today: TODAY });
    expect(p.targetLevel).toBe(1200000); // 10L × 1.20
    expect(p.achieved).toBe(1050000);
    expect(p.progressAmount).toBe(50000);
    expect(p.progressPct).toBe(25); // 50k of the 2L profit target
    expect(p.gapAmount).toBe(150000);
  });

  it("REQUIRES the frozen baseline — unknown baseline is notMeasurable, never re-baselined to today", () => {
    const p = goalProgress(pctGoal({ baselineCapital: null }), { currentCapital: 1000000, realised, today: TODAY });
    expect(p.measurable).toBe(false);
    expect(p.reason).toBe("baseline-unknown");
    expect(p.progressPct).toBeNull();
  });

  it("a missing pct target is refused as unmeasurable, not defaulted to 0%", () => {
    const p = goalProgress(pctGoal({ pctTarget: null }), { currentCapital: 1000000, realised, today: TODAY });
    expect(p.measurable).toBe(false);
    expect(p.reason).toBe("target-missing");
  });
});

describe("run-rates (₹/week from trailing realised windows)", () => {
  it("windows the realised series from today", () => {
    // Trailing 30d from 2026-09-02 starts 2026-08-04: 25,000 − 5,000 = 20,000.
    expect(trailingRunRate(realised, TODAY, 30)).toBe(r2((20000 / 30) * 7));
    // Trailing 90d starts 2026-06-05: all four days = 60,000.
    expect(trailingRunRate(realised, TODAY, 90)).toBe(r2((60000 / 90) * 7));
  });

  it("an EMPTY realised history yields null — a quiet window over a real history yields a true 0", () => {
    expect(trailingRunRate([], TODAY, 30)).toBeNull();
    const oldOnly: RealisedDay[] = [{ date: "2026-01-05", net: 40000 }];
    expect(trailingRunRate(oldOnly, TODAY, 30)).toBe(0);
  });

  it("goalProgress carries both windows", () => {
    const p = goalProgress(absGoal(), { currentCapital: null, realised, today: TODAY });
    expect(p.runRate30).toBe(r2((20000 / 30) * 7));
    expect(p.runRate90).toBe(r2((60000 / 90) * 7));
  });
});

describe("target dates", () => {
  it("requiredPerWeek is stated only when a target date is set and the gap is open", () => {
    const p = goalProgress(absGoal({ targetDate: "2026-12-01" }), { currentCapital: null, realised, today: TODAY });
    expect(p.daysLeft).toBe(daysBetween(TODAY, "2026-12-01"));
    expect(p.requiredPerWeek).toBe(r2((450000 / p.daysLeft!) * 7));

    const noDate = goalProgress(absGoal(), { currentCapital: null, realised, today: TODAY });
    expect(noDate.daysLeft).toBeNull();
    expect(noDate.requiredPerWeek).toBeNull();
  });

  it("a passed date with an open gap is pastDue, with no invented pace", () => {
    const p = goalProgress(absGoal({ targetDate: "2026-08-01" }), { currentCapital: null, realised, today: TODAY });
    expect(p.status).toBe("pastDue");
    expect(p.daysLeft).toBeLessThan(0);
    expect(p.requiredPerWeek).toBeNull();
  });

  it("an achieved goal is achieved even past its date", () => {
    const p = goalProgress(absGoal({ targetAmount: 1540000, targetDate: "2026-08-01" }), {
      currentCapital: null,
      realised,
      today: TODAY,
    });
    expect(p.status).toBe("achieved");
  });
});

describe("requiredPerWeek edge cases (adversarial probe, 2026-09-01)", () => {
  it("daysLeft == 0 (target date is today) yields null, never a division by zero", () => {
    const p = goalProgress(
      absGoal({ targetAmount: 200000, baselineCapital: 100000, baselineDate: "2026-01-01", targetDate: TODAY }),
      { currentCapital: null, realised: [{ date: "2026-02-01", net: 10000 }], today: TODAY },
    );
    expect(p.requiredPerWeek).toBeNull();
    expect(Number.isFinite(p.gapAmount!)).toBe(true);
  });

  it("progress beyond 100% is genuine overshoot, and the status says achieved", () => {
    const p = goalProgress(
      absGoal({ targetAmount: 110000, baselineCapital: 100000, baselineDate: "2026-01-01", targetDate: null }),
      { currentCapital: null, realised: [{ date: "2026-02-01", net: 20000 }], today: TODAY },
    );
    expect(p.progressPct).toBe(200); // 20k of a 10k gap
    expect(p.status).toBe("achieved");
  });
});

describe("aggregateGoalProgress — the honest All-accounts walk (adversarial probe, 2026-09-01)", () => {
  const A: AccountGoalFacts = {
    accountId: 1, bucket: "total", kind: "absolute", targetAmount: 1200000,
    pctTarget: null, baselineCapital: 1000000, baselineDate: "2026-01-01", targetDate: null,
  };
  const B: AccountGoalFacts = {
    accountId: 2, bucket: "total", kind: "absolute", targetAmount: 600000,
    pctTarget: null, baselineCapital: 500000, baselineDate: "2026-06-01", targetDate: null,
  };
  const today = "2026-08-31";

  it("PROBE 1: pre-baseline profit inside a later-frozen baseline is never re-counted", () => {
    // A made 50k on 02-01 (after A's baseline). B made 100k on 03-01 — BEFORE
    // B's baseline froze in June, so that 100k is already inside B's 5L base.
    const series = new Map<number, RealisedDay[]>([
      [1, [{ date: "2026-02-01", net: 50000 }]],
      [2, [{ date: "2026-03-01", net: 100000 }]],
    ]);
    const p = aggregateGoalProgress([A, B], { realisedOf: (id) => series.get(id) ?? [], today }).get("total")!;
    expect(p.measurable).toBe(true);
    expect(p.progressAmount).toBe(50000); // the blended walk said 150k
    expect(p.progressPct).toBe(16.67); // 50k of the 3L summed gap
    expect(p.achieved).toBe(1550000); // 10L+50k + 5L+0
    expect(p.gapAmount).toBe(250000);

    // Red-on-revert: the old call-site shape — goalProgress on the synthesised
    // sum over the blended series — really does overstate.
    const g = aggregateGoals([A, B]).goals[0];
    const blended = goalProgress(g, {
      currentCapital: null,
      realised: [...(series.get(1) ?? []), ...(series.get(2) ?? [])],
      today,
    });
    expect(blended.progressAmount).toBe(150000);
  });

  it("PROBE 2: an account WITHOUT a goal cannot leak realised P&L into the numerator", () => {
    // Account 3 holds no goal; its 120k must not enter, even though the
    // aggregate view's blended series would have carried it.
    const series = new Map<number, RealisedDay[]>([
      [1, [{ date: "2026-02-01", net: 50000 }]],
      [3, [{ date: "2026-03-01", net: 120000 }]],
    ]);
    const asked: number[] = [];
    const p = aggregateGoalProgress([A], {
      realisedOf: (id) => { asked.push(id); return series.get(id) ?? []; },
      today,
    }).get("total")!;
    expect(p.progressAmount).toBe(50000); // 170k would be the leak
    expect(asked).toEqual([1]); // account 3's series is never even requested
  });

  it("a bucket where ANY contributor lacks a frozen baseline is notMeasurable — no partial sum", () => {
    const p = aggregateGoalProgress([A, { ...B, baselineCapital: null }], { realisedOf: () => [], today }).get("total")!;
    expect(p.measurable).toBe(false);
    expect(p.reason).toBe("baseline-unknown");
    expect(p.progressAmount).toBeNull();
  });

  it("buckets aggregateGoals excludes (%-goals) produce no entry; shared target dates drive the pace", () => {
    const out = aggregateGoalProgress(
      [
        { ...A, targetDate: "2026-12-31" },
        { ...B, targetDate: "2026-12-31" },
        { ...pctGoal({ bucket: "equity" }), accountId: 1 } as AccountGoalFacts,
      ],
      { realisedOf: () => [{ date: "2026-07-01", net: 50000 }], today },
    );
    expect(out.has("equity" as GoalBucket)).toBe(false);
    const p = out.get("total")!;
    expect(p.daysLeft).toBe(daysBetween(today, "2026-12-31"));
    expect(p.requiredPerWeek).not.toBeNull();
  });
});

describe("aggregateGoals — the All-accounts view (invariant 8/9)", () => {
  const a = (over: Partial<GoalFacts> & { accountId: number }) => ({ ...absGoal(), ...over });

  it("sums absolute goals per bucket", () => {
    const agg = aggregateGoals([
      a({ accountId: 1, targetAmount: 2000000, baselineCapital: 1500000 }),
      a({ accountId: 2, targetAmount: 1000000, baselineCapital: 400000, baselineDate: "2026-06-01" }),
    ]);
    expect(agg.goals).toHaveLength(1);
    expect(agg.goals[0].targetAmount).toBe(3000000);
    expect(agg.goals[0].baselineCapital).toBe(1900000);
    expect(agg.goals[0].baselineDate).toBe("2026-06-01"); // earliest
    expect(agg.excluded).toHaveLength(0);
  });

  it("a bucket containing any %-goal is EXCLUDED with the reason stated, never blended", () => {
    const agg = aggregateGoals([
      a({ accountId: 1 }),
      { ...pctGoal({ bucket: "equity" }), accountId: 2 },
    ]);
    expect(agg.goals).toHaveLength(0);
    expect(agg.excluded).toEqual([{ bucket: "equity", reason: expect.stringMatching(/cannot be summed/i) }]);
  });

  it("a partially-known baseline sums to null (an understated base would overstate progress)", () => {
    const agg = aggregateGoals([
      a({ accountId: 1, baselineCapital: 1500000 }),
      a({ accountId: 2, baselineCapital: null }),
    ]);
    expect(agg.goals[0].baselineCapital).toBeNull();
  });

  it("keeps the target date only when every account agrees on it", () => {
    const same = aggregateGoals([
      a({ accountId: 1, targetDate: "2026-12-31" }),
      a({ accountId: 2, targetDate: "2026-12-31" }),
    ]);
    expect(same.goals[0].targetDate).toBe("2026-12-31");
    const mixed = aggregateGoals([
      a({ accountId: 1, targetDate: "2026-12-31" }),
      a({ accountId: 2, targetDate: null }),
    ]);
    expect(mixed.goals[0].targetDate).toBeNull();
  });
});

const r2 = (n: number) => Math.round(n * 100) / 100;
