import "server-only";
import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";

// P0.3 — append-only audit trail. recordAudit is best-effort: a logging failure
// must NEVER break the mutation it is recording, so it swallows errors.

export type AuditEntity =
  | "trade"
  | "charge_config"
  | "risk_config"
  | "settings"
  | "capital"
  | "ledger"
  | "restriction";

export interface AuditInput {
  entity: AuditEntity;
  entityId?: number | null;
  action: "create" | "update" | "delete" | "close" | "override";
  summary?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  source?: string;
}

export function recordAudit(e: AuditInput): void {
  try {
    db.insert(auditLog)
      .values({
        entity: e.entity,
        entityId: e.entityId ?? null,
        action: e.action,
        summary: e.summary ?? null,
        beforeJson: e.before ?? null,
        afterJson: e.after ?? null,
        source: e.source ?? "ui",
      })
      .run();
  } catch {
    /* auditing is best-effort; never throw into the caller */
  }
}
