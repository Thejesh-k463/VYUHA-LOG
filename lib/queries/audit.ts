import "server-only";
import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { desc } from "drizzle-orm";

export interface AuditRow {
  id: number;
  ts: string;
  entity: string;
  entityId: number | null;
  action: string;
  summary: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  source: string;
}

/** Recent audit entries (newest first). */
export function getAuditLog(limit = 250): AuditRow[] {
  return db
    .select()
    .from(auditLog)
    .orderBy(desc(auditLog.id))
    .limit(limit)
    .all()
    .map((r) => ({
      id: r.id,
      ts: r.ts,
      entity: r.entity,
      entityId: r.entityId,
      action: r.action,
      summary: r.summary,
      before: r.beforeJson ?? null,
      after: r.afterJson ?? null,
      source: r.source,
    }));
}
