/**
 * Live Desk — market hours and the daily anchor. PURE (invariant 2).
 *
 * NO CLOCK IS READ HERE. Every function takes `now` as an argument, because a
 * function that calls `Date.now()` cannot be tested at 09:14:59 and cannot be
 * tested at all on a CI box in another timezone.
 *
 * IST IS COMPUTED, NOT ASSUMED. `toIst()` from `lib/domain/trading-day.ts` is
 * the one definition of "India's clock" in the product and this file reuses it
 * rather than re-deriving the +5:30 offset — a second definition is precisely
 * what `tests/today-clock.test.ts` was written to prevent for "today".
 *
 * EXCHANGE HOLIDAYS ARE NOT MODELLED, deliberately and in line with the rest of
 * the app: Vyuha is offline-first and ships no holiday calendar, so
 * `isMarketOpenIst` answers "is this a weekday inside the session window",
 * which is a question about the clock. A caller that has a holiday list can
 * pass it; without one, the honest answer is the clock's, not a guess.
 */

import { sessionOf } from "@/lib/analytics/cockpit";
import { toIst } from "@/lib/domain/trading-day";
import { PPM, type Ppm } from "./types";

/** NSE cash-market session, IST. Pre-open (09:00–09:15) is NOT "open". */
export const MARKET_OPEN_MINUTE = 9 * 60 + 15; // 09:15
export const MARKET_CLOSE_MINUTE = 15 * 60 + 30; // 15:30

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
 * Is the NSE cash market inside its session window right now?
 *
 * Monday–Friday, 09:15–15:30 IST INCLUSIVE of 15:30 — a fill stamped exactly
 * 15:30:00 is a closing-auction fill, not an after-hours one, which is the same
 * boundary `sessionOf()` and the sidebar clock already use. Holidays are not
 * modelled (see the file header), so this can say "open" on Republic Day.
 */
export function isMarketOpenIst(now: Date): boolean {
  const { weekday, minutes } = istParts(now);
  if (weekday === 0 || weekday === 6) return false;
  return minutes >= MARKET_OPEN_MINUTE && minutes <= MARKET_CLOSE_MINUTE;
}

/**
 * Which named session an instant falls in — `preopen | open | morning | midday
 * | afternoon | close`, or null outside 09:00–15:30 and on weekends.
 *
 * Delegates to `sessionOf()` in `lib/analytics/cockpit.ts` rather than
 * redefining the bands: the desk's "Morning trend" and the cockpit's must be
 * the same window, or the same trade is filed under two different sessions in
 * two different screens.
 */
export function sessionBucketIst(now: Date): string | null {
  const { weekday, hhmm } = istParts(now);
  if (weekday === 0 || weekday === 6) return null;
  return sessionOf(hhmm);
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
