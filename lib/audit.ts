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
  | "restriction"
  | "corporate_action"
  | "account"
  | "session"
  | "rule_pack";

export interface AuditInput {
  entity: AuditEntity;
  entityId?: number | null;
  action:
    | "create"
    | "update"
    | "delete"
    | "close"
    | "override"
    // Staged (scaled) positions — every fill is recorded separately so the
    // ladder can be reconstructed from the audit trail alone.
    | "leg_add_entry"
    | "leg_add_exit"
    | "leg_edit"
    | "leg_delete"
    | "leg_stop_all"
    | "staged_enable";
  summary?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  source?: string;
}

export function recordAudit(e: AuditInput): void {
  recordAuditMany([e]);
}

/**
 * Audit many entities in as few statements as possible.
 *
 * A bulk delete audits one row per trade, and calling `recordAudit` in a loop
 * meant one INSERT per trade: a 2,000-trade delete issued 2,029 statements, of
 * which 2,000 were audit writes. The rows themselves are genuinely per-trade
 * (each carries that trade's before-image), so the fix is one multi-row INSERT,
 * not fewer rows.
 *
 * Chunked because a multi-row INSERT binds columns × rows parameters, and
 * SQLite's per-statement ceiling applies here exactly as it does to `inArray`
 * — the bug this batching was written alongside.
 */
export function recordAuditMany(entries: AuditInput[]): void {
  if (entries.length === 0) return;
  const values = entries.map((e) => ({
    entity: e.entity,
    entityId: e.entityId ?? null,
    action: e.action,
    summary: e.summary ?? null,
    beforeJson: e.before ?? null,
    afterJson: e.after ?? null,
    source: e.source ?? "ui",
  }));
  // 7 columns per row; 100 rows = 700 parameters, comfortably under any build.
  const CHUNK = 100;
  try {
    for (let i = 0; i < values.length; i += CHUNK) {
      db.insert(auditLog).values(values.slice(i, i + CHUNK)).run();
    }
  } catch {
    /* auditing is best-effort; never throw into the caller */
  }
}
