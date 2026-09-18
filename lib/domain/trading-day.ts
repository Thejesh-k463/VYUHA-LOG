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

/* ─────────── reading a date a human or a broker file TYPED (L3 / G-G3-1) ──── */

/**
 * L3 (v4.3.0 wave 2L), moved here VERBATIM in wave 2M (finding G-G3-1).
 *
 * The two branches below matched on digit count alone, so '31-02-2026' was reordered
 * into '2026-02-31' and '99-99-9999' into '9999-99-99', and both were stored as if
 * they were days. `new Date('9999-99-99')` is an Invalid Date: on an eq_mtf close the
 * holding period went NaN, the charge total with it, and the UPDATE failed with
 * `NOT NULL constraint failed: trades.charges_total_paise` — the server action 500d
 * instead of answering {ok:false}. On every other row the impossible day was simply
 * stored, and the readers that date a trade (the tax pack's financial year, the MTF
 * day count) then read a day that does not exist.
 *
 * A date that is not a real calendar day reads as NO date — the same answer this
 * function already gave to text it could not parse at all, and the same rule
 * `isPriceableExitDate` applies to an IPO exit. Callers that write a date a user
 * TYPED refuse the whole write rather than store or silently clear it (see
 * `closePosition`, `updateManualTrade` and `validateLegs`); an importer keeps its own
 * rule of refusing a row it cannot read (AGENTS.md: never coerce a bad cell).
 *
 * WHY IT LIVES HERE: it was private to `lib/import/commit.ts`, which is server-only,
 * so the close dialog restated it and the staged ladder did without it — and the
 * ladder then priced MTF interest off `new Date(leg.tradeDate)`, billing 1,449.86 for
 * a real 192.33 on '2026-02-31' (G-G3-1). This module is PURE (invariant 2) and
 * already reaches both graphs, so there is now ONE calendar implementation:
 * commit.ts imports it, `lib/queries/staged.ts` prices through it, and both dialogs
 * read it. `tests/trading-day.test.ts` fails on a second private copy.
 */
export function isRealDay(y: string, mo: string, d: string): string | null {
  const [yy, mm, dd] = [Number(y), Number(mo), Number(d)];
  const t = new Date(Date.UTC(yy, mm - 1, dd));
  return t.getUTCFullYear() === yy && t.getUTCMonth() === mm - 1 && t.getUTCDate() === dd ? `${y}-${mo}-${d}` : null;
}

/** The ISO day a typed/exported date states, or null when it states none. */
export function normalizeDate(s: string | null): string | null {
  if (!s) return null;
  const t = s.trim();
  // DD-MM-YYYY or DD/MM/YYYY
  const m = t.match(/^(\d{2})[-/](\d{2})[-/](\d{4})/);
  if (m) return isRealDay(m[3], m[2], m[1]);
  // YYYY-MM-DD (optionally with time)
  const m2 = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return isRealDay(m2[1], m2[2], m2[3]);
  return null;
}

/**
 * D4 / D8 (v4.3.0 fix wave 2P) — THE ONE FOLD for "which day does this value state".
 *
 * A stored or typed date compares as the ISO DAY it states, not as its bytes: a
 * 4.2.x row holds '20-01-2026' where a save resolves '2026-01-20', and a byte
 * compare read that as a moved fill (the staged refusal), a moved charge input
 * (a flat re-price that dropped the IPO sync's marker) and a NEW sell date.
 * Three private copies of this fold existed (`lib/analytics/ipo-link.ts`, twice in
 * `app/api/ipos/route.ts`) and two of them handed '' back as '' — so a blank
 * stored IPO exit date compared unequal to the null the form sends, and a
 * notes-only save was a 409 "sale recorded in Trades" (D8).
 *
 *   readable      → the ISO day (whatever the spelling);
 *   unreadable    → the raw, trimmed value — it compares only to itself (D13's
 *                   rule: a byte-identical unreadable pair is still one pair);
 *   blank / null  → null — a value that states no day is the same absence as
 *                   a null, on BOTH sides of every compare.
 */
export function dayOf(v: string | null | undefined): string | null {
  if (v == null) return null;
  const raw = v.trim();
  if (raw === "") return null;
  return normalizeDate(raw) ?? raw;
}

/** Do two values state the same day (or the same absence of one)? */
export const sameDay = (a: string | null | undefined, b: string | null | undefined): boolean => dayOf(a) === dayOf(b);

/**
 * D7 (v4.3.0 fix wave 2P) — THE ONE DAY COUNT for every writer that prices from
 * two trade dates: T+1 settlement start through the day before sale proceeds
 * settle = exactly (to − from) calendar days, confirmed against Dhan's MTF
 * documentation (no extra "-1": that undercounted every position by a day).
 *
 * Both ends resolve through `normalizeDate` (which trims), and a date that states
 * no day — blank, whitespace, unreadable, null — counts ZERO days rather than
 * inventing one (invariant 6). Five copies of this expression existed and one of
 * them (`updateManualTrade`) tested the raw string for emptiness, so a stored ' '
 * read as PRESENT there and as ABSENT to `storedDateProblem`: NaN reached the
 * engine and the write died on `NOT NULL constraint failed`. The other readers
 * billed 0 days for the same row. Now all of them answer 0.
 */
export function calendarDaysHeld(from: string | null | undefined, to: string | null | undefined): number {
  const a = normalizeDate(from ?? null);
  const b = normalizeDate(to ?? null);
  if (!a || !b) return 0;
  return Math.max(0, Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000));
}

/**
 * The refusal a writer states for a date it was GIVEN and cannot read — commit.ts's
 * `unreadableDate` wording, in one place both a pure module and a client component
 * can reach (`lib/domain/staged.ts#validateLegs`, the trade editor's preview).
 * commit.ts keeps its own copy of the sentence; `tests/trading-day.test.ts` fails if
 * the two ever drift apart.
 */
export function unreadableDateMessage(label: string, raw: string): string {
  return `The ${label} “${raw}” is not a real calendar day — enter it as a day that exists, for example 2026-06-15. Nothing was changed.`;
}

/**
 * D3 (v4.3.0 wave 2N) — the refusal a writer states for a date the ROW ALREADY
 * HOLDS and cannot read. A different sentence from the one above because there is
 * no field in front of the user to fix: the value was written before the calendar
 * check existed (a typed '99-99-9999' became the stored '9999-99-99'), and the
 * remedy is the trade editor.
 *
 * `new Date('9999-99-99')` is an Invalid Date, so an eq_mtf close's day count went
 * NaN and the write died with `NOT NULL constraint failed: trades.charges_total_paise`
 * — the server action 500d instead of answering {ok:false}; `new Date('2026-02-31')`
 * rolls forward to 3 March and bills days the row does not state.
 */
export function unreadableStoredDateMessage(label: string, raw: string): string {
  return `This trade's stored ${label} “${raw}” is not a real calendar day, so nothing can be priced from it. Correct the date in Edit trade first. Nothing was changed.`;
}

/**
 * The refusal a re-price states for a trade whose STORED buy or sell date is not a
 * real day, or null when both are readable (or absent — a missing date is an
 * unanswered field, not an unreadable one, and keeps its 0-day path).
 *
 * ONE implementation for the three writers that price from those columns
 * (`closePosition`, `applyOverride`) and for the re-tag dialog, which states the
 * same sentence rather than submitting a save that can only refuse.
 */
export function storedDateProblem(t: { buyDate?: string | null; sellDate?: string | null }): string | null {
  const bad = unreadableStoredDate(t);
  return bad ? unreadableStoredDateMessage(bad.label, bad.raw) : null;
}

/**
 * D9 (v4.3.0 fix wave 2P) — the PARTS `storedDateProblem` states: which column,
 * and the raw (trimmed) value it holds. One rule, two sentences: the writers and
 * the re-tag dialog state the sentence above; the trade editor — the one place
 * the date can be corrected — states its own, because the browser shows a date
 * input holding '9999-99-99' as BLANK, and the user must be told the field is
 * not empty but unreadable. Null when both dates are readable or absent (a
 * whitespace value is an unanswered field, not an unreadable one).
 */
export function unreadableStoredDate(t: { buyDate?: string | null; sellDate?: string | null }): { label: "buy date" | "sell date"; raw: string } | null {
  for (const [label, value] of [["buy date", t.buyDate], ["sell date", t.sellDate]] as const) {
    const raw = (value ?? "").trim();
    if (raw !== "" && normalizeDate(raw) == null) return { label, raw };
  }
  return null;
}
