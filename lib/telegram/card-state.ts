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

/* ───────────── stop / target alerts section (v4.7.0 C5, design D11) ─────────────
 * View INPUTS only — the copy and the JSX are the card's (components/settings/
 * telegram-card.tsx). The status line is keyed on the job's reason code
 * (lib/telegram/alert-gate.ts, plus the job's own `feed-error`), never on a
 * sentence, so the card and the server cannot drift into two vocabularies. */

export interface TelegramAlertsCardState extends TelegramCardState {
  /** `getEntitlement().pro` — the section is visible either way; the toggle is Pro. */
  pro: boolean;
  alertsEnabled: boolean;
  windowFrom: string | null;
  windowTo: string | null;
  /** The last answer of POST /api/telegram/alerts, when the card has one. */
  lastRefusal?: string | null;
}

export interface TelegramAlertsCardView {
  /** The section renders under the digest's status block (Telegram on, ack current, connected). */
  showAlertsSection: boolean;
  /** The toggle can be switched ON (Pro). Switching OFF is always possible. */
  canEnable: boolean;
  /** Show the "Pro" lock instead of an active toggle. */
  proLocked: boolean;
  alertsOn: boolean;
  /** The window as stored, or both null = the market's own hours. */
  window: { from: string; to: string } | null;
  /** The reason code the one status line renders, or null when armed or off. */
  status: string | null;
}

export function telegramAlertsCardView(s: TelegramAlertsCardState): TelegramAlertsCardView {
  const base = telegramCardView(s);
  const window = s.windowFrom && s.windowTo ? { from: s.windowFrom, to: s.windowTo } : null;
  // Not Pro wins over everything after it — the gate's own order.
  const status = !s.pro ? "not-pro" : s.alertsEnabled ? (s.lastRefusal ?? null) : null;
  return {
    showAlertsSection: base.showStatus,
    canEnable: s.pro && base.showStatus,
    proLocked: !s.pro,
    alertsOn: s.alertsEnabled,
    window,
    status,
  };
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
