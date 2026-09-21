import { createHash } from "node:crypto";
import { dedupHash, dedupSymbolKey, type DedupInput } from "./dedup";

/**
 * ONE trade identity, in ONE function (v4.5.0 W1, design D1).
 *
 * Until now "is this the same execution?" was answered in four places with
 * three different rules. This module is the single door: `executionIdentity()`
 * is PURE (no DB, no React — invariant 2, the same rule `dedup.ts` already
 * follows) and every import path goes through it — `buildRow` in
 * `lib/import/commit.ts` (preview AND commit, so the two can never drift), the
 * manual-trade writer beside it, and the cross-source scan's own key.
 *
 * ── What identity is made of ───────────────────────────────────────────────
 *
 *   hash      `dedupHash()` UNCHANGED (`lib/import/dedup.ts`) — broker, symbol
 *             key, quantities, prices, values and dates. This is what the
 *             `trades.dedup_hash` column stores and what
 *             `trades_account_broker_dedup_uq` (account_id, broker,
 *             dedup_hash) is built on. Neither is touched by W1: re-keying
 *             stored rows is exactly what `isLotIdentityFrozen`
 *             (`close-open-lots.ts`) exists to forbid.
 *   scope     `segment|exchange` — the NEW disambiguator, deliberately NOT in
 *             the hash (see below).
 *   symbolKey `dedupSymbolKey()` — the symbol segment the hash is built from.
 *   label     the raw text that symbol key came from. It is the `tradingsymbol`
 *             for every broker except where a parser states a `dedupLabel`:
 *             a Dhan GTR row is keyed on the SCRIP NAME the settlement bill
 *             states, even after the parser has resolved that name to a ticker
 *             (W1 revision 8 — so the resolution can never move a stored row's
 *             identity, and no alias is needed).
 *
 * ── F-L1-7: one hash, k scopes (revision 7) ────────────────────────────────
 *
 * `dedupHash` carries no exchange and no segment, so an NSE sale and a BSE sale
 * of the same symbol, same quantity, same price, on the same day collide — and
 * `commit.ts` dropped the second as a duplicate of the first. Both are real
 * money. Since v1.10.0.
 *
 * The fix is per FILE and only where the collision actually exists
 * (`scopedHashes`): rows of ONE file that share a hash across k > 1 distinct
 * scopes are sorted by scope string; the FIRST keeps the legacy hash, the
 * others store `sha1(hash|scope)`. So
 *
 *   • a file with no collision hashes byte-for-byte as it did in v4.4.0 — an
 *     unchanged re-import of any pre-4.5.0 file still de-duplicates and still
 *     drops nothing;
 *   • the same file re-imported produces the same derived hashes (the rule is a
 *     pure function of the file), so the second import is still a duplicate;
 *   • the stored `dedup_hash` column, the unique index and every alias row are
 *     untouched.
 *
 * THE BOOK COMPARISON STAYS HASH-ONLY. Nothing compares an incoming scope
 * against a stored row's segment/exchange columns: a user who re-tags a row's
 * exchange would then look like a different execution and the next import would
 * add the position a second time. Scope disambiguates rows of one file against
 * EACH OTHER, and nothing else.
 *
 * STATED LIMITATION — the CROSS-FILE NSE/BSE collision is not solved. Two such
 * sales imported from two different files still collide on the legacy hash (the
 * second file has one scope and therefore re-keys nothing), and the second is
 * still skipped as a duplicate. Solving it needs the exchange inside the stored
 * key, i.e. a re-key of every stored row — which is the frozen-identity rule's
 * flat no. The in-file case is the one the brokers' own exports produce.
 *
 * ── Scope is the RAW classification, never the overridden one ──────────────
 * `buildRow` computes identity from `classify()`'s own answer, BEFORE any
 * `classification_overrides` row is applied. A manual re-tag is a fact about
 * the row, not about the execution the file states; deriving scope after the
 * override would also make the hash depend on a lookup keyed by that hash.
 */

/** A dedup hash is a sha1 hex digest. Shared with `close-open-lots.ts`. */
const HASH_RE = /^[0-9a-f]{40}$/;

/**
 * Marks the RAW label an execution is keyed on inside `import_notes`, when the
 * parser resolved the row's `tradingsymbol` to something else. Segments are
 * joined by " | ", exactly like `dedup-alias:` (`close-open-lots.ts`).
 *
 * Dhan's Global Transaction Report is the one writer today (W1 revision 8):
 * the bill states "Aarti Industries" where the API states AARTIIND, so the row
 * is SHOWN and grouped as AARTIIND while its identity stays the name the file
 * carried. Without this segment the resolution would move the hash, and a
 * snapshot refresh that later stopped resolving the name would re-import the
 * whole report.
 */
export const DEDUP_LABEL_PREFIX = "gtr-name:";

export interface ExecutionIdentityInput extends DedupInput {
  /** The row's classified segment — `scope`, never the hash. */
  segment?: string | null;
  /** The row's classified exchange — `scope`, never the hash. */
  exchange?: string | null;
}

export interface ExecutionIdentity {
  /** `dedupHash()`, unchanged — what `trades.dedup_hash` stores. */
  hash: string;
  /** `segment|exchange`. Compared only between rows of ONE file. */
  scope: string;
  /** The symbol segment of the hash (`dedupSymbolKey`). */
  symbolKey: string;
  /** The raw label that symbol key came from — the `dedupLabel` when stated. */
  label: string;
}

/** `segment|exchange`, with a missing half stated as the empty string. */
export function identityScope(segment: string | null | undefined, exchange: string | null | undefined): string {
  return `${(segment ?? "").trim()}|${(exchange ?? "").trim()}`;
}

/** The ONE identity of one execution. Pure; no DB, no React. */
export function executionIdentity(row: ExecutionIdentityInput): ExecutionIdentity {
  return {
    hash: dedupHash(row),
    scope: identityScope(row.segment, row.exchange),
    symbolKey: dedupSymbolKey(row.broker, row.tradingsymbol, row.isin, row.dedupLabel),
    label: (row.dedupLabel ?? row.tradingsymbol ?? "").trim(),
  };
}

/** The derived hash a row takes when it is NOT the first scope on its hash. */
export function scopedHash(hash: string, scope: string): string {
  return createHash("sha1").update(`${hash}|${scope}`).digest("hex");
}

/**
 * The hash each row of ONE parsed file must be stored and de-duplicated under.
 *
 * Returns one hash per input row, in input order. A hash held by rows of a
 * single scope is returned unchanged — which is every row of almost every file.
 * Where k > 1 scopes share one hash, the scopes are sorted as strings and only
 * the first keeps it; the rest take `sha1(hash|scope)`. Rows sharing BOTH a
 * hash and a scope are genuine in-file duplicates and still collapse, exactly
 * as they did before.
 */
export function scopedHashes(rows: readonly { hash: string; scope: string }[]): string[] {
  const scopesByHash = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = scopesByHash.get(r.hash);
    if (set) set.add(r.scope);
    else scopesByHash.set(r.hash, new Set([r.scope]));
  }
  return rows.map((r) => {
    const scopes = scopesByHash.get(r.hash)!;
    if (scopes.size < 2) return r.hash;
    const first = [...scopes].sort()[0]!;
    return r.scope === first ? r.hash : scopedHash(r.hash, r.scope);
  });
}

/** Append `gtr-name:<label>` once. Order is preserved; " | " is the separator. */
export function withDedupLabelNote(importNotes: string | null, label: string): string {
  const parts = (importNotes ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
  const seg = `${DEDUP_LABEL_PREFIX}${label.trim()}`;
  if (!parts.some((p) => p.startsWith(DEDUP_LABEL_PREFIX))) parts.push(seg);
  return parts.join(" | ");
}

/**
 * The raw label a STORED row is keyed on, read back out of its `import_notes` —
 * null when the row carries none, which means its `tradingsymbol` is the label.
 */
export function dedupLabelFromNotes(importNotes: string | null): string | null {
  for (const seg of (importNotes ?? "").split("|")) {
    const s = seg.trim();
    if (!s.startsWith(DEDUP_LABEL_PREFIX)) continue;
    const label = s.slice(DEDUP_LABEL_PREFIX.length).trim();
    if (label) return label;
  }
  return null;
}

/** True when `h` reads as a dedup hash at all (a sha1 hex digest). */
export function isDedupHash(h: string): boolean {
  return HASH_RE.test(h);
}
