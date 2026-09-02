// TELEGRAM DIGEST GATE (PURE — no DB, no fetch). Decides whether NOW is a
// moment the EOD digest may be sent. The server job re-reads settings and
// applies THIS function, so every precondition is unit-testable and the route
// cannot drift from the UI's description of when a digest goes out.
//
// Preconditions, in refusal order (each blocks alone):
//   1. consent — the telegramGate (enabled AND current ack), never bypassed
//   2. credentials on file (token + chat id)
//   3. a market day in IST — weekends are known statically; exchange holidays
//      are NOT knowable offline (the trading-day module's recorded posture),
//      so a holiday digest can still go out: it reports the user's own
//      recorded data, which is true on any day
//   4. the clock has reached the configured IST send time
//   5. not already sent today (last_telegram_sent_date guard). Catch-up is
//      exactly this shape: opening the app at 21:00 still sends today's digest
//      (time ≥ send time, not yet stamped). A day the app never ran after send
//      time is a day with no digest — stated in the card copy rather than
//      papered over with a night queue or scheduler.

import { toIst } from "@/lib/domain/trading-day";
import { telegramGate } from "@/lib/domain/telegram-disclosure";

export interface DigestGateState {
  enabled: boolean;
  ackVersion: number | null;
  hasCredentials: boolean;
  /** "HH:MM" IST; anything unparseable falls back to the column default. */
  sendTime: string | null;
  lastSentDate: string | null;
}

export interface DigestGateResult {
  send: boolean;
  reason: string;
  /** The IST date a send would be stamped with. */
  today: string;
}

export const DEFAULT_SEND_TIME = "15:35";

/** Minutes since midnight for "HH:MM", or null when unparseable. */
export function parseSendTime(s: string | null | undefined): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function shouldSendDigest(state: DigestGateState, now: Date): DigestGateResult {
  const ist = toIst(now);
  const today = ist.toISOString().slice(0, 10);
  const no = (reason: string): DigestGateResult => ({ send: false, reason, today });

  const gate = telegramGate({ enabled: state.enabled, ackVersion: state.ackVersion });
  if (!gate.allowed) return no(gate.reason ?? "The Telegram gate is closed.");
  if (!state.hasCredentials) {
    return no("No bot token and chat id on file — finish the setup in Settings → Alerts.");
  }
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return no(`No digest on a weekend (${today}).`);

  const sendMinutes = parseSendTime(state.sendTime) ?? parseSendTime(DEFAULT_SEND_TIME)!;
  const nowMinutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (nowMinutes < sendMinutes) {
    return no(`Before today's send time (${state.sendTime || DEFAULT_SEND_TIME} IST).`);
  }
  if (state.lastSentDate != null && state.lastSentDate >= today) {
    return no(`Already sent the ${state.lastSentDate} digest.`);
  }
  return { send: true, reason: "All preconditions met.", today };
}
