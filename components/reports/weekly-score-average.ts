// The weekly Process Score average, with its coverage. Shared by
// /reports/discipline and /reports/monthly so the two surfaces cannot state
// different averages for the same book (v3.7 WS2).
//
// INVARIANT 6 — NEVER FABRICATE A DENOMINATOR. A week under the sample floor
// carries `processScore: null` and a stated refusal; it is NOT a zero. The v3.6
// code averaged `WeekScore.score`, which is 0 on a refused week, so a book with
// two scoring weeks at 100 and 60 and three quiet weeks printed **32** on a
// shareable PDF instead of 80 — the three quiet weeks silently voting zero.
// Here they are excluded from both numerator and denominator, and the count of
// weeks that actually scored travels with the figure ("across 2 scoring weeks
// of 5"), because a figure computed on a subset carries its coverage.
//
// With no week scoring, the average is `null` and `display` is "—" — never 0,
// the same refusal the ITR schedule export makes.

import { PROCESS_SCORE_FLOOR } from "@/lib/analytics/process-score";

/** The only field the average reads — `WeekScore` and `WeekProcessScore` both fit. */
export interface ScoredWeek {
  processScore: number | null;
}

export interface WeeklyScoreAverage {
  /** Mean of the weeks that scored, one decimal. `null` when none did. */
  avg: number | null;
  /** Ready to render: the average, or "—". Never "0" for an absent average. */
  display: string;
  /** Weeks whose Process Score is a number. */
  scoringWeeks: number;
  /** Weeks with any closed trade at all — the population the reader assumes. */
  totalWeeks: number;
  /** The coverage sentence that travels with the figure. */
  coverage: string;
}

export function weeklyScoreAverage(weeks: ScoredWeek[], floor = PROCESS_SCORE_FLOOR): WeeklyScoreAverage {
  const scored = weeks.filter((w) => w.processScore != null).map((w) => w.processScore!);
  const avg = scored.length ? Math.round((scored.reduce((s, p) => s + p, 0) / scored.length) * 10) / 10 : null;
  const coverage =
    weeks.length === 0
      ? "no closed weeks yet"
      : scored.length === 0
        ? `no week of ${weeks.length} reached ${floor} closed trades`
        : `across ${scored.length} scoring week${scored.length === 1 ? "" : "s"} of ${weeks.length}`;
  return {
    avg,
    display: avg == null ? "—" : `${avg}`,
    scoringWeeks: scored.length,
    totalWeeks: weeks.length,
    coverage,
  };
}
