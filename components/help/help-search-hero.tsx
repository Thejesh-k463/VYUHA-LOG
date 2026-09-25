"use client";

import * as React from "react";
import { Keyboard, Search, Sigma } from "lucide-react";
import { Input } from "@/components/ui/input";
import { SHORTCUTS_EVENT } from "@/lib/domain/shortcuts";

/**
 * The top of the help desk (v4.6.0 W4): one search box — focused on arrival,
 * held in local state (no `?q=`), so typing never navigates — the topic count,
 * and two ways out: the keyboard-shortcuts sheet and the Options section.
 * While the box holds a query the caller swaps the category grid for a flat
 * result list.
 */
export function HelpSearchHero({
  query,
  onQueryChange,
  topicCount,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  topicCount: number;
}) {
  return (
    <div className="space-y-3">
      <div className="relative max-w-2xl">
        <Search className="absolute left-3 top-3 size-5 text-muted-foreground" aria-hidden />
        <Input
          autoFocus
          className="h-11 pl-10 text-base"
          placeholder="Search by what you want to do — 'delete', 'stop loss', 'tax', 'backup'…"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          aria-label="Search help"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">{topicCount} topics, one per screen and tab</span>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event(SHORTCUTS_EVENT))}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 hover:bg-card-hover"
        >
          <Keyboard className="size-4" aria-hidden /> Keyboard shortcuts
        </button>
        <a
          href="#options-help"
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 hover:bg-card-hover"
        >
          <Sigma className="size-4" aria-hidden /> Options help
        </a>
      </div>
    </div>
  );
}
