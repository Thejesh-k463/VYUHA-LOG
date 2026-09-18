// USER-ORDERED PAGE SECTIONS (PURE — no DB, no React).
//
// The sidebar's "drag to reorder / Reset", applied to the cards of a page. No
// new algorithm: `mergeOrder` and `moveWithinVisible` (over `moveIndex`) are the
// sidebar's own (components/layout/nav-config.ts, pinned by
// tests/nav-order.test.ts); this module only fixes the envelope and the two
// rules a page adds on top.
//
// ── Where the order lives ────────────────────────────────────────────────
// localStorage `vyuha-section-order:<pageId>`, `{v:1, order}` (v4.4.0 ruling):
// on THIS device, not per account (where a card sits is not a fact about the
// book), not in backups, no migration. An unknown `v` is discarded WHOLE —
// nothing has ever written an older section order, so there is no legacy
// shape to rescue, and a half-understood future envelope would render the
// page in a nonsense order.
//
// ── The two rules ────────────────────────────────────────────────────────
// 1. A move is committed through `moveWithinVisible` over the FULL registry.
//    A drag counts only the sections on screen; committing those indices
//    straight would drop every conditionally-absent section from the saved
//    array, and the user's arrangement would be quietly rebuilt the next time
//    it appeared.
// 2. A `movable: false` section never moves: it is pinned at its default
//    index, and the persisted order holds movable ids only, so no commit can
//    name it.

import { mergeOrder, moveWithinVisible } from "@/components/layout/nav-config";
import type { PageId, SectionDef } from "@/lib/domain/section-registry";

export const SECTION_ORDER_KEY = (page: PageId): string => `vyuha-section-order:${page}`;

export type SectionOrderState = {
  v: 1;
  /** The user's order over the page's REGISTRY ids. Empty = defaults. */
  order: string[];
};

/**
 * Narrow whatever localStorage held into an envelope, or null (PURE).
 *
 * Corrupt JSON, a non-object, a missing/unknown `v` or a non-array `order` all
 * return null — the defaults render. Non-string entries and duplicates are
 * dropped: a duplicated id would make `mergeOrder` render one card twice.
 */
export function parseSectionOrder(raw: string | null | undefined): SectionOrderState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    if (o.v !== 1) return null; // a future (or absent) version is discarded, never mis-read
    if (!Array.isArray(o.order)) return null;
    const order = [...new Set(o.order.filter((k): k is string => typeof k === "string"))];
    return { v: 1, order };
  } catch {
    return null;
  }
}

/** The stored string for an order (PURE). */
export function serializeSectionOrder(order: readonly string[]): string {
  const state: SectionOrderState = { v: 1, order: [...order] };
  return JSON.stringify(state);
}

const isMovable = (d: SectionDef): boolean => d.movable !== false;

/** Movable ids in registry (default) order. */
export function movableIds(defs: readonly SectionDef[]): string[] {
  return defs.filter(isMovable).map((d) => d.id);
}

/**
 * The full render order for a page (PURE): every registry id exactly once.
 *
 * Movable ids follow `mergeOrder(saved, defaults)` — the saved order wins for
 * every id it knows, an id added by a release slots in after its nearest
 * preceding default neighbour, a deleted id drops out. Fixed ids keep their
 * DEFAULT index whatever the saved array says.
 */
export function resolveSectionOrder(defs: readonly SectionDef[], saved: readonly string[] | null | undefined): string[] {
  const movable = movableIds(defs);
  const merged = mergeOrder(saved ? [...new Set(saved)] : null, movable);
  let i = 0;
  return defs.map((d) => (isMovable(d) ? merged[i++] : d.id));
}

/**
 * Commit a move performed on the RENDERED movable sections (PURE).
 *
 * `visible` is the movable ids on screen, in their current order — a
 * subsequence of the resolved order. Returns the new persisted order (movable
 * ids only), with every hidden section left exactly where it sat.
 */
export function commitSectionMove(
  defs: readonly SectionDef[],
  saved: readonly string[] | null | undefined,
  visible: readonly string[],
  from: number,
  to: number,
): string[] {
  const movable = new Set(movableIds(defs));
  const full = resolveSectionOrder(defs, saved).filter((id) => movable.has(id));
  const vis = visible.filter((id) => movable.has(id));
  return moveWithinVisible(full, vis, from, to);
}

export type SectionStep = "up" | "down" | "start" | "end";

/**
 * One keyboard / button step for `id` among the `visible` movable sections
 * (PURE). Returns the new persisted order, or null when the step is a no-op
 * (already first / last, or `id` is not a visible movable section).
 */
export function stepSectionMove(
  defs: readonly SectionDef[],
  saved: readonly string[] | null | undefined,
  visible: readonly string[],
  id: string,
  step: SectionStep,
): string[] | null {
  const movable = new Set(movableIds(defs));
  const vis = visible.filter((v) => movable.has(v));
  const from = vis.indexOf(id);
  if (from < 0) return null;
  const to = step === "up" ? from - 1 : step === "down" ? from + 1 : step === "start" ? 0 : vis.length - 1;
  if (to < 0 || to >= vis.length || to === from) return null;
  return commitSectionMove(defs, saved, vis, from, to);
}
