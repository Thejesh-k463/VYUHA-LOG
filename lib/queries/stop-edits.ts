import "server-only";
import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { TradeAuditEntry } from "@/lib/analytics/stop-edit-mining";

/**
 * Every trade audit entry that CAN carry a stop level, oldest first. Which of
 * them actually records a stop moving is decided by the pure mining module
 * (`lib/analytics/stop-edit-mining.ts`), not here — see its header for what
 * each action's before/after JSON holds.
 *
 * `audit_log` has no `account_id` column, so this read cannot be scoped the
 * way trade reads are (invariant 8). Scope is applied at the JOIN instead: the
 * caller intersects these entries with the ids of its own account-scoped trade
 * read, and the mining module drops (and counts) entries whose trade it was
 * not handed a direction for.
 */
export function getTradeStopEditEntries(): TradeAuditEntry[] {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entity, "trade"), inArray(auditLog.action, ["leg_edit", "leg_stop_all"])))
    .orderBy(asc(auditLog.id))
    .all()
    .map((r) => ({
      tradeId: r.entityId,
      ts: r.ts,
      action: r.action,
      before: r.beforeJson ?? null,
      after: r.afterJson ?? null,
    }));
}
