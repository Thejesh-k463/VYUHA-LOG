/**
 * The freshness catch-up PLAN (v4.6.0 W5, Q51 A1/#2, design review A6/A10).
 *
 * Given the sessions `price_history` already holds and "now", list the
 * trading sessions MISSING from the backfill window (newest first) and the
 * slice the app may fetch on this open — at most `CATCHUP_MAX_FILES`. A larger
 * hole is REPORTED ("N sessions missing in your 252-day window — run the
 * backfill"), never quietly fetched.
 *
 * PURE (A10): this module RECEIVES the stored row counts and the clock and
 * never reads the database or `Date.now()`. Its only date walk is the
 * calendar's `latestBhavcopyDate` / `previousTradingDay` (A6 iv) — holidays
 * are never asked for and a special Sunday session is visited once.
 *
 * The NEWEST session (`latestBhavcopyDate(now)`) belongs to the auto-MTM
 * top-up that runs first on the same open; the plan starts one session before
 * it so the two never race for one file.
 */
import { latestBhavcopyDate, previousTradingDay } from "@/lib/domain/market-calendar";

/** Files per app-open. Owner (Q51 #2): 10, at the backfill's pace, abortable. */
export const CATCHUP_MAX_FILES = 10;

export interface CatchupPlanInput {
  /** date → `price_history` rows on that date. */
  rowsByDate: Map<string, number>;
  /** A date holding at least this many rows is a full session (the backfill's `FULL_SESSION_MIN_ROWS`). */
  fullSessionMinRows: number;
  now: Date;
  /** Sessions in the window (the backfill's `BACKFILL_MAX_DAYS`). */
  windowDays: number;
  maxFiles?: number;
}

export interface CatchupPlan {
  /** The session the auto-MTM top-up owns; not in this plan. */
  newest: string;
  /** The window this plan looked at, oldest and newest session. */
  windowFrom: string;
  windowTo: string;
  sessionsInWindow: number;
  /** Full sessions already stored inside the window. */
  stored: number;
  /** Every missing session in the window, newest first. */
  missing: string[];
  /** The slice this open may fetch, newest first. */
  plan: string[];
}

export function planCatchup(input: CatchupPlanInput): CatchupPlan {
  const maxFiles = Math.max(0, Math.trunc(input.maxFiles ?? CATCHUP_MAX_FILES));
  const newest = latestBhavcopyDate(input.now);
  const missing: string[] = [];
  let stored = 0;
  let date = previousTradingDay(newest);
  const windowTo = date;
  let windowFrom = date;
  for (let i = 0; i < input.windowDays; i++) {
    if ((input.rowsByDate.get(date) ?? 0) >= input.fullSessionMinRows) stored++;
    else missing.push(date);
    windowFrom = date;
    date = previousTradingDay(date);
  }
  return {
    newest,
    windowFrom,
    windowTo,
    sessionsInWindow: input.windowDays,
    stored,
    missing,
    plan: missing.slice(0, maxFiles),
  };
}

/**
 * The dead-run rule (A6 i): running, and not touched for `deadAfterMs`. A
 * missing stamp is dead too. The threshold is a PARAMETER: it is derived in the
 * jobs layer (`BACKFILL_DEAD_AFTER_MS` in lib/jobs/bhavcopy-backfill.ts) from
 * the fetch timeout and the rate limit, neither of which is this module's to
 * know — the rule stays pure, the number stays with the code that fetches.
 */
export function isEnvelopeDead(
  p: { status: string; updatedAt: string | null },
  nowMs: number,
  deadAfterMs: number,
): boolean {
  if (p.status !== "running") return false;
  if (!p.updatedAt) return true;
  const at = Date.parse(p.updatedAt);
  if (!Number.isFinite(at)) return true;
  return nowMs - at > deadAfterMs;
}

/** The panel sentence for a hole larger than one open can fill. */
export function missingSessionsLine(missing: number, windowDays: number): string {
  if (missing === 0) return `No sessions missing in your ${windowDays}-day window.`;
  return `${missing} session${missing === 1 ? "" : "s"} missing in your ${windowDays}-day window — run the backfill.`;
}

/** The gap line a window row prints (Q51 A1: "your 1m window has 4 missing sessions"). */
export function windowGapLine(windowLabel: string, missing: number): string | null {
  if (missing <= 0) return null;
  return `your ${windowLabel} window has ${missing} missing session${missing === 1 ? "" : "s"}`;
}

export interface SessionSpan {
  /** The window's first and last STORED session. */
  from: string;
  to: string;
  /** Stored sessions in the span, the window's `sessions + 1` bars. */
  stored: number;
  /** Calendar trading days in [from, to], per `previousTradingDay`. */
  expected: number;
  /** `expected − stored`, never negative. */
  missing: number;
  /** The calendar sessions in the span the store does not hold, newest first. */
  missingDates: string[];
}

/**
 * Q51 #7 — the sparse-history label. A window of N sessions spans N + 1 stored
 * bars; the calendar says how many trading days that span really held, so the
 * row can print "1m = 21 stored sessions, 12 Jul → 15 Sep (3 missing)". Null
 * when the store does not reach N + 1 sessions.
 */
export function sessionSpan(storedDates: string[], sessions: number): SessionSpan | null {
  const dates = [...storedDates].sort();
  if (sessions <= 0 || dates.length < sessions + 1) return null;
  const to = dates[dates.length - 1];
  const from = dates[dates.length - 1 - sessions];
  const stored = new Set(dates.slice(dates.length - 1 - sessions));
  const missingDates: string[] = [];
  let expected = 0;
  let d = to;
  // Walk the calendar back from `to` to `from`; bounded by the stored span's
  // own length in days, so a stale list cannot loop it.
  for (let i = 0; i < 400 && d >= from; i++) {
    expected++;
    if (!stored.has(d)) missingDates.push(d);
    if (d === from) break;
    d = previousTradingDay(d);
  }
  return { from, to, stored: stored.size, expected, missing: Math.max(0, expected - stored.size), missingDates };
}
