"use client";

import * as React from "react";
import { Check, RotateCcw, Redo2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { STRATEGY_COPY, type PickerRow } from "./strategy-copy";

/**
 * THE PICKER — the whole catalogue, grouped by the audience its row names.
 *
 * The rows arrive as a prop from the server page, already trimmed to four
 * fields, so this component never imports the catalogue itself. That is a PROP
 * boundary and not a bundling one: `strategy-copy.ts` value-imports
 * `getStrategyDef` and `legKind`, so the whole 40-row catalogue is in the
 * client chunk of every build, free included (the names are public on /help
 * anyway). What a free build is not SENT is the rows in the RSC props — the
 * picker for a shelf the route would refuse to store.
 *
 * OPEN/CLOSED IS LOCAL AND DERIVED FROM A CLICK, never from an effect keyed on
 * the selection. A `setState` inside a `useEffect` keyed on other state is the
 * pattern that broke the Trades view filter outright under the React Compiler
 * (AGENTS.md), and a drawer that reopens itself on every tick would be exactly
 * that bug wearing a different hat.
 */
export function BrowseDrawer({
  rows,
  selected,
  onToggle,
  onRestore,
  onUndo,
  onRedo,
  undoable,
  redoable,
}: {
  rows: readonly PickerRow[];
  selected: readonly string[];
  onToggle: (id: string, next: boolean) => void;
  onRestore: () => void;
  onUndo: () => void;
  onRedo: () => void;
  undoable: boolean;
  redoable: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const chosen = new Set(selected);

  // Style order is the catalogue's own first-seen order, so the drawer reads
  // the way §4 is written rather than alphabetically.
  const styles: string[] = [];
  for (const r of rows) if (!styles.includes(r.style)) styles.push(r.style);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => setOpen((v) => !v)}>
          {open ? STRATEGY_COPY.browseClose : `${STRATEGY_COPY.browseOpen} (${rows.length})`}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onUndo} disabled={!undoable}>
          <Undo2 /> {STRATEGY_COPY.undo}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onRedo} disabled={!redoable}>
          <Redo2 /> {STRATEGY_COPY.redo}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onRestore}>
          <RotateCcw /> {STRATEGY_COPY.restoreDefaults}
        </Button>
      </div>

      {open ? (
        <div className="space-y-4 rounded-md border border-border p-3">
          {styles.map((style) => (
            <div key={style} className="space-y-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{style}</div>
              <div className="flex flex-wrap gap-2">
                {rows
                  .filter((r) => r.style === style)
                  .map((r) => {
                    const on = chosen.has(r.id);
                    return (
                      <button
                        key={r.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => onToggle(r.id, !on)}
                        className={`inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] border px-2.5 py-1 text-[0.6875rem] ${
                          on
                            ? "border-primary/40 bg-primary/[0.07] text-primary"
                            : "border-border bg-card-hover/30 text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {on ? <Check className="size-3" /> : null}
                        {r.name}
                        {r.beginner ? (
                          <Badge variant="secondary" size="xs">
                            basics
                          </Badge>
                        ) : null}
                      </button>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
