"use client";

import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ProLock } from "@/components/system/pro-lock";
import { STRATEGY_COPY, type PickerRow } from "./strategy-copy";

/**
 * THE SHELF, COMPACT — the structures this person keeps to hand, as tiles.
 *
 * It renders the SELECTED ids in shelf order and nothing else: the order is the
 * user's, `parseShelf` has already dropped anything the catalogue no longer
 * knows, and a tile whose row is missing is skipped rather than drawn as a raw
 * id. Removing a tile is one `unselect` — the parent owns the history and the
 * write, so this component holds no state at all.
 */
export function ShelfStrip({
  selected,
  rows,
  onUnselect,
}: {
  selected: readonly string[];
  rows: readonly PickerRow[];
  onUnselect: (id: string) => void;
}) {
  const byId = new Map(rows.map((r) => [r.id as string, r]));
  const tiles = selected.map((id) => byId.get(id)).filter((r): r is PickerRow => r != null);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {tiles.length === 0 ? (
        <span className="text-xs text-muted-foreground">{STRATEGY_COPY.shelfEmpty}</span>
      ) : (
        tiles.map((r) => (
          <span
            key={r.id}
            className="inline-flex items-center gap-1 rounded-[var(--radius-pill)] border border-border bg-card-hover/40 py-0.5 pl-2.5 pr-1 text-[0.6875rem]"
          >
            {r.name}
            <button
              type="button"
              onClick={() => onUnselect(r.id)}
              aria-label={`Remove ${r.name} from the shelf`}
              className="rounded p-0.5 text-muted-foreground hover:bg-card-hover hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </span>
        ))
      )}
    </div>
  );
}

/**
 * The same strip for a build without a licence: the lock and ONE line.
 *
 * It lists no names and offers no control, which is what makes the free screen
 * honest — a disabled checkbox reads as "broken", a lock reads as "not yours
 * yet" (`ProLock`'s own header). The route refuses the write anyway; this is
 * the half that never asks.
 */
export function ShelfLockedStrip() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ProLock />
      <span className="text-xs text-muted-foreground">{STRATEGY_COPY.shelfLocked}</span>
      <Badge variant="secondary">{STRATEGY_COPY.shelfTitle}</Badge>
    </div>
  );
}
