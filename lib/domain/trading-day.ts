// Indian cash-market trading-day helpers (PURE). Used by the auto-MTM job to
// decide which EOD bhavcopy date to fetch, and — since v4.2 — by the desk and
// the mark doors to tell a session from a day the exchange was shut.
//
// WEEKENDS are known statically. EXCHANGE HOLIDAYS are known for the years the
// BUNDLED list covers (`lib/data/nse-holidays.json`) and for no others: an
// uncovered year answers "not a holiday", so the weekday behaviour every caller
// had before v4.2 survives unchanged rather than the app going silent every
// January. `tests/nse-holidays.test.ts` carries the YEAR GUARD that stops a
// release shipping past the end of the list, and the reasoning for the
// asymmetry (a wrongly LISTED date is far more expensive than a missing one)
// is in the file's own `_note`.
//
// The bhavcopy walk-back still handles a missing file by walking back a
// weekday: a file can be absent for reasons the calendar knows nothing about.

import nseHolidays from "@/lib/data/nse-holidays.json";

const IST_OFFSET_MIN = 330; // UTC+5:30

/** The given instant expressed as an IST wall-clock Date (UTC fields = IST). */
export function toIst(now: Date): Date {
  return new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
}

/**
 * Today in INDIA as `YYYY-MM-DD`, whatever clock the machine keeps.
 *
 * Not UTC: that calls a payment made at 03:00 IST "future" and refuses a real
 * receipt for five and a half hours, and it dates every charge computed after
 * 18:30 UTC to yesterday. Not the process's local parts either — a desktop in
 * IST gets the right answer from those, but the same build on a UTC-configured
 * box silently reintroduces the bug they were written to avoid. This is an
 * Indian trading journal, so the day is India's.
 *
 * THE NAME CARRIES THE TIMEZONE ON PURPOSE, and this is the ONLY "today" the
 * app defines (v3.8 — `lib/engine/rates.ts` used to export a UTC `todayIso()`
 * beside it; the two were a day apart for the 5½ hours after IST midnight and
 * charge pricing read the wrong one). `tests/today-clock.test.ts` fails on a
 * second definition.
 */
export function todayIstIso(d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/* ───────────────────────── the exchange calendar (F1) ────────────────────── */

/**
 * The last year `lib/data/nse-holidays.json` covers. A date in any other year
 * is UNKNOWN to this module, and unknown is never reported as a holiday.
 */
export const NSE_HOLIDAY_YEAR: number = nseHolidays.year;

/** When the bundled list was last diffed against NSE's own holiday-master. */
export const NSE_HOLIDAYS_VERIFIED_AT: string = nseHolidays.verified_at;

const HOLIDAY_DATES: ReadonlySet<string> = new Set(nseHolidays.trading_holidays.map((h) => h.date));

/**
 * Is this ISO date a listed NSE cash-market TRADING holiday?
 *
 * TRUE only when the date's year is covered by the bundled list AND the date is
 * on it. An uncovered year answers FALSE — "unknown", not "a holiday" — which
 * is what keeps a stale calendar from silently cancelling real sessions; the
 * cost of that choice is that it must be noticed, which is the year guard's
 * job (`tests/nse-holidays.test.ts`).
 *
 * CLEARING holidays are NOT here and must never be added: NSE publishes them as
 * a separate list, the market is OPEN on them, and only settlement is shut.
 */
export function isExchangeHoliday(isoDate: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return false;
  if (Number(isoDate.slice(0, 4)) !== NSE_HOLIDAY_YEAR) return false;
  return HOLIDAY_DATES.has(isoDate);
}

/** The listed holiday's name, for a sentence that says WHICH day it was. */
export function exchangeHolidayName(isoDate: string): string | null {
  if (!isExchangeHoliday(isoDate)) return null;
  return nseHolidays.trading_holidays.find((h) => h.date === isoDate)?.name ?? null;
}

/**
 * Is this a day the NSE cash market trades — a weekday that is not a listed
 * holiday?
 *
 * Takes an ISO date (already India's day) or an INSTANT, which is converted
 * through `todayIstIso()` rather than through a second +5:30 constant:
 * 2026-09-04T19:00Z is already Saturday in India, and `tests/today-clock.test.ts`
 * exists to keep that one definition one.
 */
export function isTradingDayIst(when: Date | string): boolean {
  const isoDate = typeof when === "string" ? when : todayIstIso(when);
  const d = new Date(isoDate + "T00:00:00Z");
  const day = d.getUTCDay();
  if (Number.isNaN(day) || day === 0 || day === 6) return false;
  return !isExchangeHoliday(isoDate);
}

const isWeekend = (d: Date) => d.getUTCDay() === 0 || d.getUTCDay() === 6;

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Latest weekday ≤ the given IST date. */
function backToWeekday(d: Date): Date {
  const x = new Date(d);
  while (isWeekend(x)) x.setUTCDate(x.getUTCDate() - 1);
  return x;
}

/**
 * The bhavcopy date worth fetching "now": today (IST) once the EOD file is
 * reliably published (~7pm IST), else the previous weekday. Exchange holidays
 * can still yield a date with no file — walk back with `previousTradingDay`.
 */
export function latestBhavcopyDate(now: Date, publishHourIst = 19): string {
  const ist = toIst(now);
  if (isWeekend(ist) || ist.getUTCHours() < publishHourIst) {
    const prev = new Date(ist);
    prev.setUTCDate(prev.getUTCDate() - 1);
    return iso(backToWeekday(prev));
  }
  return iso(ist);
}

/** Previous weekday before an ISO date (for walking past holidays/missing files). */
export function previousTradingDay(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return iso(backToWeekday(d));
}

/** DDMMYYYY, as used in NSE's sec_bhavdata_full_<DDMMYYYY>.csv archive names. */
export function toDdmmyyyy(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${d}${m}${y}`;
}
