// Who a half-typed weekly note BELONGS to (PURE — no DB, no React).
//
// ── The defect this exists to make impossible ──────────────────────────────
//
// The Sunday ritual panel held its textarea in `useState(note)`, seeded once.
// The account switcher ends in `router.refresh()`, which is a SOFT refresh:
// React keeps the same component instance and only the props change. So the
// sentence a trader typed against one book stayed on screen beside the next
// book's figures, and "Save note" filed it against an account it was never
// about. Nothing errored, and the query layer was innocent — it was the draft
// that had no idea which book it came from.
//
// ── Why ownership rather than a `key` or an effect ─────────────────────────
//
// A `key` on the panel is the blunt instrument: it works, and it also throws
// the unsaved prose away silently, which is the second half of the same bug.
// Re-seeding the draft from a `useEffect` keyed on the account is the shape
// AGENTS.md bans outright (it broke the Trades filter under the React Compiler
// with no error anywhere).
//
// So the draft carries its OWNER — one account, one week — and the panel
// derives what to show at render time. A draft whose owner is not the owner on
// screen simply is not this note; the filed note renders instead. It is not
// discarded either: it stays addressable, so the panel can say out loud that
// unsaved words exist and where they were typed, rather than eating them.

/** The identity a weekly note belongs to: one account, one ISO week. */
export function noteOwner(accountId: number, weekStart: string): string {
  return `${accountId}:${weekStart}`;
}

export interface NoteDraft {
  /** `noteOwner(accountId, weekStart)` at the moment the words were typed. */
  owner: string;
  /** How that owner reads on screen, e.g. "Zerodha · 2026-W35". */
  ownerLabel: string;
  text: string;
  /** False once this exact text is the text on file for `owner`. */
  unsaved: boolean;
}

/**
 * What the textarea shows.
 *
 * The draft wins ONLY for its own owner; anything else falls back to the note
 * the server sent for the account and week actually on screen.
 */
export function noteDraftText(draft: NoteDraft | null, owner: string, filed: string): string {
  return draft && draft.owner === owner ? draft.text : filed;
}

/**
 * A draft that belongs to some OTHER account or week and was never saved.
 *
 * Returns it so the panel can state that it exists. Empty prose and prose
 * already on file are not carried: there is nothing at stake in either.
 */
export function carriedOverDraft(draft: NoteDraft | null, owner: string): NoteDraft | null {
  if (draft == null || draft.owner === owner) return null;
  if (!draft.unsaved || draft.text.trim() === "") return null;
  return draft;
}
