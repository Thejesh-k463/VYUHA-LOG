"use client";

import * as React from "react";

/**
 * Pointer-driven vertical reordering for a single list.
 *
 * Pointer events rather than HTML5 drag-and-drop: DnD gives you a ghost image
 * you cannot style, fires no move events on touch, and its drop targets fight
 * the sidebar's scroll container. Pointer events cover mouse, pen and touch in
 * one path and leave the visuals entirely ours — which is the whole point when
 * the ask was "smooth, with a glow", not "functional".
 *
 * Two decisions that are load-bearing:
 *
 * 1. **The move/up listeners live on `window`, not on the grip.** The grip is a
 *    12px target; the pointer leaves it immediately and never comes back. The
 *    usual answer is `setPointerCapture`, but that call THROWS when the id has
 *    no active pointer, and a throw inside the grab handler kills the drag
 *    before any state is set — silently, because a handler that throws looks
 *    exactly like a handler that never ran. Window listeners need no capture,
 *    so there is nothing to fail: grab, and every subsequent event is ours
 *    until release, wherever the pointer goes.
 *
 * 2. **The list never re-sorts mid-drag.** Rows stay put and an insertion line
 *    moves; the commit happens once on release. Reordering under the pointer is
 *    what makes drag implementations feel like they're fighting you.
 */

export interface DragState {
  /** Which list is being dragged in — a group name, or "__groups__". */
  scope: string;
  key: string;
  fromIndex: number;
  /**
   * Where the insertion line sits, in ORIGINAL-list coordinates: "before row
   * `toIndex`". This is what the UI draws; it is NOT the index to splice at —
   * see `dropTarget`.
   */
  toIndex: number;
  /** Pixels moved since grab, for the follow transform. */
  dy: number;
}

/**
 * Convert a drop-line position into an index `moveIndex` can splice at (PURE).
 *
 * The line is drawn between existing rows, so it counts positions in the list
 * as the user currently sees it. `moveIndex` removes the dragged entry first,
 * which shifts everything below it up by one — so a downward drag lands one
 * slot past where the line promised. The line reads "between Arjun's Eye and
 * Playbooks" and the item arrives after Playbooks. Upward drags remove from
 * below the target and need no adjustment.
 *
 * A drop immediately below the grabbed row collapses to a no-op, which is
 * right: that line is drawn in the gap the row already occupies.
 */
export function dropTarget(from: number, insertionIndex: number): number {
  return insertionIndex > from ? insertionIndex - 1 : insertionIndex;
}

export function useListDrag(onCommit: (scope: string, from: number, to: number) => void) {
  const [drag, setDrag] = React.useState<DragState | null>(null);
  // Rects are measured ONCE at grab. Reading them per pointermove would hit
  // layout on every frame, and they cannot change anyway: the list is frozen
  // for the duration of the drag.
  const geom = React.useRef<{ mids: number[]; startY: number } | null>(null);
  // The live drag, mirrored outside React. The commit reads THIS rather than
  // running inside a `setState` updater: updaters must be pure, and React
  // double-invokes them in development — a commit in there fires twice.
  const stateRef = React.useRef<DragState | null>(null);
  const commitRef = React.useRef(onCommit);

  React.useEffect(() => {
    commitRef.current = onCommit;
  });

  const begin = React.useCallback(
    (e: React.PointerEvent, scope: string, key: string, index: number, siblings: (HTMLElement | null)[]) => {
      e.preventDefault();
      e.stopPropagation();
      const mids = siblings
        .filter((el): el is HTMLElement => el != null)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return r.top + r.height / 2;
        });
      geom.current = { mids, startY: e.clientY };
      const next: DragState = { scope, key, fromIndex: index, toIndex: index, dy: 0 };
      stateRef.current = next;
      setDrag(next);
    },
    [],
  );

  const dragging = drag !== null;

  React.useEffect(() => {
    if (!dragging) return;

    const onMove = (e: PointerEvent) => {
      const g = geom.current;
      const cur = stateRef.current;
      if (!g || !cur) return;
      // Insertion index = how many neighbours' midpoints the pointer has passed.
      let to = 0;
      for (const m of g.mids) if (e.clientY > m) to += 1;
      const next: DragState = { ...cur, toIndex: to, dy: e.clientY - g.startY };
      stateRef.current = next;
      setDrag(next);
    };

    const finish = (commit: boolean) => {
      const d = stateRef.current;
      stateRef.current = null;
      geom.current = null;
      setDrag(null);
      if (!commit || !d) return;
      const to = dropTarget(d.fromIndex, d.toIndex);
      if (to !== d.fromIndex) commitRef.current(d.scope, d.fromIndex, to);
    };

    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    // Escape cancels without committing — a drag you regret mid-flight should
    // not need an undo.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(false);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);

    // Without pointer capture the browser will happily select the sidebar's
    // labels as the pointer sweeps them, and the cursor reverts to an arrow the
    // moment it leaves the grip. Both give away that nothing is being held.
    const body = document.body;
    const prevSelect = body.style.userSelect;
    const prevCursor = body.style.cursor;
    body.style.userSelect = "none";
    body.style.cursor = "grabbing";

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      body.style.userSelect = prevSelect;
      body.style.cursor = prevCursor;
    };
  }, [dragging]);

  return { drag, begin };
}
