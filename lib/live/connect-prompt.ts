/**
 * The once-a-day "connect your feed" prompt on the Live Desk (owner answer Q24)
 * — PURE: which day it belongs to, whether it has been dismissed, and whether
 * it may show at all.
 *
 * WHY IT EXISTS. Q24 asked for the prompt ON THE DESK, once a day. What shipped
 * put `LIVE_FEED_COPY.connect` on the Settings card only, where it renders
 * every time the feed is unhealthy and carries no day-keyed state at all — so a
 * user who never opens Settings was never prompted, and a user who does was
 * prompted on every visit. Both halves of the ruling ("on the desk", "once a
 * day") live here.
 *
 * WHY THE DAY IS AN ARGUMENT. `Date.now()` inside a client component is a
 * hydration mismatch waiting to happen, and the IST day is already computed
 * once per render on the server (`LiveDeskData.today`, `todayIstIso()`). The
 * desk passes that string in; nothing in this file reads a clock, so the same
 * inputs give the same answer on any machine at any hour.
 *
 * STORAGE. One `localStorage` key PER IST DAY, through
 * `components/layout/use-stored-value.ts` — so "dismissed" expires by itself at
 * the IST midnight boundary without any sweeping, and the versioned envelope
 * `{v:1,…}` is the project's convention for stored JSON.
 */

/** Envelope version. A stored value of any other shape reads as NOT dismissed. */
export const CONNECT_PROMPT_VERSION = 1;

/** `vyuha-` kebab-case, one key per IST day (project convention). */
export function connectPromptKey(istDay: string): string {
  return `vyuha-live-connect-prompt:${istDay}`;
}

/** What `writeStored` puts in that key when the user dismisses the banner. */
export function connectPromptDismissal(): string {
  return JSON.stringify({ v: CONNECT_PROMPT_VERSION, dismissed: true });
}

/**
 * Was the banner dismissed for this day?
 *
 * A missing, unparseable or wrong-version value reads FALSE — the prompt shows.
 * Being shown a 20-second prompt once more is the cheap failure; suppressing it
 * for ever on a corrupt string is the expensive one.
 */
export function isConnectPromptDismissed(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const v = JSON.parse(raw) as { v?: unknown; dismissed?: unknown };
    return v?.v === CONNECT_PROMPT_VERSION && v?.dismissed === true;
  } catch {
    return false;
  }
}

/** The feed facts the decision needs — the subset of `FeedInfo` this reads. */
export interface ConnectPromptFeed {
  providerId: string;
  /** `health.state` as the provider reported it; null when it reports none. */
  healthState: string | null;
}

/**
 * The providers whose prompt has somewhere to send the user.
 *
 * `openalgo` and, since v4.2, `upstox` and `angelone` — each is a connection
 * the user makes and can remake, so the prompt has somewhere to send them.
 * `eod` and `manual` have no feed to connect; a provider that is merely PLANNED
 * (`lib/quotes/registry.ts`) cannot be selected at all. The ids are compared as
 * STRINGS so this file stays independent of the day `ProviderId` gains its next
 * member.
 *
 * ANGEL ONE BELONGS HERE EVEN THOUGH ITS DAILY SIGN-IN IS UNATTENDED. The two
 * states that open this prompt are `no-key` (nothing saved for this account)
 * and `unreachable` — and both are fixed by the user going to Import → Brokers,
 * not by waiting for the next morning's automatic sign-in.
 */
export const CONNECTABLE_PROVIDER_IDS: readonly string[] = ["openalgo", "upstox", "angelone"];

/**
 * May the prompt show right now?
 *
 * ONLY for a feed the user chose AND can reconnect, and ONLY for the two states
 * a re-connection actually fixes:
 *   `no-key`       consent is in place but no connection is saved;
 *   `unreachable`  the bridge is saved but is not answering (the daily
 *                  broker sign-in is the common cause).
 * `disabled` is deliberately excluded — the integration is off, and prompting
 * someone to connect a feed they switched off is nagging, not helping. `ok`
 * needs no prompt at all.
 */
export function showConnectPrompt(feed: ConnectPromptFeed, storedRaw: string | null | undefined): boolean {
  if (!CONNECTABLE_PROVIDER_IDS.includes(feed.providerId)) return false;
  if (feed.healthState !== "no-key" && feed.healthState !== "unreachable") return false;
  return !isConnectPromptDismissed(storedRaw);
}
