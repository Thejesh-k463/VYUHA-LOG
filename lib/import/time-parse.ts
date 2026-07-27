/**
 * Date and time extraction for broker files.
 *
 * Indian broker exports are wildly inconsistent: the same column ("Trade
 * Date", "Order Execution Time") may hold a bare date, a full timestamp, or a
 * date and time split by "T", a space, or nothing at all. So the DATE and the
 * TIME are extracted independently rather than assuming a single format.
 */

/**
 * Strip the date portion first, so its digits cannot be misread as a clock.
 *
 * NOTE the `(?!\d)` lookaheads rather than ``: in `2026-06-01T09:15` there is
 * `2026-06-01T09:15` there is NO word boundary between "01" and "T", nor
 * trailing `` silently fails to match and the time regex then reads "15:32"
 * fails, and the time regex then reads "15:32" out of the middle of the
 * date: six hours off and entirely plausible-looking.
 */
function withoutDate(s: string): string {
  return s
    .replace(/\d{4}-\d{1,2}-\d{1,2}(?!\d)/g, " ") // 2026-06-01, 2026-06-01T09:15
    .replace(/\d{1,2}[-/]\d{1,2}[-/]\d{2,4}(?!\d)/g, " "); // 01-06-2026, 1/6/26
}

/**
 * Pull an HH:MM out of a broker timestamp cell.
 *
 * Returns null rather than guessing. A wrong time is worse than no time: it
 * would attribute trades to the wrong session and quietly corrupt the entire
 * time-of-day analysis, which is exactly the sort of error nobody notices.
 *
 * The date is removed BEFORE matching — `2026-06-01T09:15:32` otherwise
 * matches "15:32" from inside the date itself, off by six hours and
 * completely plausible-looking.
 */
export function extractTime(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const s = withoutDate(String(raw));
  const m = s.match(/(?<!\d)(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?/i);
  if (!m) return null;

  let hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || mm > 59) return null;

  const ampm = m[3]?.toLowerCase().replace(/\./g, "");
  if (ampm === "pm" && hh < 12) hh += 12;
  if (ampm === "am" && hh === 12) hh = 0;
  if (hh > 23) return null;

  // Zero-padded so times sort correctly as plain strings — "9:15" would sort
  // after "15:29" lexically and scramble every hourly bucket.
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/**
 * Pull an ISO date out of the same cell. Handles yyyy-mm-dd, dd-mm-yyyy and
 * dd/mm/yyyy — Indian brokers use all three.
 *
 * DAY-FIRST is assumed for the ambiguous forms, per Indian convention. Reading
 * `06-01-2026` as June 1st instead of 6th January would shift trades by months
 * and silently rewrite the whole P&L calendar.
 */
export function extractDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();

  const iso = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/);
  if (iso) {
    const mo = Number(iso[2]);
    const d = Number(iso[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${iso[1]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  const dmy = s.match(/(?<!\d)(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?!\d)/);
  if (dmy) {
    const d = Number(dmy[1]);
    const mo = Number(dmy[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${dmy[3]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  return null;
}
