// WORKSPACE MODE (PURE, no DB/React).
//
// Most traders run one book, not two. An equity-only investor has no use for
// Option Strategies or Expiry Analytics; an options seller never opens the IPO
// or Corporate Actions screens. Workspace mode lets the user say which book
// they trade so the app stops showing them the other one.
//
// ── What this is, and firmly what it is NOT ────────────────────────────────
//
// It hides NAVIGATION and sets DEFAULTS. It is not a licence tier, not a lock,
// and it never deletes or excludes data:
//
//   • Hidden screens still RESOLVE. A deep link, a bookmark or a search result
//     opens normally — hiding a menu entry must not turn a URL into a dead end.
//     Anything else would gate the journal, which invariant 7 forbids.
//   • Pre-filtering happens through the screen's OWN visible bucket control,
//     never a hidden clause in a query. The dropdown reads "Equity" and the
//     user can set it to "All buckets" in one click. A total that quietly
//     omitted F&O rows would be a wrong number on screen, and wrong numbers
//     are worse than unwanted screens.
//   • It is per-install and reversible at any time from Settings.
//
// The domain split reuses the existing `bucket` vocabulary (equity | active)
// rather than inventing a parallel one — see lib/domain/constants.ts.

import type { Bucket } from "./constants";

export const WORKSPACES = ["both", "equity", "fno"] as const;
export type Workspace = (typeof WORKSPACES)[number];

/** A screen that belongs to exactly one book. */
export type Domain = Exclude<Workspace, "both">;

export const WORKSPACE_LABELS: Record<Workspace, string> = {
  both: "Equity + F&O",
  equity: "Equity only",
  fno: "F&O only",
};

/**
 * Screens that only make sense in one book. ANYTHING ABSENT IS SHARED and is
 * shown in every mode — the safe default, because the cost of hiding a screen
 * someone needs is much higher than the cost of showing one they don't.
 *
 * Two that look one-sided and are deliberately NOT listed:
 *   /surveillance   — F&O ban list AND equity ASM/GSM/circuit bands
 *   /reports/rom    — margin on futures, short options AND intraday equity
 *
 * /settings is never listed for a further reason: it is the only way back out
 * of a mode, so hiding it would strand the user in their own preference.
 */
export const SCREEN_DOMAIN: Readonly<Record<string, Domain>> = {
  "/equity": "equity",
  "/targets/equity": "equity",
  "/ipos": "equity",
  "/corporate-actions": "equity",
  "/reports/harvest": "equity",
  "/active": "fno",
  "/targets/active": "fno",
  "/strategies": "fno",
  "/options-journal": "fno",
  "/reports/expiry": "fno",
};

/** Should this screen appear in the sidebar / command palette? */
export function screenVisible(href: string, ws: Workspace): boolean {
  if (ws === "both") return true;
  const domain = SCREEN_DOMAIN[href];
  return domain === undefined || domain === ws;
}

/**
 * The bucket a shared screen should START filtered to — "" meaning all.
 *
 * The F&O book is stored under the bucket name "active", which is why this
 * mapping exists at all: the workspace vocabulary is user-facing, the bucket
 * vocabulary is the schema's, and they are not the same word.
 */
export function defaultBucket(ws: Workspace): Bucket | "" {
  if (ws === "equity") return "equity";
  if (ws === "fno") return "active";
  return "";
}

/** Narrow an untrusted value (DB column, query param) to a Workspace. */
export function asWorkspace(v: unknown): Workspace {
  return WORKSPACES.includes(v as Workspace) ? (v as Workspace) : "both";
}
