"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
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
 * THE ANSWER IS FOLDED, AND THEN THE CACHE IS PURGED — both, and they answer
 * different questions.
 *
 * The FOLD is what keeps THIS screen right (`live-feed-card.tsx:603`): a route
 * refresh does not re-run an initialiser, so a strip seeded from the server
 * prop would go on printing the shelf that was there BEFORE the write. The
 * route re-reads the row it wrote, so its body IS the database; `foldShelfPost`
 * is pure and `tests/strategies-page.test.ts` drives it with a real route shape.
 *
 * The `router.refresh()` keeps the NEXT MOUNT right. `next.config.ts` holds the
 * client router cache for 120s (`staleTimes: { dynamic: 120 }`) and Back reuses
 * the page payload regardless; docs/DECISIONS.md:2038-2056 granted that on the
 * condition that EVERY write path refresh after its write. Without it: tick a
 * tile (the database now holds nine ids), navigate away with the sidebar and
 * come back, and the island re-mounts on the CACHED eight-id prop — the next
 * tick posts the stale eight and the first tick is gone from the database. So
 * the refresh follows a SUCCESSFUL fold, exactly as
 * `components/settings/charge-editor.tsx:79` and `live-feed-card.tsx:813` do
 * after theirs. A refusal stored nothing and refreshes nothing. A reply that is
 * ACCEPTED but already STALE refreshes too, and re-syncs a screen still sitting
 * on the shelf it superseded — the store moved, whoever's tick was latest
 * (R5-U-2, in `run`).
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
  const router = useRouter();

  /**
   * Which write is the latest. Two quick ticks can answer out of order, and
   * folding a stale body would put the older shelf back on screen — a ref, not
   * state, because nothing renders from it.
   */
  const latest = React.useRef(0);

  /**
   * THE LAST SERVER-CONFIRMED SHELF — the only state a refusal may revert to.
   *
   * R4-U-1. This used to be a `previous` snapshotted inside the gesture, which
   * is the right answer for ONE write in flight and the wrong one for two. Tick
   * A and tick B, both refused: A's reply is stale and returns without touching
   * anything, and B's revert then landed on A's snapshot — A's OPTIMISTIC
   * state, a shelf the store never held. The strip showed A ticked while the
   * database still held the shelf from before A.
   *
   * `useRef` keeps its FIRST argument, so the seed here is the server prop this
   * island mounted on — which is the stored shelf by definition. After that it
   * moves only when the route says the store moved.
   */
  const committed = React.useRef(initShelfHistory(shelf));
  /**
   * …and WHICH write moved it. Replies can land out of order, so an older `ok`
   * must not overwrite a newer one's record — the same reason `latest` exists,
   * asked of the confirmations rather than of the renders.
   */
  const committedAt = React.useRef(0);

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
      // WHERE THE STORE IS NOW, recorded before anything is decided about the
      // screen — and recorded even when this reply is stale, because a write
      // the route ACCEPTED is where a newer tick's refusal has to land. Drop it
      // only if a newer confirmation has already been folded in.
      const before = committed.current.present;
      const advanced = r.ok && mine > committedAt.current;
      if (advanced) {
        committedAt.current = mine;
        committed.current = foldShelfPost(committed.current, r);
      }
      if (mine !== latest.current) {
        // R5-U-2. A STALE `ok` IS STILL A WRITE THAT HAPPENED — and returning
        // here without doing anything about it lost it permanently. Tick A
        // accepted but slow, tick B refused and fast: B answers first, reverts
        // the strip to `committed` (still the mount seed) and the screen is
        // back before A. A's `ok` then lands stale — it moves `committed`, and
        // used to stop there. Screen pre-A, store post-A, and the client router
        // cache never purged: the next tick posts the SCREEN's list, which no
        // longer contains A, and A is gone from the database.
        //
        // So, on the reply that moved the store: purge the cache (the store
        // moved — the same argument as the ok path's refresh, which this reply
        // never reaches), and put the screen on the shelf the route confirmed
        // IF it is still sitting on the one this reply superseded. Both halves
        // compare BY VALUE: `useState` and `useRef` seed two different objects
        // from the same server prop, so identity is false at mount even when
        // the two say the same shelf. A screen that has moved on since — a
        // later tick, a later fold — is left exactly where it is.
        //
        // RESIDUAL, recorded rather than fixed: a tick C fired in the window
        // between B's revert and A's late `ok` posts the pre-A shelf plus C,
        // which erases A in the store before this branch ever runs. Nothing on
        // the client can see that; only a write that carried the shelf it was
        // editing FROM (an if-match version) could refuse it at the route.
        //
        // A stale REFUSAL still stays silent (fix wave 4's decision): the newer
        // tick's body carries the older tick's change, so a toast for it would
        // contradict a newer acceptance.
        if (advanced) {
          setHistory((cur) =>
            sameSelection(cur.present, before) && !sameSelection(cur.present, committed.current.present)
              ? { ...cur, present: committed.current.present }
              : cur,
          );
          router.refresh();
        }
        return;
      }
      if (!r.ok) {
        toast.error(r.error);
        // PUT THE STRIP BACK. A 403, a 400 or an unreachable route stored
        // nothing, and a tile left on screen after "Nothing was stored" is the
        // screen and the database disagreeing in the one direction the user
        // cannot see. The update is FUNCTIONAL and guarded on identity so a
        // tick that landed in the meantime is not overwritten by this revert
        // (`live-feed-card.tsx` store()/saveSeconds(), fix wave 8).
        //
        // RESIDUAL, recorded rather than fixed: a refusal that is already STALE
        // (`mine !== latest`) returns above without a toast, so two refused
        // ticks state one error rather than two. That is deliberate — the newer
        // tick's body carries the older tick's change too, so if the newer one
        // is ACCEPTED the older "nothing was stored" would be a false alarm.
        // A stale refusal's state is decided by the newer tick's reply, which
        // reverts to `committed` — the same shelf, reached one step later.
        //
        // R5-U-1: THE PRESENT COMES BACK, THE HISTORY DOES NOT MOVE. Reverting
        // to the whole of `committed.current` reset Undo: `foldShelfPost` is
        // `{ ...h, present }`, so that ref's `past`/`future` are empty by
        // construction — it records the STORE, not this session — and one
        // refused tick after five accepted ones left the user with nothing to
        // undo, which is the very thing the header of this file says a write on
        // this screen must never do. `past`/`future` therefore come from the
        // gesture's PRE-TICK `history`, and NOT from `cur`: `cur === next` is
        // the optimistic state, whose `past` already carries the tick being
        // refused — undoing from there would land on a shelf the store never
        // held.
        setHistory((cur) => (cur === next ? { ...history, present: committed.current.present } : cur));
        return;
      }
      // The screen takes the route's re-read, and the client router cache is
      // purged behind it: the store has moved, so every cached RSC payload of
      // this route would seed the next mount from a shelf one tick old — and
      // the tick after that would post it back. See the header.
      setHistory((cur) => foldShelfPost(cur, r));
      router.refresh();
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
 * Do two shelves say the same thing? BY VALUE, and order matters (the strip
 * renders in the order it was built, so a re-ordered selection is a different
 * shelf — `shelfJsonEquivalent` says the same about the stored column).
 *
 * Local and tiny on purpose. `lib/domain/strategy-shelf.ts` keeps its own
 * private copy for the reducer's no-op guard; exporting that one would widen a
 * pure module's surface for a comparison this file makes in exactly one place,
 * and the two can drift only by both being wrong about what "the same shelf"
 * means. Identity is not an option here: `useState` and `useRef` each build
 * their own `ShelfState` from the same server prop, so `a === b` is false at
 * mount for two objects that hold the identical list.
 */
function sameSelection(a: ShelfState, b: ShelfState): boolean {
  return a.selected.length === b.selected.length && a.selected.every((id, i) => id === b.selected[i]);
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
