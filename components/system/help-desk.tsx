"use client";

/** The Help Desk — every screen described, searchable, deep-linked. */

import * as React from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { searchHelp, type HelpEntry } from "@/lib/domain/help-content";
import { ArrowRight, Search, ShieldOff } from "lucide-react";

export function HelpDesk({ entries, groups }: { entries: HelpEntry[]; groups: { label: string; hrefs: string[] }[] }) {
  const [q, setQ] = React.useState("");
  const hits = React.useMemo(() => searchHelp(entries, q), [entries, q]);
  const hitSet = React.useMemo(() => new Set(hits.map((h) => h.href)), [hits]);

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

      {hits.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing matches “{q}”. Try a broader word — every screen is described here.</p>
      ) : (
        groups.map((g) => {
          const items = entries.filter((e) => g.hrefs.includes(e.href) && hitSet.has(e.href));
          if (items.length === 0) return null;
          return (
            <section key={g.label}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.label}</h3>
              <div className="grid gap-3 lg:grid-cols-2">
                {items.map((e) => (
                  <Card key={e.href} className="p-0">
                    <CardHeader className="flex-row items-start justify-between gap-2 pb-2">
                      <div>
                        <CardTitle className="text-sm">{e.title}</CardTitle>
                        <p className="mt-0.5 text-xs italic text-muted-foreground">{e.answers}</p>
                      </div>
                      <Link
                        href={e.href}
                        className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-card-hover"
                      >
                        Open <ArrowRight className="size-3" />
                      </Link>
                    </CardHeader>
                    <CardContent className="space-y-1.5 pt-0 text-xs text-muted-foreground">
                      {e.body.map((b, i) => (
                        <p key={i}>{b}</p>
                      ))}
                      {e.refusals?.map((r, i) => (
                        <p key={`r${i}`} className="flex items-start gap-1.5">
                          <ShieldOff className="mt-0.5 size-3 shrink-0" />
                          <span><Badge variant="outline" className="mr-1">won&apos;t do</Badge>{r}</span>
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
