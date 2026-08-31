/**
 * AUDIT-LOG STOP-EDIT MINING (PURE — no DB, no React).
 *
 * Turns raw `audit_log` rows into the `StopEdit[]` that
 * `lib/analytics/stop-migration.ts` consumes. The query layer
 * (`lib/queries/stop-edits.ts`) fetches the rows; this module decides which of
 * them actually record a stop level moving, because that decision is testable
 * without a database and the query is not.
 *
 * What the audit trail can and cannot say today:
 *
 *   - `leg_edit` carries `before.slPlanned` and, when the edit touched the
 *     stop, `slPlanned` in its after-patch. That is a real before → after pair.
 *   - `leg_stop_all` carries only the applied stop (no before-image), so it is
 *     mined as a SET, never as a widening — a claim of "widened" needs both
 *     sides on record.
 *   - the plain trade `update` audit records qty/price/netPnl/isOpen only, so
 *     a stop changed through the plain editor is INVISIBLE here. The mining
 *     counts what the log holds; it never infers what it does not.
 *
 * Direction comes from the caller (widening is a RISK direction, not a price
 * direction). Entries whose trade the caller cannot direction — e.g. a trade
 * outside the current account scope — are dropped and counted, never guessed.
 */

import type { StopEdit } from "./stop-migration";

export interface TradeAuditEntry {
  tradeId: number | null;
  ts: string;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface MinedStopEdits {
  edits: StopEdit[];
  /** Stop-carrying entries whose trade had no known direction — dropped, counted. */
  noDirection: number;
}

const level = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const hasKey = (o: Record<string, unknown> | null, k: string): boolean =>
  o != null && Object.prototype.hasOwnProperty.call(o, k);

export function extractStopEdits(
  entries: TradeAuditEntry[],
  directionByTrade: Map<number, "long" | "short">,
): MinedStopEdits {
  const edits: StopEdit[] = [];
  let noDirection = 0;

  for (const e of entries) {
    if (e.tradeId == null) continue;

    let before: number | null;
    let after: number | null;
    if (e.action === "leg_edit" && hasKey(e.after, "slPlanned")) {
      // The after-JSON is the PATCH — an slPlanned key means the stop was edited.
      before = level(e.before?.slPlanned);
      after = level(e.after!.slPlanned);
    } else if (e.action === "leg_stop_all" && hasKey(e.after, "slPlanned")) {
      // Applied across open tranches with no before-image on record: a SET.
      before = null;
      after = level(e.after!.slPlanned);
    } else {
      continue;
    }

    const direction = directionByTrade.get(e.tradeId);
    if (direction == null) {
      noDirection++;
      continue;
    }
    edits.push({ tradeId: e.tradeId, ts: e.ts, before, after, direction });
  }

  return { edits, noDirection };
}
