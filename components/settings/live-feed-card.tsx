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
import { FeedConsentDialog } from "@/components/system/feed-consent-dialog";
// The cadence sentence is DERIVED and SHARED with the desk, never restated
// here: `components/live/desk-copy.ts` owns it, and both surfaces print the
// same string for the same book (ruling 4.2-4).
import { angelOneCadenceLine } from "@/components/live/desk-copy";
import {
  ANGELONE_FEED_ITEMS,
  LIVE_FEED_DISCLOSURE_VERSIONS,
  UPSTOX_FEED_ITEMS,
} from "@/lib/domain/live-feed-disclosure";
import { ANGELONE_FEED_ENABLED, OPENALGO_FEED_ENABLED, UPSTOX_FEED_ENABLED } from "@/lib/quotes/types";
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
   *
   * The typed-mark rule (fix wave 3) is appended rather than given its own key:
   * `tests/live-feed-copy.test.ts` forbids README.md and the sales pages from
   * carrying ANY whole `LIVE_FEED_COPY` value (owner answer Q60 — the settings
   * card's copy is not marketing), and the same sentence has to appear in the
   * README. As a clause of a longer string it is said identically on all seven
   * surfaces without any of them reproducing a whole card string.
   */
  staleness:
    "Prices refresh on screen only. Ticks are never written to your journal — one mark per position per day is saved, from the last price of the session or from the price when you press Save today's mark, whichever comes first. A price you type yourself is that day's mark: the automatic close-of-session mark does not overwrite it, and typing after the close replaces the automatic one; any bhavcopy applied for that day — the Auto-MTM job if you have switched it on, a file you drop or paste yourself, or the history backfill — replaces it with the exchange close.",
  /** Only true while the host is loopback; the card says the other case too. */
  local:
    "Requests go to the OpenAlgo bridge on your own machine. Vyuha adds no new internet host for prices.",
  remote:
    "Your OpenAlgo host is not this machine, so the symbols you hold are sent to that machine every few seconds while the desk is open.",
} as const;

/**
 * THE UPSTOX ROW (v4.2), kept OUT of `LIVE_FEED_COPY` on purpose.
 *
 * `tests/live-feed-copy.test.ts` forbids README.md and the sales pages from
 * carrying any WHOLE `LIVE_FEED_COPY` value (owner answer Q60). These three
 * sentences describe a token the user already saved for imports, and the setup
 * docs may well need to say the same thing; a separate export keeps that guard
 * meaning what it was written to mean instead of quietly widening it over
 * another wave's files.
 *
 * WHAT IS DELIBERATELY NOT SAID HERE: the daily re-authentication sentence.
 * `LIVE_FEED_COPY.dailyReauth` is true of a bridge session and NOT true of
 * Upstox — its Analytics token is read-only for about a year — so the fact is
 * stated once, in the affirmative, in `blurb`, and the warning block below is
 * not rendered while Upstox is the pick. Two sentences contradicting each other
 * on one card is worse than either alone.
 */
export const UPSTOX_FEED_COPY = {
  label: "Upstox",
  blurb:
    "Uses the Analytics token saved under Import → Connect broker for this account. Upstox keeps that token read-only for about a year, so there is no daily login.",
  /** Shown INSTEAD of the blurb when the account has no connection: the blurb
   *  describes a token this account does not have, and the next step does. */
  notConnected: "Add Upstox under Import → Connect broker first.",
  /**
   * Always, connected or not — the scope of the feed is not a footnote.
   *
   * B-5: it used to say the derivative rows "keep their last stored mark",
   * which named a thing that does not exist. No writer stores a CONTRACT-keyed
   * mark (A-1 removed the underlying's cash mark from that read), so no
   * "Stored mark" pill can ever render for a future or an option: the row shows
   * the position's recorded close, or its entry price when there is no close.
   * The sentence now says what the row really shows, byte-for-byte the same as
   * the consent sheets and the help entry (a seam test compares them).
   */
  equityOnly:
    "Futures and options rows are not priced by this feed: each shows the position's recorded close, or its entry price when no close is recorded, and says so on the row.",
} as const;

/** What the GET tells the card about the Upstox radio. Never a token. */
export interface UpstoxFeedState {
  connected: boolean;
  ackCurrent: boolean;
}

/**
 * The Upstox row's second line and whether the radio takes a click — derived,
 * never held in state (AGENTS.md: if you are resetting state in an effect, the
 * state was derivable).
 *
 * `undefined` is the honest third case: the card's own fetch has not answered
 * yet, or it failed. It renders the row ENABLED and lets the route refuse —
 * disabling a control on the strength of a request that never came back would
 * lock out a user whose feed is perfectly well connected.
 */
export function upstoxRowState(state: UpstoxFeedState | undefined): { disabled: boolean; line: string } {
  const known = state != null;
  const blocked = known && !state.connected;
  return {
    disabled: blocked,
    line: blocked ? UPSTOX_FEED_COPY.notConnected : UPSTOX_FEED_COPY.blurb,
  };
}

/**
 * THE ANGEL ONE ROW (v4.2), kept out of `LIVE_FEED_COPY` for the same reason
 * the Upstox one is: the Q60 guard forbids README.md and the sales pages from
 * carrying any WHOLE `LIVE_FEED_COPY` value, and these sentences describe a
 * credential the user already saved for imports, which the setup docs may need
 * to repeat word for word.
 *
 * WHAT IS SAID AND WHY IT IS DEFENSIBLE:
 *
 *   • `blurb` names the three things Import → Connect broker actually holds for Angel
 *     One (client code, PIN, TOTP secret) and states the ONE operational fact
 *     that follows from them — Angel One ends every API session at 5 AM IST,
 *     and the next sign-in is performed by Vyuha from the enrolled secret with
 *     nothing for the user to click. That is a fact about the BROKER's system,
 *     measured against its own documented behaviour; it names no regulator,
 *     because none has been cited anywhere in this tree (the same ruling that
 *     softened `LIVE_FEED_COPY.dailyReauth`).
 *   • `dailyReauth` is the highlighted block's sentence for this provider. It
 *     says the same fact in the block's own voice. It exists as a SEPARATE
 *     value because `LIVE_FEED_COPY.dailyReauth` would be misleading here: it
 *     tells the reader the session "has to be signed in again", which for Angel
 *     One is true of the SESSION and false of the READER — nobody is asked.
 *   • `equityOnly` is byte-identical to the Upstox scope sentence on purpose.
 *     One release-scope rule, one sentence.
 *
 * NOT SAID: any refresh interval. Angel One's is tiered and derived
 * (`angelOneCadenceLine`), so a fixed number in a blurb would be a second,
 * drifting source for something the poll computes.
 */
export const ANGELONE_FEED_COPY = {
  label: "Angel One",
  blurb:
    "Uses the client code, PIN and TOTP secret saved under Import → Connect broker. Angel One clears every session at 5 AM IST; Vyuha signs in again each morning without asking you.",
  /** Shown INSTEAD of the blurb when this account has no connection saved. */
  notConnected: "Add Angel One under Import → Connect broker first.",
  /** Always, connected or not — the scope of the feed is not a footnote. */
  equityOnly:
    "Futures and options rows are not priced by this feed: each shows the position's recorded close, or its entry price when no close is recorded, and says so on the row.",
  /**
   * The highlighted block's sentence under an Angel One pick. FACTUAL and
   * attributed to the broker's own system — never to a regulator, which
   * `tests/live-feed-angelone-settings.test.ts` bans outright.
   */
  dailyReauth:
    "Angel One ends every API session at 5 AM IST. Vyuha opens the next one by itself from the client code, PIN and TOTP secret you saved — there is nothing for you to do each morning.",
} as const;

/** What the GET tells the card about the Angel One radio. Never a credential. */
export interface AngelOneFeedState {
  connected: boolean;
  ackCurrent: boolean;
  /** Open positions of the selected account, capped at 500 by the route. */
  openCount: number;
}

/**
 * The Angel One row's second line and whether the radio takes a click.
 *
 * DERIVED, never held in state (AGENTS.md), and `undefined` is the same honest
 * third case the Upstox helper carries: the card's own fetch has not answered
 * yet, so the row renders ENABLED and the route is left to refuse. Disabling a
 * control on the strength of a request that never came back locks out a user
 * whose feed is perfectly well connected.
 */
export function angelOneRowState(state: AngelOneFeedState | undefined): { disabled: boolean; line: string } {
  const known = state != null;
  const blocked = known && !state.connected;
  return {
    disabled: blocked,
    line: blocked ? ANGELONE_FEED_COPY.notConnected : ANGELONE_FEED_COPY.blurb,
  };
}

/**
 * WHAT THE CARD SAYS WHILE ITS OWN FETCH HAS NOT ANSWERED (A-7).
 *
 * The health line has always said this; the Angel One cadence line said
 * `angelOneCadenceLine(status?.angelone?.openCount ?? 0)` instead, which prints
 * "your 0 open positions take 1 call per refresh" before the mount fetch
 * answers — and for ever if it fails, because the catch swallows. A 0 where the
 * number is simply unknown is a claim about the user's book (invariant 6), so
 * both surfaces now say the same honest thing: nothing is known yet.
 */
export const FEED_CHECKING = "Checking the feed…";

/**
 * The cadence line the Angel One block renders. DERIVED, never held in state.
 *
 * `undefined` — the fetch has not answered, or it failed — is the third case,
 * exactly as it is for the two row-state helpers above. It renders the checking
 * sentence rather than an invented count.
 */
export function angelOneCadenceText(state: AngelOneFeedState | undefined): string {
  return state == null ? FEED_CHECKING : angelOneCadenceLine(state.openCount);
}

type ProviderId = "manual" | "eod" | "openalgo" | "upstox" | "angelone";

/** The provider ids whose disclosure this card can re-open a sheet for. */
const SHEET_PROVIDERS = ["upstox", "angelone"] as const;
type SheetProvider = (typeof SHEET_PROVIDERS)[number];

/** What `/api/live/feed` says about the stored pick versus the running one. */
export interface FeedState {
  stored: string;
  effective: string;
  refreshSeconds?: number;
  blockedReason?: string;
}

/**
 * A blocked feed, as a value. `null` means the stored pick IS what runs.
 *
 * A-6 — THE BLOCKED STATE HAD EXACTLY ONE RENDERER, AND IT WAS OpenAlgo'S.
 * `resolveLiveFeed()` falls back to `eod` whenever the stored provider's
 * acknowledgement is not current — a disclosure-version bump, or a backup
 * restored on another machine, where `liveFeedProvider` travels and
 * `liveFeedAckJson` does not. The route publishes `blockedReason` for every
 * provider, but the card rendered it only inside `provider === "openalgo" && …`.
 * So with Upstox stored and blocked the radio showed CHECKED (the state is
 * initialised from the stored value), the health line read "Feed OK" (it
 * describes the EFFECTIVE provider, which is end-of-day and perfectly healthy),
 * nothing said blocked — and because a checked radio fires no `onChange`, the
 * one path to the consent sheet was unreachable without first switching to
 * another provider and back.
 *
 * PURE, and keyed on `stored !== effective` rather than on a provider name, so
 * a fourth feed is covered the day it ships. `reviewProvider` is the stored
 * provider when this card owns its sheet; OpenAlgo's consent lives on the
 * Integrations screen, so it is null there and the block is text only — which
 * is the v4.1 behaviour, unchanged.
 */
export interface FeedBlock {
  reason: string;
  reviewProvider: SheetProvider | null;
}

/** Said when the feed is blocked and the server sent no sentence of its own. */
export const FEED_BLOCKED_FALLBACK =
  "The feed you picked is not running, so the desk stays on end-of-day prices.";

/** The health line under a blocked feed. It describes the PICK, not the fallback. */
export const FEED_BLOCKED_HEALTH =
  "Not live — the feed you picked is blocked, so the desk stays on end-of-day prices.";

/**
 * B-8 — THE BUTTON OFFERED A SHEET THIS BUILD MAY NOT SHIP.
 *
 * `reviewProvider` was picked from `SHEET_PROVIDERS` alone, which is the list of
 * providers that HAVE a sheet, not the list this release OFFERS. With a release
 * flag off and the withheld broker's id sitting in `liveFeedProvider` — it
 * travels in a backup envelope; the acknowledgement does not — the card grew a
 * "Review and accept" button for a feed that has no radio, opened its consent
 * sheet and recorded an acknowledgement for it. The block itself is still
 * stated (the pick really is not running, and the user is entitled to know), so
 * only the CONTROL is withheld: text, no button.
 *
 * `offeredIds` defaults to what this build ships and is injected by the tests,
 * which is the only way to see the defect while all three flags are true.
 */
export function feedBlockState(
  feed: FeedState | undefined | null,
  offeredIds?: readonly string[],
): FeedBlock | null {
  if (feed == null || feed.stored === feed.effective) return null;
  const offered = offeredIds ?? PROVIDERS.map((p) => p.id);
  const reviewProvider =
    (SHEET_PROVIDERS as readonly string[]).includes(feed.stored) && offered.includes(feed.stored)
      ? (feed.stored as SheetProvider)
      : null;
  return { reason: feed.blockedReason ?? FEED_BLOCKED_FALLBACK, reviewProvider };
}

/** The control that reaches the sheet again once a radio can no longer fire one. */
export const REVIEW_CONSENT_CTA = "Review and accept";

/**
 * The health line, DERIVED — including the case it used to get wrong.
 *
 * `health` describes the EFFECTIVE provider (the route builds it from
 * `getLiveFeedProvider()`), so under a blocked feed it is end-of-day's health
 * and it is fine: the card printed "Feed OK" over a feed the user picked and is
 * not getting. A blocked feed is stated as blocked, before anything else is
 * said about it.
 */
export function feedHealthText(args: {
  health?: { ok: boolean; latencyMs: number | null; reason: string } | null;
  blocked: boolean;
  lastLiveMarkDate?: string | null;
}): string {
  const tail = args.lastLiveMarkDate ? ` · last saved mark ${args.lastLiveMarkDate}` : "";
  if (args.blocked) return `${FEED_BLOCKED_HEALTH}${tail}`;
  const h = args.health;
  if (h == null) return `${FEED_CHECKING}${tail}`;
  if (h.ok) return `Feed OK${h.latencyMs == null ? "" : ` · ${h.latencyMs} ms`}${tail}`;
  return `Not live — ${h.reason}${tail}`;
}

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
  {
    id: "upstox",
    label: UPSTOX_FEED_COPY.label,
    blurb: UPSTOX_FEED_COPY.blurb,
  },
  {
    id: "angelone",
    label: ANGELONE_FEED_COPY.label,
    blurb: ANGELONE_FEED_COPY.blurb,
  },
];

/**
 * What this release actually offers. v4.0 rendered two radios because OpenAlgo
 * was withheld; v4.1 renders all three, and `OPENALGO_FEED_ENABLED` in
 * `lib/quotes/types.ts` is still the one line that decides, read by the route's
 * pickable set and the provider registry as well. Offering the radio is not
 * running the feed: the route re-checks the consent pair and answers 403 until
 * the disclosure is acknowledged, and a stored value the picker does not offer
 * falls back to `eod` on its own.
 *
 * v4.2 adds `upstox` AND `angelone` on the SAME pattern, each behind its own
 * constant (`UPSTOX_FEED_ENABLED`, `ANGELONE_FEED_ENABLED`). Offering either
 * radio is again not running the feed: the route answers 409 until a connection
 * is saved for this account AND that provider's disclosure has been accepted at
 * the version this build ships.
 */
export const offeredProviders = (flags: {
  openalgo: boolean;
  upstox: boolean;
  angelone: boolean;
}): typeof ALL_PROVIDERS =>
  ALL_PROVIDERS.filter(
    (p) =>
      (p.id !== "openalgo" || flags.openalgo) &&
      (p.id !== "upstox" || flags.upstox) &&
      (p.id !== "angelone" || flags.angelone),
  );

export const PROVIDERS = offeredProviders({
  openalgo: OPENALGO_FEED_ENABLED,
  upstox: UPSTOX_FEED_ENABLED,
  angelone: ANGELONE_FEED_ENABLED,
});

/** The provider ids that ARE a broker-backed feed. `manual`/`eod` are not. */
export const BROKER_FEED_IDS: readonly ProviderId[] = ["openalgo", "upstox", "angelone"];

/**
 * Is a BROKER-backed feed on offer at all in this release?
 *
 * Derived from the resolved list rather than restated, so the release flags
 * stay the one source. Two controls exist only for such a feed: the 1–5 s
 * on-screen refresh (a poll interval means nothing when the mark is yesterday's
 * close or a number the user typed) and the daily re-authentication note (a
 * broker API session is the only thing that expires daily). Rendering either in
 * v4.0 advertised a feed that release did not ship, so both were gated here —
 * and v4.1 brought them back with NO edit to the JSX below, because flipping
 * the flags moves this derived value with them.
 * `tests/live-feed-copy.test.ts` pins the gate.
 *
 * ANY BROKER, NOT JUST OpenAlgo (v4.2 seam fix). This read
 * `PROVIDERS.some((p) => p.id === "openalgo")` while OpenAlgo was the only
 * broker feed, and that spelling survived the arrival of two more: with
 * `OPENALGO_FEED_ENABLED` false and Upstox on, the Upstox radio rendered while
 * the 1–5 s slider — which the Upstox adapter really reads
 * (`lib/quotes/upstox.ts`) — vanished, and the Angel One cadence line with it,
 * since both live inside this one gate. The question the gate asks is "does
 * this release ship a broker feed at all", so it is asked of every broker id.
 */
export const brokerFeedOffered = (ids: readonly string[]): boolean =>
  ids.some((id) => (BROKER_FEED_IDS as readonly string[]).includes(id));

export const BROKER_FEED_OFFERED = brokerFeedOffered(PROVIDERS.map((p) => p.id));

/**
 * Does this build offer the provider whose sheet the card holds? (B-8.)
 *
 * The two dialogs used to mount unconditionally, so a withheld broker's
 * disclosure was one state change away from being shown — and accepted —
 * on a build that ships no radio for it. Derived from the resolved list, like
 * every other release gate on this card, so flipping a flag moves it.
 */
export const OFFERS_UPSTOX = PROVIDERS.some((p) => p.id === "upstox");
export const OFFERS_ANGELONE = PROVIDERS.some((p) => p.id === "angelone");

export interface FeedResponse {
  ok: boolean;
  feed?: { stored: string; effective: string; refreshSeconds: number; blockedReason?: string };
  openalgo?: { enabled: boolean; ackCurrent: boolean };
  upstox?: UpstoxFeedState;
  angelone?: AngelOneFeedState;
  lastLiveMarkDate?: string | null;
  health?: { ok: boolean; state: string; latencyMs: number | null; reason: string };
  message?: string;
}

/**
 * What a POST answers with. The `feed` verdict was ALREADY in the response and
 * this type simply omitted it, which is how the card came to throw it away
 * (B-4) — the route has returned `feed: await resolveLiveFeed()` from the
 * provider action since v4.1.
 */
export interface FeedPostResult {
  ok: boolean;
  message?: string;
  feed?: FeedResponse["feed"];
  upstox?: UpstoxFeedState;
  angelone?: AngelOneFeedState;
}

async function post(body: Record<string, unknown>): Promise<FeedPostResult> {
  const res = await fetch("/api/live/feed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

/**
 * B-4 — THE CARD ASKED, WAS ANSWERED, AND KEPT THE OLD ANSWER.
 *
 * `status` is filled by the mount fetch and by nothing else, and the card is
 * mounted UNKEYED in `settings-form.tsx`, so `router.refresh()` re-renders it
 * with the state it already had (DECISIONS: an initialiser does not re-run
 * after `router.refresh()`). Every derived line about the feed — the blocked
 * block, its "Review and accept" button, the "Not live — blocked" health line —
 * therefore went on saying what was true before the write: after
 * Review and accept → ack ok → store ok → "Saved.", the block stayed on screen
 * until the user reloaded the page. The v4.1 switch-away path regressed the
 * same way (a blocked OpenAlgo pick, switch to end-of-day: the eod radio checked
 * AND a block saying the pick is blocked).
 *
 * The fix is not another fetch and not an effect: the POST's own body carries
 * the server's verdict, so it is folded in. PURE, so the tests can drive it
 * with a real route response — and it folds only what the response actually
 * carried, because a missing key is "nothing new to say", not "no longer true".
 */
export function foldFeedResponse(prev: FeedResponse | null, r: FeedPostResult): FeedResponse | null {
  if (prev == null) return prev;
  return {
    ...prev,
    ...(r.feed ? { feed: r.feed } : {}),
    ...(r.upstox ? { upstox: r.upstox } : {}),
    ...(r.angelone ? { angelone: r.angelone } : {}),
  };
}

export function LiveFeedCard({ current }: { current: Settings }) {
  const router = useRouter();
  const [provider, setProvider] = React.useState<ProviderId>(
    (PROVIDERS.some((p) => p.id === current.liveFeedProvider) ? current.liveFeedProvider : "eod") as ProviderId,
  );
  const [seconds, setSeconds] = React.useState(current.liveFeedRefreshSeconds ?? 3);
  const [status, setStatus] = React.useState<FeedResponse | null>(null);
  const [pending, setPending] = React.useState(false);
  // WHICH sheet is open, not merely whether one is: two providers now have
  // their own disclosure, and a boolean would open both at once the moment a
  // third arrives. `null` is closed.
  const [consentOpen, setConsentOpen] = React.useState<null | "upstox" | "angelone">(null);

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
  // A-6: the stored pick is not the feed that runs — for ANY provider. Derived
  // at render from what the route said; `review` is the sheet this card can
  // re-open, and a const so the callback below narrows it.
  const blocked = feedBlockState(status?.feed);
  const review = blocked?.reviewProvider ?? null;

  /**
   * The click. Upstox is the one pick that can need a sheet read first, and
   * the sheet is opened INSTEAD of the write — the provider is stored only
   * after the acknowledgement is stored, so a cancelled sheet leaves both the
   * card and the database exactly as they were.
   */
  async function pick(next: ProviderId) {
    if (next === "upstox" && !(status?.upstox?.ackCurrent ?? false)) {
      setConsentOpen("upstox");
      return;
    }
    // Angel One, on the same rule and with its OWN sheet: the acknowledgement
    // is stored per provider, so reading Upstox's is not reading this one.
    if (next === "angelone" && !(status?.angelone?.ackCurrent ?? false)) {
      setConsentOpen("angelone");
      return;
    }
    await store(next);
  }

  async function store(next: ProviderId) {
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
    // B-4: the write's own answer, not the mount fetch's. `router.refresh()`
    // re-renders this card without remounting it, so nothing else will ever
    // correct `status` — the block, its button and the health line would go on
    // describing the feed as it was before this POST.
    setStatus((prev) => foldFeedResponse(prev, r));
    toast.success(r.message ?? "Saved.");
    router.refresh();
  }

  /** Accepted the Upstox sheet: record the ack, then make the pick. */
  async function acceptUpstox() {
    setPending(true);
    const r = await post({ action: "ack", provider: "upstox" });
    setPending(false);
    if (!r.ok) {
      toast.error(r.message ?? "Could not record that you read it.");
      return;
    }
    // The SERVER's own reading of both halves, not an optimistic guess — and
    // every half it answered with, not only this provider's (B-4).
    setStatus((prev) => foldFeedResponse(prev, r));
    await store("upstox");
  }

  /** Accepted the Angel One sheet: record the ack, then make the pick. */
  async function acceptAngelOne() {
    setPending(true);
    const r = await post({ action: "ack", provider: "angelone" });
    setPending(false);
    if (!r.ok) {
      toast.error(r.message ?? "Could not record that you read it.");
      return;
    }
    setStatus((prev) => foldFeedResponse(prev, r));
    await store("angelone");
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
          {PROVIDERS.map((p) => {
            // Only the broker-credential rows have a state the server has to
            // answer for; for every other row this is the blurb the list
            // already carries.
            const upstox = p.id === "upstox" ? upstoxRowState(status?.upstox) : null;
            const angelone = p.id === "angelone" ? angelOneRowState(status?.angelone) : null;
            const row = upstox ?? angelone;
            return (
              <label
                key={p.id}
                className={cn(
                  "flex items-start gap-3 rounded-md border px-3 py-2",
                  row?.disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer",
                  provider === p.id ? "border-primary bg-card-hover/60" : "border-border bg-card-hover/40",
                )}
              >
                <input
                  type="radio"
                  name="live-feed-provider"
                  className="mt-1"
                  checked={provider === p.id}
                  disabled={pending || (row?.disabled ?? false)}
                  onChange={() => void pick(p.id)}
                  data-testid={`live-feed-${p.id}`}
                />
                <span>
                  <span className="block text-sm font-medium">{p.label}</span>
                  <span className="block text-xs text-muted-foreground" data-testid={`live-feed-${p.id}-line`}>
                    {row ? row.line : p.blurb}
                  </span>
                  {p.id === "upstox" && (
                    <span className="block text-xs text-muted-foreground" data-testid="live-feed-upstox-scope">
                      {UPSTOX_FEED_COPY.equityOnly}
                    </span>
                  )}
                  {p.id === "angelone" && (
                    <span className="block text-xs text-muted-foreground" data-testid="live-feed-angelone-scope">
                      {ANGELONE_FEED_COPY.equityOnly}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>

        <p className="text-xs text-muted-foreground">{LIVE_FEED_COPY.staleness}</p>

        {/* ANGEL ONE HAS NO SLIDER (ruling 4.2-4). Its interval is derived from
            the size of this account's own book — the provider allows about one
            request a second and takes 50 symbols to a batch — so a 1–5 s
            control would offer a setting the poll overrides. The ONE line that
            replaces it states the interval AND the arithmetic behind it.
            The gate itself is untouched: the swap is a ternary INSIDE the one
            `{BROKER_FEED_OFFERED && (…)}` subtree, which is what keeps the
            slider in exactly one gated region (tests/live-feed-copy.test.ts). */}
        {BROKER_FEED_OFFERED && (
          provider === "angelone" ? (
            <div
              className="space-y-2 rounded-md border border-border bg-card-hover/40 px-3 py-2"
              data-testid="live-feed-angelone-cadence"
            >
              <Label>On-screen refresh</Label>
              {/* A-7: `?? 0` printed "your 0 open positions take 1 call per
                  refresh" before the mount fetch answered, and for ever if it
                  failed. The helper says "Checking the feed…" until the server
                  has answered, exactly as the health line does. */}
              <p className="text-xs text-muted-foreground">{angelOneCadenceText(status?.angelone)}</p>
            </div>
          ) : (
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
          )
        )}

        {/* HIGHLIGHTED, and the highlight is the point: this is the one thing
            about a broker feed that no amount of engineering removes. Gated
            with the slider above — in a release that offers no broker feed it
            would describe a session the user never opens. */}
        {BROKER_FEED_OFFERED && (
          // …and NOT while Upstox is the pick (v4.2). Its Analytics token is
          // read-only for about a year, so "your broker's API session expires
          // every day" would be a false statement sitting two lines under the
          // true one in UPSTOX_FEED_COPY.blurb. The gate itself is untouched —
          // the sentence is still defined once and rendered in exactly one
          // place, which is what tests/live-feed-copy.test.ts pins.
          // ANGEL ONE'S SESSION DOES DIE DAILY, so the block stays for it —
          // but the generic sentence says the session "has to be signed in
          // again", which is true of the session and false of the READER: the
          // 5 AM flush is answered by an unattended sign-in from the enrolled
          // TOTP secret. It therefore gets its own sentence, which states the
          // broker's own behaviour and names no regulator (banned outright by
          // tests/live-feed-angelone-settings.test.ts — no circular saying so
          // is cited anywhere in this tree).
          provider === "upstox" ? null : (
            <div className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2" data-testid="live-feed-reauth">
              <p className="flex items-start gap-2 text-xs text-warning">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {provider === "angelone" ? ANGELONE_FEED_COPY.dailyReauth : LIVE_FEED_COPY.dailyReauth}
                </span>
              </p>
            </div>
          )
        )}

        {provider === "openalgo" && (
          <p className="text-xs text-muted-foreground">
            {LIVE_FEED_COPY.local} <span className="text-warning">{LIVE_FEED_COPY.remote}</span>
          </p>
        )}

        {/* THE BLOCKED FEED (A-6). One block, for whichever provider is stored:
            the row above still shows that pick checked — it IS what is stored —
            so this is the only thing on the card that says it is not running.
            The OpenAlgo arm is untouched (its sentence and its fallback are the
            v4.1 ones, and it gets no button, because its consent is given on
            the Integrations screen); Upstox and Angel One get the control that
            re-opens their sheet, which a checked radio can no longer reach. */}
        {(blocked !== null || consentMissing) && (
          <div className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2" data-testid="live-feed-blocked">
            <p className="text-xs text-warning">
              {blocked?.reason ??
                status?.feed?.blockedReason ??
                "Turn OpenAlgo on in Integrations and read its disclosure first — until then the desk stays on end-of-day prices."}
            </p>
            {review !== null && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2"
                disabled={pending}
                onClick={() => setConsentOpen(review)}
                data-testid="live-feed-review-consent"
              >
                {REVIEW_CONSENT_CTA}
              </Button>
            )}
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
          {/* A-6: `health` is the EFFECTIVE provider's health, so under a
              blocked feed it reported end-of-day as "Feed OK" — over a feed the
              user picked and is not getting. The blocked case is stated first,
              in one derived helper the tests can drive. */}
          <span data-testid="live-feed-health">
            {feedHealthText({ health, blocked: blocked !== null, lastLiveMarkDate: status?.lastLiveMarkDate })}
          </span>
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void markNow()}>
            Save today&apos;s mark
          </Button>
        </div>

        {/* The Upstox consent sheet. The generic dialog is handed UPSTOX's own
            items — it imports no provider's disclosure module of its own, so
            there is no OpenAlgo sentence in this tree to show by accident. The
            acceptance is written by the SAME route that enforces the gate.
            MOUNTED ONLY WHILE THIS BUILD OFFERS THE RADIO (B-8): a sheet for a
            withheld provider is a disclosure the user can accept for a feed
            that does not ship, and the route now refuses that ack too. */}
        {OFFERS_UPSTOX && (
          <FeedConsentDialog
            open={consentOpen === "upstox"}
            onOpenChange={(o) => setConsentOpen(o ? "upstox" : null)}
            onAccept={() => void acceptUpstox()}
            title="Before Upstox prices your desk"
            version={LIVE_FEED_DISCLOSURE_VERSIONS.upstox}
            items={UPSTOX_FEED_ITEMS}
            testId="upstox-feed-dialog"
          />
        )}

        {/* Angel One's sheet — the SAME generic component, handed ANGEL ONE's
            items and ANGEL ONE's version. Two sheets, two acknowledgements: the
            column is a provider-id → version map, so accepting one is never
            accepting the other. */}
        {OFFERS_ANGELONE && (
          <FeedConsentDialog
            open={consentOpen === "angelone"}
            onOpenChange={(o) => setConsentOpen(o ? "angelone" : null)}
            onAccept={() => void acceptAngelOne()}
            title="Before Angel One prices your desk"
            version={LIVE_FEED_DISCLOSURE_VERSIONS.angelone}
            items={ANGELONE_FEED_ITEMS}
            testId="angelone-feed-dialog"
          />
        )}
      </CardContent>
    </Card>
  );
}
