"use client";

// T3.9 — SL/TSL/target breach banner. Server pages compute breaches off the
// freshest marks and pass them down; this stays a dumb, honest display:
// marks are EOD/manual, so every line is a prompt to REVIEW against a live
// quote — never an instruction to exit. Desktop notifications are strictly
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

export function BreachBanner({ breaches }: { breaches: Breach[] }) {
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
  // user opted in on this device. Same set twice = silent.
  React.useEffect(() => {
    if (!optIn || breaches.length === 0) return;
    const hash = breachHash(breaches);
    if (localStorage.getItem(LAST_HASH_KEY) === hash) return;
    localStorage.setItem(LAST_HASH_KEY, hash);
    try {
      const stops = breaches.filter((b) => b.kind !== "target").length;
      const targets = breaches.length - stops;
      new Notification("Vyuha — positions need review", {
        body: `${stops ? `${stops} stop${stops === 1 ? "" : "s"} breached` : ""}${stops && targets ? ", " : ""}${
          targets ? `${targets} target${targets === 1 ? "" : "s"} reached` : ""
        } (EOD/manual marks — verify live before acting)`,
      });
    } catch {
      /* notification blocked — banner below still shows everything */
    }
  }, [optIn, breaches]);

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
      <p className="mt-2 text-[11px] text-muted-foreground">
        Marks here are EOD or manually entered — <span className="text-foreground">not live quotes</span>.
        Check a live price with your broker and act on YOUR plan, in your own time. This banner never
        places or closes anything.
      </p>
    </div>
  );
}
