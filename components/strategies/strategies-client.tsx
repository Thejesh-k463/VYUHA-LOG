"use client";

import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "@/components/ui/toaster";
import {
  canRedo,
  canUndo,
  initShelfHistory,
  shelfReducer,
  type ShelfAction,
  type ShelfPostResult,
  type ShelfState,
} from "@/lib/domain/strategy-shelf";
import { STRATEGY_COPY, foldShelfPost, type PickerRow, type ScreenGroup } from "./strategy-copy";
import { BrowseDrawer } from "./browse-drawer";
import { ShelfLockedStrip, ShelfStrip } from "./shelf-strip";
import { StrategyCard } from "./strategy-card";

/**
 * THE ONE STATEFUL PIECE OF /strategies: the shelf.
 *
 * NOT A SERVER ACTION, and the reason is AGENTS.md's, sharpened by what this
 * screen holds. An action revalidates the current route and REMOUNTS its
 * sibling client components — here that is the picker itself, whose open
 * drawer and (worse) whose UNDO HISTORY would reset on every tick. So: route
 * handler + `fetch`, exactly as the charge editor and the live-feed card do.
 *
 * AND THE ANSWER IS FOLDED, not re-fetched and not refreshed
 * (`components/settings/live-feed-card.tsx:603`). A route refresh does not
 * re-run an initialiser, so a strip initialised from the server prop would go
 * on printing the shelf that was there BEFORE the write. The route re-reads the
 * row it wrote, so its body IS the database; `foldShelfPost` is pure and
 * `tests/strategies-page.test.ts` drives it with a real route shape.
 *
 * NO EFFECT ANYWHERE. Everything on this screen is derived at render from
 * `history.present` and the props — the rule AGENTS.md states after the Trades
 * view filter broke under the React Compiler.
 *
 * A FREE BUILD NEVER POSTS. The route refuses it (403) and `pro` is false here,
 * so the strip renders locked and no write is even attempted — a refusal the
 * user can see beats one they have to trigger.
 */
export function StrategiesClient({
  groups,
  charts,
  shelf,
  picker,
  pro,
}: {
  groups: ScreenGroup[];
  /** Each group's payoff chart, rendered by the SERVER page and handed through
   *  as a node: the lazy mount stays where the perf guard put it. */
  charts: Record<string, React.ReactNode>;
  shelf: ShelfState;
  picker: PickerRow[] | null;
  pro: boolean;
}) {
  const [history, setHistory] = React.useState(() => initShelfHistory(shelf));

  /**
   * Which write is the latest. Two quick ticks can answer out of order, and
   * folding a stale body would put the older shelf back on screen — a ref, not
   * state, because nothing renders from it.
   */
  const latest = React.useRef(0);

  /**
   * One user gesture: reduce, render, write, fold.
   *
   * The reduction happens OUTSIDE the state updater on purpose — a `fetch`
   * fired from inside an updater runs twice under StrictMode's double
   * invocation, which is two writes for one click.
   */
  const run = (action: ShelfAction) => {
    if (!pro) return;
    const next = shelfReducer(history, action);
    // A no-op (unticking what was never ticked, undo with no history) must not
    // spend a round-trip either.
    if (next === history) return;
    setHistory(next);
    const mine = ++latest.current;
    const body =
      action.type === "restore"
        ? { action: "restore" as const }
        : { action: "set" as const, selected: next.present.selected };
    void postShelf(body).then((r) => {
      if (mine !== latest.current) return;
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setHistory((cur) => foldShelfPost(cur, r));
    });
  };

  const rows = picker ?? [];

  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {STRATEGY_COPY.shelfTitle}
          </div>
          {pro ? (
            <>
              <ShelfStrip
                selected={history.present.selected}
                rows={rows}
                onUnselect={(id) => run({ type: "unselect", id })}
              />
              <BrowseDrawer
                rows={rows}
                selected={history.present.selected}
                onToggle={(id, next) => run(next ? { type: "select", id } : { type: "unselect", id })}
                onRestore={() => run({ type: "restore" })}
                onUndo={() => run({ type: "undo" })}
                onRedo={() => run({ type: "redo" })}
                undoable={canUndo(history)}
                redoable={canRedo(history)}
              />
            </>
          ) : (
            <ShelfLockedStrip />
          )}
        </CardContent>
      </Card>

      {groups.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">{STRATEGY_COPY.empty}</CardContent>
        </Card>
      ) : (
        groups.map((g) => <StrategyCard key={g.key} group={g} chart={charts[g.key]} />)
      )}
    </div>
  );
}

/**
 * The write. The body is read INSIDE the `try`: a route that answers with HTML
 * (a restarting sidecar, a 502) rejects `res.json()` even though the `fetch`
 * itself resolved, and a bare `return res.json()` hands that rejection back
 * out — the live-feed card's own scar.
 */
async function postShelf(body: Record<string, unknown>): Promise<ShelfPostResult> {
  try {
    const res = await fetch("/api/strategies/shelf", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as ShelfPostResult;
  } catch {
    return { ok: false, error: STRATEGY_COPY.shelfUnreachable };
  }
}
