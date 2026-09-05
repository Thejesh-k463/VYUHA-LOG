/**
 * PURE mapping from what Vyuha already stores to a `Quote`, plus the IST
 * window that decides whether a provider may be started at all.
 *
 * This file is the pure half of the two server-only providers (`manual.ts`,
 * `eod-bhavcopy.ts`) — the same split as `lib/engine/rates.ts` vs
 * `rates-db.ts` (invariant 2). No DB, no React, no `Date.now()`; the clock is
 * always an argument.
 */
import { toIst } from "@/lib/domain/trading-day";
import { toPaise, type Quote, type QuoteKey } from "./types";

/** A stored EOD bar, in the shape `lib/queries/price-history.ts` returns it. */
export interface StoredBar {
  date: string;
  open?: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume?: number | null;
}

/** A mark the user typed, as stored in `mtm_prices`. */
export interface StoredMark {
  price: number;
  asOfDate: string;
}

/**
 * The instant an Indian cash session's close price was true. A bar dated
 * 2026-09-04 is a 15:30 IST price and says so — `asOf` is source time, not
 * receipt time (03D §1.2), so the desk can age it honestly at 09:20 the next
 * morning.
 */
export function sessionCloseIso(isoDate: string): string {
  return `${isoDate}T15:30:00+05:30`;
}

/**
 * Latest stored bar → an EOD quote. `bars` must be ASCENDING by date, which is
 * what `getBarsMap()` guarantees (SQLite returns rowid order otherwise, and a
 * "latest" taken off rowid order is silently the wrong day).
 *
 * `prevClose` is `null` under two stored sessions: the day-change column must
 * render "—", never a 0 % that looks like a flat day.
 */
export function eodQuoteFromBars(key: QuoteKey, bars: readonly StoredBar[]): Quote | null {
  if (bars.length === 0) return null;
  const last = bars[bars.length - 1];
  const prev = bars.length >= 2 ? bars[bars.length - 2] : null;
  return {
    key,
    ltp: toPaise(last.close),
    prevClose: prev ? toPaise(prev.close) : null,
    dayOpen: last.open == null ? null : toPaise(last.open),
    dayHigh: last.high == null ? null : toPaise(last.high),
    dayLow: last.low == null ? null : toPaise(last.low),
    volume: last.volume ?? null,
    asOf: sessionCloseIso(last.date),
    staleness: "eod",
    source: "eod",
  };
}

/**
 * A typed mark → a manual quote. Nothing about a typed number is a day bar, so
 * open/high/low/volume/prevClose are `null` rather than fabricated from it
 * (invariant 6).
 */
export function manualQuoteFromMark(key: QuoteKey, mark: StoredMark): Quote {
  return {
    key,
    ltp: toPaise(mark.price),
    prevClose: null,
    dayOpen: null,
    dayHigh: null,
    dayLow: null,
    volume: null,
    asOf: sessionCloseIso(mark.asOfDate),
    staleness: "manual",
    source: "manual",
  };
}

/** 09:00 IST — pre-open starts; the earliest a provider may be started. */
export const LIVE_WINDOW_START_MIN = 9 * 60;
/** 15:40 IST — ten minutes past the close, enough for the closing print. */
export const LIVE_WINDOW_END_MIN = 15 * 60 + 40;

/**
 * May a streaming provider be started right now? Mon–Fri, 09:00–15:40 IST
 * (03D "Outside market hours / offline").
 *
 * Exchange holidays are NOT modelled anywhere in this app
 * (`lib/domain/trading-day.ts`), so this is a weekday-and-clock gate: on a
 * holiday the provider starts, returns nothing, and the desk keeps showing the
 * last close. That is the safe direction of the error — the unsafe one is
 * running a feed at 23:00 and calling a stale print "live".
 */
export function isWithinLiveWindow(now: Date): boolean {
  const ist = toIst(now);
  const day = ist.getUTCDay(); // toIst() puts IST wall-clock into the UTC fields
  if (day === 0 || day === 6) return false;
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return minutes >= LIVE_WINDOW_START_MIN && minutes <= LIVE_WINDOW_END_MIN;
}
