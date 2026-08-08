/**
 * Daily P&L streaks and records (PURE).
 *
 * "Streak" here means CONSECUTIVE TRADING DAYS THAT APPEAR IN THE DATA — not
 * calendar days. A day you didn't trade is not a loss and must not break a
 * green run; a weekend certainly must not. This is the whole reason the
 * module exists rather than a one-liner in the component: the honest
 * definition is easy to get wrong and impossible to see once rendered.
 *
 * Flat days (net exactly 0) are their own case: they neither extend nor break
 * a run, because calling a ₹0 day "green" would inflate the streak the user
 * screenshots.
 */

export interface DayPnl {
  date: string; // YYYY-MM-DD
  net: number;
}

export interface StreakReport {
  /** Green run ending on the most recent traded day (0 if that day was red). */
  currentGreen: number;
  /** Red run ending on the most recent traded day (0 if that day was green). */
  currentRed: number;
  bestGreen: number;
  worstRed: number;
  best: DayPnl | null;
  worst: DayPnl | null;
  tradedDays: number;
  greenDays: number;
  redDays: number;
  flatDays: number;
}

export function streakReport(daily: Record<string, number>): StreakReport {
  const days: DayPnl[] = Object.entries(daily)
    .map(([date, net]) => ({ date, net }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const empty: StreakReport = {
    currentGreen: 0, currentRed: 0, bestGreen: 0, worstRed: 0,
    best: null, worst: null, tradedDays: 0, greenDays: 0, redDays: 0, flatDays: 0,
  };
  if (days.length === 0) return empty;

  let bestGreen = 0, worstRed = 0, runGreen = 0, runRed = 0;
  let green = 0, red = 0, flat = 0;
  let best = days[0], worst = days[0];

  for (const d of days) {
    if (d.net > 0) {
      green += 1;
      runGreen += 1; runRed = 0;
      if (runGreen > bestGreen) bestGreen = runGreen;
    } else if (d.net < 0) {
      red += 1;
      runRed += 1; runGreen = 0;
      if (runRed > worstRed) worstRed = runRed;
    } else {
      flat += 1; // neither extends nor breaks — see the header
    }
    if (d.net > best.net) best = d;
    if (d.net < worst.net) worst = d;
  }

  return {
    currentGreen: runGreen,
    currentRed: runRed,
    bestGreen,
    worstRed,
    // A book that never had a winning day has no "best day" worth showing as
    // an achievement — but the figures are still true, so they are returned
    // and the UI decides how to frame them.
    best,
    worst,
    tradedDays: days.length,
    greenDays: green,
    redDays: red,
    flatDays: flat,
  };
}
