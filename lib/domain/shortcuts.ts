// KEYBOARD SHORTCUTS (PURE — data plus one predicate; v4.6.0 W4).
//
// The registry the shortcuts sheet renders. Every row names the binding it
// describes (`binding`), and tests/shortcuts.test.ts checks each one against
// the code that actually handles the key — `isPaletteChord`, `isPanelToggleChord`,
// `deskAction`, `methodByKey`, the Alt+← handler — so a rebound key reddens the
// test instead of leaving the sheet describing a keyboard that no longer exists.
// Written from the code, not from memory.

export type ShortcutScope = "Everywhere" | "Live Desk" | "Sizing Lab" | "Help";

export interface Shortcut {
  /** Stable id of the binding, checked in tests/shortcuts.test.ts. */
  binding: string;
  /** The keys, in the order they are held. "Ctrl/⌘" means Ctrl on Windows, Cmd on a Mac keyboard. */
  keys: string[];
  does: string;
  scope: ShortcutScope;
}

export const SHORTCUT_SCOPES: readonly ShortcutScope[] = ["Everywhere", "Live Desk", "Sizing Lab", "Help"];

/** The window event that opens the shortcuts sheet (hero button, palette action). */
export const SHORTCUTS_EVENT = "vyuha:shortcuts";

export const SHORTCUTS: readonly Shortcut[] = [
  { binding: "palette", keys: ["Ctrl/⌘", "K"], does: "Open or close the command palette", scope: "Everywhere" },
  { binding: "search-panel", keys: ["Ctrl/⌘", "Shift", "K"], does: "Open or close the search panel", scope: "Everywhere" },
  { binding: "back", keys: ["Alt", "←"], does: "Go back to the previous screen in Vyuha", scope: "Everywhere" },
  { binding: "shortcuts-sheet", keys: ["?"], does: "Show this list of keyboard shortcuts", scope: "Everywhere" },
  { binding: "dialog-escape", keys: ["Esc"], does: "Close the open dialog", scope: "Everywhere" },
  { binding: "desk-row-down", keys: ["j"], does: "Move to the next position row", scope: "Live Desk" },
  { binding: "desk-row-up", keys: ["k"], does: "Move to the previous position row", scope: "Live Desk" },
  { binding: "desk-expand", keys: ["Enter"], does: "Expand or collapse the focused row", scope: "Live Desk" },
  { binding: "desk-sizing-lab", keys: ["l"], does: "Open the focused position in the Sizing Lab", scope: "Live Desk" },
  { binding: "desk-filter", keys: ["/"], does: "Put the cursor in the filter box", scope: "Live Desk" },
  { binding: "desk-escape", keys: ["Esc"], does: "Leave the filter box and return to the table", scope: "Live Desk" },
  { binding: "lab-1", keys: ["1"], does: "Switch to Fixed rupee amount", scope: "Sizing Lab" },
  { binding: "lab-2", keys: ["2"], does: "Switch to Fixed fractional (% risk)", scope: "Sizing Lab" },
  { binding: "lab-3", keys: ["3"], does: "Switch to Volatility · Turtle unit (N)", scope: "Sizing Lab" },
  { binding: "lab-4", keys: ["4"], does: "Switch to % volatility", scope: "Sizing Lab" },
  { binding: "lab-5", keys: ["5"], does: "Switch to Kelly / fractional Kelly", scope: "Sizing Lab" },
  { binding: "lab-6", keys: ["6"], does: "Switch to Fixed ratio", scope: "Sizing Lab" },
  { binding: "lab-7", keys: ["7"], does: "Switch to Equal weight", scope: "Sizing Lab" },
  { binding: "help-topic-escape", keys: ["Esc"], does: "Close the open topic and clear its link", scope: "Help" },
];

/** The keydown fields the "?" predicate depends on. */
export interface SheetKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/**
 * Does this keydown open the shortcuts sheet? `?` with no Ctrl/Cmd/Alt (Shift is
 * how `?` is typed, so it is allowed), never while the user is typing into a
 * field, and never over a dialog that is already open.
 */
export function isShortcutsSheetKey(e: SheetKeyEvent, typing: boolean, dialogOpen: boolean): boolean {
  if (e.key !== "?") return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  return !typing && !dialogOpen;
}
