/**
 * Results date — how many days away, and nothing else. PURE (invariant 2): no
 * DB, no React, no `new Date()`.
 *
 * THE DATE IS A FACT, NEVER AN INSTRUCTION (owner ruling Q-9). `instruments
 * .results_date` is a calendar date the USER typed on /instruments; Vyuha
 * fetches no results calendar and bundles none. This module turns it into a
 * distance in days, and the copy that renders it (`components/live/desk-copy.ts`
 * `resultsChip`) states that distance and stops. Nothing here — and nothing
 * downstream of here — is permitted to say what to do about it. That is the
 * same SEBI line `tests/live-tracker-copy.test.ts` guards for the rest of the
 * desk, and the reason the chip is a bare noun phrase.
 *
 * ── WHY "TODAY" IS AN ARGUMENT ─────────────────────────────────────────────
 * `todayIstIso()` (lib/domain/trading-day.ts) is the caller's job. A `new
 * Date()` in here would read the MACHINE's local calendar, so a user in a
 * different timezone — or a test running at 23:40 IST — would get a different
 * answer to "how many days" than every other date on the desk. Taking the ISO
 * string keeps this module pure and keeps one clock in the product.
 *
 * ── WHY A PAST DATE IS `null`, NOT A NEGATIVE NUMBER ───────────────────────
 * The date stays on the record — the user typed it and it is theirs — but a
 * results date that has gone by is no longer a fact about the future, and
 * "Results 4 days ago" invites the reader to draw a conclusion about a print
 * Vyuha has not seen and does not store. `null` renders nothing at all.
 */

/** ISO `YYYY-MM-DD` and a REAL calendar day — 2026-02-30 is neither. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  // Round-trip through UTC: `Date.UTC` rolls 2026-02-30 forward to 2026-03-02,
  // so a value that does not come back byte-identical was never a real day.
  return utcDay(value) !== null;
}

/** Midnight UTC for an ISO day, or null when the string is not a real day. */
function utcDay(iso: string): number | null {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const ms = Date.UTC(y, m - 1, d);
  if (!Number.isFinite(ms)) return null;
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() + 1 !== m || back.getUTCDate() !== d) return null;
  return ms;
}

/**
 * Whole days from `todayIst` to `resultsDate`.
 *
 * @param resultsDate `instruments.results_date`, or null when unrecorded.
 * @param todayIst    IST today as `YYYY-MM-DD` — `todayIstIso()` at the caller.
 * @returns 0 for today, 1 for tomorrow, N for N days out; `null` when the date
 *          is absent, unreadable, or already past.
 *
 * Both sides are read as midnight UTC, so the subtraction is exact whole days
 * with no DST or offset arithmetic anywhere near it.
 */
export function daysToResults(resultsDate: string | null | undefined, todayIst: string): number | null {
  if (resultsDate == null || !isIsoDate(resultsDate) || !isIsoDate(todayIst)) return null;
  const target = utcDay(resultsDate);
  const today = utcDay(todayIst);
  if (target === null || today === null) return null;
  const days = (target - today) / 86_400_000;
  return days < 0 ? null : days;
}
