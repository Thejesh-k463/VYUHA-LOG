"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";

/**
 * A STATED row window for long client lists.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * /equity and /risk were rendering every open position into the DOM — ~2,750
 * and ~3,460 rows respectively, behind scrollers showing about nine at a time.
 * The rows nobody looked at were most of both routes' render cost, because the
 * perf sweep (and a real user) waits for hydration, not for the document.
 *
 * `DataTable` solves this with `virtual`, but these two surfaces are not
 * DataTables — one is a div list of expandable rows, the other a bespoke table
 * with an inline editor. Windowing them properly would mean rewriting both.
 * This is the smaller, honest tool: render a slice, and SAY SO.
 *
 * ── Why "show more" rather than a silent cap ──────────────────────────────
 *
 * A silent `.slice(0, 200)` reads as "this is everything" and is exactly the
 * kind of quiet truncation this codebase refuses elsewhere (the harvest holding
 * clock states "Showing 15 of N", the lenses drill-down states its 2,000 cap).
 * A user with 3,000 open positions must not be shown 200 and left to believe
 * that is their book.
 *
 * State is deliberately local and resets on remount: this is a render window,
 * not a preference, and persisting it would re-introduce the cost on next load.
 */

/** Rows rendered before the first "show more". Tuned to fill any scroller. */
export const WINDOW_STEP = 150;

export function useRowWindow<T>(rows: readonly T[], step = WINDOW_STEP) {
  const [shown, setShown] = React.useState(step);
  // A shrinking list (filter applied, account switched) must not keep a stale
  // high-water mark, or the "show more" control lingers with nothing to show.
  const visible = React.useMemo(() => rows.slice(0, shown), [rows, shown]);
  const hidden = Math.max(0, rows.length - visible.length);
  const showMore = React.useCallback(() => setShown((n) => n + step), [step]);
  return { visible, hidden, total: rows.length, showMore };
}

export function ShowMore({
  hidden,
  total,
  onClick,
  noun = "rows",
}: {
  hidden: number;
  total: number;
  onClick: () => void;
  noun?: string;
}) {
  if (hidden <= 0) return null;
  return (
    <div className="flex items-center justify-between gap-3 px-2.5 py-2 text-xs text-muted-foreground">
      <span>
        Showing {total - hidden} of {total} {noun}.
      </span>
      <Button size="sm" variant="secondary" onClick={onClick}>
        Show {Math.min(hidden, WINDOW_STEP)} more
      </Button>
    </div>
  );
}
