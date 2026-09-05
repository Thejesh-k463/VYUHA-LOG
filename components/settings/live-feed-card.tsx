"use client";

// Settings → Live feed (v4.1). Which provider prices the Live Desk, how often
// the screen refreshes, and the one thing about a broker feed nobody can
// engineer away: the session dies every day.
//
// fetch + router.refresh(), never a server action (AGENTS.md) — a server
// action would auto-refresh the route and remount every sibling card in
// Settings, resetting state the user was in the middle of typing.
//
// OPENALGO IS NAMED HERE AND IN THE CONSENT SHEET, NOWHERE ELSE (owner answer
// Q60). tests/live-feed-copy.test.ts greps docs/sales and README to keep it
// that way: it is a bridge the user chooses to run, not a feature Vyuha sells.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Activity, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";
import { OPENALGO_FEED_ENABLED } from "@/lib/quotes/types";
import type { Settings } from "@/lib/db/schema";

/** Mirrors lib/quotes/openalgo.ts (owner answer Q25). Pinned by the copy test. */
export const REFRESH_MIN = 1;
export const REFRESH_MAX = 5;

export const LIVE_FEED_COPY = {
  /**
   * ATTRIBUTABLE, and deliberately NOT a regulatory claim (owner ruling, this
   * wave). The earlier wording said exchanges and SEBI require the daily
   * re-authentication and carried an unverified-claim marker, because no
   * circular saying so is cited anywhere in the tree — an unverified claim
   * about what a regulator requires is the kind of sentence that ships as
   * fact. What we CAN state is what the user's own broker does: the API
   * session dies daily and has to be signed in again. It still names no
   * broker (every broker in India behaves this way) and still blames nobody.
   */
  dailyReauth:
    "Your broker's API session expires every day and has to be signed in again; that is the broker's rule, not Vyuha's.",
  /** The once-a-day prompt (owner answer Q24). Twenty seconds is the honest
   *  measure of the OpenAlgo flow: open the bridge, sign in, come back. */
  connect: "Connect your feed — 20 seconds",
  /**
   * Said next to the picker, because a mark from a poll is not a tick — and
   * it describes what `lib/quotes/persist-mark.ts` actually does. It writes at
   * most one row per position per IST day, and "Save today's mark" waives the
   * 15:30 clock but never the once-a-day rule: a mark taken mid-session is the
   * mark for that day, and the close is then no longer written. Saying only
   * "from the last price of the session" would describe a write that never
   * happens on any day the button was pressed.
   */
  staleness:
    "Prices refresh on screen only. Ticks are never written to your journal — one mark per position per day is saved, from the last price of the session or from the price when you press Save today's mark, whichever comes first.",
  /** Only true while the host is loopback; the card says the other case too. */
  local:
    "Requests go to the OpenAlgo bridge on your own machine. Vyuha adds no new internet host for prices.",
  remote:
    "Your OpenAlgo host is not this machine, so the symbols you hold are sent to that machine every few seconds while the desk is open.",
} as const;

type ProviderId = "manual" | "eod" | "openalgo";

const ALL_PROVIDERS: { id: ProviderId; label: string; blurb: string }[] = [
  {
    id: "manual",
    label: "My typed marks",
    blurb: "Only the prices you type. Nothing is fetched, ever.",
  },
  {
    id: "eod",
    label: "End-of-day bhavcopy",
    blurb: "Yesterday's close from the bhavcopy already on this machine. The default.",
  },
  {
    id: "openalgo",
    label: "OpenAlgo bridge (your own)",
    blurb: "Live prices from the OpenAlgo instance you run and connect to your own broker.",
  },
];

/**
 * What this release actually offers. OpenAlgo is a v4.1 feature (owner
 * ruling), so v4.0 renders two radios; `OPENALGO_FEED_ENABLED` in
 * `lib/quotes/types.ts` is the one line that brings the third back, and the
 * route's pickable set and the provider registry read the same constant. The
 * `openalgo` BRANCHES below stay — they are the card v4.1 needs, and a stored
 * value the picker no longer offers still falls back to `eod` on its own.
 */
const PROVIDERS = ALL_PROVIDERS.filter((p) => p.id !== "openalgo" || OPENALGO_FEED_ENABLED);

interface FeedResponse {
  ok: boolean;
  feed?: { stored: string; effective: string; refreshSeconds: number; blockedReason?: string };
  openalgo?: { enabled: boolean; ackCurrent: boolean };
  lastLiveMarkDate?: string | null;
  health?: { ok: boolean; state: string; latencyMs: number | null; reason: string };
  message?: string;
}

async function post(body: Record<string, unknown>): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch("/api/live/feed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export function LiveFeedCard({ current }: { current: Settings }) {
  const router = useRouter();
  const [provider, setProvider] = React.useState<ProviderId>(
    (PROVIDERS.some((p) => p.id === current.liveFeedProvider) ? current.liveFeedProvider : "eod") as ProviderId,
  );
  const [seconds, setSeconds] = React.useState(current.liveFeedRefreshSeconds ?? 3);
  const [status, setStatus] = React.useState<FeedResponse | null>(null);
  const [pending, setPending] = React.useState(false);

  // Mount-only: ask the server for the health line. This is a FETCH effect
  // (its state comes from the network), never a state-derived one — deriving
  // is what the other values in this card do.
  React.useEffect(() => {
    const ac = new AbortController();
    fetch("/api/live/feed", { signal: ac.signal })
      .then((r) => r.json())
      .then((j: FeedResponse) => setStatus(j))
      .catch(() => {
        /* the card still renders; the health line simply says nothing yet */
      });
    return () => ac.abort();
  }, []);

  const health = status?.health;
  const needsConnect = provider === "openalgo" && health != null && (health.state === "no-key" || health.state === "unreachable");
  const consentMissing = provider === "openalgo" && status?.openalgo != null && !(status.openalgo.enabled && status.openalgo.ackCurrent);

  async function pick(next: ProviderId) {
    setPending(true);
    const previous = provider;
    setProvider(next);
    const r = await post({ action: "provider", provider: next });
    setPending(false);
    if (!r.ok) {
      setProvider(previous); // the server refused — the card must not lie
      toast.error(r.message ?? "Could not switch the feed.");
      return;
    }
    toast.success(r.message ?? "Saved.");
    router.refresh();
  }

  async function saveSeconds(next: number) {
    setSeconds(next);
    const r = await post({ action: "refresh-seconds", seconds: next });
    if (!r.ok) toast.error(r.message ?? "Could not save the refresh interval.");
  }

  async function markNow() {
    setPending(true);
    const r = await post({ action: "mark" });
    setPending(false);
    (r.ok ? toast.success : toast.error)(r.message ?? "");
    if (r.ok) router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="size-4" /> Live feed
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3" data-testid="live-feed-card">
        <div className="space-y-2">
          {PROVIDERS.map((p) => (
            <label
              key={p.id}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2",
                provider === p.id ? "border-primary bg-card-hover/60" : "border-border bg-card-hover/40",
              )}
            >
              <input
                type="radio"
                name="live-feed-provider"
                className="mt-1"
                checked={provider === p.id}
                disabled={pending}
                onChange={() => void pick(p.id)}
                data-testid={`live-feed-${p.id}`}
              />
              <span>
                <span className="block text-sm font-medium">{p.label}</span>
                <span className="block text-xs text-muted-foreground">{p.blurb}</span>
              </span>
            </label>
          ))}
        </div>

        <p className="text-xs text-muted-foreground">{LIVE_FEED_COPY.staleness}</p>

        <div className="space-y-2 rounded-md border border-border bg-card-hover/40 px-3 py-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="live-feed-seconds">On-screen refresh</Label>
            <span className="text-xs tabular-nums text-muted-foreground">{seconds}s</span>
          </div>
          <input
            id="live-feed-seconds"
            type="range"
            min={1}
            max={5}
            step={1}
            value={seconds}
            onChange={(e) => void saveSeconds(Number(e.target.value))}
            className="w-full accent-[var(--color-primary)]"
            data-testid="live-feed-seconds"
          />
        </div>

        {/* HIGHLIGHTED, and the highlight is the point: this is the one thing
            about a broker feed that no amount of engineering removes. */}
        <div className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2" data-testid="live-feed-reauth">
          <p className="flex items-start gap-2 text-xs text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>{LIVE_FEED_COPY.dailyReauth}</span>
          </p>
        </div>

        {provider === "openalgo" && (
          <p className="text-xs text-muted-foreground">
            {LIVE_FEED_COPY.local} <span className="text-warning">{LIVE_FEED_COPY.remote}</span>
          </p>
        )}

        {consentMissing && (
          <div className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2">
            <p className="text-xs text-warning">
              {status?.feed?.blockedReason ??
                "Turn OpenAlgo on in Integrations and read its disclosure first — until then the desk stays on end-of-day prices."}
            </p>
          </div>
        )}

        {needsConnect && (
          <div className="rounded-md border border-border bg-card-hover/40 px-3 py-2" data-testid="live-feed-connect">
            <p className="text-sm font-medium">{LIVE_FEED_COPY.connect}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Start your OpenAlgo instance, sign in to your broker there, then come back. Vyuha never
              holds the broker credential — OpenAlgo does. {health?.reason}
            </p>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span data-testid="live-feed-health">
            {health == null
              ? "Checking the feed…"
              : health.ok
                ? `Feed OK${health.latencyMs == null ? "" : ` · ${health.latencyMs} ms`}`
                : `Not live — ${health.reason}`}
            {status?.lastLiveMarkDate ? ` · last saved mark ${status.lastLiveMarkDate}` : ""}
          </span>
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void markNow()}>
            Save today&apos;s mark
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
