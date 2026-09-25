"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, ShieldOff } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { HelpTopic } from "@/lib/domain/help-content";
import { GlossaryText } from "./glossary-text";

/**
 * One help topic, task first (v4.6.0 W4, ruling H4): the question it answers,
 * the steps, the one trap, the screen itself, then the long description under
 * "In detail" — unchanged from the entry — and what the screen will not do.
 *
 * Radix Dialog supplies the focus trap and Esc. The dialog is OPEN exactly
 * while the URL carries this topic's `#topic-…` fragment (the caller derives
 * `topic` from the hash), so closing it — Esc, the ×, a click outside — calls
 * `onClose`, which clears the fragment. Related topics swap in place.
 */
export function HelpTopicDialog({
  topic,
  topics,
  onClose,
  onOpenTopic,
}: {
  topic: HelpTopic | null;
  topics: readonly HelpTopic[];
  onClose: () => void;
  onOpenTopic: (id: string) => void;
}) {
  const byHref = React.useMemo(() => new Map(topics.map((t) => [t.href, t])), [topics]);
  const related = topic ? topic.related.map((h) => byHref.get(h)).filter((t): t is HelpTopic => !!t && t.id !== topic.id) : [];

  return (
    <Dialog open={topic != null} onOpenChange={(open) => (open ? undefined : onClose())}>
      {topic && (
        <DialogContent className="text-lg sm:max-w-3xl" data-testid="help-topic-dialog">
          <DialogHeader>
            <DialogTitle className="pr-8 text-2xl">{topic.title}</DialogTitle>
            {/* The shared description stays text-sm (tests/seams-v43.test.ts S1
                pins every DialogDescription); the 18px reading size is the span's. */}
            <DialogDescription>
              <span className="text-lg italic">{topic.answers}</span>
            </DialogDescription>
          </DialogHeader>

          <section aria-labelledby={`${topic.id}-steps`}>
            <h3 id={`${topic.id}-steps`} className="mb-2 text-base font-semibold uppercase tracking-wide text-muted-foreground">
              Steps
            </h3>
            <ol className="list-decimal space-y-1.5 pl-6">
              {topic.steps.map((s, i) => (
                <li key={i}>
                  <GlossaryText text={s} />
                </li>
              ))}
            </ol>
          </section>

          <section
            aria-labelledby={`${topic.id}-watch`}
            className="rounded-md border border-warning/40 border-l-4 bg-warning/[0.06] px-4 py-3"
          >
            <h3 id={`${topic.id}-watch`} className="mb-1 text-base font-semibold uppercase tracking-wide text-muted-foreground">
              Watch out
            </h3>
            <p>
              <GlossaryText text={topic.watchOut} />
            </p>
          </section>

          {topic.screenshot && (
            // A static file under public/help, lazy so a closed topic costs nothing.
            // eslint-disable-next-line @next/next/no-img-element -- next/image would route the file through the optimiser, which the offline desktop sidecar does not run
            <img
              src={`/help/${topic.screenshot}.webp`}
              loading="lazy"
              alt={`${topic.title} screen, dark theme, demo data`}
              className="w-full rounded-md border border-border"
            />
          )}

          <section aria-labelledby={`${topic.id}-detail`}>
            <h3 id={`${topic.id}-detail`} className="mb-2 text-base font-semibold uppercase tracking-wide text-muted-foreground">
              In detail
            </h3>
            <div className="space-y-2 text-foreground/90">
              {topic.body.map((b, i) => (
                <p key={i}>
                  <GlossaryText text={b} />
                </p>
              ))}
            </div>
          </section>

          {topic.refusals && topic.refusals.length > 0 && (
            <section aria-labelledby={`${topic.id}-refusals`}>
              <h3 id={`${topic.id}-refusals`} className="mb-2 text-base font-semibold uppercase tracking-wide text-muted-foreground">
                What it will not do
              </h3>
              <ul className="space-y-1.5">
                {topic.refusals.map((r, i) => (
                  <li key={i} className="flex items-start gap-2 text-foreground/90">
                    <ShieldOff className="mt-1.5 size-4 shrink-0" aria-hidden />
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {related.length > 0 && (
            <section aria-labelledby={`${topic.id}-related`}>
              <h3 id={`${topic.id}-related`} className="mb-2 text-base font-semibold uppercase tracking-wide text-muted-foreground">
                Related
              </h3>
              <div className="flex flex-wrap gap-2">
                {related.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => onOpenTopic(r.id)}
                    className="rounded-md border border-border px-3 py-1.5 text-base hover:bg-card-hover"
                  >
                    {r.title}
                  </button>
                ))}
              </div>
            </section>
          )}

          <div>
            <Link
              href={topic.href}
              onClick={onClose}
              className="inline-flex items-center gap-1.5 rounded-md border border-primary/50 px-3 py-1.5 text-base font-medium hover:bg-card-hover"
            >
              Open {topic.title} <ArrowRight className="size-4" />
            </Link>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
