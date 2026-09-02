"use client";

// v3.6 — background trigger for the opt-in auto-pull sweep. Fires the API once
// per browser session (the auto-mtm-runner pattern); the server side no-ops
// unless the Settings toggle is on and today's sweep has not run, pulls only
// UNATTENDED connections, and NEVER forces past a collision (those are
// recorded as skipped and left for the manual Import flow). Shows the sweep's
// one-line summary when anything was attempted; silence is the default.

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, X } from "lucide-react";

const SESSION_KEY = "vyuha-auto-pull-fired";

export function AutoPullRunner() {
  const router = useRouter();
  const [note, setNote] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (sessionStorage.getItem(SESSION_KEY)) return;
    sessionStorage.setItem(SESSION_KEY, "1");
    const ctrl = new AbortController();
    fetch("/api/import/broker/auto-pull", { method: "POST", signal: ctrl.signal })
      .then((r) => r.json())
      .then((d) => {
        if (d?.ran && d?.line) {
          setNote(d.line);
          if (Array.isArray(d.summary) && d.summary.some((e: { status?: string }) => e.status === "imported")) {
            router.refresh();
          }
        }
      })
      .catch(() => {
        /* offline / aborted — auto-pull is best-effort by design */
      });
    return () => ctrl.abort();
  }, [router]);

  if (!note) return null;
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-card-hover/40 px-4 py-2.5 text-xs">
      <span className="flex items-start gap-2">
        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-profit" />
        <span>
          {note}{" "}
          <span className="text-muted-foreground">
            Skipped collisions wait in Import — nothing is ever force-committed for you.
          </span>
        </span>
      </span>
      <button type="button" onClick={() => setNote(null)} title="Dismiss" className="text-muted-foreground hover:text-foreground">
        <X className="size-3.5" />
      </button>
    </div>
  );
}
