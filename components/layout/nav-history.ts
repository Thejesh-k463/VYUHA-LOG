"use client";

import * as React from "react";
import { NAV_ITEMS } from "./nav-config";

/**
 * WHERE THE USER JUST CAME FROM — an in-app route stack.
 *
 * ── Why this exists at all ──────────────────────────────────────────────────
 *
 * In a browser, back is the browser's job. In the Tauri desktop shell there is
 * no browser chrome at all: no back button, no gesture, nothing. The route tree
 * is flat — forty single-segment routes, no dynamic segments — so a breadcrumb
 * has no hierarchy to describe, and a "back on drill-downs" rule has almost no
 * surface to sit on. What is actually missing on the desktop is the plain
 * "undo that navigation" affordance, and that is all this provides.
 *
 * ── Why not `history.length` ────────────────────────────────────────────────
 *
 * `history.length` counts the whole tab's history including whatever preceded
 * the app, is capped by the browser, and never decreases. It cannot answer "is
 * there an earlier screen of THIS app to go back to", which is the only
 * question the button needs answered. A stack of pathnames can.
 *
 * `router.back()` still drives the actual navigation — the browser's history is
 * authoritative, and this stack only decides whether to OFFER the control and
 * what to call it. If the two ever drift, the cost is a wrong label, not a
 * wrong navigation.
 */

/** Enough to label a back button; not a session log. */
const MAX_DEPTH = 20;

const stack: string[] = [];
const listeners = new Set<() => void>();

export interface NavHistorySnapshot {
  depth: number;
  /** The route back would land on, or null when there is none. */
  previous: string | null;
  /** That route's sidebar label, when it has one. */
  previousLabel: string | null;
}

const EMPTY: NavHistorySnapshot = { depth: 0, previous: null, previousLabel: null };

// getSnapshot must return a STABLE reference between changes: a fresh object
// every call makes useSyncExternalStore re-render forever.
let snapshot: NavHistorySnapshot = EMPTY;

function labelFor(href: string | null): string | null {
  if (!href) return null;
  return NAV_ITEMS.find((i) => i.href === href)?.label ?? null;
}

function emit(): void {
  const previous = stack.length > 1 ? stack[stack.length - 2] : null;
  snapshot = { depth: stack.length, previous, previousLabel: labelFor(previous) };
  for (const l of [...listeners]) l();
}

/**
 * Record a navigation.
 *
 * Going BACK is detected rather than recorded as a new visit: if the incoming
 * route is the one directly beneath the top, the stack pops. Without that, a
 * back followed by a back would walk forward through a growing stack and the
 * label would name a screen the user had just left.
 */
export function pushRoute(path: string): void {
  const top = stack[stack.length - 1];
  if (top === path) return;

  if (stack.length > 1 && stack[stack.length - 2] === path) {
    stack.pop();
  } else {
    stack.push(path);
    if (stack.length > MAX_DEPTH) stack.shift();
  }
  emit();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

export function useNavHistory(): NavHistorySnapshot {
  return React.useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY, // server + hydration: nothing to go back to yet
  );
}
