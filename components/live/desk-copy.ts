/**
 * Every standing string the Live Desk prints, in one place.
 *
 * WHY A MODULE: `tests/live-tracker-copy.test.ts` scans this folder for the
 * banned vocabulary (owner ruling Q31 / Q32 — describe the arithmetic, never
 * prompt a transaction). Copy that lives in one exported object can also be
 * asserted BY VALUE, which is what pins the disclaimer to the screen rather
 * than to a comment.
 *
 * TONE (Q31): (b) — "Stop ₹2,600 — from your 2% risk and the 21-day ATR" — as
 * the label; (a), the fuller arithmetic sentence, in the detail pane. (c),
 * naming a security and prompting an action, must never ship.
 *
 * EMPTY STATES: "— needs N sessions" and never 0 (invariant 6). A 0 where a
 * denominator is missing is a claim about the user's book Vyuha is not
 * entitled to make.
 */

import { angelOneCadenceSeconds } from "@/lib/quotes/types";

/** The em dash every un-computable figure renders. Never a 0, never "N/A". */
export const EM_DASH = "—";

export const DESK_COPY = {
  title: "Live Desk",
  description: "Your open positions, the levels you recorded, and the arithmetic between them.",

  /** Standing, visible, never folded away. Both sentences ship together. */
  disclaimer:
    "Vyuha is a record-keeping and calculation tool. Nothing here is investment advice or a recommendation. Prices are shown for your own reference — verify with your broker before acting.",
  disclaimerShort: "Vyuha computes; it does not advise.",

  fillsCaveat:
    "Stops are not guaranteed fills — gaps, circuits and illiquidity can execute worse than the level shown.",
  chargesCaveat: "Figures exclude brokerage and statutory charges unless the charges toggle is on.",

  /** Q33: with no risk percentage there is no stop, and the row routes here. */
  riskNotSet: "Position size needs your risk per trade. Open the Sizing Lab.",
  riskNotSetCta: "Open the Sizing Lab",

  emptyBook: "No open positions in this view.",
  emptyFilter: "No open position matches this filter.",

  marketOpen: "Market open",
  marketClosed: "Market closed",
  marketClock: "IST",

  noMark: "No mark stored for this position yet.",
  staleMark: "Older than the newest mark on this desk.",

  /**
   * Q-9. The instrument's results date, as a distance. It is a DATE FACT about
   * the company — the same kind of thing as the symbol — so it is FREE, not
   * Pro, and it is the whole of what the desk says: no sentence follows it,
   * ever. `resultsChip` below is the only string that renders it.
   */
  resultsMissing: "No results date recorded for this instrument.",
  /**
   * A recorded date that has gone by. The date stays on the record — the user
   * typed it — but the desk stops counting: "4 days ago" would invite a
   * conclusion about a print Vyuha has never seen and does not store.
   */
  resultsPast: "That date has passed.",

  heatTitle: "Portfolio heat",
  heatNoCapital: "Capital is not set, so heat has no denominator.",
  heatNoStop: (n: number) => `${n} of these rows carry no stop, and are excluded from heat.`,
  concentrationTitle: "Exposure by sector",
  concentrationEmpty: "This book has no exposure to divide.",
  rotationCaveat: "Current classification, not point-in-time.",

  keyboardHelp: "j / k move · Enter expands · L opens the Sizing Lab · / filters · Esc returns to the table",

  /**
   * Q55, and nothing beyond it. The word "alerts" is deliberately ABSENT: no
   * alert code exists under `lib/live` or `components/live` and Telegram alerts
   * ship after v4.2 (Q18, 2026-09-06). A Pro label naming a capability this build does not have sells
   * something the buyer cannot receive.
   */
  proColumns: "Pro — R, risk at stop, portfolio heat and the chart overlay.",
} as const;

/**
 * The live stream's connection state, in the feed strip (FW-1).
 *
 * WHY IT IS SAID AT ALL. `GET /api/live/stream` shipped in v4.0 and nothing
 * consumed it, so the desk's prices moved only on a server render while the
 * disclosure, PRIVACY and the Settings slider all described a 1–5 s refresh
 * "while the Live Desk is open". Now that the desk really holds the stream, the
 * user has to be able to see whether it is holding it — a price that stopped
 * moving and a market that stopped moving look identical.
 *
 * Every string states the pipe, never the prices: "Live" is a claim about the
 * CONNECTION, and the staleness of each mark keeps being said per row by
 * `stalenessLabel()` ("Delayed" for a polled LTP, "Last traded" for a push).
 * Nothing here upgrades a delayed print into a tick.
 */
export const LIVE_STREAM_COPY = {
  /** `<provider> · 3 s` — the age of the last frame, on the 30 s desk clock. */
  live: (provider: string, seconds: number) => `Live · ${provider} · ${seconds} s`,
  /**
   * The pipe is OPEN and NOTHING IS STREAMING DOWN IT — the state "Live" used
   * to be printed over.
   *
   * `GET /api/live/stream` heartbeats every 25 s whether or not it ever
   * subscribed, and outside 09:00–15:40 it never subscribes at all, so a
   * heartbeat counted as a live frame printed `Live · openalgo · 3 s` at 21:00
   * with no poll running behind it. This says the one thing the desk knows.
   *
   * IT STATES THE ABSENCE OF A STREAM, NOT THE ABSENCE OF PRICES. It read
   * "no prices yet" until the fix wave, and that was false on the ordinary
   * evening: the route snapshots unconditionally, so outside the live window
   * it ships the bridge's last prints beside `marketOpen: false`, and
   * `stream-link.ts` hands those quotes to the rows BEFORE it decides the
   * phase. The strip therefore said "no prices yet" beside the prices that
   * very frame had just delivered. What is missing is the SUBSCRIPTION.
   *
   * WHY NO REASON IS CLAIMED (A-13 — this paragraph used to say the app ships no
   * exchange calendar, which stopped being true in v4.2). It DOES ship one:
   * `lib/data/nse-holidays.json`, read by `lib/live/market-hours.ts` through
   * `isTradingDayIst()`, so "today is a listed holiday" is a fact the app can
   * state. The reason is still not claimed here, and the reason for THAT is the
   * remaining one: this string is a statement about the CONNECTION, and the
   * desk cannot tell "the exchange is shut" from "subscribed and silent" —
   * a bridge that is connected and quiet on a trading afternoon prints exactly
   * the same frame as one on Republic Day. Naming the holiday here would
   * therefore explain a silence on the days it happened to coincide with and
   * mis-explain it on every other. The holiday, when there is one, belongs to
   * the market clock beside "Market closed", not to the pipe's own label.
   */
  connected: (provider: string) => `Connected · ${provider} · not streaming`,
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  /** The provider's own sentence follows; it is never rewritten here. */
  stopped: (reason: string) => `Feed stopped — ${reason}`,
  /** Used when the pipe closed without the provider saying why. */
  stoppedNoReason: "the connection closed.",
  /**
   * A hidden tab holds no stream. The disclosure promises the feed stops when
   * the desk closes; stopping when the tab goes to the background is stricter
   * than that promise, and saying so is what stops it reading as a fault.
   */
  paused: "Feed paused while this tab is in the background.",
  /**
   * What the desk's ONE polite live region says, per link phase.
   *
   * It exists because `aria-live` used to sit on every Mark `<td>`: with the
   * stream really connected that is one announcement per row per tick, and a
   * 40-row desk becomes a screen reader that never stops talking. The
   * transitions of the CONNECTION are the events worth interrupting for, so
   * these carry no price, no provider and no number — nothing that changes
   * while the state has not.
   *
   * `idle` is deliberately empty: "Connecting…" is already on screen, and an
   * announcement for the state a page mounts in is noise on every navigation.
   */
  announce: {
    idle: "",
    connected: "Feed connected.",
    live: "Feed connected.",
    reconnecting: "Feed reconnecting.",
    paused: "Feed paused.",
    stopped: "Feed stopped.",
  },
} as const;

/**
 * The once-a-day connect prompt on the desk (owner answer Q24).
 *
 * THE TWO SENTENCES ARE NOT HERE. `LIVE_FEED_COPY.connect` and
 * `LIVE_FEED_COPY.dailyReauth` are imported by `tracker-client.tsx` from
 * `components/settings/live-feed-card.tsx`, which is their ONE source and where
 * `tests/live-feed-copy.test.ts` pins them verbatim — including the ruling that
 * the daily re-sign-in is attributed to the user's broker and names no
 * regulator. Restating either one here would be a second copy to drift.
 *
 * What lives here is the banner's own chrome, which the Settings card has no
 * equivalent of.
 */
export const CONNECT_PROMPT_COPY = {
  /** Said under the headline, before the provider's own reason. */
  body: "Start your OpenAlgo instance, sign in to your broker there, then come back. Vyuha never holds the broker credential — OpenAlgo does.",
  dismiss: "Not now",
  /** Screen-reader name for the region; the headline is the visible title. */
  label: "Connect your price feed",
  /** Stated on the button, because the dismissal really is only for today. */
  dismissTitle: "Hide this until tomorrow",
  /**
   * UPSTOX (v4.2, ruling 4.2-8). A DIFFERENT headline, and deliberately not
   * `LIVE_FEED_COPY.connect` — that sentence ends "20 seconds", which is the
   * honest measure of the OpenAlgo flow (open the bridge, sign in, come back)
   * and NOT of this one: an Upstox Analytics token is generated in a browser
   * visit to the broker. The prompt therefore says where the token already
   * lives instead of promising a duration nobody measured.
   *
   * It names the Import screen because that is where the token is saved
   * (`components/import/broker-connect.tsx`, rendered by `app/import/page.tsx`)
   * — the same screen the feed reads it from, so the breadcrumb names a place
   * that exists and a step that is really the next one.
   */
  upstoxHeadline: "Connect your feed — Upstox uses the Analytics token saved under Import → Connect broker.",
  upstoxCta: "Open Import",
  upstoxHref: "/import",
  /**
   * ANGEL ONE (v4.2). The same shape as the Upstox pair and for the same
   * reason: the credential already exists somewhere, and the prompt's job is to
   * name that place rather than to promise a duration.
   *
   * It names the three things Angel One's session is built from — the client
   * code, the PIN and the TOTP secret — because that is exactly what
   * Import → Connect broker holds for it, and because the sign-in Vyuha performs each
   * morning is performed FROM those three. No duration is promised: there is
   * nothing for the user to time, since the daily sign-in is unattended.
   */
  angeloneHeadline:
    "Connect your feed — Angel One uses the client code, PIN and TOTP secret saved under Import → Connect broker.",
  angeloneCta: "Open Import",
  angeloneHref: "/import",
} as const;

/**
 * Ruling 4.2-8 — the DERIVATIVE mark label, printed beside the row's last
 * stored mark in the same cell as the staleness pill.
 *
 * WHAT IT SAYS AND WHY IT IS SAFE: the Upstox and Angel One feeds price cash
 * scrips only (`showsNotPricedByFeed` below names both), so
 * a futures or options row on this desk is showing whatever is already in
 * `mtm_prices` — an imported close or a mark the user typed — and NOT a price
 * from the feed the strip names. The sentence states that fact and stops. No
 * instruction follows it, nothing is recommended, and no alternative feed is
 * named: it is the same discipline as `stalenessLabel()`, which says where a
 * number came from and never what to do about it.
 */
export const NOT_PRICED_BY_FEED = "Not priced by this feed";

/**
 * Does THIS row, under THIS feed, carry that label?
 *
 * PURE, and keyed on the provider STRING rather than on a capability flag, so
 * it cannot silently start labelling rows for a provider that does quote
 * contracts. `instrumentType` is the journal's own `equity | option | future`
 * (`lib/domain/constants.ts`); a null — a row whose type was never recorded —
 * is NOT labelled, because the label would then be a claim about an instrument
 * nobody has classified.
 */
export function showsNotPricedByFeed(providerId: string, instrumentType: string | null): boolean {
  // v4.2 adds `angelone` on exactly the same footing: its adapter prices cash
  // scrips only, so a futures or options row under it is showing a stored
  // number too. Listed as VALUES rather than read off a capability flag, for
  // the reason in the header — a provider that does quote contracts must not
  // start labelling rows because it happens to share a flag.
  if (providerId !== "upstox" && providerId !== "angelone") return false;
  return instrumentType === "option" || instrumentType === "future";
}

/* ─────────────────────── the Angel One cadence line ──────────────────────── */

/**
 * ANGEL ONE'S REFRESH IS TIERED, NOT CHOSEN (ruling 4.2-4), and the ONE
 * sentence that says so lives here.
 *
 * WHY THERE IS NO SLIDER. Angel One's market-data endpoint allows about one
 * request a second and takes at most 50 symbols in a batch, so the interval is
 * not a preference — it is arithmetic over the size of the user's own book. A
 * 1–5 s slider under this feed would offer a setting the provider overrides,
 * which is worse than no setting at all. The desk and the Settings card
 * therefore print the SAME derived sentence in place of the control.
 *
 * WHY THE SENTENCE IS SHARED. `components/settings/live-feed-card.tsx` imports
 * it from here rather than restating it. Two surfaces inventing their own
 * phrasing for one cadence is how `/funds` ended up stated four different ways,
 * three of them wrong (see the G2 block in tests/live-feed-copy.test.ts).
 *
 * VOICE: it states the interval, the provider's own limit, and the arithmetic
 * between them. Nothing is recommended, nothing is prompted, and no number here
 * is a price.
 */

/** The most open positions this feed prices — the desk's own cap (MAX_KEYS). */
export const ANGELONE_MAX_PRICED_POSITIONS = 500;

/** Symbols per SmartAPI market-data call; the batch the tiers are built on. */
export const ANGELONE_BATCH_SIZE = 50;

/** The book as the poll sees it: whole, non-negative, and capped at 500. */
export function angelOnePricedCount(openCount: number): number {
  if (!Number.isFinite(openCount)) return 0;
  return Math.min(Math.max(0, Math.trunc(openCount)), ANGELONE_MAX_PRICED_POSITIONS);
}

/** Calls per refresh: 50 symbols to a batch, and never fewer than one. */
export function angelOneRefreshCalls(openCount: number): number {
  return Math.max(1, Math.ceil(angelOnePricedCount(openCount) / ANGELONE_BATCH_SIZE));
}

/**
 * WHAT THE SENTENCE SAYS WHEN NOBODY HAS STATED A COUNT (A-5).
 *
 * The interval is arithmetic over the number of KEYS the poll batches, so with
 * no count there is no interval to state either — and inventing one, or
 * printing the count as 0, would be a claim about this account's book that the
 * screen has not been told (invariant 6: never fabricate a denominator). It
 * states the provider's own limit and where the interval comes from, and stops.
 *
 * AND IT COUNTS THE SAME THING THE COUNTED SENTENCE COUNTS (B-6, v4.2 fix wave
 * 2). Every count that reaches `angelOneCadenceLine()` below is the DEDUPED
 * quote-key count, which is why that sentence says "open scrips"; this branch
 * said the interval was computed from "the positions this feed prices", naming
 * a different set of the user's book on the same card. Two positions in one
 * scrip are one price and one step of the ladder — so the noun is "scrips".
 */
export const ANGELONE_CADENCE_NO_COUNT =
  `Refreshes on an interval computed from the scrips this feed prices — Angel One allows about one request a second, and takes ${ANGELONE_BATCH_SIZE} symbols to a batch.` as const;

/**
 * The line itself. `angelOneCadenceSeconds()` is the ONE source of the tier
 * (lib/quotes/types.ts) — the copy never re-derives it, so the sentence and the
 * poll can never disagree about the interval.
 *
 * `null` is the honest third case (A-5): the surface has no count yet — the
 * Settings card's own fetch has not answered, or the desk holds neither a
 * stream frame nor a server snapshot. It prints the countless sentence above
 * rather than a number nobody sent.
 *
 * THE NOUN IS "SCRIP", NOT "POSITION" (B-6, ruling of 2026-09-07). Every count
 * that reaches this sentence is the DEDUPED quote-key count — `openPositionKeys()`
 * on the card, the stream's own `symbols` on the desk — while the desk lists one
 * row per TRADE. A 51-row book in 50 scrips therefore printed "your 50 open
 * positions take 1 call" beside 51 rows, which is a wrong statement about the
 * user's book (invariant 6), not merely an awkward one. The batch limit is per
 * scrip, so the sentence counts scrips and says so.
 */
export function angelOneCadenceLine(openCount: number | null): string {
  if (openCount === null) return ANGELONE_CADENCE_NO_COUNT;
  const count = angelOnePricedCount(openCount);
  const seconds = angelOneCadenceSeconds(count);
  const calls = angelOneRefreshCalls(count);
  const scrips = count === 1 ? "scrip takes" : "scrips take";
  const requests = calls === 1 ? "call" : "calls";
  return `Refreshes every ${seconds} seconds — Angel One allows about one request a second, and your ${count} open ${scrips} ${calls} ${requests} per refresh.`;
}

/**
 * THE DESK'S CADENCE LINE, AND THE COUNT IT IS ALLOWED TO USE (A-5).
 *
 * THE DEFECT THIS REPLACES. `tracker-client.tsx` printed
 * `angelOneCadenceLine(rows.length)` — one row per open TRADE — while the
 * adapter paces on the DEDUPED quote-key count (`quoteKeyId`, two trades in one
 * scrip = 2 rows and 1 key) and the Settings card states
 * `openPositionKeys().length`. A 51-row / 50-key book therefore read "every 5
 * seconds … 2 calls" on the desk beside a poll running at 3 s and one call, and
 * beside a Settings card saying 3 s. Ruling 4.2-4 is one sentence on both
 * surfaces; two different denominators cannot produce one sentence.
 *
 * THE ORDER, and why. The LIVE frame's count first: `symbols` on the snapshot
 * frame is the very set the route handed the provider for THIS connection, so
 * it is the only number that is true of the poll now running. The SSR
 * snapshot's count second (`FeedInfo.symbolCount`) — the same deduped
 * arithmetic, one page render older. Neither, and the sentence is printed
 * WITHOUT a count: the row count is not a fallback, it is the wrong number.
 */
export function deskAngelOneCadence(args: {
  providerId: string;
  /** `LinkState.symbolCount` — the open stream's own snapshot frame. */
  linkSymbolCount: number | null;
  /** `FeedInfo.symbolCount` — the server render's snapshot, or null. */
  feedSymbolCount: number | null;
}): string | null {
  if (args.providerId !== "angelone") return null;
  return angelOneCadenceLine(args.linkSymbolCount ?? args.feedSymbolCount ?? null);
}

/** "— needs 21 sessions. You have 8." The shortfall is always stated. */
export function needsSessions(need: number, have: number): string {
  return `${EM_DASH} needs ${need} sessions. You have ${have}.`;
}

/** The same shape for a gate that is structural rather than a shortfall. */
export function needsData(what: string): string {
  return `${EM_DASH} needs ${what}.`;
}

/** Q31 (b): the level, its source and its distance — no instruction follows. */
export function stopLabel(level: string, source: string, distance: string): string {
  return `Stop ${level} — ${source}. ${distance} away.`;
}

/**
 * Q-9: the results chip. A noun phrase and a number of days, full stop.
 *
 * `days` comes from `daysToResults()`, which returns null for an absent or PAST
 * date — so this function is only ever called with 0 or more and never prints
 * "N days ago". "Results today" and "Results tomorrow" are spelled out because
 * "Results in 0 days" reads as a rounding artefact rather than as today.
 */
export function resultsChip(days: number): string {
  if (days === 0) return "Results today";
  if (days === 1) return "Results tomorrow";
  return `Results in ${days} days`;
}

/**
 * The locked-in half of `portfolioHeat` (lib/live/heat.ts), which computed it
 * from v4.0 and never printed it.
 *
 * WHY IT IS SAID AT ALL: heat counts each row's risk as `max(riskAtStopP, 0)`,
 * so a row whose stop has trailed beyond entry contributes nothing to heat. The
 * money it would return is real and was being dropped off the screen. It is
 * stated on its own line rather than netted off the heat figure — the two are
 * opposite sides of the strip, and one must never cancel the other.
 *
 * WHY THIS WORDING: "computed" and "if every stop is hit" are the whole claim.
 * The word never used here is any that implies the money is already the user's
 * — a stop is not a fill (`fillsCaveat`), and calling this "protected" or
 * "banked" would assert an execution nobody has had.
 */
export function lockedInAtStop(amount: string): string {
  return `Locked in at stop ${amount} — computed from the rows whose stop already sits beyond entry, if every stop is hit.`;
}

/** Q31 (a): the detail-pane sentence. States the arithmetic and its inputs. */
export function riskAtStopSentence(level: string, loss: string, ofCapital: string | null): string {
  const tail = ofCapital ? `, which is ${ofCapital} of the capital you recorded` : "";
  return `If the stop is hit at ${level}, the computed loss is ${loss}${tail}, before charges.`;
}

/**
 * The staleness pill. `asOf` is when the price was TRUE AT THE SOURCE.
 *
 * "manual" reads "Stored mark", not "Manual mark". The mark came out of
 * `mtm_prices`, which has no source column, and `persist-mark.ts` writes FEED
 * marks into the same table the manual MTM editor writes to. Calling every one
 * of them manual tells the user they typed a number the feed may have written —
 * a claim about provenance the desk cannot support (invariant 6 in spirit: say
 * what is known, which is that it came from the store).
 */
export function stalenessLabel(staleness: string | null, asOf: string | null): string {
  if (staleness === null) return DESK_COPY.noMark;
  const when = asOf ? ` · ${asOf}` : "";
  if (staleness === "eod") return `End of day${when}`;
  if (staleness === "manual") return `Stored mark${when}`;
  if (staleness === "delayed") return `Delayed${when}`;
  return `Last traded${when}`;
}
