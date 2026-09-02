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
 */
export const TELEGRAM_DISCLOSURE = {
  version: 1,
  title: "Before you turn on Telegram alerts",
  intro:
    "Vyuha can send you one end-of-day digest of your own recorded numbers through a Telegram bot YOU create. Read what that costs before turning it on.",
  risks: [
    {
      title: "Your trading numbers leave this machine",
      body:
        "The digest transits Telegram's servers and is stored in your chat history there, under Telegram's own security and retention — not Vyuha's. Anyone with access to that chat, or to your bot's token, can read every digest.",
    },
    {
      title: "Telegram has been blocked in India before",
      body:
        "Court and government orders have blocked or throttled Telegram in India in the past and could again. When Telegram is unreachable the digest simply does not arrive — Vyuha degrades to an in-app notice and never routes around a block. No proxies, ever.",
    },
    {
      title: "The bot token is a key, and you hold it",
      body:
        "The token BotFather gives you can send AND read messages on that bot. Vyuha stores it encrypted at rest, bound to this machine, and it never travels in a backup — but anyone you leak it to controls the bot. Revoke it any time from BotFather.",
    },
    {
      title: "Delivery is best-effort, at your own risk",
      body:
        "One attempt window per market day: a few quick retries, then it stops until the next launch of the app — never a night queue, never a proxy. Do not rely on this digest as a risk control; the journal itself is the record.",
    },
  ] satisfies TelegramDisclosureItem[],
  refusals: [
    "Vyuha sends only your own recorded data — never advice, signals or anyone else's numbers.",
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
