"use client";

import type { ReactNode } from "react";
import { useStoredValue, writeStored } from "@/components/layout/use-stored-value";

/**
 * The Trade Craft tab strip. RSC-friendly by construction: the server page
 * renders EVERY tab's content and passes it in as ReactNodes; this shell only
 * decides which one is on screen, so no tab needs a client fetch or a loading
 * state of its own.
 *
 * The active tab is DERIVED from storage on every render (no setState, no
 * effect — the repo's set-state-in-effect rule): `useStoredValue` renders the
 * default server-side and re-reads after hydration, and `writeStored`
 * re-renders every reader. A stored key that no longer names a tab falls back
 * to the first tab instead of a blank page.
 */

const STORAGE_KEY = "vyuha-arjun-tab";

export interface TradeCraftTab {
  key: string;
  label: string;
  content: ReactNode;
}

export function TabShell({ tabs }: { tabs: TradeCraftTab[] }) {
  const stored = useStoredValue(STORAGE_KEY);
  const active = tabs.some((t) => t.key === stored) ? (stored as string) : tabs[0]?.key;

  return (
    <div>
      <div role="tablist" aria-label="Trade Craft" className="flex flex-wrap gap-1 border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === active}
            onClick={() => writeStored(STORAGE_KEY, t.key)}
            className={`-mb-px rounded-t-md border-b-2 px-3 py-1.5 text-sm transition-colors ${
              t.key === active
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {/* Only the active panel MOUNTS — charts measure a real width instead of
          a hidden container — but every panel's content already crossed the RSC
          boundary, so switching is instant and needs no fetch. */}
      <div role="tabpanel" className="pt-5">
        {tabs.find((t) => t.key === active)?.content}
      </div>
    </div>
  );
}
