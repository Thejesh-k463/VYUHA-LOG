"use client";

// T3.8 — background trigger for the opt-in auto-MTM job. Fires the API once
// per browser session; the server side no-ops unless the user enabled the
// Settings toggle AND there's a new bhavcopy date. Shows a small dismissible
// status line only when something actually happened — silence is the default.

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, X } from "lucide-react";

const SESSION_KEY = "vyuha-auto-mtm-fired";

export function AutoMtmRunner() {
  const router = useRouter();
  const [note, setNote] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (sessionStorage.getItem(SESSION_KEY)) return;
    sessionStorage.setItem(SESSION_KEY, "1");
    const ctrl = new AbortController();
    fetch("/api/mtm/auto", { method: "POST", signal: ctrl.signal })
      .then((r) => r.json())
      .then((d) => {
        if (d?.ran) {
          setNote(`Auto-MTM: ${d.reason}`);
          router.refresh();
        }
      })
      .catch(() => {
        /* offline / aborted — auto-MTM is best-effort by design */
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
            Prices came from the NSE EOD file — spot-check anything that looks off before relying on it.
          </span>
        </span>
      </span>
      <button type="button" onClick={() => setNote(null)} title="Dismiss" className="text-muted-foreground hover:text-foreground">
        <X className="size-3.5" />
      </button>
    </div>
  );
}
