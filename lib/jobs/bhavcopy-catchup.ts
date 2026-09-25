import "server-only";
import { asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { applyBhavcopyMtm } from "@/lib/import/mtm-bhavcopy";
import {
  CATCHUP_MAX_FILES,
  isEnvelopeDead,
  missingSessionsLine,
  planCatchup,
  type CatchupPlan,
} from "@/lib/atlas/catchup-plan";
import { fetchBhavcopyForDate, type BhavcopyFetch } from "@/lib/jobs/auto-mtm";
import {
  BACKFILL_DEAD_AFTER_MS,
  BACKFILL_MAX_DAYS,
  BACKFILL_RATE_LIMIT_MS,
  FULL_SESSION_MIN_ROWS,
  IDLE_PROGRESS,
  existingRowsByDate,
  readBackfillProgress,
  releaseBhavcopyJobLock,
  takeBhavcopyJobLock,
  writeBackfillProgress,
  type BackfillProgress,
} from "@/lib/jobs/bhavcopy-backfill";

/**
 * The freshness catch-up (v4.6.0 W5, Q51 A1 / #2, design review A6).
 *
 * WHY: a user who opens the app on Thursday after three days away has the
 * auto-MTM top-up for Wednesday and a three-session hole behind it, and every
 * window figure on the Atlas quietly spans it. This fills UP TO TEN missing
 * sessions per app-open, under the consent the user already gave.
 *
 * WHAT IT REUSES, DELIBERATELY:
 *   - the fetch: `fetchBhavcopyForDate` (auto-mtm.ts) — same host, same headers,
 *     same UDiFF-then-legacy fallback. This file holds NO URL (A6 v; the egress
 *     guard pins the host inside auto-mtm.ts).
 *   - the pace: `BACKFILL_RATE_LIMIT_MS`, one file per interval, sequential.
 *   - the envelope: the backfill's own `bhavcopy_backfill_progress`, so a running
 *     backfill blocks the catch-up and a running catch-up blocks the backfill —
 *     one job at a time, ever.
 *   - the lock: `takeBhavcopyJobLock` (bhavcopy-backfill.ts), the SAME
 *     process-level lock the backfill button takes, so the window between
 *     reading an idle envelope and writing `running` admits no second starter.
 *   - the apply: `applyBhavcopyMtm`, so every file lands in the audit log the
 *     same way a download or a drop does.
 *
 * THE GATE is `settings.autoMtmEnabled` ONLY — the consent to fetch this file
 * family every day (PRIVACY item 2). NOT `hasBackfillConsent()`: the backfill
 * ack is consent to a button press, not to an automatic job. It is re-read from
 * the DATABASE before EVERY file (A6 iii), as is the abort flag, so turning the
 * toggle off mid-run stops the run at the next file.
 *
 * NO NEW COLUMN: "what is missing" is derived from `price_history` every time
 * (`planCatchup`). A hole larger than one open can fill is REPORTED with its
 * count and routes the user to the backfill button; it is never quietly fetched.
 */

/** The backfill's dead-run threshold (two fetch timeouts + four intervals): ONE rule for the ONE shared envelope. */
export const CATCHUP_DEAD_AFTER_MS = BACKFILL_DEAD_AFTER_MS;

export interface CatchupDeps {
  now?: Date;
  /** Injected so tests never touch the network (and never wait 1.5 s). */
  fetchOne?: (isoDate: string) => Promise<BhavcopyFetch | null>;
  sleep?: (ms: number) => Promise<void>;
  maxFiles?: number;
}

export type CatchupOutcome =
  | { ok: true; progress: BackfillProgress; plan: CatchupPlan; fetched: number; applied: number; aborted: boolean }
  | { ok: false; reason: "consent" | "already_running" | "nothing_missing"; progress: BackfillProgress; plan: CatchupPlan | null };

/** The consent this job runs under — the daily auto-MTM toggle, re-read from the DB every time. */
export function isAutoMtmEnabled(): boolean {
  try {
    const row = db.select({ autoMtmEnabled: settings.autoMtmEnabled }).from(settings).orderBy(asc(settings.id)).limit(1).all()[0];
    return row?.autoMtmEnabled === true;
  } catch {
    return false;
  }
}

/** What is missing right now, for the panel (Q51 A1: the count and the sentence). */
export interface CatchupStatus {
  windowDays: number;
  missing: number;
  /** How many this open may fetch. */
  perOpen: number;
  line: string;
  /** True when auto-MTM is on and a catch-up would run on the next open. */
  automatic: boolean;
  rateLimitMs: number;
}

export function catchupStatus(now = new Date()): CatchupStatus {
  const plan = planCatchup({
    rowsByDate: existingRowsByDate(),
    fullSessionMinRows: FULL_SESSION_MIN_ROWS,
    now,
    windowDays: BACKFILL_MAX_DAYS,
    maxFiles: CATCHUP_MAX_FILES,
  });
  return {
    windowDays: BACKFILL_MAX_DAYS,
    missing: plan.missing.length,
    perOpen: CATCHUP_MAX_FILES,
    line: missingSessionsLine(plan.missing.length, BACKFILL_MAX_DAYS),
    automatic: isAutoMtmEnabled(),
    rateLimitMs: BACKFILL_RATE_LIMIT_MS,
  };
}

/** Which of the given sessions are missing from `price_history` (for a window's gap line). */
export function missingAmong(dates: string[]): string[] {
  const rows = existingRowsByDate();
  return dates.filter((d) => (rows.get(d) ?? 0) < FULL_SESSION_MIN_ROWS);
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Fetch up to `CATCHUP_MAX_FILES` missing sessions. Returns when the slice is
 * done, aborted or refused; the ROUTE fires it with `void` so the app-open
 * response never waits on it.
 */
export async function runBhavcopyCatchup(deps: CatchupDeps = {}): Promise<CatchupOutcome> {
  const now = deps.now ?? new Date();
  const fetchOne = deps.fetchOne ?? fetchBhavcopyForDate;
  const sleep = deps.sleep ?? realSleep;

  if (!isAutoMtmEnabled()) {
    return { ok: false, reason: "consent", progress: readBackfillProgress(), plan: null };
  }
  // A6 (ii): the process-level lock SHARED with the backfill button, taken
  // before the envelope is read. Two windows can POST /api/mtm/auto within
  // seconds of each other (AutoMtmRunner dedupes per TAB), and both would read
  // an idle envelope before either wrote `running`.
  if (!takeBhavcopyJobLock()) {
    return { ok: false, reason: "already_running", progress: readBackfillProgress(), plan: null };
  }
  try {
    const existing = readBackfillProgress();
    if (existing.status === "running") {
      if (!isEnvelopeDead(existing, Date.now(), CATCHUP_DEAD_AFTER_MS)) {
        return { ok: false, reason: "already_running", progress: existing, plan: null };
      }
      // A6 (i): the app was closed mid-run. Reset, and say so.
      writeBackfillProgress({
        ...existing,
        status: "error",
        abortRequested: false,
        message: `A previous run stopped without finishing (last touched ${existing.updatedAt ?? "unknown"}); cleared so a new one can start. Nothing already saved was lost.`,
      });
    }

    const plan = planCatchup({
      rowsByDate: existingRowsByDate(),
      fullSessionMinRows: FULL_SESSION_MIN_ROWS,
      now,
      windowDays: BACKFILL_MAX_DAYS,
      maxFiles: deps.maxFiles ?? CATCHUP_MAX_FILES,
    });
    if (plan.plan.length === 0) {
      return { ok: false, reason: "nothing_missing", progress: readBackfillProgress(), plan };
    }

    const remainder = plan.missing.length - plan.plan.length;
    let progress: BackfillProgress = {
      ...IDLE_PROGRESS,
      kind: "catchup",
      status: "running",
      requested: plan.plan.length,
      from: plan.plan[0] ?? null,
      to: plan.plan[plan.plan.length - 1] ?? null,
      startedAt: new Date().toISOString(),
      message:
        `Catching up ${plan.plan.length} of ${plan.missing.length} missing session${plan.missing.length === 1 ? "" : "s"}, ` +
        `one file every ${BACKFILL_RATE_LIMIT_MS / 1000}s.`,
    };
    writeBackfillProgress(progress);
    const persist = () => {
      if (readBackfillProgress().abortRequested) progress = { ...progress, abortRequested: true };
      writeBackfillProgress(progress);
    };

    let fetched = 0;
    let applied = 0;
    for (const date of plan.plan) {
      // A6 (iii): consent AND abort are re-read from the DATABASE before every file.
      if (!isAutoMtmEnabled()) {
        progress = { ...progress, status: "aborted", message: `Stopped at ${date} — auto-MTM was turned off.` };
        writeBackfillProgress(progress);
        return { ok: true, progress, plan, fetched, applied, aborted: true };
      }
      if (progress.abortRequested || readBackfillProgress().abortRequested) {
        progress = { ...progress, status: "aborted", abortRequested: true, message: `Stopped at ${date} — you asked it to stop.` };
        writeBackfillProgress(progress);
        return { ok: true, progress, plan, fetched, applied, aborted: true };
      }

      if (fetched > 0) await sleep(BACKFILL_RATE_LIMIT_MS);
      fetched++;

      // HEARTBEAT before the fetch (see the backfill's loop): the stamp used to
      // be written only after the apply, so two slow attempts left the envelope
      // silent for ~31 s and it read as dead.
      progress = { ...progress, message: `Fetching ${date}…` };
      persist();

      let got: BhavcopyFetch | null = null;
      try {
        got = await fetchOne(date);
      } catch {
        got = null;
      }
      if (!got) {
        progress = { ...progress, attempted: progress.attempted + 1, missing: progress.missing + 1, lastDate: date, message: `No file for ${date} (holiday, or the archive did not answer).` };
        persist();
        continue;
      }
      const result = applyBhavcopyMtm(got.text);
      if (result.ok) applied++;
      progress = {
        ...progress,
        attempted: progress.attempted + 1,
        applied: progress.applied + (result.ok ? 1 : 0),
        missing: progress.missing + (result.ok ? 0 : 1),
        rows: progress.rows + result.historyRows,
        lastDate: date,
        lastSource: got.source,
        message: result.ok ? `${date}: ${result.historyRows} bars saved (${got.source}).` : `${date}: fetched but not applied — ${result.message}`,
      };
      persist();
    }

    progress = {
      ...progress,
      status: "done",
      message:
        `Catch-up finished: ${progress.applied} of ${plan.plan.length} session${plan.plan.length === 1 ? "" : "s"} fetched, ` +
        `${progress.missing} had no file. ${progress.rows} price rows saved.` +
        (remainder > 0 ? ` ${remainder} more session${remainder === 1 ? "" : "s"} still missing — run the backfill for the rest.` : ""),
    };
    writeBackfillProgress(progress);
    return { ok: true, progress, plan, fetched, applied, aborted: false };
  } finally {
    releaseBhavcopyJobLock();
  }
}
