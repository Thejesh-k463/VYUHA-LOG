// OPTION STRATEGY SHELF (PURE, no DB/React — invariant 2).
//
// The catalogue lists every structure Vyuha can price; the SHELF is the subset
// this person keeps in front of them. Three separate concerns live here and
// nowhere else, so the route handler, the client panel and the tests all agree
// on one implementation:
//
//   1. the PERSISTED SHAPE — a versioned envelope in `settings.strategy_shelf_json`
//      (migration 0071), parsed defensively;
//   2. the WIRE SHAPE of the POST that saves it (`ShelfPostResult`), declared
//      here because the route returns it and the panel folds it — a type
//      duplicated at both ends of a seam is the seam that drifts;
//   3. the UNDO/REDO history, as a pure reducer, because "I unticked the wrong
//      one" is the single most likely thing to happen on this screen.
//
// WHY A LIST OF IDS AND NOT A SET OF FLAGS: order is a preference too (the
// shelf renders in the order it was built), and a JSON array preserves it for
// free. Duplicates are removed on the way in rather than tolerated — the same
// id twice would render twice and toggle once.

/** Persisted envelope. `v` is what lets a future shape be discarded, not half-read. */
export interface ShelfEnvelope {
  v: 1;
  selected: string[];
}

/** The shelf as the app holds it. */
export interface ShelfState {
  selected: string[];
}

/**
 * What POST /api/strategy-shelf answers. Declared HERE so the route (which
 * builds it) and the panel (which folds it) cannot drift apart.
 */
export type ShelfPostResult =
  | { ok: true; shelf: ShelfState; updatedAt: string }
  | { ok: false; error: string };

export const SHELF_ENVELOPE_VERSION = 1 as const;

/**
 * The eight the shelf starts with, in this order — the structures a retail
 * options book in India actually opens: two outrights, the four vertical
 * spreads, one volatility structure and one defined-risk range trade. Stored
 * NOWHERE: `strategy_shelf_json` stays null until the user picks, so changing
 * this list changes what every untouched install sees.
 */
export const DEFAULT_SHELF: readonly string[] = [
  "long-call",
  "long-put",
  "bull-call-spread",
  "bear-put-spread",
  "bull-put-spread",
  "bear-call-spread",
  "long-straddle",
  "iron-condor",
] as const;

/**
 * How many steps back the shelf remembers. Bounded because the history lives in
 * a client component for the lifetime of a page and an unbounded array of
 * snapshots is a leak, not a feature; 50 is far past the point where anyone is
 * still undoing rather than restoring.
 */
export const SHELF_UNDO_DEPTH = 50;

/** A fresh shelf: the defaults, as a mutable copy nobody can alias into. */
export function defaultShelf(): ShelfState {
  return { selected: [...DEFAULT_SHELF] };
}

/** Dedupe, preserving first-seen order. */
function uniq(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Read the persisted column.
 *
 * Anything that is not a v1 envelope — null, "", broken JSON, an array, `{}`,
 * `{v:2,…}`, a `selected` that is not an array — is DEFAULTS, never a partial
 * read: the same rule `readBackfillProgress()` applies to its own envelope.
 * Inside a valid envelope, ids the catalogue no longer knows are DROPPED and
 * duplicates removed, because a deleted strategy id must not survive as a
 * ghost tile.
 *
 * An EMPTY valid envelope stays empty. "I want nothing on my shelf" is a real
 * choice and must round-trip; only an unreadable value falls back to defaults.
 *
 * @param validIds the catalogue's ids (`STRATEGY_IDS`,
 *   lib/analytics/strategy-catalogue.ts). Passed in rather than imported so
 *   this module stays free of the catalogue and can be fuzzed on its own.
 */
export function parseShelf(raw: string | null, validIds: readonly string[]): ShelfState {
  if (!raw) return defaultShelf();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultShelf();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaultShelf();
  const env = parsed as Partial<ShelfEnvelope>;
  if (env.v !== SHELF_ENVELOPE_VERSION) return defaultShelf();
  if (!Array.isArray(env.selected)) return defaultShelf();
  const allowed = new Set(validIds);
  return { selected: uniq(env.selected.filter((id): id is string => typeof id === "string" && allowed.has(id))) };
}

/** Write the persisted column. Always the current envelope version. */
export function serializeShelf(state: ShelfState): string {
  const env: ShelfEnvelope = { v: SHELF_ENVELOPE_VERSION, selected: uniq(state.selected) };
  return JSON.stringify(env);
}

/* ─────────────────────────────── undo / redo ─────────────────────────────── */

export interface ShelfHistory {
  past: ShelfState[];
  present: ShelfState;
  future: ShelfState[];
}

export type ShelfAction =
  | { type: "select"; id: string }
  | { type: "unselect"; id: string }
  | { type: "set"; ids: string[] }
  | { type: "restore" }
  | { type: "undo" }
  | { type: "redo" };

export function initShelfHistory(present: ShelfState): ShelfHistory {
  return { past: [], present: { selected: uniq(present.selected) }, future: [] };
}

export function canUndo(h: ShelfHistory): boolean {
  return h.past.length > 0;
}

export function canRedo(h: ShelfHistory): boolean {
  return h.future.length > 0;
}

function sameSelection(a: ShelfState, b: ShelfState): boolean {
  return a.selected.length === b.selected.length && a.selected.every((id, i) => id === b.selected[i]);
}

/** Push a new present, dropping the redo branch and bounding the depth. */
function commit(h: ShelfHistory, next: ShelfState): ShelfHistory {
  // A no-op must not consume an undo step: unticking something that was never
  // ticked would otherwise make one Ctrl+Z do nothing visible, which reads as
  // broken undo.
  if (sameSelection(h.present, next)) return h;
  const past = [...h.past, h.present];
  // Oldest first out. The bound is on PAST only — future is bounded by past.
  if (past.length > SHELF_UNDO_DEPTH) past.splice(0, past.length - SHELF_UNDO_DEPTH);
  // A new action is a new branch: whatever redo pointed at is unreachable now.
  return { past, present: next, future: [] };
}

/**
 * The whole shelf interaction, as one pure function.
 *
 * `select`/`unselect`/`set` do NOT validate against the catalogue — the reducer
 * has no catalogue and must not grow one. Validation happens at the two real
 * boundaries: `parseShelf()` on the way out of the database, and the route on
 * the way in from the client.
 */
export function shelfReducer(h: ShelfHistory, action: ShelfAction): ShelfHistory {
  switch (action.type) {
    case "select":
      return commit(h, { selected: uniq([...h.present.selected, action.id]) });
    case "unselect":
      return commit(h, { selected: h.present.selected.filter((id) => id !== action.id) });
    case "set":
      return commit(h, { selected: uniq(action.ids) });
    case "restore":
      return commit(h, defaultShelf());
    case "undo": {
      if (!canUndo(h)) return h;
      const past = [...h.past];
      const present = past.pop()!;
      return { past, present, future: [h.present, ...h.future] };
    }
    case "redo": {
      if (!canRedo(h)) return h;
      const [present, ...future] = h.future;
      return { past: [...h.past, h.present], present, future };
    }
  }
}
