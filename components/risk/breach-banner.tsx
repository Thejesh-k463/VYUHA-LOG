"use client";

// T3.9 — SL/TSL/target breach banner. Server pages compute breaches off the
// freshest marks and pass them down; this stays a dumb, honest display:
// marks are end-of-day, typed, or one dated mark a day from your own feed —
// never a live tick — so every line is a prompt to REVIEW against a live
// quote, never an instruction to exit. Desktop notifications are strictly
// opt-in (button below), and the opt-in lives on this device only.

import * as React from "react";
import { AlertTriangle, Bell, BellOff, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Breach } from "@/lib/risk/alerts";

const OPTIN_KEY = "vyuha-breach-notify";
const LAST_HASH_KEY = "vyuha-breach-last-notified";

function breachHash(breaches: Breach[]): string {
  return breaches.map((b) => `${b.id}:${b.kind}:${b.level}`).sort().join("|");
}

/**
 * U-2 — ONE RECORD PER ACCOUNT, not one record.
 *
 * The banners are account-scoped (invariant 8), so the set this component is
 * handed changes with the account switcher. Against a single stored hash,
 * Personal → Swing → Personal is three different sets and the opted-in
 * notification fired on each — re-announcing breaches the user had already
 * been shown. Keying the record by account is what makes "switching back shows
 * nothing new" true: a hash that merely CONTAINED the account id would still
 * be one record, and one record cannot remember two accounts. `0` is the
 * All-accounts view and gets its own record like any other id, because the
 * union genuinely is a different set.
 */
export function lastNotifiedKey(accountId: number): string {
  // Parameterised the way every other `vyuha-` key is (AGENTS.md: a `:suffix`).
  return `${LAST_HASH_KEY}:${accountId}`;
}

/** The dedup step: the hash to announce, or `null` if this exact set has
 *  already been announced FOR THIS ACCOUNT on this device. Takes the store so
 *  it can be tested without a DOM (vitest runs `environment: "node"`). */
export function markNotified(
  store: Pick<Storage, "getItem" | "setItem">,
  accountId: number,
  breaches: Breach[],
): string | null {
  const key = lastNotifiedKey(accountId);
  const hash = breachHash(breaches);
  if (store.getItem(key) === hash) return null;
  store.setItem(key, hash);
  return hash;
}

export function BreachBanner({ breaches, accountId }: { breaches: Breach[]; accountId: number }) {
  const [optIn, setOptIn] = React.useState(false);
  const [supported, setSupported] = React.useState(false);

  React.useEffect(() => {
    const ok = typeof window !== "undefined" && "Notification" in window;
    // .then-style deferral keeps setState out of the synchronous effect body
    Promise.resolve().then(() => {
      setSupported(ok);
      setOptIn(ok && localStorage.getItem(OPTIN_KEY) === "1" && Notification.permission === "granted");
    });
  }, []);

  // Fire a desktop notification for a NEW breach set only — and only if the
  // user opted in on this device. Same set twice, for the same account = silent
  // (U-2: the record is per account, since the set is).
  React.useEffect(() => {
    if (!optIn || breaches.length === 0) return;
    if (markNotified(localStorage, accountId, breaches) === null) return;
    try {
      const stops = breaches.filter((b) => b.kind !== "target").length;
      const targets = breaches.length - stops;
      new Notification("Vyuha — positions need review", {
        body: `${stops ? `${stops} stop${stops === 1 ? "" : "s"} breached` : ""}${stops && targets ? ", " : ""}${
          targets ? `${targets} target${targets === 1 ? "" : "s"} reached` : ""
        } (end-of-day, typed, or one dated mark a day from your own feed — never a live tick; check a live quote before acting)`,
      });
    } catch {
      /* notification blocked — banner below still shows everything */
    }
  }, [optIn, breaches, accountId]);

  async function enableNotifications() {
    if (!supported) return;
    const perm = await Notification.requestPermission();
    if (perm === "granted") {
      localStorage.setItem(OPTIN_KEY, "1");
      setOptIn(true);
    }
  }
  function disableNotifications() {
    localStorage.removeItem(OPTIN_KEY);
    setOptIn(false);
  }

  if (breaches.length === 0) return null;
  const shown = breaches.slice(0, 6);

  return (
    <div className="rounded-lg border border-warning/40 bg-warning/10 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-warning">
          <AlertTriangle className="size-4" />
          Stops &amp; targets need review ({breaches.length})
        </div>
        {supported && (
          optIn ? (
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={disableNotifications}>
              <BellOff className="size-3.5" /> Alerts on this device: on
            </Button>
          ) : (
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={enableNotifications}>
              <Bell className="size-3.5" /> Notify me on this device
            </Button>
          )
        )}
      </div>
      <ul className="mt-2 space-y-1">
        {shown.map((b) => (
          <li key={`${b.id}-${b.kind}`} className="flex items-start gap-2 text-xs">
            {b.kind === "target" ? (
              <Target className="mt-0.5 size-3.5 shrink-0 text-profit" />
            ) : (
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-loss" />
            )}
            <span>{b.message}</span>
          </li>
        ))}
        {breaches.length > shown.length && (
          <li className="text-xs text-muted-foreground">…and {breaches.length - shown.length} more.</li>
        )}
      </ul>
      <p className="mt-2 text-[0.6875rem] text-muted-foreground">
        Marks here are end-of-day, typed, or one dated mark a day from your own feed —{" "}
        <span className="text-foreground">never a live tick</span>. Check a live quote before acting,
        and act on YOUR plan, in your own time. This banner never places or closes anything.
      </p>
    </div>
  );
}
