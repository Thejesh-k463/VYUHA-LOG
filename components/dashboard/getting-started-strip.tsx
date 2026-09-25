"use client";

import * as React from "react";
import Link from "next/link";
import { Check, X } from "lucide-react";
import { useStoredValue, writeStored } from "@/components/layout/use-stored-value";
import {
  BACKUP_TAKEN_KEY,
  GETTING_STARTED_DISMISSED_KEY,
  deriveGettingStarted,
  markerJson,
  parseMarker,
  type GettingStartedServerFacts,
} from "@/lib/domain/getting-started";

/**
 * The dashboard's getting-started strip (v4.6.0 W4, row 9.5): five first steps,
 * each ticked from data the app already holds (lib/queries/getting-started.ts,
 * computed on the server and passed in) plus the one fact only this browser
 * knows — a backup downloaded on this machine. Every undone step links to its
 * screen. Gone once all five are done, or once dismissed.
 *
 * HYDRATION: `useStoredValue` is null on the server and during hydration, so
 * the strip server-renders and a stored dismissal (or backup) lands right
 * after — the documented pattern (components/layout/use-stored-value.ts).
 */
export function GettingStartedStrip({ facts }: { facts: GettingStartedServerFacts }) {
  const backup = parseMarker(useStoredValue(BACKUP_TAKEN_KEY));
  const dismissed = parseMarker(useStoredValue(GETTING_STARTED_DISMISSED_KEY));
  const view = deriveGettingStarted({ ...facts, backupTaken: backup != null });
  if (view.allDone || dismissed) return null;

  return (
    <section
      aria-label="Getting started"
      data-testid="getting-started-strip"
      className="rounded-lg border border-border bg-card/60 px-4 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          Getting started <span className="font-normal text-muted-foreground">· {view.doneCount} of {view.steps.length} done</span>
        </h2>
        <button
          type="button"
          onClick={() => writeStored(GETTING_STARTED_DISMISSED_KEY, markerJson(new Date().toISOString()))}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-card-hover hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden /> Dismiss
        </button>
      </div>
      <ol className="mt-2 flex flex-wrap gap-2">
        {view.steps.map((s) => {
          const chip = (
            <>
              <span
                className={`inline-flex size-4 shrink-0 items-center justify-center rounded-full border ${
                  s.done ? "border-profit bg-profit/20 text-profit" : "border-border"
                }`}
                aria-hidden
              >
                {s.done && <Check className="size-3" />}
              </span>
              <span>{s.title}</span>
              <span className="sr-only">{s.done ? "(done)" : "(not done yet)"}</span>
            </>
          );
          return (
            <li key={s.id}>
              {s.done ? (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-sm text-muted-foreground">
                  {chip}
                </span>
              ) : (
                <Link
                  href={s.href}
                  title={s.hint}
                  className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 px-2.5 py-1 text-sm hover:bg-card-hover"
                >
                  {chip}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
      {!view.steps.find((s) => s.id === "backup")?.done && (
        <p className="mt-2 text-xs text-muted-foreground">A backup is counted on this machine only — the journal itself records none.</p>
      )}
    </section>
  );
}
