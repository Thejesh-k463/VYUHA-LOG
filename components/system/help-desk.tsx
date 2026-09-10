"use client";

/** The Help Desk — every screen described, searchable, deep-linked. */

import * as React from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { badgeVariants } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { searchHelp, type HelpEntry } from "@/lib/domain/help-content";
import {
  OPTIONS_HELP_FOOTER,
  OPTIONS_STYLES,
  OPTIONS_STYLE_LABEL,
  optionsAnchorId,
  searchOptionsHelp,
  sebiRealityLine,
  type OptionsHelpEntry,
} from "@/lib/domain/options-help";
import { SEBI_FNO_FACTS } from "@/lib/analytics/sebi-reality";
import { ArrowRight, Search, ShieldOff } from "lucide-react";

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
  const hits = React.useMemo(() => searchHelp(entries, q), [entries, q]);
  const hitSet = React.useMemo(() => new Set(hits.map((h) => h.href)), [hits]);
  const optionHits = React.useMemo(() => searchOptionsHelp(options, q), [options, q]);

  return (
    <div className="space-y-5">
      <div className="relative max-w-xl">
        <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
        <Input
          className="pl-8"
          placeholder="Search by what you want to do — 'delete', 'stop loss', 'tax', 'backup'…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search help"
        />
      </div>

      {/* ───────────────────────────────────────────────────────────────────
          OPTIONS — the highlighted section, at the top, free on every tier.
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
            <h2 id="options-help" className="text-base font-semibold tracking-wide text-foreground">
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
                          <span className={cn(badgeVariants({ variant: "accent" }), "shrink-0")}>Beginner</span>
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

      {hits.length === 0 && optionHits.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing matches “{q}”. Try a broader word — every screen is described here.</p>
      ) : (
        groups.map((g) => {
          const items = entries.filter((e) => g.hrefs.includes(e.href) && hitSet.has(e.href));
          if (items.length === 0) return null;
          return (
            <section key={g.label}>
              <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{g.label}</h3>
              <div className="grid gap-3 lg:grid-cols-2">
                {items.map((e) => (
                  <Card key={e.href} className="p-0">
                    <CardHeader className="flex-row items-start justify-between gap-2 pb-2">
                      <div>
                        <CardTitle className="text-base">{e.title}</CardTitle>
                        <p className="mt-0.5 text-sm italic text-muted-foreground">{e.answers}</p>
                      </div>
                      <Link
                        href={e.href}
                        className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-sm hover:bg-card-hover"
                      >
                        Open <ArrowRight className="size-3" />
                      </Link>
                    </CardHeader>
                    <CardContent className="space-y-1.5 pt-0 text-sm text-foreground/90">
                      {e.body.map((b, i) => (
                        <p key={i}>{b}</p>
                      ))}
                      {e.refusals?.map((r, i) => (
                        <p key={`r${i}`} className="flex items-start gap-1.5">
                          <ShieldOff className="mt-0.5 size-3 shrink-0" />
                          {/* Chip is a <span>, not <Badge> (a <div>): a div inside <p> makes the
                              browser's parser close the <p> early, so the hydrated DOM never
                              matches the server tree — React #418, three per visit on this page. */}
                          <span><span className={cn(badgeVariants({ variant: "outline" }), "mr-1")}>won&apos;t do</span>{r}</span>
                        </p>
                      ))}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
