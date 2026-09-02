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
 * getWriteAccountId() validates an explicit id against the accounts table, but
 * its no-selection fallback is "the lowest account id" — the silent guess
 * invariant 9 forbids. Every dismissal added from the All-accounts view was
 * therefore filed against account #1 (probed: POST /api/dismissals → 200,
 * panel_dismissals.account_id = 1). Reads in the aggregate view are unscoped,
 * so it LOOKS right there — and then account #1 alone quietly stops being
 * warned about its own unmarked holdings. Refuse before asking the resolver.
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
 *
 * Same invariant-9 refusal as the other two: the fingerprints handed in were
 * computed for whatever the caller was looking at, so pruning account #1's rows
 * against an aggregate view's fingerprints would delete decisions that account
 * never made.
 */
export function pruneStaleDismissals(current: Map<DismissiblePanel, string>): DismissalWriteResult {
  const accountId = dismissalWriteAccountId();
  if (accountId == null) return { ok: false, forbidden: true, message: AGGREGATE_REFUSAL };
  const panels = [...current.keys()];
  if (panels.length === 0) return { ok: true, message: "Nothing to prune." };
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
  return { ok: true, message: "Stale dismissals pruned." };
}
