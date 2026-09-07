// BROKER LIVE-FEED DISCLOSURES (PURE — data + the ack rules, no DB, no React).
//
// v4.2 adds the first live price feed that talks to a BROKER'S OWN SERVER
// rather than to software the user runs on their own machine. OpenAlgo's
// disclosure could truthfully say "this computer talking to itself"; this one
// cannot, so it gets its own sheet, its own version and its own acknowledgement
// — and the acknowledgement is stored PER PROVIDER, because consenting to one
// broker's feed is not consenting to the next one's.
//
// ── One column, one shape, every future provider ───────────────────────────
//
// `settings.live_feed_ack_json` (migration 0069) holds a JSON object mapping
// provider id → the disclosure version that person accepted, e.g.
// `{"upstox":"1"}`. Angel One's key was typed here before its adapter existed,
// and that is exactly what it bought: v4.2 ships the Angel One feed
// (`ANGELONE_FEED_ENABLED`, ruling 4.2-9) with a second SHEET and a second
// version and NO second migration and NO second column.
//
// ── Why a VERSION and not a boolean ────────────────────────────────────────
//
// Consent is recorded against a statement. Bump the version when the risk
// statement materially changes and every install re-prompts instead of
// inheriting an acceptance of a different statement; `isFeedAckCurrent()`
// compares with `===`, so a stored "0" — or a stored `true`, or an absent key —
// is refused with no extra code.
//
// ── Voice ─────────────────────────────────────────────────────────────────
//
// Same rule as every other user-facing sentence in this tree: state what the
// code does and what it refuses to do. Nothing here recommends, suggests or
// advises anything, and nothing here is about entering or exiting a position.
// Each sheet names EXACTLY ONE host, and it is the only host that provider's
// adapter can reach — api.upstox.com for `lib/quotes/upstox.ts`,
// apiconnect.angelone.in for `lib/quotes/angelone.ts` and its token resolver.

import type { DisclosureItem } from "./openalgo-disclosure";

export type { DisclosureItem };

/**
 * The disclosure version each broker feed's consent is recorded against.
 *
 * Angel One was listed at "1" before its adapter existed, so the sheet was
 * versioned from the day the STORAGE was. It stays "1" now the adapter ships:
 * no install could have accepted a sheet that rendered nothing, so
 * `ANGELONE_FEED_ITEMS` below is the first statement anyone can agree to, and
 * bumping the number would re-prompt nobody while pretending otherwise.
 */
export const LIVE_FEED_DISCLOSURE_VERSIONS = { upstox: "1", angelone: "1" } as const;

/** The provider ids that have (or will have) their own consent sheet. */
export type LiveFeedDisclosureId = keyof typeof LIVE_FEED_DISCLOSURE_VERSIONS;

export const LIVE_FEED_DISCLOSURE_IDS = Object.keys(
  LIVE_FEED_DISCLOSURE_VERSIONS,
) as readonly LiveFeedDisclosureId[];

/**
 * THE UPSTOX CONSENT SHEET (v4.2, disclosure version 1).
 *
 * Every sentence below is checked against the code that performs it:
 *
 *   • the host, the endpoint and the Bearer token — `snapshot()` in
 *     lib/quotes/upstox.ts, which reaches `api.upstox.com` and nothing else;
 *   • the 1–5 s cadence and its 3 s default — `clampRefreshSeconds()` shared
 *     with the OpenAlgo adapter, applied again by the SSE route;
 *   • "equity only" — `upstoxInstrumentKey()`, which returns null for any key
 *     that is not a cash-segment scrip, so no derivative key is ever sent;
 *   • "never uploads them" — there is not one write in that file and no host
 *     but Upstox's own is reachable from it.
 */
export const UPSTOX_FEED_ITEMS: DisclosureItem[] = [
  {
    title: "It sends the instrument keys of your open positions to Upstox",
    body:
      "Vyuha will send the instrument keys of your open positions to api.upstox.com to fetch last traded prices, as often as every 1 to 5 seconds while the Live Desk is open.",
  },
  {
    title: "It uses the read-only Analytics token you already saved",
    body:
      "It uses the Analytics token you saved under Import → Brokers. Upstox makes that token read-only for about a year — it cannot place, change or cancel an order, and Vyuha never asks for one that can.",
  },
  {
    title: "Equity positions only in this release",
    body:
      "Only equity positions are priced by this feed in this release. Futures and options rows keep their last stored mark and say so.",
  },
  {
    title: "The prices stay on this machine",
    body:
      "Prices are shown to you, on this machine. Vyuha never uploads them, never sends them anywhere, and never resells market data.",
  },
  {
    title: "A poll is not a tick stream",
    body:
      "Vyuha asks for the last traded price on an interval instead of receiving a live stream of ticks, so a price on screen can be up to one interval old. It is labelled delayed for that reason, never live, and outside market hours Upstox answers with the previous session's last traded price.",
  },
];

/**
 * THE ANGEL ONE CONSENT SHEET (v4.2, disclosure version 1).
 *
 * The sheet that has to say the hard thing. Upstox could truthfully offer a
 * read-only token; Angel One has no such thing, and the honest disclosure is
 * not "your credentials are safe" but "the same session could place an order,
 * and here is the mechanical reason ours never will".
 *
 * Every sentence below is checked against the code that performs it:
 *
 *   • the daily sign-in and the 05:00 IST flush —
 *     `angelOneSessionExpiresAt()` in lib/quotes/angelone.ts, which caches the
 *     jwt in memory to exactly that instant and to nothing the token claims;
 *   • the host, the 50-token batch and the one-request-a-second ceiling —
 *     `planAngelOneBatches()` and the rate guard in the same file, which reach
 *     apiconnect.angelone.in and nothing else;
 *   • "3, 5 or 10 seconds … and the desk says which" —
 *     `angelOneCadenceSeconds()` in lib/quotes/types.ts, the SAME function the
 *     Live Desk renders its line from, so the sentence cannot drift from the
 *     timer;
 *   • "contains no order call at all and a test refuses to let one be added" —
 *     tests/angelone-api.test.ts greps both quote sources for order paths;
 *   • the token lookup "on the same host" — `angelSearchScrip()` in
 *     lib/quotes/angelone-tokens.ts, built from the same BASE, cached in
 *     `angelone_instrument_tokens` (migration 0070) and never a scrip-master
 *     download from a second host;
 *   • "equity only" — `angelCashKey()`, which returns null for any key that is
 *     not a cash-segment scrip, so no derivative token is ever sent;
 *   • "never uploads them" — there is no journal write in either file and no
 *     host but Angel One's own is reachable from them.
 */
export const ANGELONE_FEED_ITEMS: DisclosureItem[] = [
  {
    title: "It signs in to your Angel One account once each trading day",
    body:
      "Vyuha signs in to apiconnect.angelone.in once each trading day with the client code, PIN and TOTP secret you saved under Import → Brokers. Angel One clears every session at 5 AM IST, so this happens each morning without asking you.",
  },
  {
    title: "It sends the tokens of your open positions to fetch prices",
    body:
      "It then sends the tokens of your open positions to apiconnect.angelone.in to fetch prices, in batches of 50, no more than once a second — every 3, 5 or 10 seconds depending on how many positions you hold, and the desk says which.",
  },
  {
    title: "Angel One offers no read-only key, so the code carries the limit",
    body:
      "Angel One offers no read-only key. The same session that reads prices could in principle place an order, so Vyuha's Angel One code contains no order call at all and a test refuses to let one be added.",
  },
  {
    title: "It looks up each symbol's token once, and keeps it here",
    body:
      "It looks up each symbol's Angel One token once, on the same host, and keeps that mapping on this machine.",
  },
  {
    title: "This feed prices your equity positions and nothing else",
    body:
      "Only equity positions are priced by this feed in this release. Futures and options rows keep their last stored mark and say so.",
  },
  {
    title: "The prices Angel One returns stay on this machine",
    body:
      "Prices are shown to you, on this machine. Vyuha never uploads them, never sends them anywhere, and never resells market data.",
  },
  {
    title: "Angel One is polled on a timer, not streamed",
    body:
      "Vyuha asks for the price on an interval instead of receiving a live stream of ticks, so a price on screen can be up to one interval old. It is labelled delayed for that reason, never live, and outside market hours Angel One answers with the previous session's prices.",
  },
];

/* ─────────────────────────── the stored acknowledgement ─────────────────── */

/**
 * PURE. `settings.live_feed_ack_json` → the provider-id → version map it holds.
 *
 * ANY unusable value is an EMPTY map, never a throw and never a partial read:
 * null, invalid JSON, an array, a scalar, or an object whose values are not
 * strings. The direction of that error is deliberate — an unreadable consent is
 * no consent, so the gate closes and the user is asked again, which costs one
 * dialog. Treating it as consent would open a feed on a statement nobody can
 * prove was shown.
 */
export function parseFeedAcks(json: string | null | undefined): Record<string, string> {
  if (typeof json !== "string" || json.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * PURE. True only when the stored acknowledgement is the CURRENT version of
 * THAT provider's sheet.
 *
 * Strict `===` against the version string: "1" passes, "0" does not, and
 * neither does `null`, an absent key, a `true` written by some future careless
 * writer, or a version this build has never heard of.
 */
export function isFeedAckCurrent(json: string | null | undefined, id: LiveFeedDisclosureId): boolean {
  return parseFeedAcks(json)[id] === LIVE_FEED_DISCLOSURE_VERSIONS[id];
}

/**
 * PURE. The column's next value once `id`'s current disclosure is accepted.
 *
 * Merges rather than replaces: accepting Upstox's sheet must not withdraw an
 * Angel One acceptance the same person made earlier. An unreadable existing
 * value is dropped (see `parseFeedAcks`) instead of being preserved as garbage.
 */
export function withFeedAck(json: string | null | undefined, id: LiveFeedDisclosureId): string {
  return JSON.stringify({ ...parseFeedAcks(json), [id]: LIVE_FEED_DISCLOSURE_VERSIONS[id] });
}
