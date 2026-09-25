"use client";

/**
 * The Help Desk — every screen described, searchable, deep-linked.
 *
 * v4.6.0 W4 (rulings H1–H4): the client root of /help. It holds the search
 * query and reads the URL fragment ONCE, then derives everything from them —
 * the flat result list or the category grid (components/help/), which topic
 * dialog is open (`#topic-…`), which group that expands, and the Options
 * section below, whose markup, anchors and deep-link scroll are unchanged here
 * (tests/options-help.test.ts, tests/typography-scale.test.ts and the v4.3
 * seams read THIS file for them).
 */

import * as React from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { badgeVariants } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { HELP_TOPICS, searchTopics, type HelpEntry } from "@/lib/domain/help-content";
import { useStoredValue, writeStored } from "@/components/layout/use-stored-value";
import { HelpSearchHero } from "@/components/help/help-search-hero";
import {
  HELP_OPEN_GROUPS_KEY,
  HelpCategoryGrid,
  groupOfTopic,
  parseOpenGroups,
  serializeOpenGroups,
} from "@/components/help/help-category-grid";
import { HelpTopicDialog } from "@/components/help/help-topic-dialog";
import { readHash, subscribeHash, topicIdFromHash, writeHelpHash } from "@/components/help/use-help-hash";
import {
  OPTIONS_BEGINNER_LABEL,
  OPTIONS_HELP_FOOTER,
  OPTIONS_STYLES,
  OPTIONS_STYLE_LABEL,
  optionsAnchorId,
  optionsHashTarget,
  sebiRealityLine,
  visibleOptions,
  type OptionsHelpEntry,
} from "@/lib/domain/options-help";
import { SEBI_FNO_FACTS } from "@/lib/analytics/sebi-reality";
import { ArrowRight } from "lucide-react";

/** The four parts, in the order every entry states them. */
const PARTS: { label: string; read: (e: OptionsHelpEntry) => string }[] = [
  { label: "What it is", read: (e) => e.what },
  { label: "Payoff", read: (e) => e.payoff },
  { label: "Who uses it", read: (e) => e.whoUses },
  { label: "Risk", read: (e) => e.risk },
];

export function HelpDesk({
  entries,
  groups,
  options,
}: {
  entries: HelpEntry[];
  groups: { label: string; hrefs: string[] }[];
  options: OptionsHelpEntry[];
}) {
  const [q, setQ] = React.useState("");
  // One topic per entry the page handed us (the join is HELP_TOPICS; the
  // entries prop still decides which screens this desk describes).
  const topics = React.useMemo(() => {
    const hrefs = new Set(entries.map((e) => e.href));
    return HELP_TOPICS.filter((t) => hrefs.has(t.href));
  }, [entries]);
  const hits = React.useMemo(() => searchTopics(q, topics), [q, topics]);
  const searching = q.trim().length > 0;
  // The fragment the reader was sent to, so its card is rendered even when the
  // search they already had typed would have filtered it out — otherwise the
  // anchor is not in the DOM and the deep link scrolls nowhere. The store lives
  // in components/help/use-help-hash.ts; this is its one reader on the page.
  const hash = React.useSyncExternalStore(subscribeHash, readHash, () => "");
  const optionHits = React.useMemo(() => visibleOptions(options, q, hash), [options, q, hash]);

  // The open topic IS the fragment: `#topic-…` on load or on a palette push
  // opens it, and closing clears it. Nothing is copied into state.
  const openId = topicIdFromHash(hash);
  const openTopic = topics.find((t) => t.id === openId) ?? null;
  const storedGroups = parseOpenGroups(useStoredValue(HELP_OPEN_GROUPS_KEY));
  const hashGroup = groupOfTopic(groups, openTopic);
  const openGroups = hashGroup && !storedGroups.includes(hashGroup) ? [...storedGroups, hashGroup] : storedGroups;

  function closeTopic() {
    // A deep link expanded its group; keep it expanded once the reader is
    // back on the grid, rather than collapsing it under them (an event
    // handler, not an effect).
    if (hashGroup && !storedGroups.includes(hashGroup)) {
      writeStored(HELP_OPEN_GROUPS_KEY, serializeOpenGroups([...storedGroups, hashGroup]));
    }
    writeHelpHash(null);
  }

  // …and then SCROLL to it. Next runs its own hash scroll at navigation commit,
  // when a card the search had filtered out is still absent from the DOM, so the
  // reader saw nothing move even once the anchor was rendered. Keyed on the
  // TARGET ID: once per deep link, not once per keystroke in `q`. The body only
  // calls a DOM method — never a setState in an effect (AGENTS.md) — and
  // `getElementById` returning null is the same "is that card on the page"
  // question `visibleOptions` answers, asked of the document after this render
  // wrote it, so an empty or unknown fragment no-ops. Cards carry `scroll-mt-20`.
  const optionTarget = optionsHashTarget(hash);
  React.useEffect(() => {
    if (!optionTarget) return;
    document.getElementById(optionsAnchorId(optionTarget))?.scrollIntoView({ block: "start" });
  }, [optionTarget]);

  return (
    <div className="space-y-5">
      <HelpSearchHero query={q} onQueryChange={setQ} topicCount={topics.length} />

      {searching ? (
        hits.length > 0 && (
          <section aria-label="Matching topics">
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {hits.length} {hits.length === 1 ? "topic matches" : "topics match"}
            </h3>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {hits.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => writeHelpHash(t.id)}
                    className="flex w-full flex-col items-start gap-0.5 px-4 py-2.5 text-left hover:bg-card-hover"
                  >
                    <span className="text-base font-semibold">{t.title}</span>
                    <span className="text-sm italic text-foreground/80">{t.answers}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      ) : (
        <HelpCategoryGrid
          groups={groups}
          topics={topics}
          openGroups={openGroups}
          onOpenGroupsChange={(next) => writeStored(HELP_OPEN_GROUPS_KEY, serializeOpenGroups(next))}
          onOpenTopic={(id) => writeHelpHash(id)}
        />
      )}

      {searching && hits.length === 0 && optionHits.length === 0 && (
        <p className="text-sm text-foreground/90">Nothing matches “{q}”. Try a broader word — every screen is described here.</p>
      )}

      <HelpTopicDialog topic={openTopic} topics={topics} onClose={closeTopic} onOpenTopic={(id) => writeHelpHash(id)} />

      {/* ───────────────────────────────────────────────────────────────────
          OPTIONS — the highlighted section, free on every tier. Since v4.6.0
          W4 it sits below the topics; the hero's "Options help" jumps here.
          Accent border and a badge rather than another muted group header:
          it is the one part of this page a reader is sent to from elsewhere
          (/strategies cards deep-link to #options-<id>), so it has to be
          findable at a glance. Every anchor carries scroll-mt-20 so the
          sticky page header does not sit over the card it just jumped to.
         ─────────────────────────────────────────────────────────────────── */}
      {optionHits.length > 0 && (
        <section
          aria-labelledby="options-help"
          className="rounded-lg border-2 border-accent/60 border-l-8 bg-accent/[0.04] p-4"
        >
          <div className="flex flex-wrap items-center gap-2">
            {/* The HEADING is an anchor too — `helpHref(null)` sends every
                Custom card here — so it needs the same scroll-margin the cards
                carry, or the sticky PageHeader sits over the word it jumped to
                (R4-U-2). Nothing scrolls it in JS: the browser's own fragment
                navigation reaches a heading that is always in the DOM. */}
            <h2
              id="options-help"
              className="scroll-mt-20 text-base font-semibold tracking-wide text-foreground"
            >
              Options
            </h2>
            <span className={cn(badgeVariants({ variant: "accent" }))}>Free</span>
            <span className={cn(badgeVariants({ variant: "outline" }))}>{options.length} structures</span>
            <Link
              href="/strategies"
              className="ml-auto flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-sm hover:bg-card-hover"
            >
              Open Option Strategies <ArrowRight className="size-3" />
            </Link>
          </div>

          <p className="mt-2 text-sm text-foreground/90">{sebiRealityLine(SEBI_FNO_FACTS)}</p>

          {OPTIONS_STYLES.map((style) => {
            const items = optionHits.filter((e) => e.style === style);
            if (items.length === 0) return null;
            return (
              <div key={style} className="mt-4">
                <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-accent">
                  {OPTIONS_STYLE_LABEL[style]}
                </h3>
                <div className="grid gap-3 lg:grid-cols-2">
                  {items.map((e) => (
                    <Card key={e.id} id={optionsAnchorId(e.id)} className="scroll-mt-20 p-0">
                      <CardHeader className="flex-row items-start justify-between gap-2 pb-2">
                        <div>
                          <CardTitle className="text-base">{e.name}</CardTitle>
                          <p className="mt-0.5 text-sm italic text-muted-foreground">
                            {OPTIONS_STYLE_LABEL[e.style]}
                          </p>
                        </div>
                        {e.beginner && (
                          <span className={cn(badgeVariants({ variant: "accent" }), "shrink-0")}>{OPTIONS_BEGINNER_LABEL}</span>
                        )}
                      </CardHeader>
                      <CardContent className="space-y-2 pt-0 text-sm text-foreground/90">
                        {PARTS.map((p) => (
                          // Chip is a <span>, not <Badge> (a <div>), for the same
                          // reason the refusal chip below is — React #418.
                          <p key={p.label}>
                            <span className={cn(badgeVariants({ variant: "outline" }), "mr-1")}>{p.label}</span>
                            {p.read(e)}
                          </p>
                        ))}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            );
          })}

          <p className="mt-4 text-sm text-foreground/90">{OPTIONS_HELP_FOOTER}</p>
        </section>
      )}
    </div>
  );
}
