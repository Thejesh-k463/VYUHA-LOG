import "server-only";
import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { trades, weeklyReviews } from "@/lib/db/schema";
import type { Trade } from "@/lib/db/schema";
import { SLIM_TRADE_FIELDS, type SlimTrade } from "@/lib/domain/slim-trade";
import { getSelectedAccountId, getWriteAccountId } from "./accounts";
import { recordAudit } from "@/lib/audit";

/**
 * Trade Review Desk — queue + weekly ritual (v3.7, WS1).
 *
 * Scoping (invariants 8/9, the bf-losses/goals pattern): every read resolves
 * through getSelectedAccountId() and applies `accountId > 0 ? filter : all`;
 * every write refuses the aggregate view outright, because 0 is a view, not a
 * place. A weekly note and a "reviewed" stamp are both statements about ONE
 * book, and a write landing on "whichever account sorts first" is exactly the
 * silent cross-book bug invariant 9 exists to stop.
 *
 * Refusals over defaults (invariant 6): a week that is not an ISO MONDAY is
 * refused rather than snapped to one — filing a note against a Wednesday puts
 * it in a week the score never covered. `scoreAtCompletion` is refused unless
 * it is an integer 0–100 or an explicit null; NULL is legitimate (under the
 * sample floor the score refuses to exist, and storing 0 would fabricate one).
 *
 * `score_at_completion` is a HISTORICAL FACT — the number the user was looking
 * at when they completed the ritual. Nothing here ever reads it back as the
 * current score, and a re-completion does not rewrite the pair it belongs to.
 *
 * Timestamps use `datetime('now')` (the schema's own `now` default and what
 * migration 0055 backfilled `reviewed_at` from), so one column carries one
 * format.
 */

export type WeeklyReviewRow = typeof weeklyReviews.$inferSelect;

const nowSql = sql`(datetime('now'))`;

/** Default window for the queue — the UI states "showing N of M" over it. */
export const REVIEW_QUEUE_LIMIT = 150;

function pickCols<K extends keyof Trade & keyof typeof trades>(keys: readonly K[]): Pick<typeof trades, K> {
  const out = {} as Pick<typeof trades, K>;
  for (const k of keys) out[k] = trades[k];
  return out;
}

// ---------------------------------------------------------------------------
// Weeks
// ---------------------------------------------------------------------------

/**
 * "YYYY-MM-DD" that is a real calendar date AND an ISO Monday.
 *
 * Deliberately self-contained arithmetic rather than a bucketer import: this
 * module only ever VALIDATES a week label it is handed and derives that week's
 * last day. Which week a TRADE falls in is the analytics layer's business, and
 * the product keeps exactly one bucketer for that.
 */
export function isIsoMonday(weekStart: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return false;
  const d = new Date(`${weekStart}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  if (d.toISOString().slice(0, 10) !== weekStart) return false; // 2026-02-30 → refused
  return d.getUTCDay() === 1;
}

/** Inclusive last day (the Sunday) of the week starting at `weekStart`. */
export function weekEndOf(weekStart: string): string {
  const d = new Date(`${weekStart}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Reads (invariant 8)
// ---------------------------------------------------------------------------

export interface ReviewQueue {
  /** The windowed page, newest close first. */
  rows: SlimTrade[];
  /** The FULL unwindowed count, so the UI can say "showing N of M". */
  total: number;
  /** The window actually applied (echoed so the caller need not re-derive it). */
  limit: number;
}

/**
 * Closed trades this account has not reviewed, newest `sellDate` first.
 *
 * Projected on SLIM_TRADE_FIELDS because each row opens the EXISTING journal
 * dialog, which is typed against `SlimTrade` — a narrower projection would be
 * a compile error there, and a wider one ships columns nothing renders.
 *
 * WINDOWED, and `total` is the unwindowed count: a shortened list is never
 * shown without stating what it held back (invariant 6's sibling rule — the
 * repo does not quietly truncate).
 */
export function getReviewQueue({ limit = REVIEW_QUEUE_LIMIT }: { limit?: number } = {}): ReviewQueue {
  const accountId = getSelectedAccountId();
  const unreviewedClosed = and(eq(trades.isOpen, false), isNull(trades.reviewedAt));
  const where = accountId > 0 ? and(unreviewedClosed, eq(trades.accountId, accountId)) : unreviewedClosed;

  const window = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 5000)) : REVIEW_QUEUE_LIMIT;
  const rows = db
    .select(pickCols(SLIM_TRADE_FIELDS))
    .from(trades)
    .where(where)
    .orderBy(desc(trades.sellDate), desc(trades.createdAt))
    .limit(window)
    .all() as SlimTrade[];
  const total = db.select({ n: sql<number>`count(*)` }).from(trades).where(where).get()?.n ?? 0;
  return { rows, total, limit: window };
}

export interface ReviewStats {
  weekStart: string;
  /** Inclusive Sunday — stated so a caller never re-derives the window. */
  weekEnd: string;
  /** Trades CLOSED inside the week (by `sellDate`). */
  closed: number;
  reviewed: number;
  unreviewed: number;
}

/**
 * The desk header's counts for ONE ISO week.
 *
 * "Closed in the week" is by `sellDate`; a closed trade with no sell date is
 * outside every week rather than bucketed into this one (invariant 6 — a blank
 * is not a date).
 */
export function getReviewStats(weekStart: string): ReviewStats {
  const weekEnd = weekEndOf(weekStart);
  const accountId = getSelectedAccountId();
  const inWeek = and(eq(trades.isOpen, false), gte(trades.sellDate, weekStart), lte(trades.sellDate, weekEnd));
  const where = accountId > 0 ? and(inWeek, eq(trades.accountId, accountId)) : inWeek;
  const agg = db
    .select({
      closed: sql<number>`count(*)`,
      reviewed: sql<number>`sum(case when ${trades.reviewedAt} is null then 0 else 1 end)`,
    })
    .from(trades)
    .where(where)
    .get();
  const closed = agg?.closed ?? 0;
  const reviewed = agg?.reviewed ?? 0;
  return { weekStart, weekEnd, closed, reviewed, unreviewed: closed - reviewed };
}

/**
 * This account's row for one week, or null.
 *
 * The aggregate view returns null DELIBERATELY: a weekly note is one book's
 * prose, so "the" note across accounts does not exist. Returning the first
 * account's row would put someone else's sentences under the aggregate header,
 * and merging several would invent a note nobody wrote. The list below still
 * follows invariant 8's literal form because its rows carry `accountId` and can
 * be labelled; a single row cannot.
 */
export function getWeeklyReview(weekStart: string): WeeklyReviewRow | null {
  const accountId = getSelectedAccountId();
  if (accountId === 0) return null;
  return (
    db
      .select()
      .from(weeklyReviews)
      .where(and(eq(weeklyReviews.accountId, accountId), eq(weeklyReviews.weekStart, weekStart)))
      .get() ?? null
  );
}

/** The history strip: most recent weeks first (aggregate view: every account's). */
export function listWeeklyReviews(limit = 12): WeeklyReviewRow[] {
  const accountId = getSelectedAccountId();
  const q = db.select().from(weeklyReviews);
  const window = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 1000)) : 12;
  return (accountId > 0 ? q.where(eq(weeklyReviews.accountId, accountId)) : q)
    .orderBy(desc(weeklyReviews.weekStart), desc(weeklyReviews.id))
    .limit(window)
    .all();
}

// ---------------------------------------------------------------------------
// Writes (invariant 9 — the aggregate view refuses)
// ---------------------------------------------------------------------------

export interface ReviewWriteResult {
  ok: boolean;
  message: string;
  /** True when the refusal is the aggregate-view write ban (route → 403). */
  forbidden?: boolean;
}

/**
 * The account a review write lands on, or null in the aggregate view.
 *
 * A pre-check rather than a call into the helper alone because the aggregate
 * refusal is a typed RESULT (`forbidden` → 403), not an exception. Since v3.8
 * getWriteAccountId() throws AccountRequiredError on the same condition (its
 * lowest-id fallback is gone), so the two agree by construction.
 */
function reviewWriteAccountId(): number | null {
  if (getSelectedAccountId() === 0) return null;
  return getWriteAccountId();
}

const AGGREGATE_REFUSAL =
  "A review belongs to one account's book — pick an account in the sidebar first. The All-accounts view only reads.";

export interface WeeklyReviewInput {
  /** ISO Monday, "YYYY-MM-DD". */
  weekStart: string;
  /** The user's own prose. Blank clears it; it is never generated. */
  note?: string | null;
  /**
   * true completes the ritual, false reopens it, undefined leaves the
   * completion alone (a mid-week note edit must not complete the week).
   */
  completed?: boolean;
  /** The Process Score SHOWN at completion — history, never read back as current. */
  scoreAtCompletion?: number | null;
}

/**
 * Create or edit this account's row for one ISO week.
 *
 * UNIQUE(account, week): the week does not happen twice, so a second call is an
 * EDIT, never a duplicate row.
 *
 * Completion is recorded ONCE. A re-completion keeps the original
 * `completedAt`/`scoreAtCompletion` pair, because those two are a single
 * historical fact — the moment the user sat down and the number they were
 * looking at then. Editing the note afterwards must not restamp either, and a
 * later import moving the live score must not rewrite what was on screen.
 */
export function upsertWeeklyReview(input: WeeklyReviewInput): ReviewWriteResult {
  const accountId = reviewWriteAccountId();
  if (accountId == null) return { ok: false, forbidden: true, message: AGGREGATE_REFUSAL };

  if (!isIsoMonday(input.weekStart)) {
    return {
      ok: false,
      message: "A weekly review is filed against the ISO Monday of its week (YYYY-MM-DD) — nothing was saved.",
    };
  }
  const score = input.scoreAtCompletion ?? null;
  if (score != null && (!Number.isInteger(score) || score < 0 || score > 100)) {
    return { ok: false, message: "The score at completion must be a whole 0–100, or blank when the week refused to score." };
  }

  const note = input.note?.trim() ? input.note.trim() : null;
  const existing = db
    .select()
    .from(weeklyReviews)
    .where(and(eq(weeklyReviews.accountId, accountId), eq(weeklyReviews.weekStart, input.weekStart)))
    .get();

  // completed === undefined leaves the completion exactly as it was.
  let completedAt = existing?.completedAt ?? null;
  let scoreAtCompletion = existing?.scoreAtCompletion ?? null;
  if (input.completed === true) {
    if (completedAt == null) {
      completedAt = new Date().toISOString();
      scoreAtCompletion = score;
    }
  } else if (input.completed === false) {
    // Reopening withdraws the completion, and the score-THEN belongs to it.
    completedAt = null;
    scoreAtCompletion = null;
  }

  if (existing) {
    db.update(weeklyReviews)
      .set({ note, completedAt, scoreAtCompletion, updatedAt: nowSql })
      .where(eq(weeklyReviews.id, existing.id))
      .run();
  } else {
    db.insert(weeklyReviews)
      .values({ accountId, weekStart: input.weekStart, note, completedAt, scoreAtCompletion })
      .run();
  }

  recordAudit({
    entity: "weekly_review",
    entityId: existing?.id ?? null,
    action: existing ? "update" : "create",
    summary: `weekly review ${completedAt ? "completed" : existing ? "updated" : "started"} — week of ${input.weekStart}`,
    // `weekStart` belongs on BOTH sides or neither: `existing` is looked up BY
    // that week, so it is provably identical, but listing it only on `after`
    // made every note edit render a phantom `weekStart: null → "2026-08-24"`.
    // (On the CREATE path `before` is null, which is the honest "there was
    // nothing" shape rather than a key-set mismatch, so every key showing is
    // correct there.)
    before: existing
      ? { weekStart: existing.weekStart, note: existing.note, completedAt: existing.completedAt, scoreAtCompletion: existing.scoreAtCompletion }
      : null,
    after: { weekStart: input.weekStart, note, completedAt, scoreAtCompletion },
    source: "ui",
  });

  return {
    ok: true,
    message: completedAt ? `Week of ${input.weekStart} reviewed.` : `Saved your note for the week of ${input.weekStart}.`,
  };
}

/** Shared lookup: the trade, only if it is on the account being written to. */
function ownTrade(tradeId: number, accountId: number) {
  return db
    .select({ id: trades.id, symbol: trades.symbol, reviewedAt: trades.reviewedAt, isOpen: trades.isOpen })
    .from(trades)
    .where(and(eq(trades.id, tradeId), eq(trades.accountId, accountId)))
    .get();
}

/**
 * Stamp a trade reviewed. Idempotent: an already-reviewed trade keeps its
 * original stamp, so clicking twice does not move the date the desk shows.
 *
 * CLOSED ONLY, enforced here rather than assumed. The queue only ever lists
 * closed trades, but the queue is a CALLER, not a guarantee: this is an
 * exported write, and the same rule holds at the journal route and in
 * migration 0055's backfill. A stamp on an open trade is permanent — nothing
 * clears it when the position closes except an explicit "Reopen" — so the
 * trade would close already "reviewed", count in the Process Score's
 * `reviewed` component, and never once be looked at as a finished trade.
 * Refused, not silently ignored (invariant 6).
 */
export function markReviewed(tradeId: number): ReviewWriteResult {
  const accountId = reviewWriteAccountId();
  if (accountId == null) return { ok: false, forbidden: true, message: AGGREGATE_REFUSAL };
  const row = ownTrade(tradeId, accountId);
  if (!row) return { ok: false, message: "That trade is not on this account." };
  if (row.isOpen) {
    return { ok: false, message: `${row.symbol} is still open — a review is of a finished trade.` };
  }
  if (row.reviewedAt) return { ok: true, message: `${row.symbol} was already reviewed.` };

  db.update(trades).set({ reviewedAt: nowSql }).where(eq(trades.id, row.id)).run();
  // BOTH sides, or the row says nothing. diffFields (lib/analytics/audit-diff)
  // walks the UNION of the two key sets and normalises a missing key to null,
  // so `before: { reviewedAt: null }` with no `after` at all compares null
  // against null and yields ZERO changes — an audit row that exists, looks
  // complete, and does not contain the one mutation it was written for. Read
  // back rather than recomputed in JS: the value is SQLite's datetime('now'),
  // and a JS clock would log a second-off number for the row it describes.
  const storedReviewedAt =
    db.select({ reviewedAt: trades.reviewedAt }).from(trades).where(eq(trades.id, row.id)).get()?.reviewedAt ?? null;
  recordAudit({
    entity: "trade",
    entityId: row.id,
    action: "update",
    summary: `${row.symbol} marked reviewed`,
    before: { reviewedAt: row.reviewedAt }, // null — the guard above returned otherwise
    after: { reviewedAt: storedReviewedAt },
    source: "ui",
  });
  return { ok: true, message: `${row.symbol} marked reviewed.` };
}

/** Clear the stamp — the trade returns to the queue. */
export function reopenReview(tradeId: number): ReviewWriteResult {
  const accountId = reviewWriteAccountId();
  if (accountId == null) return { ok: false, forbidden: true, message: AGGREGATE_REFUSAL };
  const row = ownTrade(tradeId, accountId);
  if (!row) return { ok: false, message: "That trade is not on this account." };
  if (!row.reviewedAt) return { ok: true, message: `${row.symbol} is already in the queue.` };

  db.update(trades).set({ reviewedAt: null }).where(eq(trades.id, row.id)).run();
  recordAudit({
    entity: "trade",
    entityId: row.id,
    action: "update",
    summary: `${row.symbol} reopened for review`,
    before: { reviewedAt: row.reviewedAt },
    after: { reviewedAt: null },
    source: "ui",
  });
  return { ok: true, message: `${row.symbol} is back in the review queue.` };
}
