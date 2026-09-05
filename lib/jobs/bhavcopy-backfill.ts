import "server-only";
import { sqlite } from "@/lib/db";
import { applyBhavcopyMtm } from "@/lib/import/mtm-bhavcopy";
import { latestBhavcopyDate, previousTradingDay } from "@/lib/domain/trading-day";
import { fetchBhavcopyForDate, type BhavcopyFetch } from "@/lib/jobs/auto-mtm";

/**
 * The one-time history backfill (research answer Q43).
 *
 * WHY THIS EXISTS: every Atlas figure is computed from bars the user already
 * has, and a fresh install has one session. %>SMA200 needs 200, the 52-week
 * high needs 252, the 3-month return needs 64 — so a new user's Atlas is
 * almost entirely "needs N sessions, you have 1". This walks BACK through the
 * same NSE archive `auto-mtm.ts` already uses and fills `price_history`.
 *
 * FIVE PROPERTIES THAT ARE NOT NEGOTIABLE:
 *
 *  1. USER-INITIATED. Nothing here runs on a timer, on launch, or as a side
 *     effect of opening a page. `hasBackfillConsent()` gates every run and the
 *     route turns a missing consent into a 403, not a silent no-op.
 *  2. RATE-LIMITED. One request per {@link BACKFILL_RATE_LIMIT_MS}, strictly
 *     sequential. 252 files at 1.5 s is ~6.5 minutes and looks like a person
 *     browsing an archive; a parallel burst looks like a scraper and is how a
 *     free public archive stops being free and public for everyone.
 *  3. NO NEW HOST. The fetch is `fetchBhavcopyForDate` in auto-mtm.ts — the
 *     same host, the same headers, the same fallback. This module makes no
 *     network call of its own, which is also why `tests/egress-guard.test.ts`
 *     has nothing new to allow.
 *  4. ABORTABLE AND RESUMABLE. The abort flag and the progress both live in
 *     the database, so a second request can stop a run and a reload (or a
 *     restart) can still see where it got to. Dates already holding a full
 *     session are skipped, so a re-run costs nothing.
 *  5. HONEST COUNTS. `applied`, `skipped` and `missing` are three different
 *     facts and are never summed into one "done" number: a market holiday
 *     (no file, ever) and a blocked download are not the same event, and the
 *     ledger on the Coverage tab is what the user reads afterwards.
 */

/** One request per 1.5 s. See property 2 above. */
export const BACKFILL_RATE_LIMIT_MS = 1_500;
/** 252 sessions ~ one year: exactly what the 52-week high/low window needs. */
export const BACKFILL_DEFAULT_DAYS = 252;
/** The privacy sheet says "up to 252 past files"; the code must not exceed it. */
export const BACKFILL_MAX_DAYS = 252;
/**
 * Stop after this many CONSECUTIVE dates with no file. Holidays come in ones
 * and twos (Diwali week is the worst case at three sessions plus a weekend);
 * ten in a row means blocked, offline or the archive moved, and grinding
 * through 242 more requests to discover that is neither polite nor useful.
 */
export const BACKFILL_MAX_CONSECUTIVE_MISSES = 10;
/**
 * A date already holding this many `price_history` rows is a full session and
 * is skipped. A manual MTM paste for a handful of held names leaves a few rows
 * on a date and must NOT be mistaken for a bhavcopy; a real NSE cash file
 * carries ~2,000.
 */
export const FULL_SESSION_MIN_ROWS = 500;

export type BackfillStatus = "idle" | "running" | "done" | "aborted" | "error";

/** Versioned envelope, the AGENTS.md stored-JSON convention. */
export interface BackfillProgress {
  v: 1;
  status: BackfillStatus;
  /** Sessions the run was asked for. */
  requested: number;
  /** Dates walked so far (applied + skipped + missing). */
  attempted: number;
  /** Files fetched and written. */
  applied: number;
  /** Dates that already held a full session. */
  skipped: number;
  /** Dates with no file — holiday, or the archive did not answer. */
  missing: number;
  /** `price_history` rows written across the run. */
  rows: number;
  /** Newest and oldest date in the plan, and the last one touched. */
  from: string | null;
  to: string | null;
  lastDate: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  /** Set by a second request; the loop reads it from the DB every iteration. */
  abortRequested: boolean;
  /** Which file answered last — `udiff` or `legacy` (Q48). */
  lastSource: "udiff" | "legacy" | null;
  message: string;
}

export const IDLE_PROGRESS: BackfillProgress = {
  v: 1,
  status: "idle",
  requested: 0,
  attempted: 0,
  applied: 0,
  skipped: 0,
  missing: 0,
  rows: 0,
  from: null,
  to: null,
  lastDate: null,
  startedAt: null,
  updatedAt: null,
  abortRequested: false,
  lastSource: null,
  message: "No backfill has been run on this machine.",
};

// ---------------------------------------------------------------------------
// Settings access.
//
// The two columns (migration 0066) are read and written with raw SQL rather
// than through the drizzle table object: this wave owns the migration but not
// `lib/db/schema.ts`, and a wave that edits a cross-cutting file another wave
// also edits is how two agents clobber each other. The reads are defensive —
// a database that has not run 0066 yet reports "idle" instead of throwing.
// ---------------------------------------------------------------------------

interface SettingsConsentRow {
  id: number;
  auto_mtm_enabled: number;
  bhavcopy_backfill_ack: string | null;
  bhavcopy_backfill_progress: string | null;
}

function settingsRow(): SettingsConsentRow | null {
  try {
    const row = sqlite
      .prepare(
        "SELECT id, auto_mtm_enabled, bhavcopy_backfill_ack, bhavcopy_backfill_progress FROM settings ORDER BY id LIMIT 1",
      )
      .get() as SettingsConsentRow | undefined;
    return row ?? null;
  } catch {
    return null; // migration 0066 not applied on this database
  }
}

/**
 * Consent: the daily auto-MTM toggle OR the backfill's own acknowledgement.
 *
 * Auto-MTM counts because it is consent to the SAME host and the same file
 * family, already given; asking twice for strictly less would be theatre. The
 * separate ack exists for the user who wants the history WITHOUT turning on a
 * daily download — the two questions are genuinely different.
 */
export function hasBackfillConsent(): boolean {
  const row = settingsRow();
  if (!row) return false;
  return row.auto_mtm_enabled === 1 || !!row.bhavcopy_backfill_ack;
}

/** Record the explicit acknowledgement. Stores WHEN, so it is auditable. */
export function recordBackfillAck(at = new Date().toISOString()): void {
  const row = settingsRow();
  if (!row) return;
  sqlite.prepare("UPDATE settings SET bhavcopy_backfill_ack = ? WHERE id = ?").run(at, row.id);
}

/** The persisted run state; `IDLE_PROGRESS` when there is none or it is alien. */
export function readBackfillProgress(): BackfillProgress {
  const row = settingsRow();
  if (!row?.bhavcopy_backfill_progress) return IDLE_PROGRESS;
  try {
    const parsed = JSON.parse(row.bhavcopy_backfill_progress) as Partial<BackfillProgress>;
    // A shape from a future version is DISCARDED, never half-read.
    if (parsed?.v !== 1) return IDLE_PROGRESS;
    return { ...IDLE_PROGRESS, ...parsed, v: 1 };
  } catch {
    return IDLE_PROGRESS;
  }
}

export function writeBackfillProgress(p: BackfillProgress): void {
  const row = settingsRow();
  if (!row) return;
  const json = JSON.stringify({ ...p, updatedAt: new Date().toISOString() });
  sqlite.prepare("UPDATE settings SET bhavcopy_backfill_progress = ? WHERE id = ?").run(json, row.id);
}

/** Ask a running backfill to stop after the file it is on. */
export function requestBackfillAbort(): BackfillProgress {
  const current = readBackfillProgress();
  if (current.status !== "running") return current;
  const next: BackfillProgress = { ...current, abortRequested: true, message: "Stopping after the current file…" };
  writeBackfillProgress(next);
  return next;
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

export interface BackfillDeps {
  /** Sessions to walk back. Clamped to `BACKFILL_MAX_DAYS`. */
  days?: number;
  now?: Date;
  /** Injected so tests never touch the network (and never wait 1.5 s). */
  fetchOne?: (isoDate: string) => Promise<BhavcopyFetch | null>;
  sleep?: (ms: number) => Promise<void>;
}

export type BackfillOutcome =
  | { ok: true; progress: BackfillProgress }
  | { ok: false; reason: "consent" | "already_running"; progress: BackfillProgress };

/** The dates a run would walk, newest first. Pure enough to test on its own. */
export function backfillDates(now: Date, days: number): string[] {
  const out: string[] = [];
  let date = latestBhavcopyDate(now);
  for (let i = 0; i < days; i++) {
    out.push(date);
    date = previousTradingDay(date);
  }
  return out;
}

/** date → how many `price_history` rows it already holds. */
function existingRowsByDate(): Map<string, number> {
  const rows = sqlite.prepare("SELECT date, COUNT(*) AS n FROM price_history GROUP BY date").all() as {
    date: string;
    n: number;
  }[];
  return new Map(rows.map((r) => [r.date, Number(r.n)]));
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Walk back `days` sessions, one file at a time, into `price_history`.
 *
 * Returns when the walk finishes, aborts, or gives up — the ROUTE is what
 * makes it a background job (it does not await this), and the UI polls the
 * progress the loop persists after every date.
 */
export async function runBhavcopyBackfill(deps: BackfillDeps = {}): Promise<BackfillOutcome> {
  if (!hasBackfillConsent()) {
    return { ok: false, reason: "consent", progress: readBackfillProgress() };
  }
  const existing = readBackfillProgress();
  if (existing.status === "running") {
    return { ok: false, reason: "already_running", progress: existing };
  }

  const days = Math.max(1, Math.min(BACKFILL_MAX_DAYS, Math.trunc(deps.days ?? BACKFILL_DEFAULT_DAYS)));
  const now = deps.now ?? new Date();
  const fetchOne = deps.fetchOne ?? fetchBhavcopyForDate;
  const sleep = deps.sleep ?? realSleep;

  const dates = backfillDates(now, days);
  const already = existingRowsByDate();

  let progress: BackfillProgress = {
    ...IDLE_PROGRESS,
    status: "running",
    requested: days,
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
    startedAt: new Date().toISOString(),
    message: `Fetching ${days} session${days === 1 ? "" : "s"}, one file every ${BACKFILL_RATE_LIMIT_MS / 1000}s.`,
  };
  writeBackfillProgress(progress);

  /**
   * Persist the local progress WITHOUT erasing a stop request.
   *
   * The abort flag is written to the database by a different request, at any
   * moment — most likely while this loop is inside a 1.5-second fetch. The
   * local `progress` predates that write, so a plain `writeBackfillProgress`
   * put `abortRequested: false` straight back and the Stop button did nothing
   * for the whole of the next file. Carry the stored flag forward on every
   * write and the loop's own check at the top sees it.
   */
  const persist = () => {
    if (readBackfillProgress().abortRequested) progress = { ...progress, abortRequested: true };
    writeBackfillProgress(progress);
  };

  let consecutiveMisses = 0;
  let fetched = 0;

  for (const date of dates) {
    // The abort flag is re-read from the DATABASE, not from the local copy:
    // the request that sets it is a different request in a different context.
    if (progress.abortRequested || readBackfillProgress().abortRequested) {
      progress = { ...progress, status: "aborted", abortRequested: true, message: `Stopped at ${date} — you asked it to stop.` };
      writeBackfillProgress(progress);
      return { ok: true, progress };
    }

    if ((already.get(date) ?? 0) >= FULL_SESSION_MIN_ROWS) {
      progress = { ...progress, attempted: progress.attempted + 1, skipped: progress.skipped + 1, lastDate: date };
      persist();
      continue;
    }

    // Rate limit BETWEEN requests: the first one goes immediately, so a
    // one-file run never waits, and n files make exactly n-1 waits.
    if (fetched > 0) await sleep(BACKFILL_RATE_LIMIT_MS);
    fetched++;

    let got: BhavcopyFetch | null = null;
    try {
      got = await fetchOne(date);
    } catch {
      got = null; // a throwing fetch is a miss, never a crashed run
    }

    if (!got) {
      consecutiveMisses++;
      progress = {
        ...progress,
        attempted: progress.attempted + 1,
        missing: progress.missing + 1,
        lastDate: date,
        message: `No file for ${date} (holiday, or the archive did not answer).`,
      };
      persist();
      if (consecutiveMisses >= BACKFILL_MAX_CONSECUTIVE_MISSES) {
        progress = {
          ...progress,
          status: "error",
          message: `Stopped at ${date}: ${consecutiveMisses} sessions in a row with no file. You are probably offline or blocked — nothing already saved was lost.`,
        };
        writeBackfillProgress(progress);
        return { ok: true, progress };
      }
      continue;
    }

    consecutiveMisses = 0;
    const applied = applyBhavcopyMtm(got.text);
    progress = {
      ...progress,
      attempted: progress.attempted + 1,
      applied: progress.applied + (applied.ok ? 1 : 0),
      missing: progress.missing + (applied.ok ? 0 : 1),
      rows: progress.rows + applied.historyRows,
      lastDate: date,
      lastSource: got.source,
      message: applied.ok
        ? `${date}: ${applied.historyRows} bars saved (${got.source}).`
        : `${date}: fetched but not applied — ${applied.message}`,
    };
    persist();
  }

  progress = {
    ...progress,
    status: "done",
    message:
      `Backfill finished: ${progress.applied} session${progress.applied === 1 ? "" : "s"} downloaded, ` +
      `${progress.skipped} already had bars, ${progress.missing} had no file. ` +
      `${progress.rows} price rows saved.`,
  };
  writeBackfillProgress(progress);
  return { ok: true, progress };
}
