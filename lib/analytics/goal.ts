/**
 * GOAL MATHS — Expected Capital / goal tracking (v3.6, decision #4). PURE
 * (invariant 2): no DB, no React. Inputs are fetched by pages/queries and
 * passed in; `today` is injected so every figure is reproducible in tests.
 *
 * Money discipline (invariant 1): everything in this module is RUPEES. The
 * `capital_goals` columns are integer paise at rest, and the `moneyPaise`
 * custom type already converted them to rupees before a row reaches here —
 * converting again is the 100× bug. There is deliberately NO paise arithmetic
 * in this file.
 *
 * Honesty rules (invariant 6):
 *  - A %-profit goal without a known frozen baseline is NOT MEASURABLE — the
 *    result says so and the UI renders "—" plus one Settings nudge, never 0.
 *  - An absolute goal with neither a baseline nor a known current capital is
 *    not measurable either: "how far from ₹T" needs to know where you stand.
 *  - Run-rates come from the user's own realised P&L series. An empty series
 *    yields null (nothing to phrase a pace from); a non-empty series with a
 *    quiet trailing window yields a true ₹0/week.
 */

export type GoalBucket = "equity" | "active" | "total";
export type GoalKind = "absolute" | "pct_profit";

/** The goal row's facts, in runtime rupees. */
export interface GoalFacts {
  bucket: GoalBucket;
  kind: GoalKind;
  /** ₹ capital level to reach (absolute goals). */
  targetAmount: number | null;
  /** Profit % on the frozen baseline (pct_profit goals), e.g. 20 = +20%. */
  pctTarget: number | null;
  /** Bucket capital frozen at creation; null = unknown then. */
  baselineCapital: number | null;
  baselineDate: string;
  targetDate: string | null;
}

/** One realised-P&L day (rupees), the dailyPnl() shape flattened. */
export interface RealisedDay {
  date: string;
  net: number;
}

export type GoalStatus = "achieved" | "inProgress" | "pastDue" | "notMeasurable";

/** Why a goal could not be measured — the UI maps these to copy. */
export type GoalUnmeasurableReason = "baseline-unknown" | "capital-unknown" | "target-missing";

export interface GoalProgress {
  measurable: boolean;
  reason: GoalUnmeasurableReason | null;
  /** The ₹ capital level the goal resolves to (pct goals: baseline × (1 + pct/100)). */
  targetLevel: number | null;
  /** Where the bucket stands now, ₹. */
  achieved: number | null;
  /** ₹ made since the baseline (null when the baseline is unknown). */
  progressAmount: number | null;
  /** % of the way from baseline to target (baseline unknown: achieved/target). */
  progressPct: number | null;
  /** targetLevel − achieved; ≤ 0 means the goal is met. */
  gapAmount: number | null;
  /** ₹/week from the trailing 30-day realised window. */
  runRate30: number | null;
  /** ₹/week from the trailing 90-day realised window. */
  runRate90: number | null;
  /** ₹/week the remaining gap works out to — only when a target date is set. */
  requiredPerWeek: number | null;
  /** Calendar days to the target date (negative = past). Null without a date. */
  daysLeft: number | null;
  status: GoalStatus;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Calendar days from `a` to `b` (ISO dates); positive when b is later. */
export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b + "T00:00:00").getTime() - new Date(a + "T00:00:00").getTime()) / 86400000);
}

/**
 * ISO date `days` before `d`. UTC-stable on purpose: the old form parsed LOCAL
 * midnight and sliced `toISOString()` (UTC), so on any TZ ahead of UTC (IST)
 * the result slid one calendar day back and the "30-day" window quietly held
 * 31 days. Date.UTC from the ISO parts keeps the arithmetic in one calendar.
 */
function shiftDays(d: string, days: number): string {
  const [y, m, dd] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd - days)).toISOString().slice(0, 10);
}

/** Sum of realised nets with from <= date <= to. */
function realisedIn(realised: RealisedDay[], from: string, to: string): number {
  let s = 0;
  for (const d of realised) if (d.date >= from && d.date <= to) s += d.net;
  return r2(s);
}

/**
 * ₹/week from the trailing `windowDays` realised window ending `today`.
 * Null when the series is EMPTY (no realised history at all — a pace phrased
 * from nothing would be an invention); a quiet window over a real history is
 * a true ₹0/week.
 */
export function trailingRunRate(realised: RealisedDay[], today: string, windowDays: number): number | null {
  if (realised.length === 0) return null;
  const from = shiftDays(today, windowDays - 1);
  return r2((realisedIn(realised, from, today) / windowDays) * 7);
}

const notMeasurable = (
  reason: GoalUnmeasurableReason,
  runRate30: number | null,
  runRate90: number | null,
): GoalProgress => ({
  measurable: false,
  reason,
  targetLevel: null,
  achieved: null,
  progressAmount: null,
  progressPct: null,
  gapAmount: null,
  runRate30,
  runRate90,
  requiredPerWeek: null,
  daysLeft: null,
  status: "notMeasurable",
});

/**
 * Measure one goal.
 *
 * @param goal the goal row's facts (rupees)
 * @param opts.currentCapital the bucket's CURRENT resolved capital, or null
 *   when not configured (callers pass null for the app's "0 = unknown")
 * @param opts.realised the bucket's dated realised-P&L days (whole history —
 *   the function windows it itself)
 * @param opts.today injected clock, ISO date
 *
 * Progress semantics: with a known frozen baseline, standing is
 * `baseline + realised P&L since the baseline date` — capital EDITS after
 * creation (deposits, corrections) are deliberately not progress, and
 * compounding realised P&L into capital cannot double-count because the walk
 * starts at the frozen figure. With no baseline (absolute goals only),
 * standing falls back to the user's current capital statement.
 */
export function goalProgress(
  goal: GoalFacts,
  opts: { currentCapital: number | null; realised: RealisedDay[]; today: string },
): GoalProgress {
  const { currentCapital, realised, today } = opts;
  const runRate30 = trailingRunRate(realised, today, 30);
  const runRate90 = trailingRunRate(realised, today, 90);

  // Resolve the ₹ target level and the standing.
  let targetLevel: number | null;
  let achieved: number | null;
  let progressAmount: number | null;
  let progressPct: number | null;

  const realisedSince = realisedIn(realised, goal.baselineDate, today);

  if (goal.kind === "pct_profit") {
    if (goal.pctTarget == null) return notMeasurable("target-missing", runRate30, runRate90);
    // A % goal REQUIRES the frozen baseline: percent of an unknown base is not
    // a number, and substituting today's capital would silently re-baseline.
    if (goal.baselineCapital == null) return notMeasurable("baseline-unknown", runRate30, runRate90);
    targetLevel = r2(goal.baselineCapital * (1 + goal.pctTarget / 100));
    achieved = r2(goal.baselineCapital + realisedSince);
    progressAmount = realisedSince;
    const denom = targetLevel - goal.baselineCapital;
    progressPct = denom > 0 ? r2((realisedSince / denom) * 100) : null;
  } else {
    if (goal.targetAmount == null) return notMeasurable("target-missing", runRate30, runRate90);
    targetLevel = goal.targetAmount;
    if (goal.baselineCapital != null) {
      achieved = r2(goal.baselineCapital + realisedSince);
      progressAmount = realisedSince;
      const denom = targetLevel - goal.baselineCapital;
      progressPct = denom > 0 ? r2((realisedSince / denom) * 100) : null;
    } else if (currentCapital != null) {
      // No frozen baseline (capital was unknown at creation): the standing is
      // the user's own current statement; % is share of the level attained.
      achieved = r2(currentCapital);
      progressAmount = null;
      progressPct = targetLevel > 0 ? r2((achieved / targetLevel) * 100) : null;
    } else {
      return notMeasurable("capital-unknown", runRate30, runRate90);
    }
  }

  const gapAmount = r2(targetLevel - achieved);
  const daysLeft = goal.targetDate ? daysBetween(today, goal.targetDate) : null;
  const requiredPerWeek =
    goal.targetDate && daysLeft != null && daysLeft > 0 && gapAmount > 0
      ? r2((gapAmount / daysLeft) * 7)
      : null;

  const status: GoalStatus =
    gapAmount <= 0 ? "achieved" : daysLeft != null && daysLeft < 0 ? "pastDue" : "inProgress";

  return {
    measurable: true,
    reason: null,
    targetLevel,
    achieved,
    progressAmount,
    progressPct,
    gapAmount,
    runRate30,
    runRate90,
    requiredPerWeek,
    daysLeft,
    status,
  };
}

// ── The All-accounts aggregate (invariant 8/9 support) ──────────────────────

export interface AccountGoalFacts extends GoalFacts {
  accountId: number;
}

export interface AggregatedGoals {
  /** Synthesised per-bucket goals the aggregate view can honestly show. */
  goals: GoalFacts[];
  /** Buckets whose goals could not be summed, with the stated reason. */
  excluded: { bucket: GoalBucket; reason: string }[];
}

/**
 * What "All accounts" shows: per bucket, the SUM of every account's goal.
 *
 * Only absolute ₹ goals sum — two %-profit goals scale two different
 * baselines, and a blended percent would be a fabricated figure, so such
 * buckets are EXCLUDED with the reason stated rather than approximated.
 * The summed baseline is null unless every contributor froze one (a partial
 * sum would understate the base and overstate progress). The summed target
 * date is kept only when every contributor agrees on it — a summed goal has
 * no single deadline otherwise.
 */
export function aggregateGoals(rows: AccountGoalFacts[]): AggregatedGoals {
  const buckets = new Map<GoalBucket, AccountGoalFacts[]>();
  for (const r of rows) {
    const list = buckets.get(r.bucket) ?? [];
    list.push(r);
    buckets.set(r.bucket, list);
  }

  const goals: GoalFacts[] = [];
  const excluded: AggregatedGoals["excluded"] = [];
  for (const [bucket, list] of buckets) {
    if (list.some((g) => g.kind !== "absolute" || g.targetAmount == null)) {
      excluded.push({
        bucket,
        reason: "%-profit goals scale each account's own baseline and cannot be summed across accounts.",
      });
      continue;
    }
    const allBaselines = list.every((g) => g.baselineCapital != null);
    const dates = new Set(list.map((g) => g.targetDate ?? ""));
    goals.push({
      bucket,
      kind: "absolute",
      targetAmount: r2(list.reduce((s, g) => s + (g.targetAmount ?? 0), 0)),
      pctTarget: null,
      baselineCapital: allBaselines ? r2(list.reduce((s, g) => s + (g.baselineCapital ?? 0), 0)) : null,
      baselineDate: list.map((g) => g.baselineDate).sort()[0],
      targetDate: dates.size === 1 ? (list[0].targetDate ?? null) : null,
    });
  }
  return { goals, excluded };
}

/** Sum where at least one value is known; all-null stays null (invariant 6). */
const sumOrNull = (vals: (number | null)[]): number | null =>
  vals.every((v) => v == null) ? null : r2(vals.reduce<number>((s, v) => s + (v ?? 0), 0));

export interface AggregateProgressOpts {
  /**
   * One account's OWN dated realised-P&L series for one bucket. Called only
   * for accounts that actually hold a goal — an account without a goal has no
   * baseline to walk from, so its P&L never enters the numerator.
   */
  realisedOf: (accountId: number, bucket: GoalBucket) => RealisedDay[];
  today: string;
}

/**
 * Progress for the All-accounts aggregate, the honest way: the SUM of each
 * account's own frozen-baseline walk over its OWN realised series from its
 * OWN baselineDate.
 *
 * A blended cross-account series walked from the earliest baselineDate (the
 * old call-site shape) overstates twice: profit an account made BEFORE its
 * baseline froze is already inside that baseline yet re-enters the walk, and
 * accounts holding no goal at all leak their P&L into the numerator. Neither
 * survives the component-wise sum.
 *
 * Buckets aggregateGoals() excludes (any %-goal) produce no entry here.
 * A bucket where ANY contributor lacks a frozen baseline is notMeasurable —
 * summing the rest would walk an understated base and overstate progress
 * (same rule as aggregateGoals' summed baseline).
 */
export function aggregateGoalProgress(
  rows: AccountGoalFacts[],
  opts: AggregateProgressOpts,
): Map<GoalBucket, GoalProgress> {
  const { realisedOf, today } = opts;
  const buckets = new Map<GoalBucket, AccountGoalFacts[]>();
  for (const g of rows) buckets.set(g.bucket, [...(buckets.get(g.bucket) ?? []), g]);

  const out = new Map<GoalBucket, GoalProgress>();
  for (const [bucket, list] of buckets) {
    if (list.some((g) => g.kind !== "absolute" || g.targetAmount == null)) continue; // aggregateGoals excluded it

    const parts = list.map((g) => ({
      g,
      p: goalProgress(g, { currentCapital: null, realised: realisedOf(g.accountId, bucket), today }),
    }));
    const runRate30 = sumOrNull(parts.map(({ p }) => p.runRate30));
    const runRate90 = sumOrNull(parts.map(({ p }) => p.runRate90));

    if (parts.some(({ p }) => !p.measurable)) {
      // With currentCapital pinned null, the only unmeasurable case here is a
      // goal created before capital was configured — no frozen baseline.
      out.set(bucket, {
        measurable: false,
        reason: "baseline-unknown",
        targetLevel: null,
        achieved: null,
        progressAmount: null,
        progressPct: null,
        gapAmount: null,
        runRate30,
        runRate90,
        requiredPerWeek: null,
        daysLeft: null,
        status: "notMeasurable",
      });
      continue;
    }

    const targetLevel = r2(list.reduce((s, g) => s + (g.targetAmount ?? 0), 0));
    const achieved = r2(parts.reduce((s, { p }) => s + (p.achieved ?? 0), 0));
    const progressAmount = r2(parts.reduce((s, { p }) => s + (p.progressAmount ?? 0), 0));
    const denom = parts.reduce((s, { g }) => s + ((g.targetAmount ?? 0) - (g.baselineCapital ?? 0)), 0);
    const progressPct = denom > 0 ? r2((progressAmount / denom) * 100) : null;
    const gapAmount = r2(targetLevel - achieved);

    // A summed goal has one deadline only when every contributor agrees on it.
    const dates = new Set(list.map((g) => g.targetDate ?? ""));
    const targetDate = dates.size === 1 ? (list[0].targetDate ?? null) : null;
    const daysLeft = targetDate ? daysBetween(today, targetDate) : null;
    const requiredPerWeek =
      targetDate && daysLeft != null && daysLeft > 0 && gapAmount > 0 ? r2((gapAmount / daysLeft) * 7) : null;

    out.set(bucket, {
      measurable: true,
      reason: null,
      targetLevel,
      achieved,
      progressAmount,
      progressPct,
      gapAmount,
      runRate30,
      runRate90,
      requiredPerWeek,
      daysLeft,
      status: gapAmount <= 0 ? "achieved" : daysLeft != null && daysLeft < 0 ? "pastDue" : "inProgress",
    });
  }
  return out;
}
