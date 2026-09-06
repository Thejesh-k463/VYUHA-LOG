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
   * The pipe is OPEN and has carried no prices — the state "Live" used to be
   * printed over.
   *
   * `GET /api/live/stream` heartbeats every 25 s whether or not it ever
   * subscribed, and outside 09:00–15:40 it never subscribes at all, so a
   * heartbeat counted as a live frame printed `Live · openalgo · 3 s` at 21:00
   * with no poll running behind it. This says the one thing the desk knows.
   *
   * WHY NOT "outside market hours": the desk cannot tell that from "subscribed
   * and silent" without asserting an exchange calendar it does not ship
   * (`lib/live/market-hours.ts` models the clock, not holidays). It states the
   * connection and the absence, and claims nothing about why.
   */
  connected: (provider: string) => `Connected · ${provider} · no prices yet`,
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
} as const;

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
