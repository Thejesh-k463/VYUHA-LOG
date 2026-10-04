// TELEGRAM DISCLOSURE (PURE — data + one gate rule, no DB, no React).
//
// The Telegram EOD digest is the first thing in Vyuha that sends the user's
// own trading numbers OFF this machine to a third party's servers. That is a
// bigger step than any import path, so it is off until the user reads what it
// costs and accepts explicitly — the exact posture, structure and versioning
// of lib/domain/openalgo-disclosure.ts, which is the house pattern:
//
//   1. The Settings card, the consent dialog and the server-side gate all read
//      the SAME sentences — copy written twice drifts.
//   2. The SERVER applies the same gate the UI applies (`telegramGate`), so
//      hiding a button is never the only thing between an unread disclosure
//      and a stored bot token or a sent message.
//   3. Consent is recorded against a VERSION (an integer here). If the risks
//      materially change, bump `TELEGRAM_DISCLOSURE.version` and every install
//      re-prompts instead of inheriting an acceptance of an older statement.
//
// Voice rule: state the refusals as design. Nothing here may promise delivery
// Telegram cannot guarantee.

export interface TelegramDisclosureItem {
  title: string;
  body: string;
}

/**
 * ONE exported const (owner decision #6). Bump `version` ONLY when the risk
 * statement materially changes — a typo fix is not a new disclosure, a new
 * risk is. Bumping re-prompts every install that accepted an older version,
 * and until they accept, the gate is closed.
 *
 * v3.6 is UNRELEASED, so no user has ever acknowledged this v1 copy — until
 * v3.6 ships, the copy may be edited freely without a bump. The FIRST copy
 * change AFTER the v3.6 release must bump `version`.
 *
 * 1 → 2 (v4.7.0 wave C5, ruling Q18 + owner answers TG1–TG6, DECISIONS
 * 2026-10-04). A NEW RISK, so a new number: v1 described one end-of-day digest
 * of recorded numbers; v2 adds a second, separately-switched path — Pro
 * stop/target alerts — that during market hours asks the user's own live feed
 * for prices about once a minute while Vyuha is open (minimised included, TG2),
 * checks every account's open positions (TG3) and sends a market price, a
 * recorded level, a check time, the feed's name and, with more than one account,
 * an ACCOUNT NAME to Telegram. None of that was in the statement a v1 install
 * accepted. `isTelegramAckCurrent()` compares with `===`, so a stored 1 closes
 * the gate for BOTH paths until the user re-reads — the digest included, which
 * is why the root layout carries a re-consent strip (TG6, design D13).
 * Every alert sentence below describes the C5 design's job
 * (`lib/jobs/telegram-alerts.ts`, `lib/telegram/alert-plan.ts`,
 * `lib/telegram/format.ts`): the cap of 20 then one summary line (Q18-i), one
 * alert per trade × kind × IST day (Q18-d), the quiet window per position's own
 * market from `lib/domain/market-calendar.ts` (TG4), no quantity / no rupees (TG5).
 * "checked" and never "as of": the adapters stamp receipt time, not source time
 * (design review R2).
 */
export const TELEGRAM_DISCLOSURE = {
  version: 2,
  title: "Before you turn on the Telegram digest or stop/target alerts",
  intro:
    "Vyuha can send you one end-of-day digest of your own recorded numbers through a Telegram bot YOU create — and, only if you also turn them on (Pro), stop/target alerts during market hours. Read what each costs before turning it on.",
  risks: [
    {
      title: "Your trading numbers leave this machine",
      body:
        "The digest, and every alert if you turn alerts on, transits Telegram's servers and is stored in your chat history there, under Telegram's own security and retention — not Vyuha's. Anyone with access to that chat, or to your bot's token, can read every message.",
    },
    {
      title: "Stop/target alerts ask your live feed for prices, about once a minute",
      body:
        "Only if you turn them on (Pro): during market hours — each position only while its own market is trading, never in the pre-open — and about once a minute while Vyuha is open, minimised included (more often while the Live Desk itself is open), Vyuha asks the live feed you chose in Settings → Live feed for the prices of your open positions, in every account, and checks them against the stops, trailing stops and targets you recorded. The end-of-day feed gives no alerts, and commodity and currency positions are never checked. Each alert carries the symbol, the price it was checked at, the recorded level, the time of the check in IST, the feed's name and, when you have more than one account, the account's name — never a quantity and never a rupee figure. At most 20 alerts a day, then one summary line for the rest; one alert per trade per kind per day.",
    },
    {
      title: "Telegram has been blocked in India before",
      body:
        "Court and government orders have blocked or throttled Telegram in India in the past and could again. When Telegram is unreachable the digest and any alert simply do not arrive — Vyuha degrades to an in-app notice and never routes around a block. No proxies, ever.",
    },
    {
      title: "The bot token is a key, and you hold it",
      body:
        "The token BotFather gives you can send AND read messages on that bot. Vyuha stores it encrypted at rest, bound to this machine, and it never travels in a backup — but anyone you leak it to controls the bot. Revoke it any time from BotFather.",
    },
    {
      title: "Delivery is best-effort, at your own risk",
      body:
        "The digest gets one attempt window per market day: a few quick retries, then it stops until the next launch of the app — never a night queue, never a proxy. An alert whose send fails is tried again at the next check while the price is still through the level, and never queued. An alert arrives only while Vyuha is open and your feed answers; a closed app, a slow or signed-out feed, or a blocked Telegram means no alert. Do not rely on the digest or an alert as a risk control; the journal itself is the record.",
    },
  ] satisfies TelegramDisclosureItem[],
  refusals: [
    "Vyuha sends only your own recorded data and, in an alert, the price your own feed returned — never advice, never a signal of its own, never anyone else's numbers.",
    "Vyuha never reads your Telegram messages beyond the one chat-id discovery you trigger yourself.",
    "Turning this off deletes nothing from your journal; disconnecting deletes the stored token.",
  ],
  /** Pinned last line of every digest — tested verbatim. */
  footer: "Your own recorded data. Not investment advice.",
} as const;

/** The exact validation/test message the setup card promises and the API
 *  route sends — one string, so the promise and the send cannot drift. */
export const TELEGRAM_TEST_MESSAGE = "✅ Vyuha connected — test alert";

/** True when a stored acknowledgement covers the CURRENT disclosure. */
export function isTelegramAckCurrent(ackVersion: number | null | undefined): boolean {
  return typeof ackVersion === "number" && ackVersion === TELEGRAM_DISCLOSURE.version;
}

export interface TelegramGateState {
  enabled: boolean;
  ackVersion: number | null | undefined;
}

export interface TelegramGateResult {
  allowed: boolean;
  /** Why not, in the user's words — safe to show or return as an API message. */
  reason?: string;
}

/**
 * THE gate — the openAlgoGate shape exactly. Both halves must hold: the switch
 * is on AND the acceptance covers the disclosure as it reads today. Consent
 * columns are machine state (SETTINGS_MACHINE_COLUMNS), so a restored backup
 * leaves this closed — and if `enabled` ever travelled anyway, an unaccepted
 * install would still be refused here rather than sending on someone else's
 * consent.
 */
export function telegramGate(state: TelegramGateState): TelegramGateResult {
  if (!state.enabled) {
    return {
      allowed: false,
      reason: "Telegram alerts are off. Turn them on in Settings → Alerts after reading what they cost.",
    };
  }
  if (!isTelegramAckCurrent(state.ackVersion)) {
    return {
      allowed: false,
      reason:
        "The Telegram disclosure has changed since you accepted it. Open Settings → Alerts and read it again to continue.",
    };
  }
  return { allowed: true };
}
