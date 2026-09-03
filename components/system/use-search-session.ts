"use client";

import * as React from "react";
import { CATEGORY_CHIPS } from "@/lib/domain/search-rank";
import { SOURCES, type SearchResult, type SourceKey } from "@/lib/domain/search-scope";

/**
 * SEARCH SESSION — the palette's own back stack, plus the pure helpers the
 * palette and its results list share (v3.8 Wave 3).
 *
 * ── Why a stack of its own ──────────────────────────────────────────────────
 *
 * Opening a result navigates the app; the user then wants "the search I just
 * had" back, results and all, without retyping and without a refetch. That is
 * a property of the SEARCH, not of the route, so it lives here rather than in
 * nav-history — and it never calls the router's history back: the browser's history is
 * bound to Alt+← / mouse button 3 elsewhere, and a palette control that also
 * drove it would make two different "backs" fight over one stack.
 *
 * The stack is component state on the palette, which the root layout mounts
 * ONCE — so it survives every in-app navigation and every close/reopen, and is
 * gone on a full reload (a reload is a new session; nothing to restore).
 *
 * Everything below `useSearchSession` is PURE and unit-tested in
 * tests/search-palette.test.ts; the hook only wraps `pushFrame`/`popFrame`.
 */

/** Below this many trimmed characters the palette does not search at all. */
export const MIN_QUERY = 2;
/** Keystroke → fetch delay; a new keystroke inside it aborts the pending one. */
export const SEARCH_DEBOUNCE_MS = 150;
/** Enough to walk back through a research session; not a log. */
export const MAX_FRAMES = 20;

export interface SearchFrame {
  q: string;
  /** Selected chips, in chip order; empty = every source. */
  cats: SourceKey[];
  results: SearchResult[];
}

/** Chips normalised to registry order, so `["help","trades"]` and `["trades","help"]` are one key. */
export function catsKey(cats: readonly SourceKey[]): string {
  return CATEGORY_CHIPS.filter((k) => cats.includes(k)).join(",");
}

/** `/api/search?q=…&cat=…` — `cat` omitted when every source is wanted. */
export function searchUrl(q: string, cats: readonly SourceKey[]): string {
  const key = catsKey(cats);
  return `/api/search?q=${encodeURIComponent(q)}${key ? `&cat=${key}` : ""}`;
}

/** Toggle one chip; the result stays in registry order. */
export function toggleCat(cats: readonly SourceKey[], key: SourceKey): SourceKey[] {
  const next = cats.includes(key) ? cats.filter((k) => k !== key) : [...cats, key];
  return CATEGORY_CHIPS.filter((k) => next.includes(k));
}

/**
 * Push a frame. The same search opened twice in a row is one frame — a user
 * who opens three results of one search and walks back expects ONE step back
 * to that search, not three copies of it.
 */
export function pushFrame(stack: readonly SearchFrame[], frame: SearchFrame): SearchFrame[] {
  const top = stack[stack.length - 1];
  if (top && top.q === frame.q && catsKey(top.cats) === catsKey(frame.cats)) {
    return [...stack.slice(0, -1), frame];
  }
  const next = [...stack, frame];
  return next.length > MAX_FRAMES ? next.slice(next.length - MAX_FRAMES) : next;
}

export function popFrame(stack: readonly SearchFrame[]): { stack: SearchFrame[]; frame: SearchFrame | null } {
  if (stack.length === 0) return { stack: [], frame: null };
  return { stack: stack.slice(0, -1), frame: stack[stack.length - 1] };
}

export interface SearchGroup {
  key: SourceKey;
  label: string;
  results: SearchResult[];
}

/**
 * Results grouped by source IN CHIP ORDER, empty sources omitted. Both the
 * results list and the palette's keyboard cursor derive their order from this
 * one function, so Enter always opens the row that is highlighted.
 */
export function groupBySource(results: readonly SearchResult[]): SearchGroup[] {
  const out: SearchGroup[] = [];
  for (const key of CATEGORY_CHIPS) {
    const rows = results.filter((r) => r.source === key);
    if (rows.length) out.push({ key, label: SOURCES[key].label, results: rows });
  }
  return out;
}

/** The lock line under a gated result — one sentence on what buying Pro unlocks. */
export function unlockLine(r: Pick<SearchResult, "locked" | "unlocks">): string | null {
  if (!r.locked) return null;
  return `Unlocks with Pro — ${r.unlocks ?? "this screen"}`;
}

/**
 * The palette's search keywords for a screen, DERIVED from the help desk's
 * registry by href — one list, maintained once. A screen the help desk has no
 * keywords for falls back to its own label, so it still matches on what it is
 * called; tests/help-content.test.ts fails on that case anyway.
 */
export function deriveKeywords(entries: readonly { href: string; keywords: readonly string[] }[], href: string, label: string): string {
  const entry = entries.find((e) => e.href === href);
  const words = entry?.keywords.length ? entry.keywords : [label];
  return words.join(" ").toLowerCase();
}

export function useSearchSession() {
  const [stack, setStack] = React.useState<SearchFrame[]>([]);

  const push = React.useCallback((frame: SearchFrame) => {
    setStack((s) => pushFrame(s, frame));
  }, []);

  // Returns the popped frame so the caller can restore it in the same tick.
  const pop = React.useCallback((): SearchFrame | null => {
    const { stack: next, frame } = popFrame(stack);
    if (frame) setStack(next);
    return frame;
  }, [stack]);

  return { depth: stack.length, previous: stack[stack.length - 1] ?? null, push, pop };
}
