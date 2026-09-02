// The ONE ISO-week bucketer in the product (PURE — no DB, no React).
//
// Extracted from `disciplineByWeek`'s private `isoWeek()` (v3.7 WS1) because
// three callers now need it: the weekly discipline table, the Process Score,
// and `weekly_reviews.week_start` (migration 0056). Two bucketers that
// disagree would file a user's note against a week their score never covered —
// which is why `lib/db/schema.ts` names this file as the source of that column.
//
// ISO-8601: weeks start on MONDAY, and a week belongs to the year that owns its
// THURSDAY. So 2025-12-31 sits in 2026-W01, and 2024-12-30 sits in 2025-W01.
//
// TIMEZONE — the one behavioural fix in the extraction. The original built the
// Monday from a LOCAL midnight and then serialised it with `toISOString()`,
// which is UTC: in any zone east of Greenwich that lands on the previous day,
// so every `weekStart` in India read as the SUNDAY. The label (and therefore
// which week a trade buckets into) was never affected — it is computed from
// local date fields — so bucketing is unchanged; only the emitted date string
// is now the Monday it always claimed to be.

export interface IsoWeek {
  /** ISO year-week label, e.g. "2026-W23". */
  label: string;
  /** ISO Monday of that week, "YYYY-MM-DD". */
  monday: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Serialise a Date by its LOCAL fields. `toISOString()` would re-zone it. */
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Label + Monday for the ISO week containing `dateStr` ("YYYY-MM-DD"). */
export function isoWeek(dateStr: string): IsoWeek {
  const d = new Date(dateStr + "T00:00:00");
  const day = (d.getDay() + 6) % 7; // 0=Mon
  const monday = new Date(d);
  monday.setDate(d.getDate() - day);
  // The week belongs to the year holding its Thursday.
  const thursday = new Date(monday);
  thursday.setDate(monday.getDate() + 3);
  const yearStart = new Date(thursday.getFullYear(), 0, 1);
  const week = Math.ceil((((thursday.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return {
    label: `${thursday.getFullYear()}-W${String(week).padStart(2, "0")}`,
    monday: localDate(monday),
  };
}

/** The ISO Monday of the week containing `dateStr`, as "YYYY-MM-DD". */
export function isoWeekStart(dateStr: string): string {
  return isoWeek(dateStr).monday;
}

/** The ISO year-week label of the week containing `dateStr`, e.g. "2026-W23". */
export function isoWeekLabel(dateStr: string): string {
  return isoWeek(dateStr).label;
}
