"use client";

/** Import Help — one expandable card per import path, chips for what each offers. */

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { ImportChannel, ImportHelpCard } from "@/lib/domain/import-help-content";
import { ChevronDown, Info } from "lucide-react";

const CHANNEL_LABELS: Record<ImportChannel, string> = {
  files: "Files",
  api: "API",
  openalgo: "OpenAlgo",
};

export function ImportHelp({ cards }: { cards: ImportHelpCard[] }) {
  const [expanded, setExpanded] = React.useState<string | null>(null);

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {cards.map((c) => {
        const open = expanded === c.id;
        return (
          <Card key={c.id} className="h-fit p-0">
            <button
              type="button"
              className="w-full text-left"
              aria-expanded={open}
              onClick={() => setExpanded(open ? null : c.id)}
            >
              <CardHeader className="flex-row items-start justify-between gap-2 pb-2">
                <div>
                  <CardTitle className="text-sm">{c.title}</CardTitle>
                  <p className="mt-0.5 text-xs text-muted-foreground">{c.summary}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {c.channels.map((ch) => (
                    <Badge key={ch} variant="outline">
                      {CHANNEL_LABELS[ch]}
                    </Badge>
                  ))}
                  <ChevronDown
                    className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
                  />
                </div>
              </CardHeader>
            </button>
            {open && (
              <CardContent className="space-y-3 pt-0 text-xs text-muted-foreground">
                {c.formats.length > 0 && (
                  <div>
                    <p className="mb-1 font-medium text-foreground">Files Vyuha reads</p>
                    <ul className="list-disc space-y-0.5 pl-4">
                      {c.formats.map((f) => (
                        <li key={f.sourceId}>{f.label}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="space-y-1.5">
                  {c.steps.map((s, i) => (
                    <p key={i}>{s}</p>
                  ))}
                </div>
                {c.api && (
                  <div>
                    <p className="mb-1 font-medium text-foreground">API connection</p>
                    <div className="space-y-1.5">
                      {c.api.map((s, i) => (
                        <p key={i}>{s}</p>
                      ))}
                    </div>
                  </div>
                )}
                {c.notes?.map((n, i) => (
                  <p key={`n${i}`} className="flex items-start gap-1.5">
                    <Info className="mt-0.5 size-3 shrink-0" />
                    <span>{n}</span>
                  </p>
                ))}
              </CardContent>
            )}
          </Card>
        );
      })}
    </div>
  );
}
