"use client";

import * as React from "react";
import * as Accordion from "@radix-ui/react-accordion";
import { ChevronDown } from "lucide-react";
import type { HelpTopic } from "@/lib/domain/help-content";

/**
 * The help desk's map of the app (v4.6.0 W4): one accordion item per sidebar
 * group — the SAME grouping the sidebar uses, passed in from app/help/page.tsx
 * (`navGroupHrefs`) — each a grid of topic cards. A card is the title and the
 * question the screen answers; a click opens the topic dialog.
 *
 * Every group starts collapsed. Which groups are open is remembered per device
 * in `vyuha-help-open-groups` `{v:1, groups}` (AGENTS: localStorage through
 * useStoredValue/writeStored, versioned envelope). A `#topic-…` link expands
 * the group that owns it — DERIVED at render (`openGroups` below), never a
 * setState in an effect.
 */

export const HELP_OPEN_GROUPS_KEY = "vyuha-help-open-groups";

/** Read the stored envelope; any other shape is no stored state (every group collapsed). */
export function parseOpenGroups(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const o = JSON.parse(raw) as { v?: unknown; groups?: unknown };
    if (o?.v !== 1 || !Array.isArray(o.groups)) return [];
    return o.groups.filter((g): g is string => typeof g === "string");
  } catch {
    return [];
  }
}

export function serializeOpenGroups(groups: readonly string[]): string {
  return JSON.stringify({ v: 1, groups: [...new Set(groups)] });
}

/** The group label whose hrefs include this topic's href, if any. */
export function groupOfTopic(groups: readonly { label: string; hrefs: string[] }[], topic: HelpTopic | null): string | null {
  if (!topic) return null;
  return groups.find((g) => g.hrefs.includes(topic.href))?.label ?? null;
}

export function HelpCategoryGrid({
  groups,
  topics,
  openGroups,
  onOpenGroupsChange,
  onOpenTopic,
}: {
  groups: readonly { label: string; hrefs: string[] }[];
  topics: readonly HelpTopic[];
  /** Stored groups plus the group of the topic the URL names. */
  openGroups: string[];
  onOpenGroupsChange: (groups: string[]) => void;
  onOpenTopic: (id: string) => void;
}) {
  const byHref = React.useMemo(() => new Map(topics.map((t) => [t.href, t])), [topics]);
  return (
    <Accordion.Root type="multiple" value={openGroups} onValueChange={onOpenGroupsChange} className="space-y-2">
      {groups.map((g) => {
        const items = g.hrefs.map((h) => byHref.get(h)).filter((t): t is HelpTopic => !!t);
        if (items.length === 0) return null;
        return (
          <Accordion.Item key={g.label} value={g.label} className="rounded-lg border border-border bg-card/40">
            <Accordion.Header className="m-0">
              <Accordion.Trigger className="group flex w-full items-center justify-between gap-3 rounded-lg px-4 py-3 text-left hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="text-base font-semibold tracking-wide">{g.label}</span>
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  {items.length} {items.length === 1 ? "topic" : "topics"}
                  <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none" aria-hidden />
                </span>
              </Accordion.Trigger>
            </Accordion.Header>
            <Accordion.Content className="px-4 pb-4">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {items.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    id={t.id}
                    onClick={() => onOpenTopic(t.id)}
                    className="scroll-mt-20 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                  >
                    <span className="block text-base font-semibold">{t.title}</span>
                    <span className="mt-0.5 block text-sm italic text-foreground/80">{t.answers}</span>
                  </button>
                ))}
              </div>
            </Accordion.Content>
          </Accordion.Item>
        );
      })}
    </Accordion.Root>
  );
}
