// Indian cash-market trading-day helpers (PURE). Used by the auto-MTM job to
// decide which EOD bhavcopy date to fetch. Weekends are known statically;
// exchange holidays are NOT (offline-first app) — callers handle a missing
// file by walking back one more weekday.

const IST_OFFSET_MIN = 330; // UTC+5:30

/** The given instant expressed as an IST wall-clock Date (UTC fields = IST). */
export function toIst(now: Date): Date {
  return new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
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
