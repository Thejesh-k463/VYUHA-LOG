"use client";

// v3.7 §5.3a — the DURABLE, route-independent note that a Telegram EOD digest
// failed. Mounted once in app/layout.tsx, so it is visible from every route;
// the record it reads is a versioned localStorage envelope written by
// <TelegramRunner> (lib/domain/telegram-failure.ts explains why the settings
// column the plan preferred could not be used in this wave).
//
// What it must not become: an alarm. The digest is best-effort by design, the
// journal is untouched by a failed send, and the strip says so.
//
// §5.3b — the OS-notification probe rides here rather than in a new dependency.
// It is the browser Notification API already present in the WebView, behind the
// same per-device opt-in shape as components/risk/breach-banner.tsx: nothing is
// requested until the button is pressed, and it fires only for this one case.
// The capability is INFERRED, not VERIFIED — see DIGEST_NOTIFY_COPY.

import * as React from "react";
import { TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStoredValue, writeStored } from "@/components/layout/use-stored-value";
import {
  DIGEST_NOTIFY_COPY,
  DIGEST_NOTIFY_LAST_KEY,
  DIGEST_NOTIFY_OPTIN_KEY,
  TELEGRAM_FAILURE_DISMISS_LABEL,
  TELEGRAM_FAILURE_KEY,
  TELEGRAM_FAILURE_REASSURANCE,
  digestFailureSignature,
  parseTelegramFailure,
  serializeTelegramFailure,
  shouldRaiseDigestNotification,
  telegramFailureHeadline,
} from "@/lib/domain/telegram-failure";

export function TelegramFailureNote() {
  // Derived from storage, never mirrored into state — so a write from
  // <TelegramRunner> in the same document re-renders this strip immediately
  // (writeStored notifies local subscribers) and a refresh loses nothing.
  const record = parseTelegramFailure(useStoredValue(TELEGRAM_FAILURE_KEY));
  const [supported, setSupported] = React.useState(false);
  const [optIn, setOptIn] = React.useState(false);

  React.useEffect(() => {
    const ok = typeof window !== "undefined" && "Notification" in window;
    // Deferred exactly as breach-banner defers it: no synchronous setState in
    // an effect body (AGENTS.md).
    Promise.resolve().then(() => {
      setSupported(ok);
      setOptIn(ok && localStorage.getItem(DIGEST_NOTIFY_OPTIN_KEY) === "1" && Notification.permission === "granted");
    });
  }, []);

  const signature = digestFailureSignature(record);
  React.useEffect(() => {
    if (
      !shouldRaiseDigestNotification({
        supported,
        optIn,
        permission: supported ? Notification.permission : null,
        signature,
        lastSignature: localStorage.getItem(DIGEST_NOTIFY_LAST_KEY),
      })
    ) {
      return;
    }
    localStorage.setItem(DIGEST_NOTIFY_LAST_KEY, signature);
    try {
      new Notification(DIGEST_NOTIFY_COPY.title, { body: TELEGRAM_FAILURE_REASSURANCE });
    } catch {
      /* blocked or unsupported in this shell — the strip below is the record. */
    }
  }, [supported, optIn, signature]);

  if (!record || record.dismissed) return null;

  function dismiss() {
    if (!record) return;
    // Keep the record, drop the strip: a dismissal is not a resolution, and the
    // next failure (a different signature) writes a fresh, undismissed record.
    writeStored(TELEGRAM_FAILURE_KEY, serializeTelegramFailure({ ...record, dismissed: true }));
  }

  async function enableNotifications() {
    if (!supported) return;
    const perm = await Notification.requestPermission();
    if (perm === "granted") {
      localStorage.setItem(DIGEST_NOTIFY_OPTIN_KEY, "1");
      setOptIn(true);
    }
  }

  function disableNotifications() {
    localStorage.removeItem(DIGEST_NOTIFY_OPTIN_KEY);
    setOptIn(false);
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-3 z-40 flex justify-center px-4 print:hidden">
      <div
        className="pointer-events-auto w-full max-w-3xl rounded-lg border border-warning/40 bg-card px-4 py-2.5 text-xs shadow-[var(--shadow-overlay)]"
        data-testid="telegram-failure-note"
      >
        <div className="flex items-start justify-between gap-3">
          <span className="flex items-start gap-2">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <span>
              {telegramFailureHeadline(record)}{" "}
              <span className="text-muted-foreground">{TELEGRAM_FAILURE_REASSURANCE}</span>
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {supported &&
              (optIn ? (
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={disableNotifications}>
                  {DIGEST_NOTIFY_COPY.enabled}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => void enableNotifications()}
                  title={DIGEST_NOTIFY_COPY.note}
                >
                  {DIGEST_NOTIFY_COPY.enable}
                </Button>
              ))}
            <button
              type="button"
              onClick={dismiss}
              title={TELEGRAM_FAILURE_DISMISS_LABEL}
              aria-label={TELEGRAM_FAILURE_DISMISS_LABEL}
              className="text-muted-foreground hover:text-foreground"
              data-testid="telegram-failure-dismiss"
            >
              <X className="size-3.5" />
            </button>
          </span>
        </div>
        {supported && !optIn && <p className="mt-1.5 pl-5 text-[0.6875rem] text-muted-foreground">{DIGEST_NOTIFY_COPY.note}</p>}
      </div>
    </div>
  );
}
