import "server-only";
import { and, eq, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { panelDismissals } from "@/lib/db/schema";
import { isDismissed, type Dismissal, type DismissiblePanel } from "@/lib/domain/dismissals";
import { getSelectedAccountId, getWriteAccountId } from "./accounts";

/**
 * Server half of dismiss-with-memory. The rules live in
 * lib/domain/dismissals.ts; this file only reads and writes rows.
 */

export function getDismissals(): Dismissal[] {
  const accountId = getSelectedAccountId();
  const q = db.select().from(panelDismissals);
  const rows = accountId > 0 ? q.where(eq(panelDismissals.accountId, accountId)).all() : q.all();
  return rows.map((r) => ({ panel: r.panel, fingerprint: r.fingerprint, dismissedAt: r.dismissedAt }));
}

/** Is this panel dismissed for the situation it currently describes? */
export function panelHidden(panel: DismissiblePanel, fingerprint: string): boolean {
  return isDismissed(getDismissals(), panel, fingerprint);
}

/** Record a dismissal for the CURRENT situation. Idempotent. */
export function dismissPanel(panel: DismissiblePanel, fingerprint: string): void {
  db.insert(panelDismissals)
    .values({ accountId: getWriteAccountId(), panel, fingerprint })
    .onConflictDoNothing()
    .run();
}

/** Bring one panel (or all) back regardless of fingerprints. */
export function undismissPanels(panel?: DismissiblePanel): void {
  const accountId = getWriteAccountId();
  if (panel) {
    db.delete(panelDismissals).where(and(eq(panelDismissals.accountId, accountId), eq(panelDismissals.panel, panel))).run();
  } else {
    db.delete(panelDismissals).where(eq(panelDismissals.accountId, accountId)).run();
  }
}

/**
 * Drop rows whose situation no longer exists. Called with the fingerprints the
 * app just computed, so anything not in the map is stale by definition — and a
 * stale fingerprint must never linger where a future state could collide into it.
 */
export function pruneStaleDismissals(current: Map<DismissiblePanel, string>): void {
  const accountId = getWriteAccountId();
  const panels = [...current.keys()];
  if (panels.length === 0) return;
  for (const [panel, fp] of current) {
    db.delete(panelDismissals)
      .where(and(
        eq(panelDismissals.accountId, accountId),
        eq(panelDismissals.panel, panel),
        notInArray(panelDismissals.fingerprint, [fp]),
      ))
      .run();
  }
  // Panels the app no longer computes at all: remove wholesale.
  db.delete(panelDismissals)
    .where(and(eq(panelDismissals.accountId, accountId), notInArray(panelDismissals.panel, panels)))
    .run();
}
