"use client";

// v3.6 — background trigger for the opt-in Telegram EOD digest. Fires the API
// once per browser session (the auto-mtm-runner pattern); the server side
// no-ops unless every precondition holds (enabled + current ack + credentials
// + market day + past send time IST + not already sent today — see
// lib/telegram/digest-gate.ts). Silence is the default.
//
// v3.7 §5.3a — the FAILURE half of the outcome no longer lives in this
// component's React state. It did until now, which meant a refresh erased it
// while the sessionStorage latch suppressed the re-fire, and a user who opened
// the app on any other route never learned at all — the digest job itself keeps
// no trace, because it deliberately reverts its `last_telegram_sent_date` claim
// on failure so the next launch retries. A failure is now written to a durable
// versioned envelope (lib/domain/telegram-failure.ts) that
// <TelegramFailureNote> renders from the ROOT LAYOUT on every route, and a
// successful send clears it. The success line stays here, ephemeral and on the
// dashboard: good news that is already visible in the numbers below it does not
// need to survive a refresh.

import * as React from "react";
import { CheckCircle2, X } from "lucide-react";
import { writeStored } from "@/components/layout/use-stored-value";
import { TELEGRAM_FAILURE_KEY, serializeTelegramFailure } from "@/lib/domain/telegram-failure";

const SESSION_KEY = "vyuha-telegram-digest-fired";

export function TelegramRunner() {
  const [note, setNote] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (sessionStorage.getItem(SESSION_KEY)) return;
    sessionStorage.setItem(SESSION_KEY, "1");
    const ctrl = new AbortController();
    fetch("/api/telegram/digest", { method: "POST", signal: ctrl.signal })
      .then((r) => r.json())
      .then((d) => {
        if (d?.ran) {
          setNote(d.reason);
          // A confirmed send is the only thing that clears a recorded failure.
          writeStored(TELEGRAM_FAILURE_KEY, null);
        } else if (d?.failed) {
          writeStored(
            TELEGRAM_FAILURE_KEY,
            serializeTelegramFailure({ date: d.date ?? null, reason: String(d.reason), at: new Date().toISOString() }),
          );
        }
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
        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-profit" />
        <span>{note}</span>
      </span>
      <button type="button" onClick={() => setNote(null)} title="Dismiss" className="text-muted-foreground hover:text-foreground">
        <X className="size-3.5" />
      </button>
    </div>
  );
}
