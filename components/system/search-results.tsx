"use client";

import { CornerDownLeft, Lock } from "lucide-react";
import { CATEGORY_CHIPS } from "@/lib/domain/search-rank";
import { SOURCES, type SearchResult, type SourceKey } from "@/lib/domain/search-scope";
import { groupBySource, unlockLine } from "./use-search-session";

/**
 * The palette's search results (v3.8 Wave 3) — LAZY. command-palette.tsx
 * reaches this file only through `next/dynamic`, so a page that mounts the
 * palette (every page) pays for none of this until the user types.
 *
 * Grouped by source in chip order; the chips toggle `cat` on the fetch. A
 * gated result is SHOWN with a lock and one line on what unlocks it (owner
 * ruling 2026-09-04), and stays navigable — the screen it opens carries its
 * own gate. The user's own rows never arrive locked (invariant 7).
 *
 * Keyboard: the palette owns the cursor. `activeIndex` counts from 0 across
 * the grouped, flattened results, in the SAME order `groupBySource` yields —
 * so the highlighted row is the one Enter opens.
 */
export interface SearchResultsProps {
  q: string;
  results: readonly SearchResult[];
  loading: boolean;
  error: boolean;
  cats: readonly SourceKey[];
  onToggleCat: (key: SourceKey) => void;
  /** Index into the flattened grouped results; -1 when the cursor is on a command. */
  activeIndex: number;
  onHover: (index: number) => void;
  onOpen: (result: SearchResult) => void;
}

export default function SearchResults({ q, results, loading, error, cats, onToggleCat, activeIndex, onHover, onOpen }: SearchResultsProps) {
  const groups = groupBySource(results);
  let cursor = 0;

  return (
    <div className="border-t border-border" data-search-results aria-busy={loading || undefined}>
      <div className="flex flex-wrap items-center gap-1 px-3 py-1.5" role="group" aria-label="Search categories">
        {CATEGORY_CHIPS.map((key) => {
          const on = cats.includes(key);
          return (
            <button
              key={key}
              type="button"
              aria-pressed={on}
              onClick={() => onToggleCat(key)}
              className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide transition-colors ${
                on ? "border-primary/60 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {SOURCES[key].label}
            </button>
          );
        })}
        {loading && <span className="ml-auto text-[10px] text-muted-foreground">Searching…</span>}
      </div>

      {error ? (
        <p className="px-3 pb-3 text-sm text-muted-foreground">Search failed — try again.</p>
      ) : groups.length === 0 && !loading ? (
        <p className="px-3 pb-3 text-sm text-muted-foreground">No results for &ldquo;{q}&rdquo;</p>
      ) : (
        <div className="p-1.5 pt-0">
          {groups.map((g) => (
            <section key={g.key} data-search-group={g.key} aria-label={g.label}>
              <h3 className="px-3 pb-0.5 pt-2 text-[10px] uppercase tracking-wide text-muted-foreground">{g.label}</h3>
              {g.results.map((r) => {
                const i = cursor++;
                const active = i === activeIndex;
                const lock = unlockLine(r);
                return (
                  <button
                    key={`${r.source}:${r.id}`}
                    type="button"
                    data-search-result={r.source}
                    onClick={() => onOpen(r)}
                    onMouseEnter={() => onHover(i)}
                    className={`flex w-full items-start justify-between gap-3 rounded-md px-3 py-1.5 text-left text-sm transition-colors duration-100 motion-reduce:transition-none ${
                      active ? "bg-card-hover text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        {lock && <Lock className="size-3 shrink-0 text-accent" aria-label="Pro" />}
                        <span className="truncate">{r.title}</span>
                      </span>
                      {r.subtitle && <span className="block truncate text-xs opacity-80">{r.subtitle}</span>}
                      {lock && <span className="block text-[11px] text-accent">{lock}</span>}
                    </span>
                    {active && <CornerDownLeft className="mt-1 size-3 shrink-0" />}
                  </button>
                );
              })}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
