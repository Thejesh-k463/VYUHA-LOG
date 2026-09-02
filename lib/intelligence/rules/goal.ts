/**
 * GOAL RULES — Expected-capital findings on the insight contract (v3.6).
 *
 * PURE (invariant 2): no DB, no React. The page computes each goal's
 * GoalProgress (lib/analytics/goal.ts) from data it already loaded and hands
 * the FACTS in; rules only compare numbers already computed.
 *
 * Everything here is arithmetic about the user's own record — a pace, a gap,
 * a date — stated descriptively (contract rule 1). No rule can say what to
 * do about a goal, only what the numbers already are.
 */

import type { Insight, InsightRule } from "@/lib/intelligence/insight";

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/** One goal's already-computed facts (rupees). */
export interface GoalRuleFact {
  /** "Equity" | "Trade F&O" | "Total" — presentation label, pre-resolved. */
  bucketLabel: string;
  measurable: boolean;
  runRate30: number | null;
  runRate90: number | null;
  requiredPerWeek: number | null;
  gapAmount: number | null;
  daysLeft: number | null;
}

export interface GoalRuleInput {
  goals: GoalRuleFact[];
  /** Realised (dated, closed) days in the trailing 90-day window — the
   *  observation count every pace claim rests on. */
  realisedDays90: number;
}

/** Below this many realised days a weekly pace is an anecdote (contract rule 2). */
const MIN_REALISED_DAYS = 10;

/** 30d-vs-90d pace divergence that reads as recency rather than noise. */
export const PACE_DIVERGENCE_RATIO = 2;

export const GOAL_RULES: InsightRule<GoalRuleInput>[] = [
  {
    id: "goal-pace-vs-required",
    watches: "trailing realised pace against the goal date's arithmetic",
    sampleFloor: MIN_REALISED_DAYS,
    compute(input): Insight | null {
      if (input.realisedDays90 < MIN_REALISED_DAYS) return null;
      const g = input.goals.find(
        (x) => x.measurable && x.requiredPerWeek != null && x.runRate30 != null && x.gapAmount != null && x.daysLeft != null,
      );
      if (!g) return null;
      const ahead = g.runRate30! >= g.requiredPerWeek!;
      return {
        id: "goal-pace-vs-required",
        tone: ahead ? "good" : "info",
        headline: `Your ${g.bucketLabel} goal's remaining ${inr(g.gapAmount!)} works out to ${inr(g.requiredPerWeek!)}/week over the ${g.daysLeft} days to its date; your trailing 30-day realised pace is ${inr(g.runRate30!)}/week.`,
        detail: ahead
          ? "At the trailing pace the arithmetic currently closes ahead of the date. A pace is a trailing fact, not a forecast."
          : "The required figure is the date's arithmetic, not a forecast — it moves only when the gap, the date, or the realised pace does.",
        evidence: [
          { label: "remaining gap", value: inr(g.gapAmount!) },
          { label: "required / week", value: inr(g.requiredPerWeek!) },
          { label: "trailing 30d pace", value: `${inr(g.runRate30!)}/wk`, tone: ahead ? "good" : "warn" },
          ...(g.runRate90 != null ? [{ label: "trailing 90d pace", value: `${inr(g.runRate90)}/wk` }] : []),
          { label: "days to date", value: String(g.daysLeft) },
        ],
        sampleSize: input.realisedDays90,
        coverage: { have: input.realisedDays90, of: 90, noun: "days in the trailing window with realised P&L" },
      };
    },
  },
  {
    id: "goal-pace-window-gap",
    watches: "30-day vs 90-day realised pace divergence",
    sampleFloor: MIN_REALISED_DAYS,
    compute(input): Insight | null {
      if (input.realisedDays90 < MIN_REALISED_DAYS) return null;
      const g = input.goals.find((x) => x.runRate30 != null && x.runRate90 != null && x.runRate90 !== 0);
      if (!g) return null;
      const r30 = g.runRate30!;
      const r90 = g.runRate90!;
      const flipped = Math.sign(r30) !== Math.sign(r90) && r30 !== 0;
      const ratio = Math.abs(r30) / Math.abs(r90);
      if (!flipped && ratio <= PACE_DIVERGENCE_RATIO && ratio >= 1 / PACE_DIVERGENCE_RATIO) return null;
      return {
        id: "goal-pace-window-gap",
        tone: "info",
        headline: `Your trailing 30-day realised pace (${inr(r30)}/week) diverges from the 90-day pace (${inr(r90)}/week) on the ${g.bucketLabel} book.`,
        // A fact about THIS book's two windows — not a general claim about
        // what such gaps "historically" turn out to be (nobody measured that).
        detail: `Both figures window the same realised series: the 30-day rate is ${inr(r30)}/week against the 90-day ${inr(r90)}/week — the gap sits in the most recent weeks, which only the shorter window leans on.`,
        evidence: [
          { label: "30-day pace", value: `${inr(r30)}/wk` },
          { label: "90-day pace", value: `${inr(r90)}/wk` },
        ],
        sampleSize: input.realisedDays90,
        coverage: { have: input.realisedDays90, of: 90, noun: "days in the trailing window with realised P&L" },
      };
    },
  },
];

/** Fixture inputs that make every rule above fire (contract requirement). */
export const CONTRACT_FIXTURES: GoalRuleInput[] = [
  {
    goals: [
      {
        bucketLabel: "Equity",
        measurable: true,
        runRate30: 12000,
        runRate90: 4000, // 3× the 90d pace → window-gap fires
        requiredPerWeek: 18000,
        gapAmount: 230000,
        daysLeft: 90,
      },
    ],
    realisedDays90: 34,
  },
  {
    goals: [
      {
        bucketLabel: "Trade F&O",
        measurable: true,
        runRate30: 25000,
        runRate90: 24000,
        requiredPerWeek: 9000, // ahead of required → the good-tone branch
        gapAmount: 45000,
        daysLeft: 35,
      },
    ],
    realisedDays90: 61,
  },
];
