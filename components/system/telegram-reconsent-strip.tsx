"use client";

// v4.7.0 C5 — the Telegram re-consent strip (owner answer TG6; design D13,
// review R5). TELEGRAM_DISCLOSURE went 1 → 2 in this release (stop/target
// alerts are a new risk), and `isTelegramAckCurrent()` compares with `===`, so
// an install that accepted v1 has its END-OF-DAY DIGEST stopped too until the
// user re-reads. Without this strip that stoppage is silent: the digest simply
// stops arriving (research risk 5). So, on every route, where Telegram is ON and
// the accepted version is not the current one, one dismissable line points at
// the card. It is gone on re-accept (the layout's prop changes) or on dismiss.
//
// Server props from the root layout's EXISTING settings read; the dismissal is a
// per-device `{v:1, version}` envelope through components/layout/use-stored-
// value.ts (AGENTS.md). A dismissal records WHICH version it dismissed, so a
// later disclosure bump raises the strip again.
//
// HYDRATION: nothing renders on the server or during hydration — the dismissal
// lives only on the client, and rendering the strip first and hiding it after
// would flash it on every page for a user who dismissed it. `useHydrated()` is a
// `useSyncExternalStore` whose server snapshot is false, so the server markup
// and the hydration render agree (empty), and the strip lands right after.

import * as React from "react";
import Link from "next/link";
import { TriangleAlert, X } from "lucide-react";
import { useStoredValue, writeStored } from "@/components/layout/use-stored-value";
import { TELEGRAM_DISCLOSURE } from "@/lib/domain/telegram-disclosure";

/** `vyuha-` kebab-case, `{v:1, version}` (AGENTS.md). */
export const TELEGRAM_RECONSENT_DISMISS_KEY = "vyuha-telegram-reconsent-dismissed";
const ENVELOPE_VERSION = 1;

/** The Telegram card's anchor on /settings (lib/domain/section-registry.ts). */
export const TELEGRAM_CARD_HREF = "/settings#settings-telegram";

/** `lead` + `link` is the design's sentence, word for word (D13); the link is its last clause. */
export const TELEGRAM_RECONSENT_COPY = {
  lead: "Telegram digest paused — the disclosure changed.",
  link: "Review it in Settings.",
  dismiss: "Dismiss",
} as const;

/** The disclosure version a stored dismissal covers, or null (none / unreadable / another shape). */
export function dismissedVersion(raw: string | null | undefined): number | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const e = parsed as { v?: unknown; version?: unknown };
  if (e.v !== ENVELOPE_VERSION) return null;
  return typeof e.version === "number" && Number.isInteger(e.version) ? e.version : null;
}

export function serializeReconsentDismissal(version: number): string {
  return JSON.stringify({ v: ENVELOPE_VERSION, version });
}

/**
 * Show the strip? Telegram is on, the accepted version is not the current one,
 * and the user has not dismissed THIS version. A dismissal for an older (or any
 * other) version does not hide the current one.
 */
export function shouldShowReconsent(s: {
  telegramEnabled: boolean;
  ackVersion: number | null | undefined;
  currentVersion: number;
  dismissed: number | null;
}): boolean {
  if (!s.telegramEnabled) return false;
  if (s.ackVersion === s.currentVersion) return false;
  return s.dismissed !== s.currentVersion;
}

/** Record the dismissal of `version` and re-render every reader. */
export function dismissReconsent(version: number = TELEGRAM_DISCLOSURE.version): void {
  writeStored(TELEGRAM_RECONSENT_DISMISS_KEY, serializeReconsentDismissal(version));
}

const noopSubscribe = () => () => {};

/** False on the server and during hydration, true after. */
function useHydrated(): boolean {
  return React.useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

export interface TelegramReconsentStripProps {
  telegramEnabled: boolean;
  ackVersion: number | null;
}

export function TelegramReconsentStrip({ telegramEnabled, ackVersion }: TelegramReconsentStripProps) {
  const hydrated = useHydrated();
  const dismissed = dismissedVersion(useStoredValue(TELEGRAM_RECONSENT_DISMISS_KEY));
  const current = TELEGRAM_DISCLOSURE.version;
  if (!hydrated || !shouldShowReconsent({ telegramEnabled, ackVersion, currentVersion: current, dismissed })) {
    return null;
  }

  return (
    // Bottom of the viewport, ABOVE the failure strip's slot (bottom-3), so the
    // two never overlap and neither covers a page's own header controls.
    <div className="pointer-events-none fixed inset-x-0 bottom-16 z-40 flex justify-center px-4 print:hidden">
      <div
        className="pointer-events-auto flex w-full max-w-3xl items-start justify-between gap-3 rounded-lg border border-warning/40 bg-card px-4 py-2.5 text-sm shadow-[var(--shadow-overlay)]"
        data-testid="telegram-reconsent-strip"
        role="status"
      >
        <span className="flex items-start gap-2">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            {TELEGRAM_RECONSENT_COPY.lead}{" "}
            <Link href={TELEGRAM_CARD_HREF} className="text-primary underline underline-offset-2" data-testid="telegram-reconsent-link">
              {TELEGRAM_RECONSENT_COPY.link}
            </Link>
          </span>
        </span>
        <button
          type="button"
          onClick={() => dismissReconsent(current)}
          title={TELEGRAM_RECONSENT_COPY.dismiss}
          aria-label={TELEGRAM_RECONSENT_COPY.dismiss}
          className="text-muted-foreground hover:text-foreground"
          data-testid="telegram-reconsent-dismiss"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
