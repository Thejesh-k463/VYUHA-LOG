/**
 * /trades SERVER PAGING — the acceptance rule and the copy, as pure functions.
 *
 * ZERO React, ZERO DB (invariant 2). `components/trades/trades-client.tsx`
 * holds no second copy of either half.
 *
 * ── Why the acceptance rule is not inline in the component ──────────────────
 *
 * v3.9 pages the table. Page 1 comes from the server render; every later page
 * comes from `/api/trades/page`, and the response lands in a `.then` — by
 * which time the question may have changed. The filter effect already guarded
 * itself with a `cancelled` flag and a key comparison; `loadMore` did NOT.
 *
 * The hole that left: a `router.refresh()` mid-load — the account switcher,
 * saving an edit, deleting a trade — re-seeds the table with the NEW scope's
 * page 1 while the OLD scope's page 2 is still in flight. It then appended
 * account A's rows 501-1000 onto account B's page 1 and overwrote B's `total`
 * and `viewCounts` with A's. Two books in one table, and nothing on screen
 * looked broken (invariant 8's failure mode exactly).
 *
 * So a response carries the key it was FETCHED FOR, and `acceptsPage` is the
 * one place that decides whether it may land.
 *
 * ── Why the copy is here too ────────────────────────────────────────────────
 *
 * Column sort and row selection run over the LOADED rows (TanStack's
 * `getSortedRowModel` sees `data`, not the book), while the counter and the
 * view dropdown are SQL aggregates over the whole filtered set. Both are
 * correct; a screen that shows them side by side without saying so is not.
 * Stating it is cheaper than pretending a page sort is a book sort.
 */

import { TRADES_PAGE_SIZE } from "@/lib/domain/trades-filter";

/** Rendered counts elsewhere in the app use en-IN grouping; so does this. */
const n = (v: number) => v.toLocaleString("en-IN");

export interface PageAggregates<V> {
  cursor: string | null;
  total: number;
  viewCounts: V;
}

export interface PageState<T, V> extends PageAggregates<V> {
  rows: T[];
}

export interface PageBody<T, V> {
  ok?: boolean;
  rows?: T[];
  nextCursor?: string | null;
  total?: number;
  viewCounts?: V;
}

export interface PageRequest {
  /** The `filterKey` this request was ISSUED for. */
  requestedKey: string;
  /** The key the rows on screen currently answer. */
  servedKey: string;
  /** The key the controls currently ask. */
  filterKey: string;
  /** Set by the effect/handler teardown. */
  cancelled: boolean;
}

/**
 * May this response be merged into what is on screen?
 *
 * All four must hold: the request was not cancelled, the body arrived and is
 * ok, the rows on screen are still the ones this page continues
 * (`servedKey === requestedKey`), and the user has not moved on
 * (`filterKey === requestedKey`).
 */
export function acceptsPage(req: PageRequest, body: { ok?: boolean } | null | undefined): boolean {
  if (req.cancelled) return false;
  if (!body?.ok) return false;
  return req.servedKey === req.requestedKey && req.filterKey === req.requestedKey;
}

/**
 * Append a page. The keyset order is TOTAL as of v3.9, so a page boundary can
 * neither repeat a row nor skip one — and the aggregates are the server's,
 * never recomputed from `rows` (a count that means "of what we fetched" is a
 * fabricated denominator, invariant 6).
 */
export function appendPage<T, V>(prev: PageState<T, V>, body: PageBody<T, V>): PageState<T, V> {
  return {
    rows: [...prev.rows, ...(body.rows ?? [])],
    cursor: body.nextCursor ?? null,
    total: body.total ?? prev.total,
    viewCounts: body.viewCounts ?? prev.viewCounts,
  };
}

/**
 * The bare counter node, ungrouped.
 *
 * `e2e/z-remove-broker.spec.ts` matches this text node ANCHORED
 * (`/^\d+ of \d+$/`) and `e2e/trade-views.spec.ts` reads the SECOND number out
 * of it, so neither digits nor separators may move. Everything honest that
 * needs saying goes in `LOADED_COUNT_PREFIX` and the captions below, OUTSIDE
 * this node.
 */
export function rowCountLabel(loaded: number, total: number): string {
  return `${loaded} of ${total}`;
}

/** Sits before the counter: "Loaded 500 of 25001". Carries no digits. */
export const LOADED_COUNT_PREFIX = "Loaded";

/** The KPI strip on /trades is whole-book while the table is filtered. */
export const WHOLE_BOOK_CAPTION = "Totals above cover the whole book";

/** Page 1 was re-adopted by a refresh after pages 2..n had been loaded. */
export const RELOADED_TO_FIRST_PAGE = `Reloaded — showing the first ${TRADES_PAGE_SIZE} again`;

/** Free-text debounce: a five-letter symbol is one request, not five. */
export const SEARCH_DEBOUNCE_MS = 150;

/** The one-line caption under the table. `total` is the SQL count. */
export function loadedScopeCaption(total: number): string {
  return `Sort and select act on the loaded rows; filters, search and counts cover all ${n(total)}.`;
}
