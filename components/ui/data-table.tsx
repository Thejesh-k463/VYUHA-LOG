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
}

/** Per-column extras carried on TanStack's `meta`. */
type ColMeta = { align?: string; truncate?: boolean; width?: number };

export function DataTable<T>({
  columns,
  data,
  globalFilter,
  emptyMessage = "No rows.",
  // dvh, not vh: on mobile browsers vh includes the retracted URL bar, which
  // pushed the last visible rows under the real viewport edge.
  maxHeight = "calc(100dvh - 320px)",
  stickyColumns = 0,
}: DataTableProps<T>) {
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

  return (
    // bg-surface on the WRAPPER so header and rows share one surface — the
    // header used to sit on bg-surface while rows showed the page background
    // through, a visible tone step the moment the header went sticky.
    <div className="overflow-auto rounded-md border border-border bg-surface" style={{ maxHeight }}>
      <table className="w-full text-xs">
        <thead className="sticky top-0 z-10 bg-surface">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id} className="border-b border-border text-left text-muted-foreground">
              {hg.headers.map((header, i) => {
                const canSort = header.column.getCanSort();
                const sorted = header.column.getIsSorted();
                return (
                  <th
                    key={header.id}
                    className={cn(
                      // Header band: one step smaller, uppercase, tracked out.
                      // Same-size same-weight headers read as a first data row.
                      // 0.6875rem (11px at the compact root) so density scales it.
                      "whitespace-nowrap px-2.5 py-2 text-[0.6875rem] font-semibold uppercase tracking-[0.06em]",
                      canSort && "cursor-pointer select-none hover:text-foreground",
                      (header.column.columnDef.meta as ColMeta)?.align === "right" && "text-right",
                      i < stickyColumns && "sticky z-20 bg-surface",
                    )}
                    style={stickyStyle(i)}
                    onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                  >
                    <span className="inline-flex items-center gap-1">
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
          ) : (
            table.getRowModel().rows.map((row) => (
              // border-rule, not border-border/40: the old separator measured
              // 1.08:1 against the row surface — invisible. See --color-rule.
              <tr key={row.id} className="group row-hover border-b border-rule">
                {row.getVisibleCells().map((cell, i) => {
                  const meta = cell.column.columnDef.meta as ColMeta | undefined;
                  const raw = cell.getValue();
                  return (
                    <td
                      key={cell.id}
                      // Full value on hover for truncated cells.
                      title={meta?.truncate && typeof raw === "string" ? raw : undefined}
                      className={cn(
                        "whitespace-nowrap px-2.5 py-1.5",
                        meta?.align === "right" && "text-right tabular-nums",
                        // Truncate long labels (option tradingsymbols) instead of
                        // forcing the whole table wide enough for the longest one.
                        meta?.truncate && "max-w-[18ch] overflow-hidden text-ellipsis",
                        // Sticky cells need an opaque bg; group-hover keeps them
                        // tinting with the row instead of going dead on hover.
                        i < stickyColumns && "sticky z-[1] bg-surface group-hover:bg-card-hover",
                      )}
                      style={stickyStyle(i)}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
