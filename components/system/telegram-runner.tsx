"use client";

// v3.6 — background trigger for the opt-in Telegram EOD digest. Fires the API
// once per browser session (the auto-mtm-runner pattern); the server side
// no-ops unless every precondition holds (enabled + current ack + credentials
// + market day + past send time IST + not already sent today — see
// lib/telegram/digest-gate.ts). Shows a small dismissible line when a digest
// actually went out, and the promised degrade-to-in-app note when the gate
// was open but Telegram could not be reached. Silence is the default.

import * as React from "react";
import { CheckCircle2, TriangleAlert, X } from "lucide-react";

const SESSION_KEY = "vyuha-telegram-digest-fired";

export function TelegramRunner() {
  const [note, setNote] = React.useState<{ text: string; failed: boolean } | null>(null);

  React.useEffect(() => {
    if (sessionStorage.getItem(SESSION_KEY)) return;
    sessionStorage.setItem(SESSION_KEY, "1");
    const ctrl = new AbortController();
    fetch("/api/telegram/digest", { method: "POST", signal: ctrl.signal })
      .then((r) => r.json())
      .then((d) => {
        if (d?.ran) setNote({ text: d.reason, failed: false });
        else if (d?.failed) setNote({ text: `Telegram digest not sent: ${d.reason}`, failed: true });
      })
      .catch(() => {
        /* offline / aborted — the digest is best-effort by design */
      });
    return () => ctrl.abort();
  }, []);

  if (!note) return null;
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-card-hover/40 px-4 py-2.5 text-xs">
      <span className="flex items-start gap-2">
        {note.failed ? (
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
        ) : (
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-profit" />
        )}
        <span>
          {note.text}{" "}
          {note.failed && (
            <span className="text-muted-foreground">
              Your journal is unaffected — everything in the digest is already on this screen.
            </span>
          )}
        </span>
      </span>
      <button type="button" onClick={() => setNote(null)} title="Dismiss" className="text-muted-foreground hover:text-foreground">
        <X className="size-3.5" />
      </button>
    </div>
  );
}
