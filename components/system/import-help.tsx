"use client";

/**
 * Import Help — one card per import path; clicking a card opens the full
 * story in a dialog.
 *
 * The card grid stays scannable (title + summary + channel chips) and the
 * dialog carries the depth, modeled on `components/system/openalgo-dialog.tsx`:
 * the house <Dialog> (sticky header/footer, max-w-2xl, scrollable body),
 * uppercase Section sub-headings, a warning-tinted block for the notes, and
 * the AddressBlock pattern for the client-package guide files — selectable
 * font-mono text first, because in the Tauri desktop webview an external
 * anchor does nothing at all, and these point at files in the buyer's own
 * download rather than at a URL anyway.
 *
 * Every sentence comes from `lib/domain/import-help-content.ts` — this file
 * contributes section headings and layout and nothing else, so the copy stays
 * under `tests/import-help-content.test.ts`'s banned-claims scan.
 */

import * as React from "react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ImportChannel, ImportHelpCard } from "@/lib/domain/import-help-content";
import { ChevronRight, Info, TriangleAlert } from "lucide-react";

const CHANNEL_LABELS: Record<ImportChannel, string> = {
  files: "Files",
  api: "API",
  openalgo: "OpenAlgo",
};

export function ImportHelp({ cards }: { cards: ImportHelpCard[] }) {
  const [openId, setOpenId] = React.useState<string | null>(null);
  const active = cards.find((c) => c.id === openId) ?? null;

  return (
    <>
      <div className="grid gap-3 lg:grid-cols-2">
        {cards.map((c) => (
          <Card key={c.id} className="h-fit p-0">
            <button
              type="button"
              className="w-full rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-haspopup="dialog"
              aria-expanded={openId === c.id}
              onClick={() => setOpenId(c.id)}
              data-testid={`import-help-open-${c.id}`}
            >
              <CardHeader className="flex-row items-start justify-between gap-2">
                <div>
                  <CardTitle className="text-base">{c.title}</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">{c.summary}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {c.channels.map((ch) => (
                    <Badge key={ch} variant="outline">
                      {CHANNEL_LABELS[ch]}
                    </Badge>
                  ))}
                  <ChevronRight className="size-4 text-muted-foreground" />
                </div>
              </CardHeader>
            </button>
          </Card>
        ))}
      </div>

      <Dialog open={active !== null} onOpenChange={(open) => !open && setOpenId(null)}>
        {active && (
          <DialogContent className="max-w-2xl" data-testid="import-help-dialog">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-lg">
                {active.title}
                <span className="flex items-center gap-1.5">
                  {active.channels.map((ch) => (
                    <Badge key={ch} variant="outline">
                      {CHANNEL_LABELS[ch]}
                    </Badge>
                  ))}
                </span>
              </DialogTitle>
              <DialogDescription className="text-sm">{active.summary}</DialogDescription>
            </DialogHeader>

            <div className="space-y-5 text-sm">
              {active.formats.length > 0 && (
                <Section title="Files Vyuha reads">
                  <ul className="space-y-1 text-muted-foreground">
                    {active.formats.map((f) => (
                      <li key={f.sourceId} className="flex gap-1.5">
                        <span aria-hidden>·</span>
                        <span>{f.label}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              <Section title="Where to get the files & how it works">
                <StepList steps={active.steps} />
              </Section>

              {active.api && (
                <Section title="API connection">
                  <StepList steps={active.api} />
                </Section>
              )}

              {active.openalgo && (
                <Section title="Over OpenAlgo">
                  <StepList steps={active.openalgo} />
                </Section>
              )}

              {active.notes && active.notes.length > 0 && (
                <section
                  className="rounded-md border border-warning/40 bg-warning/5 p-3"
                  data-testid="import-help-notes"
                >
                  <h3 className="flex items-center gap-1.5 text-sm font-semibold text-warning">
                    <TriangleAlert className="size-4 shrink-0" />
                    Worth knowing before you rely on it
                  </h3>
                  <ul className="mt-2 space-y-2.5">
                    {active.notes.map((n, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-muted-foreground">
                        <Info className="mt-0.5 size-3.5 shrink-0" />
                        <span>{n}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {active.guide && (
                <Section title="The full walkthrough">
                  <p className="text-muted-foreground">{active.guide.intro}</p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {active.guide.files.map((f) => (
                      <FileBlock key={f} name={f} />
                    ))}
                  </div>
                </Section>
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpenId(null)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

/** Numbered prose steps — the dialog's body voice. */
function StepList({ steps }: { steps: string[] }) {
  return (
    <ol className="space-y-2.5">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-2.5 text-muted-foreground">
          <span aria-hidden className="font-medium tabular-nums text-foreground">
            {i + 1}.
          </span>
          <span>{s}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The AddressBlock pattern from openalgo-dialog.tsx, for a FILE instead of a
 * URL: selectable text naming the client-package file, no anchor at all —
 * there is nothing to link to, the file sits in the buyer's own download.
 */
function FileBlock({ name }: { name: string }) {
  return (
    <div className="rounded-md border border-border bg-background/40 p-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        In your client package
      </div>
      <div className="mt-1 select-all break-all font-mono text-xs text-foreground">{name}</div>
    </div>
  );
}
