import "server-only";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { capitalGoals, trades } from "@/lib/db/schema";
import {
  aggregateGoals,
  aggregateGoalProgress,
  type GoalBucket,
  type GoalFacts,
  type GoalKind,
  type GoalProgress,
  type RealisedDay,
} from "@/lib/analytics/goal";
import { getSelectedAccountId } from "./accounts";
import { getBucketCapital } from "./capital";
import { recordAudit } from "@/lib/audit";

/**
 * capital_goals CRUD — Expected Capital / goal tracking (v3.6).
 *
 * Scoping (invariants 8/9): reads go through getSelectedAccountId(). The
 * aggregate view (id 0) shows the SUM of every account's goals per bucket —
 * computed by the pure aggregateGoals(), which refuses to blend %-goals —
 * and REFUSES writes outright, mirroring compoundRealised: a goal is a
 * statement about ONE book, and 0 is a view, not a place.
 *
 * Refusals over defaults (invariant 6): an absolute goal without a ₹ target,
 * or a %-goal without a percent, is refused — never defaulted to 0. A %-goal
 * additionally requires the bucket's capital to be KNOWN at creation, because
 * its baseline freezes then; "20% of an unknown base" is not a goal.
 *
 * The baseline is FROZEN at creation (decision #4): edits keep it; only
 * delete-and-recreate re-baselines, deliberately.
 */

export type CapitalGoalRow = typeof capitalGoals.$inferSelect;

export const GOAL_BUCKETS: GoalBucket[] = ["equity", "active", "total"];

export interface GoalView {
  /** Per-bucket goals for the selected account, or the aggregate's sums. */
  goals: GoalFacts[];
  /** Aggregate view only: buckets whose goals could not be summed. */
  excluded: { bucket: GoalBucket; reason: string }[];
  /** True when the view is the All-accounts aggregate (writes refused). */
  aggregate: boolean;
}

/** The selected account's raw goal rows (aggregate view: every account's). */
export function getGoalRows(): CapitalGoalRow[] {
  const accountId = getSelectedAccountId();
  const q = db.select().from(capitalGoals);
  return (accountId > 0 ? q.where(eq(capitalGoals.accountId, accountId)) : q).all();
}

const toFacts = (r: CapitalGoalRow): GoalFacts => ({
  bucket: r.bucket as GoalBucket,
  kind: r.kind as GoalKind,
  targetAmount: r.targetAmount,
  pctTarget: r.pctTarget,
  baselineCapital: r.baselineCapital,
  baselineDate: r.baselineDate,
  targetDate: r.targetDate,
});

/** What the current view shows: the account's goals, or honest per-bucket sums. */
export function getGoalView(): GoalView {
  const accountId = getSelectedAccountId();
  const rows = getGoalRows();
  if (accountId > 0) return { goals: rows.map(toFacts), excluded: [], aggregate: false };
  const agg = aggregateGoals(rows.map((r) => ({ ...toFacts(r), accountId: r.accountId })));
  return { goals: agg.goals, excluded: agg.excluded, aggregate: true };
}

/**
 * The All-accounts aggregate's progress, computed the honest way (v3.12):
 * the SUM of each account's own frozen-baseline walk over its OWN realised
 * days from its OWN baselineDate — never a blended cross-account series,
 * which double-counted pre-baseline profit and let goal-less accounts leak
 * P&L into the numerator. One narrow read: closed, dated rows only (the
 * walk and the run-rates need nothing else), every account (this is the
 * aggregate view's read — invariant 8's `accountId > 0 ? filter : all`).
 */
export function getAggregateGoalProgress(today: string): Map<GoalBucket, GoalProgress> {
  const rows = getGoalRows().map((r) => ({ ...toFacts(r), accountId: r.accountId }));
  if (rows.length === 0) return new Map();
  const closed = db
    .select({ accountId: trades.accountId, bucket: trades.bucket, sellDate: trades.sellDate, netPnl: trades.netPnl })
    .from(trades)
    .where(and(eq(trades.isOpen, false), isNotNull(trades.sellDate)))
    .all();
  const cache = new Map<string, RealisedDay[]>();
  const realisedOf = (accountId: number, bucket: GoalBucket): RealisedDay[] => {
    const key = `${accountId}|${bucket}`;
    let series = cache.get(key);
    if (!series) {
      const byDay = new Map<string, number>();
      for (const t of closed) {
        if (t.accountId !== accountId) continue;
        if (bucket !== "total" && t.bucket !== bucket) continue;
        byDay.set(t.sellDate!, (byDay.get(t.sellDate!) ?? 0) + t.netPnl);
      }
      series = [...byDay.entries()].map(([date, net]) => ({ date, net: Math.round(net * 100) / 100 }));
      cache.set(key, series);
    }
    return series;
  };
  return aggregateGoalProgress(rows, { realisedOf, today });
}

export interface GoalWriteResult {
  ok: boolean;
  message: string;
  /** True when the refusal is the aggregate-view write ban (route → 403). */
  forbidden?: boolean;
}

export interface GoalUpsertInput {
  bucket: GoalBucket;
  kind: GoalKind;
  /** ₹ capital level (absolute goals). */
  targetAmount?: number | null;
  /** Profit % on the frozen baseline (pct_profit goals). */
  pctTarget?: number | null;
  targetDate?: string | null;
}

const bucketCapitalOf = (bucket: GoalBucket): number => {
  const cap = getBucketCapital();
  return bucket === "equity" ? cap.equityCapital : bucket === "active" ? cap.activeCapital : cap.totalCapital;
};

/** Create or edit the selected account's goal for one bucket. */
export function upsertGoal(input: GoalUpsertInput): GoalWriteResult {
  const accountId = getSelectedAccountId();
  if (accountId === 0) {
    return {
      ok: false,
      forbidden: true,
      message: "A goal belongs to a single account's book — pick one in the sidebar first. The All-accounts view only sums per-account goals.",
    };
  }

  const targetAmount = input.targetAmount ?? null;
  const pctTarget = input.pctTarget ?? null;
  const targetDate = input.targetDate ?? null;

  // Refuse, never default: a goal the user did not state is not stored.
  if (input.kind === "absolute" && (targetAmount == null || targetAmount <= 0)) {
    return { ok: false, message: "An absolute goal needs a ₹ target above zero — nothing was saved." };
  }
  if (input.kind === "pct_profit" && (pctTarget == null || pctTarget <= 0)) {
    return { ok: false, message: "A %-profit goal needs a percent above zero — nothing was saved." };
  }

  const existing = db
    .select()
    .from(capitalGoals)
    .where(and(eq(capitalGoals.accountId, accountId), eq(capitalGoals.bucket, input.bucket)))
    .get();

  // The baseline freezes at CREATION: current bucket capital, or null when the
  // capital is genuinely unknown (0 = not configured). A %-goal cannot freeze
  // an unknown baseline, so it is refused with the one Settings nudge.
  const capNow = bucketCapitalOf(input.bucket);
  const baselineCapital = existing ? existing.baselineCapital : capNow > 0 ? capNow : null;
  if (input.kind === "pct_profit" && baselineCapital == null) {
    // Two different situations, two different remedies. An EDIT keeps the
    // frozen (null) baseline by design, so "set capital in Settings" cannot
    // fix it — the only re-baseline path is delete + recreate, deliberately:
    // switching kind must not silently re-baseline at today's capital, or an
    // old goal's progress would quietly restart from a fatter base.
    return {
      ok: false,
      message: existing
        ? "This goal was created before capital was configured, so it has no frozen baseline — delete and recreate it to baseline at today's capital. Edits keep the original (missing) baseline by design."
        : "A %-profit goal needs a known capital base to freeze — set this bucket's capital in Settings first, or use an absolute ₹ target.",
    };
  }

  const now = new Date().toISOString();
  const values = {
    kind: input.kind,
    targetAmount: input.kind === "absolute" ? targetAmount : null,
    pctTarget: input.kind === "pct_profit" ? pctTarget : null,
    targetDate,
    updatedAt: now,
  };

  if (existing) {
    db.update(capitalGoals).set(values).where(eq(capitalGoals.id, existing.id)).run();
  } else {
    db.insert(capitalGoals)
      .values({
        accountId,
        bucket: input.bucket,
        baselineCapital,
        baselineDate: now.slice(0, 10),
        ...values,
      })
      .run();
  }

  recordAudit({
    entity: "capital",
    entityId: existing?.id ?? accountId,
    action: existing ? "update" : "create",
    summary: `${input.bucket} goal ${existing ? "updated" : "set"} (${input.kind === "absolute" ? `₹${targetAmount}` : `+${pctTarget}%`})`,
    after: { bucket: input.bucket, ...values },
    source: "ui",
  });

  const label = input.bucket === "active" ? "Trade F&O" : input.bucket === "equity" ? "equity" : "total";
  return { ok: true, message: existing ? `Updated the ${label} goal.` : `Goal set for the ${label} bucket.` };
}

/** Remove the selected account's goal for one bucket. */
export function deleteGoal(bucket: GoalBucket): GoalWriteResult {
  const accountId = getSelectedAccountId();
  if (accountId === 0) {
    return { ok: false, forbidden: true, message: "Pick the account whose goal you want to remove — the All-accounts view holds none of its own." };
  }
  const existing = db
    .select()
    .from(capitalGoals)
    .where(and(eq(capitalGoals.accountId, accountId), eq(capitalGoals.bucket, bucket)))
    .get();
  if (!existing) return { ok: false, message: "No goal exists for that bucket." };
  db.delete(capitalGoals).where(eq(capitalGoals.id, existing.id)).run();
  recordAudit({
    entity: "capital",
    entityId: existing.id,
    action: "delete",
    summary: `${bucket} goal removed`,
    before: existing as unknown as Record<string, unknown>,
    source: "ui",
  });
  return { ok: true, message: "Goal removed." };
}
