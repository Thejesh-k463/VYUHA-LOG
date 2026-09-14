import "server-only";
import { and, eq, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { panelDismissals } from "@/lib/db/schema";
import {
  isDismissed,
  PER_SUBJECT_PANELS,
  type CurrentFingerprints,
  type Dismissal,
  type DismissiblePanel,
} from "@/lib/domain/dismissals";
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

/** Every dismissed fingerprint of one panel, read with the same account scope
 *  as `getDismissals()` — for a per-subject panel, whose rows the page checks
 *  one subject at a time (R13's "Keep my mark" on /risk). */
export function getDismissedFingerprints(panel: DismissiblePanel): string[] {
  return getDismissals()
    .filter((d) => d.panel === panel)
    .map((d) => d.fingerprint);
}

// ---------------------------------------------------------------------------
// Writes (invariant 9 — the aggregate view refuses)
// ---------------------------------------------------------------------------

export interface DismissalWriteResult {
  ok: boolean;
  message: string;
  /** True when the refusal is the aggregate-view write ban (route → 403). */
  forbidden?: boolean;
}

/**
 * The account a dismissal write lands on, or null in the aggregate view.
 *
 * Kept as a pre-check rather than a call into the helper alone: the aggregate
 * refusal here is a typed RESULT (`forbidden` → the route's 403), not an
 * exception. Since v3.8 getWriteAccountId() throws AccountRequiredError on
 * the same condition (its lowest-id fallback — which once filed every
 * All-accounts dismissal against account #1 — is gone), so this check is
 * belt-and-braces, never the only thing standing between a 0 and a write.
 */
function dismissalWriteAccountId(): number | null {
  if (getSelectedAccountId() === 0) return null;
  return getWriteAccountId();
}

const AGGREGATE_REFUSAL =
  "A dismissal hides an advisory for one account's book — pick an account in the sidebar first. The All-accounts view only reads.";

/** Record a dismissal for the CURRENT situation. Idempotent. */
export function dismissPanel(panel: DismissiblePanel, fingerprint: string): DismissalWriteResult {
  const accountId = dismissalWriteAccountId();
  if (accountId == null) return { ok: false, forbidden: true, message: AGGREGATE_REFUSAL };
  db.insert(panelDismissals)
    .values({ accountId, panel, fingerprint })
    .onConflictDoNothing()
    .run();
  return { ok: true, message: "Panel hidden until these facts change." };
}

/** Bring one panel (or all) back regardless of fingerprints. */
export function undismissPanels(panel?: DismissiblePanel): DismissalWriteResult {
  const accountId = dismissalWriteAccountId();
  // Deleting "everywhere" from the aggregate view would reach into books the
  // user is not looking at; deleting account #1's rows and calling it done is
  // the same silent guess as the insert. Refuse either way.
  if (accountId == null) return { ok: false, forbidden: true, message: AGGREGATE_REFUSAL };
  if (panel) {
    db.delete(panelDismissals).where(and(eq(panelDismissals.accountId, accountId), eq(panelDismissals.panel, panel))).run();
  } else {
    db.delete(panelDismissals).where(eq(panelDismissals.accountId, accountId)).run();
  }
  return { ok: true, message: panel ? "Panel restored." : "Hidden panels restored." };
}

/**
 * Drop rows whose situation no longer exists. Called with the fingerprints the
 * app just computed, so anything not in the map is stale by definition — and a
 * stale fingerprint must never linger where a future state could collide into it.
 * The one exception is a PER-SUBJECT panel (R13's `spot-close-diff`, one row per
 * symbol): it is pruned only against the fingerprint LIST it is handed, and left
 * alone by a caller that does not name it (see PER_SUBJECT_PANELS).
 *
 * Same invariant-9 refusal as the other two: the fingerprints handed in were
 * computed for whatever the caller was looking at, so pruning account #1's rows
 * against an aggregate view's fingerprints would delete decisions that account
 * never made.
 */
export function pruneStaleDismissals(current: CurrentFingerprints): DismissalWriteResult {
  const accountId = dismissalWriteAccountId();
  if (accountId == null) return { ok: false, forbidden: true, message: AGGREGATE_REFUSAL };
  const panels = [...current.keys()];
  if (panels.length === 0) return { ok: true, message: "Nothing to prune." };
  for (const [panel, fp] of current) {
    // A per-subject panel (R13's "Keep my mark") is handed EVERY current
    // fingerprint; a row survives while its own is among them.
    const keep = typeof fp === "string" ? [fp] : [...fp];
    const scope = and(eq(panelDismissals.accountId, accountId), eq(panelDismissals.panel, panel));
    db.delete(panelDismissals)
      .where(keep.length > 0 ? and(scope, notInArray(panelDismissals.fingerprint, keep)) : scope)
      .run();
  }
  // Panels the app no longer computes at all: remove wholesale — EXCEPT a
  // per-subject panel this caller did not name. It computed nothing about that
  // panel's subjects, so it cannot know which of them moved (PER_SUBJECT_PANELS).
  const untouched = PER_SUBJECT_PANELS.filter((p) => !current.has(p));
  db.delete(panelDismissals)
    .where(and(eq(panelDismissals.accountId, accountId), notInArray(panelDismissals.panel, [...panels, ...untouched])))
    .run();
  return { ok: true, message: "Stale dismissals pruned." };
}
