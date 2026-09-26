// GETTING STARTED (PURE — no React, no DB; invariant 2). v4.6.0 W4, row 9.5.
//
// Five first steps shown as a strip on the dashboard, each derived from data
// the app already holds — no schema change, no new table:
//
//   account   an account exists                      (accounts, global)
//   trades    the selected book holds a trade         (trades, scoped — invariant 8)
//   plan      no account in scope is flagged by getAccountsWithoutPlan()
//             (Data Quality's list — the default plan is stored as NULL)
//   stop      a trade in the book records its stop   (trades.sl_planned, scoped)
//   backup    a backup was downloaded ON THIS MACHINE (a localStorage marker —
//             the database records no backup anywhere, so this is the one step
//             the strip can only know about for this browser profile)
//
// The server half of the facts comes from lib/queries/getting-started.ts; the
// backup half is read on the client. `deriveGettingStarted` only combines them.

export type GettingStartedId = "account" | "trades" | "plan" | "stop" | "backup";

export interface GettingStartedStep {
  id: GettingStartedId;
  title: string;
  hint: string;
  href: string;
}

export const GETTING_STARTED_STEPS: readonly GettingStartedStep[] = [
  { id: "account", title: "Account made", hint: "An account holds one broker book; Settings lists them.", href: "/settings" },
  { id: "trades", title: "Trades imported", hint: "A broker file or an API pull brings the book in.", href: "/import" },
  {
    id: "plan",
    title: "Charges plan set",
    hint: "The broker's pricing plan decides which rate card prices each trade.",
    href: "/settings",
  },
  { id: "stop", title: "A stop recorded", hint: "A trade with its planned stop gives R, risk at stop and heat.", href: "/trades" },
  { id: "backup", title: "Backup taken", hint: "A complete backup downloaded on this machine.", href: "/backup" },
];

/** What the server can count (the selected account's view; accounts are global). */
export interface GettingStartedServerFacts {
  accounts: number;
  trades: number;
  planSet: boolean;
  stopRecorded: boolean;
}

export interface GettingStartedFacts extends GettingStartedServerFacts {
  /** From the `vyuha-backup-taken` marker — this machine only. */
  backupTaken: boolean;
}

export interface GettingStartedView {
  steps: (GettingStartedStep & { done: boolean })[];
  doneCount: number;
  allDone: boolean;
}

export function deriveGettingStarted(facts: GettingStartedFacts): GettingStartedView {
  const done: Record<GettingStartedId, boolean> = {
    account: facts.accounts > 0,
    trades: facts.trades > 0,
    plan: facts.planSet,
    stop: facts.stopRecorded,
    backup: facts.backupTaken,
  };
  const steps = GETTING_STARTED_STEPS.map((s) => ({ ...s, done: done[s.id] }));
  const doneCount = steps.filter((s) => s.done).length;
  return { steps, doneCount, allDone: doneCount === steps.length };
}

// ── The two localStorage markers (AGENTS: `vyuha-` kebab keys, `{v:1, …}` envelope) ──

export const BACKUP_TAKEN_KEY = "vyuha-backup-taken";
export const GETTING_STARTED_DISMISSED_KEY = "vyuha-getting-started-dismissed";

/** `{v:1, at}` — what both markers store. */
export function markerJson(at: string): string {
  return JSON.stringify({ v: 1, at });
}

/**
 * Read a `{v:1, at}` marker. Anything else — a future `v`, a bare string, a
 * missing `at`, unparseable JSON — is NO marker: a shape this release does not
 * know is discarded rather than mis-read.
 */
export function parseMarker(raw: string | null): { at: string } | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== "object") return null;
    const { v, at } = o as { v?: unknown; at?: unknown };
    return v === 1 && typeof at === "string" && at.length > 0 ? { at } : null;
  } catch {
    return null;
  }
}
