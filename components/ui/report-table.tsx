import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * DataTable's LOOK for hand-rolled tables.
 *
 * The 2026-08-10 cosmetic audit found ~39 files hand-rolling `<table>` with
 * none of the reference implementation's treatment: no header band, no sticky
 * header, no row hover, ~28px rows — and, because `globals.css` puts every
 * `<table>` on the mono face, instrument names and verdicts set in JetBrains
 * Mono. One screen looked finished; the reports looked like a different app.
 *
 * These are the same classes `components/ui/data-table.tsx` earned (container
 * gradient + float shadow, 0.65625rem tracked-caps header band, 50px row
 * floor, teal hover wash, `font-sans` prose with `tabular-nums` opt-back-in
 * for numbers). Plain sub-components rather than a data-driven table: report
 * tables have colspans, tfoot totals and bespoke cells, so they keep their
 * own `<tr>` structure and only borrow the chrome.
 *
 * Adoption shape:
 *   <ReportTable>
 *     <ReportThead><ReportTh>FY</ReportTh><ReportTh align="right">Net</ReportTh></ReportThead>
 *     <tbody>
 *       <ReportTr><ReportTd>2025-26</ReportTd><ReportTd align="right">1,23,456</ReportTd></ReportTr>
 *     </tbody>
 *   </ReportTable>
 */

export function ReportTable({
  className,
  maxHeight,
  minWidth,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { maxHeight?: string; minWidth?: number }) {
  return (
    <div
      className={cn(
        "table-luxe overflow-auto rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-card-float)] [html.theme-light_&]:bg-none",
        className,
      )}
      style={maxHeight ? { maxHeight } : undefined}
      {...props}
    >
      {/* font-sans opts out of the app-wide `table { font-mono }` rule: mono is
          ~15% wider, flattens word shape and goes mushy at 13px on a dark
          ground. Numbers opt back in per-cell via ReportTd align="right". */}
      <table className="w-full font-sans text-xs" style={minWidth ? { minWidth } : undefined}>
        {children}
      </table>
    </div>
  );
}

/** Single-row sticky header on the band. Pass `<ReportTh>`s as children. */
export function ReportThead({ className, children, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead className={cn("sticky top-0 z-10 bg-surface", className)} {...props}>
      <tr className="border-b border-border bg-[var(--color-header-band)] text-left text-[color:var(--color-header-text)]">
        {children}
      </tr>
    </thead>
  );
}

export function ReportTh({
  className,
  align,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement> & { align?: "right" }) {
  return (
    <th
      className={cn(
        "whitespace-nowrap px-2.5 py-2 text-[0.65625rem] font-semibold uppercase tracking-[0.11em]",
        align === "right" && "text-right",
        className,
      )}
      {...props}
    />
  );
}

export function ReportTr({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        "h-[3.125rem] border-b border-rule transition-[background-color,box-shadow] duration-150 hover:bg-primary/5 hover:shadow-[inset_2px_0_0_0_var(--color-primary)] motion-reduce:transition-none",
        className,
      )}
      {...props}
    />
  );
}

export function ReportTd({
  className,
  align,
  muted,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement> & { align?: "right"; muted?: boolean }) {
  return (
    <td
      className={cn(
        "whitespace-nowrap px-2.5 py-2 align-middle",
        align === "right" && "text-right tabular-nums",
        muted && "text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
