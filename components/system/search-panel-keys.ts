/**
 * The search panel's PURE bits — the toggle chord, and what a session frame
 * carries.
 *
 * No React, no DOM, no `window`: both are decisions over plain values, and
 * both were wrong in ways a browser test would have had to catch by accident.
 * `tests/search-panel.test.ts` exercises them directly.
 */

import type { SearchResult, SourceKey } from "@/lib/domain/search-scope";

/** The keydown fields the chord actually depends on. */
export interface Chord {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  key: string;
}

/**
 * Ctrl/Cmd + Shift + K toggles the panel — and ONLY that.
 *
 * `altKey` is checked because it was not: on a Windows layout Ctrl+Alt is
 * AltGr, so typing an AltGr character whose keycap is K (₹ on the Indian
 * layout, among others) opened and closed the panel under the user's cursor
 * while they were typing into something else. A chord that fires on a
 * character key is not a chord.
 *
 * Ctrl+K without Shift belongs to the modal palette and is not touched here.
 */
export function isPanelToggleChord(e: Chord): boolean {
  if (e.altKey) return false;
  if (!(e.ctrlKey || e.metaKey)) return false;
  if (!e.shiftKey) return false;
  return e.key.toLowerCase() === "k";
}

/**
 * What "← previous search" is given to restore.
 *
 * `cats` are the chips THE HITS WERE FETCHED WITH, taken off the hits
 * themselves — not the chips currently on screen. Reading the live state
 * meant that toggling a chip and then opening a result pushed a frame whose
 * results and whose filter disagreed: restoring it re-rendered the old
 * results under the new chips, which silently hid some of them.
 */
export interface HitsFrame {
  q: string;
  cats: readonly SourceKey[];
  results: SearchResult[];
}

export function frameFor(hits: HitsFrame | null | undefined): HitsFrame | null {
  if (!hits) return null;
  return { q: hits.q, cats: hits.cats, results: hits.results };
}
