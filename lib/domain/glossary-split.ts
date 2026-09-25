// GLOSSARY LINKING (PURE — no React, no DB; invariant 2). v4.6.0 W4.
//
// `splitGlossary(text, terms)` cuts one paragraph into plain runs and glossary
// hits, so the help dialog can underline the FIRST whole-word occurrence of
// each term and leave every other character exactly where it was. The rules,
// each pinned in tests/glossary.test.ts:
//
//   - whole words only, case-insensitive: "R" never matches inside "ROM", and
//     "Pro" never matches inside "profit" or "pro-rata";
//   - the LONGEST phrase wins at a position: "R-multiple" before "R";
//   - one link per term per call (a call is one paragraph), aliases included:
//     once "MTM" has linked the mark term, a later "mark" stays plain text;
//   - the pieces concatenate back to the input, byte for byte.

/**
 * The shape of one glossary entry. `lib/domain/glossary.ts` exports the same
 * interface with the list; it is restated here so this module needs no import
 * from the content file and can be tested against hand-built terms.
 */
export interface GlossaryTerm {
  term: string;
  aliases?: string[];
  /** ≤ 40 words — what the term is in THIS app. */
  meaning: string;
  /** A METRIC_HELP key, when the term is a metric. */
  metricId?: string;
}

export type GlossaryPiece = string | { text: string; term: GlossaryTerm };

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Letters, digits and the hyphen count as "inside a word": a hyphenated
 * compound ("pro-rata", "stop-loss") is one word, so a term never links half of it.
 */
const WORD_BEFORE = "(?<![\\p{L}\\p{N}-])";
const WORD_AFTER = "(?![\\p{L}\\p{N}-])";

export function splitGlossary(text: string, terms: readonly GlossaryTerm[]): GlossaryPiece[] {
  if (!text) return [];
  const owner = new Map<string, GlossaryTerm>();
  for (const t of terms) {
    for (const phrase of [t.term, ...(t.aliases ?? [])]) {
      const key = phrase.trim().toLowerCase();
      if (key && !owner.has(key)) owner.set(key, t);
    }
  }
  if (owner.size === 0) return [text];

  // Longest first, so the alternation prefers "R-multiple" over "R" at one position.
  const phrases = [...owner.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const re = new RegExp(`${WORD_BEFORE}(?:${phrases.map(escapeRe).join("|")})${WORD_AFTER}`, "giu");

  const pieces: GlossaryPiece[] = [];
  const linked = new Set<GlossaryTerm>();
  let cursor = 0;
  for (const m of text.matchAll(re)) {
    const term = owner.get(m[0].toLowerCase());
    if (!term || linked.has(term)) continue;
    linked.add(term);
    const at = m.index ?? 0;
    if (at > cursor) pieces.push(text.slice(cursor, at));
    pieces.push({ text: m[0], term });
    cursor = at + m[0].length;
  }
  if (cursor < text.length) pieces.push(text.slice(cursor));
  return pieces;
}
