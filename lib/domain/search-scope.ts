// SEARCH — the source registry (PURE — data and one gating rule).
//
// Every searchable thing declares, in ONE place, where it lives and whether it
// is scoped to the selected account. The registry is what
// tests/search-scope-guard.test.ts joins against lib/db/schema.ts: a source
// whose table carries an `account_id` column MUST say `scope: "account"`, and
// its reader in lib/queries/search.ts MUST take the account id — a search that
// forgot the filter would merge two books into one result list, and nothing on
// screen would look broken (invariant 8).
//
// Owner rulings (2026-09-04): gated results are SHOWN with a lock and what
// unlocks them, never hidden; a user's own rows — trades, playbooks,
// instruments, sessions, challans — and the bundled symbol list are NEVER
// locked (invariant 7). Only a HELP entry or a SCREEN can be locked, and only
// because the screen it opens is on PRO_FEATURES.

import { PRO_FEATURES } from "@/lib/license";

export type SearchScope = "account" | "global";

export type SourceKey = "trades" | "symbols" | "playbooks" | "instruments" | "sessions" | "challans" | "help" | "screens";

export interface SourceSpec {
  /** Chip label in the UI. */
  label: string;
  /** "account": every read is filtered by the selected account (0 = all). */
  scope: SearchScope;
  /** The SQLite table the source reads; absent for bundled / static sources. */
  table?: string;
  /**
   * A Pro href that gates EVERY result of this source. None today: the user's
   * own rows are never locked, and help/screens decide per result (below).
   */
  gatedHref?: string;
  /**
   * Each hit of this source is itself a screen, so the lock is decided per
   * result from the hit's own href against PRO_FEATURES.
   */
  perResultLock?: true;
}

export const SOURCES: Readonly<Record<SourceKey, SourceSpec>> = {
  trades: { label: "Trades", scope: "account", table: "trades" },
  symbols: { label: "Symbols", scope: "global" },
  playbooks: { label: "Playbooks", scope: "global", table: "playbooks" },
  instruments: { label: "Instruments", scope: "global", table: "instruments" },
  sessions: { label: "Sessions", scope: "account", table: "trading_sessions" },
  challans: { label: "Challans", scope: "account", table: "advance_tax_challans" },
  help: { label: "Help", scope: "global", perResultLock: true },
  screens: { label: "Screens", scope: "global", perResultLock: true },
};

/** Registry order = chip order. */
export const SOURCE_KEYS: readonly SourceKey[] = Object.keys(SOURCES) as SourceKey[];

/** Per-source cap on results. */
export const RESULT_CAP = 50;

export function isSourceKey(s: string): s is SourceKey {
  return Object.prototype.hasOwnProperty.call(SOURCES, s);
}

/**
 * `?cat=a,b` → the known keys, in registry order. `null` when the parameter
 * is absent or blank (every source); an EMPTY array when it named nothing
 * known — the route answers 400 rather than silently searching everything.
 */
export function parseCategories(csv: string | null | undefined): SourceKey[] | null {
  if (csv == null) return null;
  const wanted = new Set(
    csv
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  if (wanted.size === 0) return null;
  return SOURCE_KEYS.filter((k) => wanted.has(k));
}

export interface SearchResult {
  source: SourceKey;
  /** Row id for DB rows; the href for help/screens; the ISIN for a symbol. */
  id: number | string;
  title: string;
  subtitle?: string;
  href: string;
  locked: boolean;
  /** The PRO_FEATURES label — what buying Pro unlocks. Set only when locked. */
  unlocks?: string;
}

export interface Lock {
  locked: boolean;
  unlocks?: string;
}

type Feature = { href: string; label: string };

const FREE: Lock = { locked: false };

/**
 * Is this href behind Pro for this entitlement?
 *
 * Matches the PATH only, so a feature that is a query-string ACTION on a free
 * page (`/trades?add=open`, `partial`) never locks the page itself: `/trades`
 * is the core journal.
 */
export function lockFor(href: string, entitlement: { pro: boolean }, features: readonly Feature[] = PRO_FEATURES): Lock {
  if (entitlement.pro) return FREE;
  const path = href.split("?")[0].split("#")[0];
  const hit = features.find((f) => f.href === path);
  return hit ? { locked: true, unlocks: hit.label } : FREE;
}

/** The registry's rule: own rows never lock; help/screens lock per result. */
export function lockForSource(source: SourceKey, href: string, entitlement: { pro: boolean }, features?: readonly Feature[]): Lock {
  const spec = SOURCES[source];
  if (spec.gatedHref) return lockFor(spec.gatedHref, entitlement, features);
  if (spec.perResultLock) return lockFor(href, entitlement, features);
  return FREE;
}
