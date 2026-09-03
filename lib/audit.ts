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
  | "rule_pack"
  | "bf_loss"
  // v3.7: the weekly review ritual (the user's own prose + completion) and the
  // dated advance-tax challan ledger. Both are account-scoped tables whose
  // rows a merge can move or amend, so their mutations belong in the trail
  // beside bf_loss's.
  | "weekly_review"
  | "advance_tax_challan";

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
    | "staged_enable"
    // v3.8: a broker-scoped remove from the import screen (lib/trash.ts
    // `removeBroker`). Admitted here so the literal is type-checked instead of
    // cast; the column stays free text, the row is written verbatim.
    | "import.remove-broker";
  summary?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  source?: string;
}

/**
 * Thrown (dev/test only) when `before` and `after` describe different column
 * sets — see `assertSymmetricSnapshots`.
 */
export class AuditShapeError extends Error {
  readonly entity: AuditEntity;
  readonly action: string;
  readonly onlyBefore: string[];
  readonly onlyAfter: string[];
  constructor(e: AuditInput, onlyBefore: string[], onlyAfter: string[]) {
    super(
      `recordAudit(${e.entity}/${e.action}): before/after key sets differ — ` +
        `only in before: [${onlyBefore.join(", ")}] only in after: [${onlyAfter.join(", ")}]. ` +
        "Project both snapshots from ONE key list (the row read before the write).",
    );
    this.name = "AuditShapeError";
    this.entity = e.entity;
    this.action = e.action;
    this.onlyBefore = onlyBefore;
    this.onlyAfter = onlyAfter;
  }
}

/** Keys on one side only, or null when the two objects describe the same columns. */
function keySetAsymmetry(before: Record<string, unknown>, after: Record<string, unknown>): { onlyBefore: string[]; onlyAfter: string[] } | null {
  const b = new Set(Object.keys(before));
  const a = new Set(Object.keys(after));
  const onlyBefore = [...b].filter((k) => !a.has(k)).sort();
  const onlyAfter = [...a].filter((k) => !b.has(k)).sort();
  return onlyBefore.length === 0 && onlyAfter.length === 0 ? null : { onlyBefore, onlyAfter };
}

/**
 * THE SINGLE-BINDING CONVENTION (v3.8). `lib/analytics/audit-diff.ts` diffs the
 * UNION of the two key sets and reads a missing key as `null`, so a key present
 * on one side only renders as a change that never happened ("note: … → —"),
 * and a written column absent from both renders as nothing at all. v3.7 found
 * this class ("before/after key-set asymmetry") had survived four separate
 * fixes, because each fix hand-assembled one side.
 *
 * The rule that makes it structurally impossible: ONE variable holds the row
 * read before the write, and BOTH snapshots are projections of that row's key
 * list — `before = pick(row, KEYS)`, `after = pick({ ...row, ...patch }, KEYS)`
 * (or the row re-read after the write, projected to the same KEYS). Never
 * build `after` from the request body, and never pass the patch object itself
 * as `after` against a full-row `before`.
 *
 * `before: null` (a create) and `after: null` (a delete) stay legal: an absent
 * side is the honest "there was no row" / "the row is gone", not an asymmetry.
 * When both sides are objects their key sets must be equal, order-free.
 *
 * Outside production this THROWS a typed `AuditShapeError` naming the action
 * and the odd keys, so a test that exercises the write fails on the shape. In
 * production the entry is still recorded (a mutation must never lose its
 * trail over a logging defect) and the asymmetry is warned to the console.
 */
function assertSymmetricSnapshots(e: AuditInput): void {
  if (!e.before || !e.after) return;
  const asym = keySetAsymmetry(e.before, e.after);
  if (!asym) return;
  const err = new AuditShapeError(e, asym.onlyBefore, asym.onlyAfter);
  if (process.env.NODE_ENV !== "production") throw err;
  console.warn(err.message);
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
  // Shape check BEFORE the best-effort try: a throw here is deliberate and
  // must reach the caller (dev/test), unlike an INSERT failure.
  for (const e of entries) assertSymmetricSnapshots(e);
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
