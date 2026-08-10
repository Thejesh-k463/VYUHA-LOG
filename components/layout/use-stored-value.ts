"use client";

import * as React from "react";

/**
 * Read a `localStorage` key as React state, correctly across HYDRATION.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * The obvious way to restore per-device chrome is a mount effect:
 *
 *     const [x, setX] = useState(null);
 *     useEffect(() => { const v = localStorage.getItem(K); if (v) setX(v); }, []);
 *
 * That trips `react-hooks/set-state-in-effect`, and the usual dodge is to defer
 * the write into a microtask — `Promise.resolve().then(() => setX(v))`, the
 * shape `sidebar.tsx` uses. It works, but it keeps a SECOND copy of the value
 * in React state, and it quiets the rule rather than answering it.
 *
 * `useSyncExternalStore` answers it: the server snapshot renders the default
 * (so the markup matches and hydration is clean), then React re-reads the
 * client snapshot immediately after hydrating. No effect, no deferred write,
 * storage stays the single source of truth, and the value is DERIVED — which
 * is what the project's "never silence set-state-in-effect, derive instead"
 * rule was actually asking for.
 *
 * One thing this does NOT change: the value cannot appear before the route
 * hydrates, because it is a client-only read either way. On a full page load
 * the default order paints first. That gap is invisible in production and
 * seconds long in dev — long enough that a Playwright assertion fired straight
 * after `networkidle` reads the DEFAULT order and looks exactly like broken
 * persistence. `e2e/column-order.spec.ts` polls for that reason.
 *
 * ── The subscriber set ───────────────────────────────────────────────────
 *
 * The DOM `storage` event fires only in OTHER documents, so a write made here
 * would not re-render the component that made it. Writes therefore go through
 * `writeStored`, which notifies local subscribers as well.
 */

const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // Still worth listening: two windows of the desktop app share one origin.
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Write (or clear, with `null`) and re-render every reader of that key. */
export function writeStored(key: string, value: string | null): void {
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
  for (const l of [...listeners]) l();
}

/**
 * The raw string at `key`, or null.
 *
 * `getSnapshot` returns a primitive, so repeated reads compare equal and React
 * does not loop — returning a fresh object here is the classic way to hang this
 * hook.
 */
export function useStoredValue(key: string): string | null {
  return React.useSyncExternalStore(
    subscribe,
    () => localStorage.getItem(key),
    () => null, // server + hydration snapshot: always the default
  );
}
