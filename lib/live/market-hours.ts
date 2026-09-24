/**
 * Live Desk — market hours and the daily anchor. PURE (invariant 2).
 *
 * NO CLOCK IS READ HERE. Every function takes `now` as an argument, because a
 * function that calls `Date.now()` cannot be tested at 09:14:59 and cannot be
 * tested at all on a CI box in another timezone.
 *
 * THE HOURS ARE THE MARKET CALENDAR'S (v4.6.0 W1). This file typed 09:15–15:30
 * until SEBI's Closing Auction Session (2026-08-03) made it wrong: equity
 * derivatives now trade to 15:40, and the desk said "closed" for their last ten
 * minutes (R4 #1). `isMarketOpen()` in `lib/domain/market-calendar.ts` is the
 * one answer, shared with the sidebar dot, so the two cannot disagree again.
 * IST is `toIst()`'s — the one definition in the product.
 */

import { sessionOf } from "@/lib/analytics/cockpit";
import { toIst } from "@/lib/domain/trading-day";
import { isMarketOpen, istClock, tradingDayStatus } from "@/lib/domain/market-calendar";
import { PPM, type Ppm } from "./types";

/** IST wall-clock parts of an instant. `minutes` is minutes past IST midnight. */
export function istParts(now: Date): { weekday: number; hour: number; minute: number; minutes: number; hhmm: string } {
  const ist = toIst(now);
  const hour = ist.getUTCHours();
  const minute = ist.getUTCMinutes();
  return {
    weekday: ist.getUTCDay(), // 0 = Sunday
    hour,
    minute,
    minutes: hour * 60 + minute,
    hhmm: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

/**
 * Is the market in session right now? NSE continuous trading in cash or in
 * equity derivatives, from the market calendar: 09:15–15:40 IST since
 * 2026-08-03 (09:15–15:30 before). Pre-open is NOT "open"; a listed holiday is
 * closed (F1, v4.2); a special Sunday session is open.
 */
export function isMarketOpenIst(now: Date): boolean {
  return isMarketOpen(now);
}

/**
 * Which named session an instant falls in — the cockpit's bands (`preopen |
 * open | morning | midday | afternoon | close`, and since CAS `auction` and
 * `postclose`), or null outside them and on a day with no session.
 *
 * Delegates to `sessionOf()` in `lib/analytics/cockpit.ts` rather than
 * redefining the bands: the desk's "Morning trend" and the cockpit's must be
 * the same window, or the same trade is filed under two different sessions in
 * two different screens. The DATE is passed so the day's own rules apply.
 */
export function sessionBucketIst(now: Date): string | null {
  const { date } = istClock(now);
  if (!tradingDayStatus(date).trading) return null;
  return sessionOf(istParts(now).hhmm, date);
}
/** What `anchorSession` publishes. Every count travels with the anchor. */
export interface AnchorResult {
  /** The latest MODAL session date, or null when there is nothing to anchor to. */
  anchor: string | null;
  /** Symbols whose latest bar IS the anchor. */
  onAnchor: number;
  /** Symbols with a bar AFTER the anchor — truncated back to it, not dropped. */
  ahead: number;
  /** Symbols whose latest bar is BEFORE the anchor — excluded as stale. */
  behind: number;
  total: number;
  /** `onAnchor / total`. null for an empty universe — never a fabricated 100%. */
  coveragePpm: Ppm | null;
}

/**
 * The daily anchor: the LATEST MODAL valid session across the universe.
 *
 * NOT `max(date)`. Bhavcopy imports land at different times for different
 * symbols, so the maximum date is whatever refreshed first — on the morning
 * after a partial import, five symbols would decide the breadth of two
 * thousand, and every breadth figure would be computed over a five-symbol
 * universe while looking perfectly healthy. The mode is the session the market
 * actually has data for; ties break to the LATER date, so a genuine new session
 * takes over as soon as it is half the book rather than lingering a day behind.
 *
 * Symbols ahead of the anchor are truncated to it and symbols behind it are
 * excluded, and BOTH counts are published — a coverage figure without its
 * exclusions is the fabricated denominator invariant 6 forbids.
 *
 * @param latestDates the latest stored session per symbol, one entry per symbol
 */
export function anchorSession(latestDates: readonly string[]): AnchorResult {
  const total = latestDates.length;
  if (total === 0) return { anchor: null, onAnchor: 0, ahead: 0, behind: 0, total: 0, coveragePpm: null };

  const counts = new Map<string, number>();
  for (const d of latestDates) counts.set(d, (counts.get(d) ?? 0) + 1);

  let anchor: string | null = null;
  let best = -1;
  for (const [date, n] of counts) {
    // Strictly greater wins on count; an equal count breaks to the LATER date.
    if (n > best || (n === best && anchor !== null && date > anchor)) {
      anchor = date;
      best = n;
    }
  }

  let onAnchor = 0;
  let ahead = 0;
  let behind = 0;
  for (const d of latestDates) {
    if (d === anchor) onAnchor += 1;
    else if (anchor !== null && d > anchor) ahead += 1;
    else behind += 1;
  }

  return {
    anchor,
    onAnchor,
    ahead,
    behind,
    total,
    coveragePpm: Math.floor((onAnchor * PPM) / total),
  };
}
