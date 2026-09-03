import { todayIstIso } from "@/lib/domain/trading-day";
import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  accounts,
  settings,
  trades,
  tradeLegs,
  tradeAttachments,
  importBatches,
  ipos,
  ledgerEntries,
  tradingSessions,
  capitalSnapshots,
  capitalGoals,
  bfLossLots,
  weeklyReviews,
  advanceTaxChallans,
  brokerConnections,
  panelDismissals,
} from "@/lib/db/schema";
import { recordAudit, recordAuditMany } from "@/lib/audit";
import { writeTrashSnapshot, stashAttachmentFiles } from "@/lib/trash";
import { forEachIdChunk, collectIdChunks } from "./delete";

/**
 * Deleting a whole account — the v3.1 headline.
 *
 * Two modes, both preceded by a server-computed preview so the confirmation
 * dialog shows the true blast radius:
 *
 *   purge — everything the account owns is removed: rows in all twelve
 *     account-scoped tables (trades, import_batches, ipos, ledger_entries,
 *     trading_sessions, capital_snapshots, capital_goals, bf_loss_lots,
 *     weekly_reviews, advance_tax_challans,
 *     broker_connections, panel_dismissals), the per-trade children (trade_legs,
 *     trade_attachments + their files on disk) and finally the accounts row.
 *     A trash snapshot is written FIRST (no snapshot, no delete — the same
 *     promise lib/queries/delete.ts makes), carrying the account row itself
 *     AND the destroyed scoped rows (ipos, ledger, imports, sessions, capital
 *     history, weekly reviews) so restore can recreate the whole book. Broker connections are
 *     never snapshotted — credentials stay out of trash files — and panel
 *     dismissals are regenerable, so both are genuinely unrecoverable.
 *
 *   merge — the account's journal moves into another account by account-keyed
 *     UPDATE ... WHERE account_id = ? statements, so trade ids never change
 *     and every child link (trade_legs, trade_attachments, ipos.tradeId,
 *     ledger_entries.refTradeId) survives untouched. Trades carry
 *     UNIQUE(account_id, broker, dedup_hash): colliding source trades are
 *     snapshotted and deleted, and the skip count is reported — a silent drop
 *     would make the merge look lossless when it was not.
 *
 * ── Account scoping is an EXPLICIT parameter here, deliberately ─────────────
 *
 * Every ordinary read goes through getSelectedAccountId() /
 * getWriteAccountId() (invariant 8). This module does NOT: the account being
 * deleted is almost never the account being viewed, and getSelectedAccountId
 * is request-cached — resolving it mid-delete could hand back the id this
 * very transaction is removing. The route passes the target id explicitly,
 * and target validation mirrors getWriteAccountId (integer > 0, present in
 * the accounts table).
 *
 * ── What merge does to capital (documented choice) ──────────────────────────
 *
 * `accounts.pnlRolledIn` records realised P&L already compounded into THAT
 * account's capital (lib/queries/capital.ts, migration 0044). After a merge
 * the target's realised total grows by exactly the net realised P&L of the
 * trades that MOVED — the dedup collisions are deleted, so their P&L never
 * reaches the target. The marker carried into the target is therefore
 *
 *     carried = min(source.pnlRolledIn, max(0, net realised P&L of moved trades))
 *
 * and the target's marker becomes target.pnlRolledIn + carried. Carrying the
 * FULL source marker was the original design and it was wrong: when dedup
 * collisions kept realised P&L out of the target, the target's marker exceeded
 * its realised total and "available to compound" went NEGATIVE — a click on
 * Compound would then have applied a withdrawal (compoundRealised now refuses
 * a negative figure as a second line of defence). The uncarried share of the
 * source's marker is not lost: it is recorded in the trash envelope
 * (`merge.carried`), and restoring the snapshot recreates the source with
 * pnlRolledIn = original − carried while subtracting `carried` back out of the
 * target's marker (floored at 0). The source's equity/active capital figures
 * are NOT added to the target: capital is the user's own statement of what
 * each book holds, not something a merge may fabricate; the figures are
 * preserved in the trash snapshot's account row.
 *
 * ── What happens to capital GOALS (v3.6, documented choice) ─────────────────
 *
 * `capital_goals` rows do NOT merge and do NOT sum. A goal is the user's own
 * statement about ONE book's expected capital, frozen against that book's
 * baseline — adding two accounts' targets would fabricate a goal nobody set,
 * exactly as summing their capital would. On merge (and purge) the source's
 * goals are DELETED, the preview says so, and — like panel_dismissals — they
 * are not snapshotted: a goal is one row the user can restate in seconds, and
 * keeping the trash envelope's shape stable is worth more than carrying it.
 *
 * ── What happens to B/F LOSS LOTS (v3.6, documented choice) ─────────────────
 *
 * `bf_loss_lots` rows are the OPPOSITE of goals: not aspirations, but
 * STATEMENTS OF FACT about a demat account's filed ITR history — a loss the
 * Act lets that book set off for years to come. Merging two journal accounts
 * merges their books, so the facts follow the trades: on merge the source's
 * lots MOVE to the target wherever the target has no (incurred_fy, head) row.
 * Where BOTH accounts recorded the same vintage, the two rows are two
 * transcriptions of possibly the SAME filed loss — summing them could double-
 * count one return, and dropping the source could lose a genuinely larger
 * remainder. The LARGER amount survives (never lose a recorded loss, never
 * fabricate a sum), the collision is written into the surviving row's note
 * AND the audit log, and the preview names every colliding vintage so the
 * user can correct the figure against the actual return. originalAmount on a
 * collision keeps the larger non-null figure by the same logic. On purge the
 * lots are deleted and, like goals, NOT snapshotted — a handful of rows the
 * user restates from filed ITRs in seconds.
 *
 * ── What happens to WEEKLY REVIEWS (v3.7, documented choice) ────────────────
 *
 * `weekly_reviews` rows carry the user's OWN PROSE — the note they sat down
 * and wrote about a week of their trading. That makes them the one v3.6/v3.7
 * scoped table that IS snapshotted (goals and b/f lots are a line of numbers
 * each; a paragraph someone wrote is not restatable "in seconds"). On merge
 * they MOVE, because the trades they describe move. Where BOTH accounts wrote
 * a review of the SAME ISO week the unique index allows only one, and the
 * TARGET'S ROW WINS — it is the book that survives — but the source's note is
 * APPENDED to it under a dated "merged from …" line rather than dropped: a
 * sentence the user wrote is never silently destroyed. `completed_at` and
 * `score_at_completion` stay the TARGET's; they are facts about what the
 * target's owner saw and did, and they cannot be merged.
 *
 * ── What happens to ADVANCE-TAX CHALLANS (v3.7, documented choice) ──────────
 *
 * `advance_tax_challans` follow the b/f-lot rule exactly, because they are the
 * same class of thing: STATEMENTS OF FACT about money that really left a bank
 * account. On merge they MOVE with the trades — and unconditionally, since the
 * table deliberately carries no unique key (a challan serial is unique only
 * per BSR code, and both are optional), so there is no such thing as a
 * colliding challan. On purge they are deleted and NOT snapshotted, like the
 * lots: the user holds the receipts these were transcribed from.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

export type AccountDeleteMode = "purge" | "merge";
export type ConnectionsChoice = "delete" | "move";

export interface AccountDeleteCounts {
  trades: number;
  legs: number;
  attachments: number;
  importBatches: number;
  ipos: number;
  ledgerEntries: number;
  tradingSessions: number;
  capitalSnapshots: number;
  capitalGoals: number;
  bfLossLots: number;
  weeklyReviews: number;
  advanceTaxChallans: number;
  brokerConnections: number;
  panelDismissals: number;
}

export interface AccountDeletePreview {
  ok: boolean;
  message: string;
  accountName?: string;
  targetName?: string | null;
  counts?: AccountDeleteCounts;
  /** merge: source trades whose (broker, dedup_hash) already exist in the target — skipped, not moved. */
  dedupCollisions?: number;
  /** merge: source sessions whose date the target already has — discarded on move. */
  sessionCollisions?: number;
  warnings?: string[];
}

export interface AccountDeleteResult {
  ok: boolean;
  message: string;
  mode: AccountDeleteMode;
  snapshotId: string | null;
  counts?: AccountDeleteCounts;
  /** merge: dedup-colliding source trades removed instead of moved. */
  skippedTrades: number;
  /** merge: source sessions discarded because the target already had that date. */
  discardedSessions: number;
  movedConnections: number;
  /** merge + move: brokers whose connection could not move (target already connected). */
  skippedConnections: string[];
  orphanedFiles: string[];
}

type AccountRow = typeof accounts.$inferSelect;

interface ResolvedOk { ok: true; account: AccountRow; target: AccountRow | null }
interface ResolvedErr { ok: false; message: string }

/**
 * Shared validation for preview and delete. Refusals, in order:
 * the account must exist; deleting it must leave at least one LIVE account
 * (the archive path's D8 lesson — selection needs somewhere to go); merge
 * needs a target that is a real, different account (0 and the synthetic
 * aggregate are views, not places — invariant 9).
 */
function resolve(accountId: number, mode: AccountDeleteMode, targetId?: number | null): ResolvedOk | ResolvedErr {
  if (!Number.isInteger(accountId) || accountId <= 0) return { ok: false, message: "That is not an account." };
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) return { ok: false, message: "That account no longer exists." };

  const liveOthers = db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.archived, false))
    .all()
    .filter((a) => a.id !== accountId);
  if (liveOthers.length === 0) {
    return { ok: false, message: "This is the last live account — the journal needs at least one. Create or unarchive another account first." };
  }

  if (mode === "merge") {
    if (targetId == null || !Number.isInteger(targetId) || targetId <= 0) {
      return { ok: false, message: "Merging needs a destination account." };
    }
    if (targetId === accountId) {
      return { ok: false, message: "An account cannot be merged into itself." };
    }
    const target = db.select().from(accounts).where(eq(accounts.id, targetId)).get();
    if (!target) return { ok: false, message: "The destination account no longer exists." };
    return { ok: true, account, target };
  }

  return { ok: true, account, target: null };
}

/** count(*) of one account-scoped table. */
function countRows(table: { accountId: unknown }, accountId: number): number {
  const t = table as unknown as typeof importBatches; // any table with accountId — shape only
  return db.select({ n: sql<number>`count(*)` }).from(t).where(eq(t.accountId, accountId)).get()?.n ?? 0;
}

function gatherCounts(accountId: number): AccountDeleteCounts {
  const legs = (db.get(
    sql`select count(*) as n from ${tradeLegs} where trade_id in (select id from ${trades} where account_id = ${accountId})`,
  ) as { n: number }).n;
  const attachments = (db.get(
    sql`select count(*) as n from ${tradeAttachments} where trade_id in (select id from ${trades} where account_id = ${accountId})`,
  ) as { n: number }).n;
  return {
    trades: countRows(trades, accountId),
    legs,
    attachments,
    importBatches: countRows(importBatches, accountId),
    ipos: countRows(ipos, accountId),
    ledgerEntries: countRows(ledgerEntries, accountId),
    tradingSessions: countRows(tradingSessions, accountId),
    capitalSnapshots: countRows(capitalSnapshots, accountId),
    capitalGoals: countRows(capitalGoals, accountId),
    bfLossLots: countRows(bfLossLots, accountId),
    weeklyReviews: countRows(weeklyReviews, accountId),
    advanceTaxChallans: countRows(advanceTaxChallans, accountId),
    brokerConnections: countRows(brokerConnections, accountId),
    panelDismissals: countRows(panelDismissals, accountId),
  };
}

/** merge: source trade ids whose (broker, dedup_hash) the target already holds. */
function dedupCollisionIds(accountId: number, targetId: number): number[] {
  const rows = db.all(
    sql`select s.id as id from ${trades} s join ${trades} t
        on t.account_id = ${targetId} and t.broker = s.broker and t.dedup_hash = s.dedup_hash
        where s.account_id = ${accountId}`,
  ) as { id: number }[];
  return rows.map((r) => r.id);
}

/** merge: source session ids whose date the target already has (UNIQUE account+date). */
function sessionCollisionIds(accountId: number, targetId: number): number[] {
  const rows = db.all(
    sql`select s.id as id from ${tradingSessions} s join ${tradingSessions} t
        on t.account_id = ${targetId} and t.session_date = s.session_date
        where s.account_id = ${accountId}`,
  ) as { id: number }[];
  return rows.map((r) => r.id);
}

/** merge: source b/f loss lots whose (incurred_fy, head) the target already holds (UNIQUE account+fy+head). */
function bfLossCollisions(accountId: number, targetId: number): { sourceId: number; targetId: number; fy: string; head: string }[] {
  const rows = db.all(
    sql`select s.id as sourceId, t.id as targetId, s.incurred_fy as fy, s.head as head
        from ${bfLossLots} s join ${bfLossLots} t
        on t.account_id = ${targetId} and t.incurred_fy = s.incurred_fy and t.head = s.head
        where s.account_id = ${accountId}`,
  ) as { sourceId: number; targetId: number; fy: string; head: string }[];
  return rows.sort((a, b) => a.fy.localeCompare(b.fy) || a.head.localeCompare(b.head));
}

/** merge: source weekly reviews whose ISO week the target also reviewed (UNIQUE account+week). */
function weeklyReviewCollisions(accountId: number, targetId: number): { sourceId: number; targetId: number; weekStart: string }[] {
  const rows = db.all(
    sql`select s.id as sourceId, t.id as targetId, s.week_start as weekStart
        from ${weeklyReviews} s join ${weeklyReviews} t
        on t.account_id = ${targetId} and t.week_start = s.week_start
        where s.account_id = ${accountId}`,
  ) as { sourceId: number; targetId: number; weekStart: string }[];
  return rows.sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

/** merge: source connection brokers the target is already connected to (UNIQUE account+broker). */
function connectionCollisionBrokers(accountId: number, targetId: number): string[] {
  const rows = db.all(
    sql`select s.broker as broker from ${brokerConnections} s join ${brokerConnections} t
        on t.account_id = ${targetId} and t.broker = s.broker
        where s.account_id = ${accountId}`,
  ) as { broker: string }[];
  return rows.map((r) => r.broker).sort();
}

function selectedAccountIdRaw(): number {
  // The raw stored value — NOT getSelectedAccountId(), which is request-cached
  // and resolves 0 to a sole live account; here the literal stored id is what
  // decides whether the selection must move.
  return db.select({ id: settings.selectedAccountId }).from(settings).limit(1).get()?.id ?? 0;
}

export function previewAccountDelete(opts: { accountId: number; mode: AccountDeleteMode; targetId?: number | null }): AccountDeletePreview {
  const r = resolve(opts.accountId, opts.mode, opts.targetId);
  if (!r.ok) return { ok: false, message: r.message };

  const counts = gatherCounts(opts.accountId);
  const warnings: string[] = [];
  let dedupCollisions = 0;
  let sessionCollisions = 0;

  if (selectedAccountIdRaw() === opts.accountId) {
    warnings.push("You are viewing this account right now — the view will switch after the delete.");
  }

  if (r.target) {
    if (r.target.archived) warnings.push(`“${r.target.name}” is archived — the merged journal will live in an archived account.`);
    dedupCollisions = dedupCollisionIds(opts.accountId, r.target.id).length;
    if (dedupCollisions > 0) {
      warnings.push(
        `${dedupCollisions} trade${dedupCollisions === 1 ? " is" : "s are"} already recorded in “${r.target.name}” (same broker and dedup identity) — ${dedupCollisions === 1 ? "it" : "they"} will be skipped and saved to Deleted items, not duplicated.`,
      );
    }
    sessionCollisions = sessionCollisionIds(opts.accountId, r.target.id).length;
    if (sessionCollisions > 0) {
      warnings.push(`${sessionCollisions} trading session${sessionCollisions === 1 ? "" : "s"} share a date with “${r.target.name}” and will be discarded (saved to Deleted items).`);
    }
    if (counts.capitalSnapshots > 0) {
      warnings.push(`${counts.capitalSnapshots} capital checkpoint${counts.capitalSnapshots === 1 ? " is" : "s are"} this account's own history and will not move — discarded (saved to Deleted items).`);
    }
    if (counts.capitalGoals > 0) {
      warnings.push(`${counts.capitalGoals} capital goal${counts.capitalGoals === 1 ? " is" : "s are"} this account's own statement and will not move or sum — removed (not recoverable; set a new goal on “${r.target.name}” if you want one).`);
    }
    if (counts.bfLossLots > 0) {
      const collisions = bfLossCollisions(opts.accountId, r.target.id);
      const moving = counts.bfLossLots - collisions.length;
      if (moving > 0) {
        warnings.push(`${moving} brought-forward loss lot${moving === 1 ? "" : "s"} will move to “${r.target.name}” — they are statements of the demat account's filed history and follow the trades.`);
      }
      if (collisions.length > 0) {
        warnings.push(
          `${collisions.length} brought-forward loss vintage${collisions.length === 1 ? " (" : "s ("}${collisions.map((c) => `${c.fy} ${c.head}`).join(", ")}) exist${collisions.length === 1 ? "s" : ""} on both accounts — the LARGER amount will be kept with a note, never the sum (two entries may transcribe the same filed loss). Check the kept figure against the actual return.`,
        );
      }
    }
    if (counts.weeklyReviews > 0) {
      const weekly = weeklyReviewCollisions(opts.accountId, r.target.id);
      const moving = counts.weeklyReviews - weekly.length;
      if (moving > 0) {
        warnings.push(`${moving} weekly review${moving === 1 ? "" : "s"} will move to “${r.target.name}” — they are your own notes on the weeks these trades were taken.`);
      }
      if (weekly.length > 0) {
        warnings.push(
          `${weekly.length} week${weekly.length === 1 ? "" : "s"} (${weekly.map((c) => c.weekStart).join(", ")}) ${weekly.length === 1 ? "was" : "were"} reviewed on both accounts — “${r.target.name}”'s review is kept and this account's note is APPENDED to it, never dropped.`,
        );
      }
    }
    if (counts.advanceTaxChallans > 0) {
      warnings.push(`${counts.advanceTaxChallans} advance-tax challan${counts.advanceTaxChallans === 1 ? "" : "s"} will move to “${r.target.name}” — they record payments that really happened and follow the trades.`);
    }
    for (const broker of connectionCollisionBrokers(opts.accountId, r.target.id)) {
      warnings.push(`Target already connected to ${broker} — that connection cannot move and will be removed (credentials are not recoverable).`);
    }
  }

  return {
    ok: true,
    message: "",
    accountName: r.account.name,
    targetName: r.target?.name ?? null,
    counts,
    dedupCollisions,
    sessionCollisions,
    warnings,
  };
}

/** Move the sidebar selection off a deleted account, inside the transaction.
 *  Merge prefers the target (that is where the trades went) — but only a LIVE
 *  target: selecting an archived account strands the user in a switcher that
 *  filters it out (defect D8). An archived preferred target falls through to
 *  purge's rule — the default account first, else the first live one. */
function moveSelection(deletedId: number, preferredId: number | null): void {
  if (selectedAccountIdRaw() !== deletedId) return;
  let nextId: number | undefined;
  if (
    preferredId != null &&
    db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.id, preferredId), eq(accounts.archived, false))).get()
  ) {
    nextId = preferredId;
  } else {
    // The deleted row is already gone by the time this runs, so "live" here
    // can no longer include it.
    const live = db.select({ id: accounts.id, isDefault: accounts.isDefault }).from(accounts).where(eq(accounts.archived, false)).all();
    nextId = (live.find((a) => a.isDefault) ?? live[0])?.id;
  }
  if (nextId != null) {
    db.update(settings).set({ selectedAccountId: nextId, updatedAt: new Date().toISOString() }).run();
  }
}

const fail = (mode: AccountDeleteMode, message: string): AccountDeleteResult => ({
  ok: false, message, mode, snapshotId: null, skippedTrades: 0, discardedSessions: 0,
  movedConnections: 0, skippedConnections: [], orphanedFiles: [],
});

export function deleteAccount(opts: {
  accountId: number;
  mode: AccountDeleteMode;
  targetId?: number | null;
  connections: ConnectionsChoice;
  source?: string;
}): AccountDeleteResult {
  const { accountId, mode, connections } = opts;
  const source = opts.source ?? "ui";
  const r = resolve(accountId, mode, opts.targetId);
  if (!r.ok) return fail(mode, r.message);
  const account = r.account;
  const counts = gatherCounts(accountId);

  // ── Which trades are about to be DESTROYED (vs moved) ─────────────────────
  // purge: all of them. merge: only the dedup collisions.
  const doomedIds =
    mode === "purge"
      ? db.select({ id: trades.id }).from(trades).where(eq(trades.accountId, accountId)).all().map((x) => x.id)
      : dedupCollisionIds(accountId, r.target!.id);

  const doomedRows = collectIdChunks(doomedIds, (chunk) => db.select().from(trades).where(inArray(trades.id, chunk)).all());
  const legRows = collectIdChunks(doomedIds, (chunk) => db.select().from(tradeLegs).where(inArray(tradeLegs.tradeId, chunk)).all());
  const attachRows = collectIdChunks(doomedIds, (chunk) => db.select().from(tradeAttachments).where(inArray(tradeAttachments.tradeId, chunk)).all());
  const ledgerRefRows = collectIdChunks(doomedIds, (chunk) =>
    db
      .select({ ledgerId: ledgerEntries.id, tradeId: ledgerEntries.refTradeId })
      .from(ledgerEntries)
      .where(inArray(ledgerEntries.refTradeId, chunk))
      .all(),
  ) as { ledgerId: number; tradeId: number }[];

  const sessionDropIds = mode === "merge" ? sessionCollisionIds(accountId, r.target!.id) : [];
  const connCollisions = mode === "merge" && connections === "move" ? connectionCollisionBrokers(accountId, r.target!.id) : [];
  // merge: vintages recorded on BOTH accounts — resolved keep-larger, full rows
  // gathered up front so the transaction below works from a stable picture.
  const bfCollisions = mode === "merge" ? bfLossCollisions(accountId, r.target!.id) : [];
  const bfRowById = new Map(
    (bfCollisions.length > 0 ? db.select().from(bfLossLots).all() : []).map((row) => [row.id, row]),
  );
  // merge: ISO weeks reviewed on BOTH accounts — the target's row survives and
  // the source's note is appended to it. Gathered up front for the same reason.
  const weeklyCollisions = mode === "merge" ? weeklyReviewCollisions(accountId, r.target!.id) : [];
  const weeklyRowById = new Map(
    (weeklyCollisions.length > 0 ? db.select().from(weeklyReviews).all() : []).map((row) => [row.id, row]),
  );

  // ── Every account-scoped row about to be DESTROYED goes into the snapshot ─
  // purge: all of them. merge: only what the merge discards — the colliding
  // sessions and the source's capital checkpoints (imports/IPOs/ledger MOVE).
  // broker_connections are deliberately NEVER snapshotted (credentials must
  // not enter trash files) and panel_dismissals are regenerable UI state.
  const asRows = (x: unknown) => x as Record<string, unknown>[];
  const destroyedRows = {
    ipos: asRows(mode === "purge" ? db.select().from(ipos).where(eq(ipos.accountId, accountId)).all() : []),
    ledgerEntries: asRows(mode === "purge" ? db.select().from(ledgerEntries).where(eq(ledgerEntries.accountId, accountId)).all() : []),
    importBatches: asRows(mode === "purge" ? db.select().from(importBatches).where(eq(importBatches.accountId, accountId)).all() : []),
    tradingSessions: asRows(
      mode === "purge"
        ? db.select().from(tradingSessions).where(eq(tradingSessions.accountId, accountId)).all()
        : collectIdChunks(sessionDropIds, (chunk) => db.select().from(tradingSessions).where(inArray(tradingSessions.id, chunk)).all()),
    ),
    capitalSnapshots: asRows(db.select().from(capitalSnapshots).where(eq(capitalSnapshots.accountId, accountId)).all()),
    // Weekly reviews are the user's own PROSE, so they are snapshotted where
    // goals and b/f lots are not (module header). purge: all of them. merge:
    // only the source rows a colliding week consumes — the rest MOVE.
    weeklyReviews: asRows(
      mode === "purge"
        ? db.select().from(weeklyReviews).where(eq(weeklyReviews.accountId, accountId)).all()
        : collectIdChunks(weeklyCollisions.map((c) => c.sourceId), (chunk) =>
            db.select().from(weeklyReviews).where(inArray(weeklyReviews.id, chunk)).all(),
          ),
    ),
  };

  // merge: the marker share that follows the trades whose realised P&L
  // actually reaches the target — see the module header for the arithmetic.
  let carried = 0;
  if (mode === "merge") {
    const doomedSet = new Set(doomedIds);
    const movedNet = db
      .select({ id: trades.id, netPnl: trades.netPnl, isOpen: trades.isOpen })
      .from(trades)
      .where(eq(trades.accountId, accountId))
      .all()
      .filter((t) => !doomedSet.has(t.id) && !t.isOpen)
      .reduce((s, t) => s + t.netPnl, 0);
    carried = Math.min(account.pnlRolledIn, Math.max(0, r2(movedNet)));
  }

  // ── The recovery, before anything is touched (no snapshot, no delete) ─────
  // The envelope carries the account row itself, so restore can recreate the
  // book — including its capital fields and pnlRolledIn marker.
  const reason =
    mode === "purge"
      ? `account “${account.name}” deleted`
      : `account “${account.name}” merged into “${r.target!.name}” — duplicates skipped`;
  let snapshotId: string;
  try {
    snapshotId = writeTrashSnapshot({
      trades: doomedRows as unknown as Record<string, unknown>[],
      legs: legRows as unknown as Record<string, unknown>[],
      attachments: attachRows as unknown as Record<string, unknown>[],
      ledgerRefs: ledgerRefRows,
      account: account as unknown as Record<string, unknown> & { id: number; name: string },
      accountRows: destroyedRows,
      merge: mode === "merge" ? { targetId: r.target!.id, targetName: r.target!.name, carried } : undefined,
      reason,
      accountId,
    });
  } catch (e) {
    return fail(mode, `Nothing was deleted — the recovery snapshot could not be saved (${e instanceof Error ? e.message : "unknown error"}). Your journal is unchanged.`);
  }

  let movedConnections = 0;
  try {
    // ONE transaction for the whole operation — a half-deleted account is the
    // failure this shape exists to make impossible.
    db.transaction((tx) => {
      // Audit BEFORE the rows go — one row per destroyed trade, batched.
      recordAuditMany(
        doomedRows.map((t) => ({
          entity: "trade" as const,
          entityId: t.id,
          action: "delete" as const,
          summary: `${t.tradingsymbol} — ${reason}`,
          before: t as unknown as Record<string, unknown>,
          source,
        })),
      );

      // Children of the destroyed trades.
      forEachIdChunk(doomedIds, (chunk) => tx.delete(tradeLegs).where(inArray(tradeLegs.tradeId, chunk)).run());
      forEachIdChunk(doomedIds, (chunk) => tx.delete(tradeAttachments).where(inArray(tradeAttachments.tradeId, chunk)).run());

      if (mode === "purge") {
        // The account's own rows in every scoped table, account-keyed.
        tx.delete(ipos).where(eq(ipos.accountId, accountId)).run();
        tx.delete(ledgerEntries).where(eq(ledgerEntries.accountId, accountId)).run();
        // Any SURVIVING row (another account's) still pointing at a deleted
        // trade is unlinked, not left dangling — same rule as delete.ts.
        forEachIdChunk(doomedIds, (chunk) => tx.update(ipos).set({ tradeId: null }).where(inArray(ipos.tradeId, chunk)).run());
        forEachIdChunk(doomedIds, (chunk) => tx.update(ledgerEntries).set({ refTradeId: null }).where(inArray(ledgerEntries.refTradeId, chunk)).run());
        tx.delete(trades).where(eq(trades.accountId, accountId)).run();
        tx.delete(importBatches).where(eq(importBatches.accountId, accountId)).run();
        tx.delete(tradingSessions).where(eq(tradingSessions.accountId, accountId)).run();
        tx.delete(capitalSnapshots).where(eq(capitalSnapshots.accountId, accountId)).run();
        tx.delete(capitalGoals).where(eq(capitalGoals.accountId, accountId)).run();
        tx.delete(bfLossLots).where(eq(bfLossLots.accountId, accountId)).run();
        tx.delete(weeklyReviews).where(eq(weeklyReviews.accountId, accountId)).run();
        tx.delete(advanceTaxChallans).where(eq(advanceTaxChallans.accountId, accountId)).run();
        tx.delete(brokerConnections).where(eq(brokerConnections.accountId, accountId)).run();
        tx.delete(panelDismissals).where(eq(panelDismissals.accountId, accountId)).run();
      } else {
        const targetId = r.target!.id;
        // Unlink anything pointing at the SKIPPED (deleted) duplicates, then
        // remove them — so the account-keyed moves below cannot violate the
        // dedup unique index.
        forEachIdChunk(doomedIds, (chunk) => tx.update(ipos).set({ tradeId: null }).where(inArray(ipos.tradeId, chunk)).run());
        forEachIdChunk(doomedIds, (chunk) => tx.update(ledgerEntries).set({ refTradeId: null }).where(inArray(ledgerEntries.refTradeId, chunk)).run());
        forEachIdChunk(doomedIds, (chunk) => tx.delete(trades).where(inArray(trades.id, chunk)).run());

        // Account-keyed moves — trade ids never change, so every child link
        // (legs, attachments, ipos.tradeId, ledger refTradeId) survives.
        tx.update(trades).set({ accountId: targetId }).where(eq(trades.accountId, accountId)).run();
        tx.update(importBatches).set({ accountId: targetId }).where(eq(importBatches.accountId, accountId)).run();
        tx.update(ipos).set({ accountId: targetId }).where(eq(ipos.accountId, accountId)).run();
        tx.update(ledgerEntries).set({ accountId: targetId }).where(eq(ledgerEntries.accountId, accountId)).run();

        // Sessions move; a date the target already has is discarded (UNIQUE
        // account+date — two plans for the same day cannot both survive, and
        // the target's own plan wins).
        forEachIdChunk(sessionDropIds, (chunk) => tx.delete(tradingSessions).where(inArray(tradingSessions.id, chunk)).run());
        tx.update(tradingSessions).set({ accountId: targetId }).where(eq(tradingSessions.accountId, accountId)).run();

        // Capital snapshots and panel dismissals are per-book state, not
        // journal data — a checkpoint of the source's capital is meaningless
        // in the target's history, and a dismissal fingerprint no longer
        // matches once the facts merge. Both discard.
        tx.delete(capitalSnapshots).where(eq(capitalSnapshots.accountId, accountId)).run();
        // Goals DROP on merge, never sum — the module-header choice: a goal is
        // one book's own statement, and a summed target is a fabricated one.
        tx.delete(capitalGoals).where(eq(capitalGoals.accountId, accountId)).run();
        tx.delete(panelDismissals).where(eq(panelDismissals.accountId, accountId)).run();

        // B/f loss lots MOVE — statements of the book's filed history follow
        // the trades. A vintage the target also holds keeps the LARGER amount
        // with a note, never the sum (module-header choice: two rows may
        // transcribe the SAME filed loss).
        for (const c of bfCollisions) {
          const src = bfRowById.get(c.sourceId);
          const tgt = bfRowById.get(c.targetId);
          if (!src || !tgt) continue; // gathered pre-tx; cannot happen inside it
          const keptAmount = Math.max(src.amount, tgt.amount);
          const keptOriginal =
            src.originalAmount == null
              ? tgt.originalAmount
              : tgt.originalAmount == null
                ? src.originalAmount
                : Math.max(src.originalAmount, tgt.originalAmount);
          const mergeNote = `merge ${todayIstIso()}: “${account.name}” also recorded this vintage (₹${src.amount}) — kept the larger of the two, not the sum; verify against the filed return`;
          // ONE binding per written value, used by BOTH the UPDATE and the
          // audit snapshot below (the lib/queries/review.ts rule). Computing
          // the note twice, or snapshotting a different key set, is the class-1
          // defect: diffFields (lib/analytics/audit-diff) walks the UNION of
          // the two key sets and normalises a missing key to null, so an
          // `after` of {amount, originalAmount} against a full-row `before`
          // rendered `incurredFy`, `head` and `note` as cleared on a tax
          // carry-forward record that kept all three — and hid the one thing
          // that DID change: the row gaining the merge-provenance sentence.
          const keptNote = tgt.note ? `${tgt.note} · ${mergeNote}` : mergeNote;
          const keptUpdatedAt = new Date().toISOString();
          tx.update(bfLossLots)
            .set({
              amount: keptAmount,
              originalAmount: keptOriginal,
              note: keptNote,
              updatedAt: keptUpdatedAt,
            })
            .where(eq(bfLossLots.id, c.targetId))
            .run();
          tx.delete(bfLossLots).where(eq(bfLossLots.id, c.sourceId)).run();
          recordAudit({
            entity: "bf_loss",
            entityId: c.targetId,
            action: "update",
            summary: `b/f loss ${c.fy} ${c.head} — both accounts held this vintage; kept the larger ₹${keptAmount} (source ₹${src.amount}, target ₹${tgt.amount}), never the sum`,
            // Same shape both sides: the surviving row as it was, and the same
            // row carrying exactly the four values the UPDATE just wrote.
            before: tgt as unknown as Record<string, unknown>,
            after: {
              ...(tgt as unknown as Record<string, unknown>),
              amount: keptAmount,
              originalAmount: keptOriginal,
              note: keptNote,
              updatedAt: keptUpdatedAt,
            },
            source,
          });
        }
        tx.update(bfLossLots).set({ accountId: targetId }).where(eq(bfLossLots.accountId, accountId)).run();

        // Weekly reviews MOVE — the notes describe the weeks these trades were
        // taken in. UNIQUE(account, week): a week BOTH accounts reviewed keeps
        // the TARGET's row (completion and the score it saw are facts about
        // the surviving book) and APPENDS the source's note to it. A sentence
        // the user wrote is never dropped; the source row is then removed and
        // it is in the trash snapshot either way.
        for (const c of weeklyCollisions) {
          const src = weeklyRowById.get(c.sourceId);
          const tgt = weeklyRowById.get(c.targetId);
          if (!src || !tgt) continue; // gathered pre-tx; cannot happen inside it
          const srcNote = (src.note ?? "").trim();
          // ONE binding per written value, shared by the UPDATE and the audit
          // snapshot. `keptNote`/`keptUpdatedAt` fall back to the row's OWN
          // values on the no-source-note path, which is exactly what that path
          // leaves in the column — so the snapshot describes the row that
          // exists rather than a second derivation of it.
          const header = `merged from “${account.name}” (${todayIstIso()}):`;
          const tgtNote = (tgt.note ?? "").trim();
          const keptNote = srcNote
            ? tgtNote
              ? `${tgtNote}\n\n${header}\n${srcNote}`
              : `${header}\n${srcNote}`
            : tgt.note;
          const keptUpdatedAt = srcNote ? new Date().toISOString() : tgt.updatedAt;
          if (srcNote) {
            tx.update(weeklyReviews)
              .set({ note: keptNote, updatedAt: keptUpdatedAt })
              .where(eq(weeklyReviews.id, c.targetId))
              .run();
          }
          tx.delete(weeklyReviews).where(eq(weeklyReviews.id, c.sourceId)).run();
          recordAudit({
            entity: "weekly_review",
            entityId: c.targetId,
            action: "update",
            summary: srcNote
              ? `week ${c.weekStart} — both accounts reviewed it; kept “${r.target!.name}”'s review and appended “${account.name}”'s note`
              : `week ${c.weekStart} — both accounts held a review; “${account.name}”'s carried no note, so “${r.target!.name}”'s is unchanged`,
            // Same shape both sides. The old `after` was {weekStart,
            // appendedFrom, appended} — two of those are not even columns —
            // against a full-row `before`, so diffFields emitted NINE rows,
            // every one of them false: the surviving row read as having lost
            // its `id`, its `accountId`, its completion AND the sentence the
            // user wrote, on the one screen checked after an irreversible
            // merge. The provenance those keys carried is in the summary
            // above; the snapshot's job is the row.
            before: tgt as unknown as Record<string, unknown>,
            after: {
              ...(tgt as unknown as Record<string, unknown>),
              note: keptNote,
              updatedAt: keptUpdatedAt,
            },
            source,
          });
        }
        tx.update(weeklyReviews).set({ accountId: targetId }).where(eq(weeklyReviews.accountId, accountId)).run();

        // Advance-tax challans MOVE unconditionally — statements of fact about
        // real payments (b/f-lot semantics), and the table carries no unique
        // key, so there is no such thing as a colliding challan.
        tx.update(advanceTaxChallans).set({ accountId: targetId }).where(eq(advanceTaxChallans.accountId, accountId)).run();

        if (connections === "move") {
          // UNIQUE(account_id, broker): a broker the target already has keeps
          // the TARGET's credentials; the source's copy is removed + reported.
          if (connCollisions.length > 0) {
            tx.delete(brokerConnections)
              .where(and(eq(brokerConnections.accountId, accountId), inArray(brokerConnections.broker, connCollisions)))
              .run();
          }
          movedConnections = tx
            .update(brokerConnections)
            .set({ accountId: targetId, updatedAt: new Date().toISOString() })
            .where(eq(brokerConnections.accountId, accountId))
            .run().changes;
        } else {
          tx.delete(brokerConnections).where(eq(brokerConnections.accountId, accountId)).run();
        }

        // Carry only the marker share whose realised P&L actually moved —
        // never the full marker; see the module header for the arithmetic.
        tx.update(accounts)
          .set({ pnlRolledIn: r2(r.target!.pnlRolledIn + carried), updatedAt: new Date().toISOString() })
          .where(eq(accounts.id, targetId))
          .run();
      }

      tx.delete(accounts).where(eq(accounts.id, accountId)).run();
      moveSelection(accountId, mode === "merge" ? r.target!.id : null);

      recordAudit({
        entity: "account",
        entityId: accountId,
        action: "delete",
        summary:
          mode === "purge"
            ? `${account.name} — deleted with ${counts.trades} trade(s)`
            : `${account.name} — merged into ${r.target!.name} (${counts.trades - doomedIds.length} moved, ${doomedIds.length} duplicate(s) skipped)`,
        before: account as unknown as Record<string, unknown>,
        source,
      });
    });
  } catch (e) {
    return fail(mode, `Nothing was deleted — ${e instanceof Error ? e.message : "unknown error"}. Your journal is unchanged.`);
  }

  // Attachment BYTES only after the commit, moved into the snapshot — the
  // rows are recoverable, so the screenshots must be too (invariant 10).
  const { failed } = stashAttachmentFiles(snapshotId, attachRows.map((a) => a.storedName));

  const message =
    mode === "purge"
      ? `Deleted account “${account.name}” — ${counts.trades} trade${counts.trades === 1 ? "" : "s"} and everything it owned. Trades, imports, IPOs, ledger, sessions, capital history and weekly reviews are recoverable from Backup & Restore → Deleted items; broker API credentials, capital goals, brought-forward loss lots, advance-tax challans and panel dismissals are not.` +
        (failed.length ? ` ${failed.length} attachment file${failed.length === 1 ? "" : "s"} could not be moved into the snapshot.` : "")
      : `Merged “${account.name}” into “${r.target!.name}” — ${counts.trades - doomedIds.length} trade${counts.trades - doomedIds.length === 1 ? "" : "s"} moved` +
        (doomedIds.length ? `, ${doomedIds.length} duplicate${doomedIds.length === 1 ? "" : "s"} skipped (saved to Deleted items)` : "") +
        (sessionDropIds.length ? `, ${sessionDropIds.length} same-day session${sessionDropIds.length === 1 ? "" : "s"} discarded (saved to Deleted items)` : "") +
        (counts.capitalSnapshots ? `, ${counts.capitalSnapshots} capital checkpoint${counts.capitalSnapshots === 1 ? "" : "s"} discarded (saved to Deleted items)` : "") +
        (counts.capitalGoals ? `, ${counts.capitalGoals} capital goal${counts.capitalGoals === 1 ? "" : "s"} removed (goals never merge — set a new one on the target)` : "") +
        (counts.bfLossLots
          ? `, ${counts.bfLossLots - bfCollisions.length} b/f loss lot${counts.bfLossLots - bfCollisions.length === 1 ? "" : "s"} moved` +
            (bfCollisions.length ? ` and ${bfCollisions.length} shared vintage${bfCollisions.length === 1 ? "" : "s"} kept at the larger amount (noted on the row — verify against the filed return)` : "")
          : "") +
        (counts.weeklyReviews
          ? `, ${counts.weeklyReviews - weeklyCollisions.length} weekly review${counts.weeklyReviews - weeklyCollisions.length === 1 ? "" : "s"} moved` +
            (weeklyCollisions.length ? ` and ${weeklyCollisions.length} shared week${weeklyCollisions.length === 1 ? "" : "s"} kept on the target with this account's note appended` : "")
          : "") +
        (counts.advanceTaxChallans ? `, ${counts.advanceTaxChallans} advance-tax challan${counts.advanceTaxChallans === 1 ? "" : "s"} moved` : "") +
        (connections === "move" ? `, ${movedConnections} connection${movedConnections === 1 ? "" : "s"} moved` : "") +
        (connCollisions.length ? `, ${connCollisions.length} connection${connCollisions.length === 1 ? "" : "s"} removed (target already connected — credentials are not recoverable)` : "") +
        (connections === "delete" && counts.brokerConnections ? `, ${counts.brokerConnections} connection${counts.brokerConnections === 1 ? "" : "s"} deleted (credentials are not recoverable)` : "") +
        ".";

  return {
    ok: true,
    message,
    mode,
    snapshotId,
    counts,
    skippedTrades: mode === "merge" ? doomedIds.length : 0,
    discardedSessions: sessionDropIds.length,
    movedConnections,
    skippedConnections: connCollisions,
    orphanedFiles: failed,
  };
}
