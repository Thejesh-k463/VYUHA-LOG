// Week-over-week comparison for the Process Score (PURE — no DB, no React).
//
// ── The rule, copied from lib/analytics/monthly.ts ─────────────────────────
//
// `momNet` there is set ONLY when the preceding row is the immediately
// preceding CALENDAR month: "a trader who did not trade in November has no
// November-to-December comparison, and quietly comparing December against
// October would invent a trend. Gaps yield null, and null renders as '—'."
//
// The same holds a week at a time, with one extra way to have nothing to
// compare against: a week that HAS trades can still refuse to score (under the
// sample floor), and a refusal is not a number. So there are three distinct
// no-comparison cases, and this returns which one it is — the desk states the
// reason rather than printing a bare dash that reads like a bug.

export type WeekComparison =
  | { kind: "delta"; delta: number; previousWeekStart: string; previousScore: number }
  | {
      kind: "none";
      previousWeekStart: string;
      /**
       * `no-current` this week has no score to compare;
       * `no-week`    the preceding week has no closed trades at all;
       * `no-score`   it has trades but refused to score.
       */
      reason: "no-current" | "no-week" | "no-score";
    };

/** The ISO Monday exactly one week before `weekStart` ("YYYY-MM-DD"). */
export function previousWeekStart(weekStart: string): string {
  const d = new Date(`${weekStart}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

/**
 * This week's score against the IMMEDIATELY preceding week's.
 *
 * `scores` maps an ISO Monday to that week's score — a key that is ABSENT means
 * the week has no closed trades, a key mapped to `null` means the week exists
 * and refused to score. The two are different facts and produce different
 * sentences, which is why an absent key is not normalised to null.
 */
export function weekOverWeek(
  scores: ReadonlyMap<string, number | null>,
  weekStart: string,
  currentScore: number | null,
): WeekComparison {
  const prev = previousWeekStart(weekStart);
  if (currentScore == null) return { kind: "none", previousWeekStart: prev, reason: "no-current" };
  if (!scores.has(prev)) return { kind: "none", previousWeekStart: prev, reason: "no-week" };
  const previousScore = scores.get(prev) ?? null;
  if (previousScore == null) return { kind: "none", previousWeekStart: prev, reason: "no-score" };
  return { kind: "delta", delta: currentScore - previousScore, previousWeekStart: prev, previousScore };
}
