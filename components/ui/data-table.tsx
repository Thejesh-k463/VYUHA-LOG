"use client";

import * as React from "react";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { GripVertical } from "lucide-react";
import { useListDrag } from "@/components/layout/use-list-drag";
import { useVirtualizer } from "@tanstack/react-virtual";
import { EmptyState } from "@/components/ui/empty-state";

interface DataTableProps<T> {
  columns: ColumnDef<T, unknown>[];
  data: T[];
  globalFilter?: string;
  emptyMessage?: string;
  maxHeight?: string;
  /** Pin the first N columns while scrolling horizontally — for wide tables
   *  where losing the symbol means losing which trade you are reading. Every
   *  pinned column except the last must declare `meta.width` so the ones after
   *  it know their left offset. */
  stickyColumns?: number;
  /**
   * Enables drag-to-reorder of the columns AFTER `stickyColumns`. Indices are
   * relative to the movable region, so 0 means `columns[stickyColumns]`.
   * Omitted, every branch below is inert and this table renders exactly as it
   * did before the feature existed.
   */
  onReorder?: (from: number, to: number) => void;
  /**
   * Windows the rows: only what fits the scroll container (plus overscan)
   * reaches the DOM. Omitted, every branch below is inert and the table
   * renders exactly as it did before the feature existed — the tracker
   * tables depend on that. Windowing is y-only, so the sticky header and
   * the sticky-left columns are untouched by construction.
   */
  virtual?: boolean;
  /** Override the table-guard budget (px). Only needed when a table's columns
   *  are far wider or narrower than the defaults below. */
  minWidth?: number;
}

/** Per-column extras carried on TanStack's `meta`. */
type ColMeta = { align?: string; truncate?: boolean; width?: number; minWidth?: number; flex?: boolean };

/* Table guard (v3 §4.2). The scroll container is `overflow-x: auto`, so the
   table itself owes an explicit min-width — Σ(fixed columns) + gutters + at
   least 200px for the flexible one. Under-budget it and the flexible column
   collapses under pressure, at which point the badges inside it lay over the
   next column instead of pushing it right. */
const FLEX_COL_MIN = 200; // §4.2 floor for the one flexible column
const FIXED_COL_MIN = 92; // ~72px of nowrap content + the 2 × 10px px-2.5 gutters

/** Per-column floors: a declared `meta.width`/`meta.minWidth` wins; the first
 *  column that is neither fixed-width nor right-aligned is the flexible one
 *  (the instrument/label column in every ledger screen); everything else is a
 *  nowrap cell. */
/**
 * Minimum table width implied by the column set.
 *
 * Exported for `tests/column-order.test.ts`: the budget must not depend on the
 * ORDER of the columns, or dragging one would change the table's min-width and
 * the layout would jump mid-interaction. It holds because eligibility for the
 * flexible allowance is a per-column property and exactly one eligible column
 * receives it — so the multiset of contributions, and therefore the sum, is the
 * same for every permutation. Make the rule POSITIONAL (say, "column 0 is
 * flexible") and reordering starts moving the min-width. The test is what
 * notices.
 */
export function budgetMinWidth<T>(columns: ColumnDef<T, unknown>[]): number {
  let flexTaken = false;
  let total = 0;
  for (const c of columns) {
    const m = c.meta as ColMeta | undefined;
    const declared = m?.width ?? m?.minWidth;
    if (declared) {
      total += declared;
    } else if (!flexTaken && (m?.flex || m?.align !== "right")) {
      flexTaken = true;
      total += FLEX_COL_MIN;
    } else {
      total += FIXED_COL_MIN;
    }
  }
  return total;
}

export function DataTable<T>({
  columns,
  data,
  globalFilter,
  emptyMessage = "No rows.",
  // dvh, not vh: on mobile browsers vh includes the retracted URL bar, which
  // pushed the last visible rows under the real viewport edge.
  maxHeight = "calc(100dvh - 320px)",
  stickyColumns = 0,
  minWidth,
  onReorder,
  virtual = false,
}: DataTableProps<T>) {
  // Opt this ONE component out of the React Compiler. The eslint-disable on
  // the useReactTable line silences the LINTER; it does not reach the
  // compiler. TanStack's table instance mutates internally without changing
  // identity, so compiler-memoized JSX keyed on `table` would stop
  // re-rendering on sort — no error, just a dead header, the same silent
  // failure class as the historical view-select break. This is the
  // TanStack-documented answer, and it gates the tracker tables too.
  "use no memo";
  const [sorting, setSorting] = React.useState<SortingState>([]);

  // Left offset of each pinned column = sum of the declared widths before it.
  const stickyLefts: number[] = [];
  for (let i = 0, acc = 0; i < stickyColumns; i++) {
    stickyLefts.push(acc);
    acc += (columns[i]?.meta as ColMeta | undefined)?.width ?? 0;
  }
  /** Sticky positioning for column i, or undefined when not pinned. */
  const stickyStyle = (i: number): React.CSSProperties | undefined => {
    if (i >= stickyColumns) return undefined;
    const w = (columns[i]?.meta as ColMeta | undefined)?.width;
    return { left: stickyLefts[i], ...(w ? { width: w, minWidth: w } : {}) };
  };

  // TanStack Table's API returns unmemoizable functions — React Compiler skips
  // this component by design; the table manages its own memoization internally.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const tableMinWidth = minWidth ?? budgetMinWidth(columns);

  // Column drag. The x axis is the only difference from the sidebar's row drag;
  // the hook's hard-won parts (window listeners, commit outside the state
  // updater, Escape-cancel) are shared.
  const thRefs = React.useRef<(HTMLElement | null)[]>([]);
  const { drag, begin } = useListDrag((_scope, from, to) => onReorder?.(from, to), "x");

  /**
   * Which edge of header `i` should show the drop line, if any.
   *
   * `drag.toIndex` is an INSERTION position among the movable headers, so it
   * ranges over 0…n and the last value has no header to mark on its left —
   * that one is drawn on the right edge of the final column instead. A drop at
   * `fromIndex` or `fromIndex + 1` both collapse to a no-op (see `dropTarget`),
   * so neither draws a line: promising a move that will not happen is worse
   * than drawing nothing.
   */
  const movableCount = Math.max(0, columns.length - stickyColumns);
  const dropEdge = (i: number): "left" | "right" | null => {
    if (!onReorder || !drag) return null;
    const to = drag.toIndex;
    if (to === drag.fromIndex || to === drag.fromIndex + 1) return null;
    const rel = i - stickyColumns;
    if (rel === to) return "left";
    if (to >= movableCount && rel === movableCount - 1) return "right";
    return null;
  };

  // ── Row windowing ───────────────────────────────────────────────────────
  // The hook is called UNconditionally (rules of hooks); `count: 0` keeps it
  // fully inert for the tracker tables. Rows are a 3.125rem FLOOR that grows
  // for two-line cells and scales with the density root font-size, so the 50px
  // here is only the first estimate — `measureElement` corrects every row.
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const rows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 50,
    overscan: 12,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const padTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const padBottom =
    virtualItems.length > 0
      ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end
      : 0;

  /** One real `<tr>`, shared verbatim by both render paths below. */
  const renderRow = (row: (typeof rows)[number], vIndex?: number) => (
    // border-rule, not border-border/40: the old separator measured
    // 1.08:1 against the row surface — invisible. See --color-rule.
    // 3.125rem = 50px at the compact root (v3 §4.2 wants 50–52px);
    // `height` on a row is a floor, so two-line instrument cells still
    // grow past it. Hover = 5% teal wash + a 2px teal left edge.
    <tr
      key={row.id}
      data-index={vIndex}
      ref={vIndex !== undefined ? virtualizer.measureElement : undefined}
      className="group h-[3.125rem] border-b border-rule transition-[background-color,box-shadow] duration-150 hover:bg-primary/5 hover:shadow-[inset_2px_0_0_0_var(--color-primary)] motion-reduce:transition-none"
    >
      {row.getVisibleCells().map((cell, i) => {
        const meta = cell.column.columnDef.meta as ColMeta | undefined;
        const raw = cell.getValue();
        return (
          <td
            key={cell.id}
            // Full value on hover for truncated cells.
            title={meta?.truncate && typeof raw === "string" ? raw : undefined}
            className={cn(
              "whitespace-nowrap px-2.5 py-2 align-middle",
              meta?.align === "right" && "text-right tabular-nums",
              // Truncate long labels (option tradingsymbols) instead of
              // forcing the whole table wide enough for the longest one.
              meta?.truncate && "max-w-[18ch] overflow-hidden text-ellipsis",
              // Sticky cells need an opaque bg; the row's own 5% teal
              // wash paints BEHIND them, so they mix the same tint into
              // the surface themselves instead of going dead on hover.
              i < stickyColumns &&
                "sticky z-[1] bg-surface group-hover:bg-[color-mix(in_oklab,var(--color-primary)_5%,var(--color-surface))]",
            )}
            style={stickyStyle(i)}
          >
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </td>
        );
      })}
    </tr>
  );

  return (
    // bg-surface on the WRAPPER so header and rows share one surface — the
    // header used to sit on bg-surface while rows showed the page background
    // through, a visible tone step the moment the header went sticky.
    // `table-luxe` paints the v3 container gradient over that surface and
    // floats it on --shadow-card-float. table-luxe carries literal dark hexes
    // and had no light-theme branch (globals.css says the first user owes it
    // one) — this is that branch: light mode drops the image and keeps the
    // flat --color-surface underneath.
    <div
      ref={scrollRef}
      className="table-luxe overflow-auto rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-card-float)] [html.theme-light_&]:bg-none"
      style={{ maxHeight }}
    >
      {/* font-sans overrides the app-wide `table { font-mono }` rule in
          globals.css. That rule put PROSE on the monospace face — instrument
          names, broker, segment, exchange — where mono is ~15% wider, flattens
          word shape (which is what the eye scans by) and goes mushy at 13px on
          a dark ground. Numbers opt back in per-cell via `tabular-nums`, so
          money and R-multiples still align to the digit, which is the only
          thing the mono face was ever needed for. */}
      <table className="w-full font-sans text-xs" style={{ minWidth: tableMinWidth }}>
        <thead className="sticky top-0 z-10 bg-surface">
          {table.getHeaderGroups().map((hg) => (
            <tr
              key={hg.id}
              className="border-b border-border bg-[var(--color-header-band)] text-left text-[color:var(--color-header-text)]"
            >
              {hg.headers.map((header, i) => {
                const canSort = header.column.getCanSort();
                // An EMPTY string header (the row-actions column) cannot be used
                // as a label: `aria-label=""` is ignored outright, so the name
                // falls back to content and picks the grip's label back up. The
                // column id is the honest stand-in — there is no visible text to
                // match.
                const headerDef = header.column.columnDef.header;
                const thLabel =
                  onReorder && i >= stickyColumns && typeof headerDef === "string"
                    ? headerDef || header.column.id
                    : undefined;
                const sorted = header.column.getIsSorted();
                return (
                  <th
                    key={header.id}
                    className={cn(
                      // Header band: one step smaller, uppercase, tracked out.
                      // Same-size same-weight headers read as a first data row.
                      // 0.59375rem = 9.5px at the compact root (v3 §4.2), in rem
                      // so comfortable density scales it with everything else.
                      "group/th whitespace-nowrap px-2.5 py-2 text-[0.65625rem] font-semibold uppercase tracking-[0.11em]",
                      // Drop indicator: an inset edge on the header the drag
                      // would insert at — no extra element, so it cannot
                      // disturb the width budget the table is laid out from.
                      dropEdge(i) === "left" && "shadow-[inset_2px_0_0_0_var(--color-primary)]",
                      dropEdge(i) === "right" && "shadow-[inset_-2px_0_0_0_var(--color-primary)]",
                      // The grabbed header dims so the line reads as "this one,
                      // going there" rather than as an unexplained mark.
                      onReorder && drag?.fromIndex === i - stickyColumns && "opacity-40",
                      canSort && "cursor-pointer select-none hover:text-foreground",
                      (header.column.columnDef.meta as ColMeta)?.align === "right" && "text-right",
                      i < stickyColumns && "sticky z-20",
                    )}
                    // A pinned header cell scrolls out over its neighbours, so it
                    // needs its own opaque backing: the band is 75% black, which
                    // would let the cells behind it read through. Painting it as
                    // an image over an opaque surface composites to exactly the
                    // same colour as the band on the row.
                    style={
                      i < stickyColumns
                        ? {
                            ...stickyStyle(i),
                            backgroundColor: "var(--color-surface)",
                            backgroundImage:
                              "linear-gradient(var(--color-header-band), var(--color-header-band))",
                          }
                        : stickyStyle(i)
                    }
                    ref={(el) => { thRefs.current[i] = el; }}
                    // A columnheader's accessible name is computed from its
                    // CONTENT, so the grip's own label lands inside it and the
                    // cell announces as "Reorder netPnl column Net". Naming the
                    // header explicitly keeps it "Net" while the grip keeps its
                    // own label for when focus reaches it. Only when the header
                    // is a plain string: for a rendered header, the visible text
                    // is unknown here and the column id would announce worse
                    // than the pollution it replaced.
                    aria-label={thLabel}
                    // A grab must not also sort. `begin` preventDefaults the
                    // pointerdown, but the click still bubbles here.
                    onClick={canSort && !drag ? header.column.getToggleSortingHandler() : undefined}
                  >
                    <span className="inline-flex items-center gap-1">
                      {onReorder && i >= stickyColumns && (
                        <button
                          type="button"
                          aria-label={`Reorder ${header.id} column`}
                          title="Drag to move this column"
                          onPointerDown={(e) =>
                            // Bounded by the CURRENT column count: the ref array
                            // is never trimmed, so a release that drops a column
                            // would otherwise leave a detached node at the tail
                            // and every midpoint after it would measure 0.
                            begin(e, "cols", header.id, i - stickyColumns, thRefs.current.slice(stickyColumns, columns.length))
                          }
                          onClick={(e) => e.stopPropagation()}
                          style={{ touchAction: "none" }}
                          className="-ml-1 cursor-grab text-muted-foreground/30 opacity-0 transition-opacity group-hover/th:opacity-100 hover:text-foreground active:cursor-grabbing"
                        >
                          <GripVertical className="size-3" />
                        </button>
                      )}
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {canSort &&
                        (sorted === "asc" ? <ArrowUp className="size-3" /> : sorted === "desc" ? <ArrowDown className="size-3" /> : <ChevronsUpDown className="size-3 opacity-40" />)}
                    </span>
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length}>
                <EmptyState variant="chart" title="Nothing here yet" hint={emptyMessage} />
              </td>
            </tr>
          ) : virtual ? (
            <>
              {/* Spacer rows keep table semantics (and therefore the sticky
                  header/left cells) intact; their height is the off-screen
                  region's measured size. aria-hidden: they are geometry. */}
              {padTop > 0 && (
                <tr aria-hidden style={{ height: padTop }}>
                  <td colSpan={columns.length} className="border-0 p-0" />
                </tr>
              )}
              {virtualItems.map((vi) => renderRow(rows[vi.index], vi.index))}
              {padBottom > 0 && (
                <tr aria-hidden style={{ height: padBottom }}>
                  <td colSpan={columns.length} className="border-0 p-0" />
                </tr>
              )}
            </>
          ) : (
            rows.map((row) => renderRow(row))
          )}
        </tbody>
      </table>
    </div>
  );
}
