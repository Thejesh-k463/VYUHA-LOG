/**
 * The Live Desk keyboard map (spec §7), as ONE pure decision over a keydown.
 *
 * No DOM, no React: the whole map is a function from the fields a `KeyboardEvent`
 * carries to an action, so `tests/live-desk-keys.test.ts` can prove the two
 * collisions that matter without a browser.
 *
 * WHAT MUST NOT BREAK, and is asserted:
 *   Ctrl/Cmd+K          the modal command palette (`command-palette.tsx:143`)
 *   Ctrl/Cmd+Shift+K    the search panel (`search-panel-keys.ts` isPanelToggleChord)
 * Both are answered here with `null` — the desk never sees a chorded key, so a
 * bare-letter map can never shadow an app-wide one. `isPanelToggleChord` is
 * IMPORTED rather than re-implemented, because a second copy of a chord is how
 * two shortcuts drift apart.
 *
 * TYPING IS NOT NAVIGATION: while focus is inside an input, textarea, select or
 * anything `contenteditable`, every bare letter belongs to the field. Only
 * `Escape` survives, so the filter box can always hand focus back to the table.
 * Skipping this check is what makes a `j`-to-move desk unusable the moment it
 * grows a filter.
 */

import { isPanelToggleChord } from "@/components/system/search-panel-keys";

export type DeskAction =
  | "row-down"
  | "row-up"
  | "expand"
  | "sizing-lab"
  | "focus-filter"
  | "escape";

/** The keydown fields the map actually depends on. */
export interface DeskChord {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  key: string;
}

/** True when the keystroke belongs to whatever the user is typing into. */
export function isTypingTarget(tag: string | null | undefined, editable: boolean): boolean {
  if (editable) return true;
  const t = (tag ?? "").toUpperCase();
  return t === "INPUT" || t === "TEXTAREA" || t === "SELECT";
}

/**
 * The desk's action for a keystroke, or null when the desk must not act.
 *
 * @param e       the keydown fields
 * @param typing  true when focus sits in a text field (see `isTypingTarget`)
 */
export function deskAction(e: DeskChord, typing = false): DeskAction | null {
  // Escape first: it is the ONE key that works while typing, because its whole
  // job is to get focus back out of the filter and onto the table.
  if (e.key === "Escape") return "escape";
  if (typing) return null;
  // Any chord — including both existing app-wide ones — belongs to someone else.
  if (isPanelToggleChord(e)) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;

  switch (e.key) {
    case "j":
      return "row-down";
    case "k":
      return "row-up";
    case "Enter":
      return "expand";
    case "l":
    case "L":
      return "sizing-lab";
    case "/":
      return "focus-filter";
    default:
      return null;
  }
}

/** Move the focused index inside a list of `count` rows, clamped at both ends. */
export function nextIndex(current: number, count: number, delta: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, current + delta));
}
