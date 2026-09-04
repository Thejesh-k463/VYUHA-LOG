// SEARCH — query tokenising and in-memory ranking (PURE).
//
// Two engines answer a search box: FTS5 (trigram) over the trades table, and
// this module over everything small enough to hold in memory — the bundled
// symbol list, playbooks, instruments, help entries, screens. The FTS side
// only understands terms of THREE OR MORE characters (the trigram tokenizer's
// rule; a shorter term matches nothing), so `minTrigram` is the switch the
// caller flips: below it, the in-memory prefix ranking is the whole answer.
//
// Ranking is a tier ladder, not a score: exact ticker beats ticker prefix
// beats a name/keyword substring beats an exact BSE code. Within a tier the
// order is the label, so the same query always returns the same list.

import { SOURCE_KEYS, type SourceKey } from "./search-scope";

/** FTS5 trigram: a term shorter than this matches nothing. */
export const TRIGRAM_MIN = 3;

/**
 * Lower-cased, whitespace-split, de-duplicated, in query order.
 *
 * CONTROL CHARACTERS ARE STRIPPED FIRST. A NUL (or any C0 byte) pasted into
 * the box reached FTS5 inside a quoted term and SQLite answered
 * `unterminated string`, which surfaced as an unhandled 500 from
 * /api/search — the quote-doubling in `ftsMatch` cannot escape a NUL because
 * SQLite's own string reader stops there. Stripping at the token boundary
 * keeps every downstream consumer (FTS and the in-memory ranker) fed the same
 * text, so a control byte narrows nothing and throws nothing.
 */
export function tokenise(q: string): string[] {
  const out: string[] = [];
  for (const raw of String(q ?? "").toLowerCase().replace(/[\u0000-\u001f\u007f]/g, "").split(/\s+/)) {
    const t = raw.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** The tokens FTS can use — those of TRIGRAM_MIN or more characters. */
export function ftsTokens(q: string): string[] {
  return tokenise(q).filter((t) => [...t].length >= TRIGRAM_MIN);
}

/** Can the FTS path run for this query at all? */
export function minTrigram(q: string): boolean {
  return ftsTokens(q).length > 0;
}

/**
 * The MATCH expression for `trades_fts`, or null when no token qualifies.
 *
 * Every token is a QUOTED STRING — inside double quotes FTS5 treats `AND`,
 * `OR`, `NOT`, `*`, `^`, `:` and parentheses as literal text, so a user typing
 * `fomo OR chased` searches for those words rather than running an operator.
 * A double quote inside a token is doubled, which is FTS5's own escape.
 * Tokens are AND-ed (FTS5's implicit conjunction), so every term must appear
 * somewhere in the row — in any column, in any order.
 */
export function ftsMatch(q: string): string | null {
  const toks = ftsTokens(q);
  if (toks.length === 0) return null;
  return toks.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");
}

/** What an in-memory source hands the ranker. */
export interface Candidate {
  id: number | string;
  /** Tie-break and display; the ticker for a symbol, the title otherwise. */
  label: string;
  ticker?: string | null;
  name?: string | null;
  keywords?: readonly string[];
  bseCode?: string | null;
}

/** 0 exact ticker · 1 ticker prefix · 2 name/keyword substring · 3 BSE code exact. */
export type Tier = 0 | 1 | 2 | 3;

export interface Ranked<C extends Candidate = Candidate> {
  candidate: C;
  tier: Tier;
}

const lower = (s: string | null | undefined) => (s ?? "").toLowerCase();

/** The best tier ONE token reaches on a candidate, or null when it misses. */
export function matchTier(token: string, c: Candidate): Tier | null {
  const t = token.toLowerCase();
  if (!t) return null;
  const ticker = lower(c.ticker);
  if (ticker && ticker === t) return 0;
  if (ticker && ticker.startsWith(t)) return 1;
  if (lower(c.name).includes(t) || lower(c.label).includes(t) || (c.keywords ?? []).some((k) => lower(k).includes(t))) return 2;
  if (c.bseCode && c.bseCode === t) return 3;
  return null;
}

/**
 * Rank candidates for a query. EVERY token must hit; the candidate's tier is
 * its weakest token's tier (a query is as specific as its vaguest word).
 * Stable: tier, then label (case-insensitive), then id.
 */
export function rankCandidates<C extends Candidate>(q: string, candidates: readonly C[], limit = 50): Ranked<C>[] {
  const toks = tokenise(q);
  if (toks.length === 0) return [];
  const hits: Ranked<C>[] = [];
  for (const c of candidates) {
    let worst: Tier = 0;
    let ok = true;
    for (const tok of toks) {
      const tier = matchTier(tok, c);
      if (tier == null) {
        ok = false;
        break;
      }
      if (tier > worst) worst = tier;
    }
    if (ok) hits.push({ candidate: c, tier: worst });
  }
  hits.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.candidate.label.localeCompare(b.candidate.label, "en", { sensitivity: "base" }) ||
      String(a.candidate.id).localeCompare(String(b.candidate.id)),
  );
  return hits.slice(0, Math.max(0, limit));
}

/** The category chips the UI renders — the registry's keys, in its order. */
export const CATEGORY_CHIPS: readonly SourceKey[] = SOURCE_KEYS;
