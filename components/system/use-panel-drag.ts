"use client";

import * as React from "react";

/**
 * The floating search panel's POSITION — the pure geometry, the stored
 * envelope, and the pointer-drag hook (v3.9, Search v2).
 *
 * ── Why not `components/layout/use-list-drag.ts` ────────────────────────────
 *
 * That hook reorders a LIST: it turns a pointer's y into an insertion index by
 * comparing midpoints, and the thing being dragged never leaves its column.
 * A floating panel is free 2-D positioning — there is no list, no insertion
 * index, and both axes matter. Sharing one hook would mean a mode flag on a
 * hook whose entire body is the midpoint maths, so this is a small dedicated
 * one instead. No new dependency: pointer events on `window` are the whole
 * mechanism.
 *
 * ── Everything above the hook is PURE ───────────────────────────────────────
 *
 * `parsePanelState` / `clampPoint` / `dragDelta` / `resolvePosition` take
 * numbers and return numbers, so tests/search-panel.test.ts exercises the
 * off-screen-recovery and version-envelope rules with no browser at all.
 *
 * ── Off-screen recovery ─────────────────────────────────────────────────────
 *
 * A panel dragged to x=2400 on a docked monitor and reopened on the laptop
 * would be stored, restored and INVISIBLE — and unreachable, because the only
 * way to move it is to grab a header that is off-screen. So the stored point
 * is never trusted as-is: `resolvePosition` clamps it against the CURRENT
 * viewport on every read, not only on drag.
 */

/** localStorage key — kebab-case `vyuha-…`, per the recorded convention. */
export const PANEL_STATE_KEY = "vyuha-search-panel";

/** The panel's fixed footprint; clamping needs a size, and this one is CSS-pinned. */
export const PANEL_SIZE = { w: 380, h: 520 } as const;

/** How close to an edge the panel may sit. */
export const PANEL_MARGIN = 8;

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

/**
 * The stored envelope. `x`/`y` are null until the user has dragged it: a panel
 * that has never been moved belongs wherever this build parks a new one, which
 * is a decision for `resolvePosition`, not a number frozen into storage on
 * first open.
 */
export interface PanelState {
  v: 1;
  x: number | null;
  y: number | null;
  open: boolean;
}

export const DEFAULT_PANEL_STATE: PanelState = { v: 1, x: null, y: null, open: false };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Read the envelope. An unknown `v` is DISCARDED whole (review-prefs.ts states
 * the reasoning: it was written by a different build, and reading it
 * field-by-field is guessing what a future author meant). Inside a v1
 * envelope, tolerance is field-level — a corrupt x must not throw away the
 * `open` the user chose.
 */
export function parsePanelState(raw: string | null | undefined): PanelState {
  if (!raw) return DEFAULT_PANEL_STATE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PANEL_STATE;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_PANEL_STATE;
  const o = parsed as Record<string, unknown>;
  if (o.v !== 1) return DEFAULT_PANEL_STATE;
  return { v: 1, x: num(o.x), y: num(o.y), open: o.open === true };
}

export function serialisePanelState(s: PanelState): string {
  return JSON.stringify({ v: 1, x: s.x, y: s.y, open: s.open });
}

/** The panel's top-left, moved so the whole rectangle sits inside the viewport. */
export function clampPoint(p: Point, size: Size, viewport: Size, margin = PANEL_MARGIN): Point {
  // Math.max(margin, …) is applied LAST so a viewport narrower than the panel
  // (a phone-width window) pins it to the top-left rather than to a negative
  // coordinate, which would put the header — the only drag handle — off-screen.
  return {
    x: Math.max(margin, Math.min(p.x, viewport.w - size.w - margin)),
    y: Math.max(margin, Math.min(p.y, viewport.h - size.h - margin)),
  };
}

/** Where a drag has moved the panel: the grabbed position plus the pointer's travel. */
export function dragDelta(start: Point, from: Point, to: Point): Point {
  return { x: start.x + (to.x - from.x), y: start.y + (to.y - from.y) };
}

/** Bottom-right, one margin in — where a panel nobody has dragged belongs. */
export function defaultPosition(size: Size, viewport: Size, margin = PANEL_MARGIN): Point {
  return clampPoint({ x: viewport.w - size.w - margin, y: viewport.h - size.h - margin }, size, viewport, margin);
}

/** The position to render at: the stored point clamped to THIS viewport, or the default. */
export function resolvePosition(state: PanelState, size: Size, viewport: Size, margin = PANEL_MARGIN): Point {
  if (state.x == null || state.y == null) return defaultPosition(size, viewport, margin);
  return clampPoint({ x: state.x, y: state.y }, size, viewport, margin);
}

// ── The viewport, as an external store ──────────────────────────────────────
//
// The clamp needs the window's size, which does not exist on the server. A
// mount effect that setStates it is exactly the `set-state-in-effect` the
// house rule forbids, so it is read the same way localStorage is:
// useSyncExternalStore, with a null server snapshot. The snapshot object is
// CACHED — returning a fresh object per call is the classic way to hang this
// hook.

let vpCache: Size = { w: 0, h: 0 };

function viewportSnapshot(): Size {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (w !== vpCache.w || h !== vpCache.h) vpCache = { w, h };
  return vpCache;
}

function subscribeViewport(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

/** The current viewport, or null before hydration. */
export function useViewport(): Size | null {
  return React.useSyncExternalStore(subscribeViewport, viewportSnapshot, () => null);
}

export interface PanelDrag {
  /** Where to render the panel right now — mid-drag this is the live position. */
  position: Point;
  dragging: boolean;
  /** Put this on the panel's HEADER; the body must stay selectable and clickable. */
  onPointerDown: (e: React.PointerEvent) => void;
  /** Arrow-key nudge for a keyboard user who cannot drag. */
  nudge: (dx: number, dy: number) => void;
}

/**
 * Pointer-drag a panel by its header.
 *
 * The live position is DERIVED (`committed` + the gesture), never synced into
 * state by an effect — the house rule, and here it also means a drag that is
 * cancelled leaves nothing to unwind: dropping the gesture IS the cancel.
 * Escape cancels; pointerup commits through `onCommit`, which is what writes
 * storage. Listeners live on `window`, so a fast drag that outruns the header
 * (or leaves the window) still tracks.
 */
export function usePanelDrag(committed: Point, size: Size, viewport: Size | null, onCommit: (p: Point) => void): PanelDrag {
  const [gesture, setGesture] = React.useState<{ start: Point; from: Point; to: Point } | null>(null);

  const vp = viewport;
  const clamp = React.useCallback((p: Point) => (vp ? clampPoint(p, size, vp) : p), [vp, size]);

  const position = gesture ? clamp(dragDelta(gesture.start, gesture.from, gesture.to)) : committed;

  /**
   * The live gesture, readable from a listener WITHOUT being a dependency.
   *
   * The effect below used to depend on `gesture` itself — an object whose `to`
   * is rewritten on every pointermove. So a single drag across the screen tore
   * down and re-registered four window listeners a few hundred times, once per
   * frame, and each teardown raced the move it was handling. Holding `to` in a
   * ref and depending on `gesture != null` registers them ONCE per drag.
   */
  const gestureRef = React.useRef(gesture);
  // Synced in an effect, not during render (react-hooks/refs): a pointerup
  // cannot arrive before the commit that follows the render which moved it.
  React.useEffect(() => { gestureRef.current = gesture; }, [gesture]);
  const dragging = gesture != null;

  React.useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => setGesture((g) => (g ? { ...g, to: { x: e.clientX, y: e.clientY } } : g));
    const up = (e: PointerEvent) => {
      const g = gestureRef.current;
      setGesture(null);
      if (g) onCommit(clamp(dragDelta(g.start, g.from, { x: e.clientX, y: e.clientY })));
    };
    // Escape CANCELS: the panel snaps back to where it was picked up, and
    // nothing is written. Captured and stopped so the same key does not also
    // close the panel underneath the gesture.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setGesture(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key, true);
    };
  }, [dragging, clamp, onCommit]);

  const onPointerDown = React.useCallback(
    (e: React.PointerEvent) => {
      // Left button only, and never from a control inside the header (the
      // close button lives there).
      if (e.button !== 0 || (e.target as HTMLElement).closest("button,input,a")) return;
      e.preventDefault();
      const at = { x: e.clientX, y: e.clientY };
      setGesture({ start: committed, from: at, to: at });
    },
    [committed],
  );

  const nudge = React.useCallback(
    (dx: number, dy: number) => onCommit(clamp({ x: committed.x + dx, y: committed.y + dy })),
    [committed, clamp, onCommit],
  );

  return { position, dragging, onPointerDown, nudge };
}
