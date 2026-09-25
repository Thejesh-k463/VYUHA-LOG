"use client";

/**
 * THE URL FRAGMENT, READ AS AN EXTERNAL STORE (v4.3 audit round 3, U-4;
 * moved here from components/system/help-desk.tsx in v4.6.0 W4).
 *
 * `useSyncExternalStore`, never a `setState` in an effect: an effect keyed on
 * other state is what broke the Trades view filter under the React Compiler
 * (AGENTS.md), and the hash is not this component's state anyway — it belongs
 * to the document. The server snapshot is `""`, so the server render and the
 * first client render agree.
 *
 * Three signals, because the platform has no single "the fragment changed"
 * event: `hashchange` (a link click, a typed fragment, `location.hash = …`),
 * `popstate` (back/forward), and a coarse poll — because the command palette
 * deep-links with `router.push("/help#options-<id>")` and, the path being the
 * same one, the App Router moves that fragment with `history.pushState`, which
 * fires neither event and re-renders nothing in this subtree. The poll notifies
 * only when the string actually differs, so a still page re-renders nothing.
 *
 * v4.6.0 W4 adds a FOURTH signal: the help desk's own writes. Opening a topic
 * `replaceState`s `#topic-…` and closing it restores the bare path; neither
 * fires an event, so `writeHelpHash` notifies this store's subscribers directly
 * (the same shape as `writeStored` in components/layout/use-stored-value.ts) —
 * the dialog opens on the click, not 250 ms later on the poll.
 */
const HASH_POLL_MS = 250;

const writers = new Set<() => void>();

export function subscribeHash(onChange: () => void): () => void {
  let last = window.location.hash;
  const fire = () => {
    if (window.location.hash === last) return;
    last = window.location.hash;
    onChange();
  };
  window.addEventListener("hashchange", fire);
  window.addEventListener("popstate", fire);
  writers.add(fire);
  const timer = window.setInterval(fire, HASH_POLL_MS);
  return () => {
    window.removeEventListener("hashchange", fire);
    window.removeEventListener("popstate", fire);
    writers.delete(fire);
    window.clearInterval(timer);
  };
}

/** The client snapshot. */
export function readHash(): string {
  return window.location.hash;
}

/** The topic id a fragment names (`#topic-trades` → `topic-trades`), or null. */
export function topicIdFromHash(hash: string): string | null {
  const id = hash.startsWith("#") ? hash.slice(1) : hash;
  return /^topic-[a-z0-9-]+$/.test(id) ? id : null;
}

/**
 * Put `#<id>` on the URL without a navigation or a history entry, or — with
 * null — restore the bare path (query kept). Notifies every hash reader.
 * `replaceState(null, …)` is the documented App Router form: Next patches the
 * History API and keeps its own router state in sync (node_modules/next/dist/
 * docs/01-app/01-getting-started/04-linking-and-navigating.md, "Native History API").
 */
export function writeHelpHash(id: string | null): void {
  const url = id ? `#${id}` : window.location.pathname + window.location.search;
  window.history.replaceState(null, "", url);
  for (const w of [...writers]) w();
}
