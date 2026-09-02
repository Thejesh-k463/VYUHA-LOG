// TELEGRAM CARD RENDER-STATE (PURE — no DB, no React). The settings card's
// section visibility as one testable state machine, so the render matrix is
// pinned by tests/telegram-card-state.test.ts instead of living only in JSX.
//
// The rule this module exists to enforce: DELETING A STORED CREDENTIAL MUST
// NEVER REQUIRE ACCEPTING A DISCLOSURE. The card once rendered its only
// "Disconnect & delete token" button inside the enabled+acked status block, so
// toggling the digest off (or a disclosure version bump) left the bot token
// stored on this machine with no path to delete it short of re-consenting.
// `showDisconnect` is therefore keyed on `connected` ALONE.

import { isTelegramAckCurrent } from "@/lib/domain/telegram-disclosure";

export interface TelegramCardState {
  enabled: boolean;
  ackVersion: number | null;
  /** Token + chat id are on file. */
  connected: boolean;
}

export interface TelegramCardView {
  /** Enabled but the stored ack no longer covers the current disclosure. */
  ackStale: boolean;
  /** The one-time BotFather setup block. */
  showSetup: boolean;
  /** The full enabled status block (send time / test / disable / disconnect). */
  showStatus: boolean;
  /** The disconnect affordance, ANYWHERE it must exist: whenever connected. */
  showDisconnect: boolean;
  /** The standalone disconnect row, when the status block (which already
   *  carries a disconnect button) is not on screen. */
  showDisconnectStandalone: boolean;
}

export function telegramCardView(s: TelegramCardState): TelegramCardView {
  const ackStale = s.enabled && !isTelegramAckCurrent(s.ackVersion);
  const showStatus = s.enabled && !ackStale && s.connected;
  return {
    ackStale,
    showSetup: s.enabled && !ackStale && !s.connected,
    showStatus,
    showDisconnect: s.connected,
    showDisconnectStandalone: s.connected && !showStatus,
  };
}
