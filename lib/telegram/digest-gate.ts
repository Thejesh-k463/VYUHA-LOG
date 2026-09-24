// TELEGRAM DIGEST GATE (PURE — no DB, no fetch). Decides whether NOW is a
// moment the EOD digest may be sent. The server job re-reads settings and
// applies THIS function, so every precondition is unit-testable and the route
// cannot drift from the UI's description of when a digest goes out.
//
// Preconditions, in refusal order (each blocks alone):
//   1. consent — the telegramGate (enabled AND current ack), never bypassed
//   2. credentials on file (token + chat id)
//   3. a market day in IST — weekends are known statically (a special Sunday
//      session is NOT a weekend), and exchange holidays ARE knowable offline
//      (`isExchangeHoliday()` in lib/domain/market-calendar.ts, since v4.6.0).
//      This gate still does not ask, on purpose: a holiday digest reports the
//      user's own recorded data, which is true on any day, and suppressing it
//      would silently drop a day from a report the user asked for. The doors
//      where a holiday changes what is STORED do ask — `shouldPersistMark()`
//      refuses with code "holiday"
//   4. the clock has reached the configured IST send time
//   5. not already sent today (last_telegram_sent_date guard). Catch-up is
//      exactly this shape: opening the app at 21:00 still sends today's digest
//      (time ≥ send time, not yet stamped). A day the app never ran after send
//      time is a day with no digest — stated in the card copy rather than
//      papered over with a night queue or scheduler.

import { toIst } from "@/lib/domain/trading-day";
import { hhmmOf, markMinuteInForce, sessionFor, tradingDayStatus } from "@/lib/domain/market-calendar";
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

/**
 * The FALLBACK send time when the stored one is unreadable — derived from the
 * market calendar (v4.6.0 W1): the F&O close plus its mark margin, 15:45 since
 * the derivatives session runs to 15:40. It was a typed 15:35, which sent the
 * "end of day" digest five minutes before F&O stopped trading (R4 #18). The
 * COLUMN default ('15:35', migration 0053) is untouched — no migration; a
 * stored value is the user's own choice and is honoured as typed.
 */
export const DEFAULT_SEND_TIME: string = hhmmOf(markMinuteInForce("NSE_FO", "derivative") ?? parseSendTime("15:35")!);

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
  // A weekend has no digest; a special weekend session with KNOWN hours (the
  // Budget-day Sunday) does. Muhurat's hours are not bundled, so a digest at the
  // usual time would go out before its evening session — none is sent.
  const weekday = ist.getUTCDay();
  const specialWithHours = tradingDayStatus(today).reason === "special" && sessionFor(today, "NSE_CM", "equity") != null;
  if ((weekday === 0 || weekday === 6) && !specialWithHours) return no(`No digest on a weekend (${today}).`);

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
