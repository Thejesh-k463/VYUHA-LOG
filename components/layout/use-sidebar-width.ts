"use client";

import * as React from "react";
import { useStoredValue, writeStored } from "./use-stored-value";
import { useViewport } from "@/components/system/use-panel-drag";

/**
 * The sidebar's user-resizable WIDTH (v4.4.0) — the pure geometry, the stored
 * envelope, and the drag/keyboard hook.
 *
 * Modelled line-for-line on `components/system/use-panel-drag.ts`, because that
 * module already survived this exact class of bug: a value stored on one
 * screen and read back on another.
 *
 * ── Per MACHINE, in localStorage — not a settings column ────────────────────
 *
 * The width is chrome, not book data: a monitor does not change when the
 * account does. So it lives beside `vyuha-sidebar-collapsed` and
 * `vyuha-nav-order` under `vyuha-sidebar-width`, and it is excluded from a
 * backup by construction (the backup is DB tables only). A settings column
 * would cost a migration plus a `SETTINGS_MACHINE_COLUMNS` entry to keep it OUT
 * of a donor's backup — the price of a cross-device value nobody asked for.
 *
 * ── Clamped on EVERY read, not only on drag ──────────────────────────────────
 *
 * A 420 px sidebar stored on a wide monitor and reopened in a 1024 px window
 * would leave `main` 604 px wide — tables clip, and NOTHING looks broken; the
 * app just looks cramped. `main` is a scroll container, so its automatic
 * minimum size is 0 and it will shrink to nothing without complaint: the clamp
 * is the only guard. `resolveSidebarWidth` therefore clamps against the
 * CURRENT viewport every time it is asked, exactly as `resolvePosition` does
 * for the floating panel.
 *
 * ── Derived, never synced ───────────────────────────────────────────────────
 *
 * storage → `useStoredValue` → `parse` → `resolve` → render. Mid-drag the live
 * width is `committed + the gesture`, and dropping the gesture IS the cancel.
 * There is no second copy of the width in React state and no effect that
 * mirrors one (AGENTS.md: never setState in an effect keyed on other state).
 */

/** localStorage key — kebab-case `vyuha-…`, per the recorded convention. */
export const SIDEBAR_WIDTH_KEY = "vyuha-sidebar-width";

/** Today's literal (`w-[232px]` until v4.4.0) — SSR and hydration render this. */
export const SIDEBAR_DEFAULT_W = 232;

/** The narrowest width at which a truncated label still sits beside its icon. */
export const SIDEBAR_MIN_W = 180;

/** Where the longest label has slack and `main` keeps 640 px at the 1024 px window floor. */
export const SIDEBAR_MAX_W = 420;

/** What `main` is never squeezed below, whatever the sidebar does. */
export const CONTENT_MIN_W = 640;

/** Arrow-key step, and the Shift+Arrow step. */
export const SIDEBAR_STEP = 16;
export const SIDEBAR_STEP_LARGE = 64;

/**
 * The stored envelope. `px` is null until the user has resized: a sidebar
 * nobody has touched belongs at whatever this build's default is, which is a
 * decision for `resolveSidebarWidth`, not a number frozen into storage.
 */
export interface SidebarWidthState {
  v: 1;
  px: number | null;
}

export const DEFAULT_SIDEBAR_WIDTH: SidebarWidthState = { v: 1, px: null };

/**
 * Read the envelope. An unknown `v` — or no envelope at all, e.g. a bare
 * number — is DISCARDED whole: another build wrote it, and guessing what its
 * author meant is worse than opening at the default. Inside a v1 envelope a
 * corrupt `px` falls back to null on its own.
 */
export function parseSidebarWidth(raw: string | null | undefined): SidebarWidthState {
  if (!raw) return DEFAULT_SIDEBAR_WIDTH;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_SIDEBAR_WIDTH;
  const o = parsed as Record<string, unknown>;
  if (o.v !== 1) return DEFAULT_SIDEBAR_WIDTH;
  const px = typeof o.px === "number" && Number.isFinite(o.px) ? o.px : null;
  return { v: 1, px };
}

/** The ONLY producer of the stored string — never a bare number. */
export function serialiseSidebarWidth(s: SidebarWidthState): string {
  return JSON.stringify({ v: 1, px: s.px });
}

/**
 * The widest the sidebar may be in a window `viewportW` wide: MAX, or less
 * when the content floor bites. `Math.max(MIN, …)` is applied LAST so a window
 * narrower than MIN + CONTENT_MIN pins the sidebar to MIN rather than to a
 * width smaller than a label can live in (the `clampPoint` rule).
 */
export function sidebarMaxFor(viewportW: number | null): number {
  if (viewportW == null || !Number.isFinite(viewportW)) return SIDEBAR_MAX_W;
  return Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, viewportW - CONTENT_MIN_W));
}

/** `px` moved into [MIN, max-for-this-window], whole pixels. `null` viewport = pre-hydration. */
export function clampSidebarWidth(px: number, viewportW: number | null): number {
  const want = Number.isFinite(px) ? Math.round(px) : SIDEBAR_DEFAULT_W;
  return Math.max(SIDEBAR_MIN_W, Math.min(want, sidebarMaxFor(viewportW)));
}

/** The width to render: the stored px (or the default) clamped to THIS window. */
export function resolveSidebarWidth(state: SidebarWidthState, viewportW: number | null): number {
  return clampSidebarWidth(state.px ?? SIDEBAR_DEFAULT_W, viewportW);
}

/**
 * What a key on the separator does (PURE). A number is the width to commit
 * (already clamped), `"reset"` clears the stored width, `null` means the key is
 * not ours and must be left alone.
 */
export function sidebarWidthForKey(
  key: string,
  shift: boolean,
  current: number,
  viewportW: number | null,
): number | "reset" | null {
  const step = shift ? SIDEBAR_STEP_LARGE : SIDEBAR_STEP;
  switch (key) {
    case "ArrowRight":
      return clampSidebarWidth(current + step, viewportW);
    case "ArrowLeft":
      return clampSidebarWidth(current - step, viewportW);
    case "Home":
      return clampSidebarWidth(SIDEBAR_MIN_W, viewportW);
    case "End":
      return clampSidebarWidth(SIDEBAR_MAX_W, viewportW);
    case "Enter":
    case " ":
      return "reset";
    default:
      return null;
  }
}

/** Write (or, with null, clear) the stored width. Every reader re-renders. */
export function writeSidebarWidth(px: number | null): void {
  writeStored(SIDEBAR_WIDTH_KEY, px === null ? null : serialiseSidebarWidth({ v: 1, px }));
}

export interface SidebarResize {
  /** The width to render right now — mid-drag this is the live width. */
  width: number;
  /** The widest this window allows (for `aria-valuemax`). */
  max: number;
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  /** Back to the build default: the stored key is CLEARED, not set to 232. */
  reset: () => void;
}

/**
 * Pointer-drag + keyboard resize for a width `committed` from storage.
 *
 * Listeners live on `window` — no `setPointerCapture`, which THROWS when the
 * id has no active pointer, and a throw in the grab handler kills the drag
 * silently (`use-list-drag.ts`). The live gesture is read through a ref, so
 * the listener effect keys on `dragging` and registers ONCE per drag rather
 * than once per pointermove (`use-panel-drag.ts`). Escape and pointercancel
 * cancel; pointerup commits — but only if the pointer actually moved, so a
 * plain click (or the first half of a double-click) writes nothing.
 */
export function useSidebarResize(
  committed: number,
  viewportW: number | null,
  onCommit: (px: number | null) => void,
): SidebarResize {
  const [gesture, setGesture] = React.useState<{ start: number; from: number; to: number } | null>(null);

  const clamp = React.useCallback((px: number) => clampSidebarWidth(px, viewportW), [viewportW]);

  const width = gesture ? clamp(gesture.start + (gesture.to - gesture.from)) : committed;

  const gestureRef = React.useRef(gesture);
  // Synced in an effect, not during render (react-hooks/refs): a pointerup
  // cannot arrive before the commit that follows the render which moved it.
  React.useEffect(() => {
    gestureRef.current = gesture;
  }, [gesture]);
  const dragging = gesture != null;

  React.useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => setGesture((g) => (g ? { ...g, to: e.clientX } : g));
    const up = (e: PointerEvent) => {
      const g = gestureRef.current;
      setGesture(null);
      if (g && e.clientX !== g.from) onCommit(clamp(g.start + (e.clientX - g.from)));
    };
    const cancel = () => setGesture(null);
    // Escape CANCELS: the edge snaps back to where it was picked up and
    // nothing is written. Captured and stopped so the key does not also close
    // whatever is open underneath the gesture.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setGesture(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);

    // Without capture the browser selects the labels the pointer sweeps, and
    // the cursor reverts to an arrow the moment it leaves the 6 px handle.
    const body = document.body;
    const prevSelect = body.style.userSelect;
    const prevCursor = body.style.cursor;
    body.style.userSelect = "none";
    body.style.cursor = "col-resize";

    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      body.style.userSelect = prevSelect;
      body.style.cursor = prevCursor;
    };
  }, [dragging, clamp, onCommit]);

  const onPointerDown = React.useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      setGesture({ start: committed, from: e.clientX, to: e.clientX });
    },
    [committed],
  );

  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      const next = sidebarWidthForKey(e.key, e.shiftKey, committed, viewportW);
      if (next === null) return;
      e.preventDefault();
      // A key the separator handled is the separator's. Page shortcuts listen
      // on `window` — the Live Desk expands its focused row on Enter — and
      // React's stopPropagation stops the native event at the root, before it
      // reaches them.
      e.stopPropagation();
      onCommit(next === "reset" ? null : next);
    },
    [committed, viewportW, onCommit],
  );

  const reset = React.useCallback(() => onCommit(null), [onCommit]);

  return { width, max: sidebarMaxFor(viewportW), dragging, onPointerDown, onKeyDown, reset };
}

/**
 * The sidebar's width, end to end: storage → parse → clamp to this window →
 * the resize gesture. `stored` says whether a width is saved at all, which is
 * what the footer's Reset needs to know.
 *
 * Before hydration the viewport is null and storage reads null, so the first
 * paint is SIDEBAR_DEFAULT_W — the server markup matches and hydration is clean.
 */
export function useSidebarWidth(): SidebarResize & { stored: boolean } {
  const raw = useStoredValue(SIDEBAR_WIDTH_KEY);
  const state = React.useMemo(() => parseSidebarWidth(raw), [raw]);
  const viewportW = useViewport()?.w ?? null;
  const committed = resolveSidebarWidth(state, viewportW);
  const resize = useSidebarResize(committed, viewportW, writeSidebarWidth);
  return { ...resize, stored: raw !== null };
}
