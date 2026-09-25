"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { CircleHelp } from "lucide-react";
import { HUB_TAB_PARAM } from "@/lib/domain/hubs";

/** The two fields of a help topic a "?" link needs (`HELP_TOPIC_LINKS`). */
export interface TopicLink {
  href: string;
  id: string;
}

/**
 * The topic for the screen at `pathname` (PURE). A hub tab is matched by its
 * exact tab URL first (`/reports/capital?tab=expiry` → the Expiry topic), then
 * the bare path (`/reports/capital` → the hub's topic). Anything else on the
 * query string (`/trades?add=manual`) is not part of a topic's identity.
 */
export function topicForPath(pathname: string, tab: string | null, topics: readonly TopicLink[]): TopicLink | null {
  if (tab) {
    const exact = `${pathname}?${HUB_TAB_PARAM}=${encodeURIComponent(tab)}`;
    const hit = topics.find((t) => t.href === exact);
    if (hit) return hit;
  }
  return topics.find((t) => t.href === pathname) ?? null;
}

function HelpLinkInner({ topics }: { topics: readonly TopicLink[] }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const topic = topicForPath(pathname ?? "", params?.get(HUB_TAB_PARAM) ?? null, topics);
  if (!topic) return null;
  return (
    <Link
      href={`/help#${topic.id}`}
      aria-label="Help for this screen"
      className="inline-flex size-8 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground print:hidden"
    >
      <CircleHelp className="size-4" aria-hidden />
    </Link>
  );
}

/**
 * The "?" in every page header (v4.6.0 W4): a link to this screen's help
 * topic, or nothing when the screen has none. A client island inside the
 * server PageHeader; `useSearchParams` needs a Suspense boundary so a
 * statically rendered page does not bail out of rendering entirely.
 */
export function HelpLink({ topics }: { topics: readonly TopicLink[] }) {
  return (
    <React.Suspense fallback={null}>
      <HelpLinkInner topics={topics} />
    </React.Suspense>
  );
}
