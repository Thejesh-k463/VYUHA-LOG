// USER-ORDERED TABLE COLUMNS (PURE, no DB/React).
//
// The Trades table lets the user drag columns into the order they work in. Two
// things make that less trivial than it looks.
//
// ── 1. The order lives in the ARRAY, not in TanStack's columnOrder state ──
//
// `components/ui/data-table.tsx` reads the raw `columns` prop POSITIONALLY in
// two places — `budgetMinWidth()` walks it to compute the table's min-width,
// and `stickyStyle(i)` reads `columns[i].meta.width` to place the pinned cells
// — while rendering goes through TanStack's `getHeaderGroups()`. Today those
// agree because nothing reorders anything.
//
// Turning on TanStack's own `columnOrder` would break that silently: the DOM
// would render the new order while the width budget and the sticky offsets
// still described the old one. The pinned pair would take its `left` values
// from whichever columns happened to sit at indices 0 and 1, so they overlap or
// gap; and the min-width would describe a layout that no longer exists, so the
// flexible column collapses under horizontal pressure and its badges lay over
// the neighbour. Nothing throws. It is wrong at some widths and fine at others.
//
// Reordering the array keeps `i` and `columns[i]` in lockstep by construction.
//
// ── 2. The pinned prefix is structurally unreachable ─────────────────────
//
// The first `pinned` columns (the row-select checkbox and Instrument) are
// frozen while scrolling sideways. `select` declares the `meta.width` the
// sticky maths needs, and `budgetMinWidth` awards its 200px flexible allowance
// to the FIRST column that is neither width-declared nor right-aligned — which
// must stay Instrument. So the head is sliced off before any reordering and
// re-attached afterwards: a saved array cannot move those columns even if it
// names them, because the code never looks at them.

import { mergeOrder } from "@/components/layout/nav-config";

/** The shape this module needs from a TanStack column definition. */
export interface ColumnLike {
  id?: string;
  accessorKey?: string | number;
}

/**
 * A stable key for a column.
 *
 * TanStack accepts either `id` or `accessorKey`; a definition carrying neither
 * would collapse onto the empty string and two such columns would fold into
 * one on reload, silently losing a column.
 */
export function columnKey(c: ColumnLike): string {
  return c.id ?? (c.accessorKey != null ? String(c.accessorKey) : "");
}

/**
 * Apply a saved order to `columns`, keeping the first `pinned` in place (PURE).
 *
 * Built on `mergeOrder`, so a saved order survives a release that changes the
 * columns: a column the saved array has never seen appears at its DEFAULT slot
 * rather than at the end or nowhere, and a column that no longer exists drops
 * out silently. Never mutates its input.
 */
export function applyColumnOrder<T extends ColumnLike>(
  columns: T[],
  saved: string[] | null | undefined,
  pinned: number,
): T[] {
  const head = columns.slice(0, pinned);
  const tail = columns.slice(pinned);
  const order = mergeOrder(saved, tail.map(columnKey));
  const byKey = new Map(tail.map((c) => [columnKey(c), c]));
  const moved = order.map((k) => byKey.get(k)).filter((c): c is T => c != null);
  return [...head, ...moved];
}

/** The movable keys of an ordered column list — what gets persisted. */
export function movableKeys<T extends ColumnLike>(columns: T[], pinned: number): string[] {
  return columns.slice(pinned).map(columnKey);
}

/** Persisted shape. The version field lets a future change be discarded
 *  rather than mis-parsed. */
export interface StoredColumnOrder {
  v: 1;
  order: string[];
}

/** Narrow whatever localStorage held into an order, or null. */
export function parseStoredOrder(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredColumnOrder;
    if (parsed?.v !== 1 || !Array.isArray(parsed.order)) return null;
    return parsed.order.filter((k): k is string => typeof k === "string");
  } catch {
    return null; // corrupt entry = default order, never a crash
  }
}
