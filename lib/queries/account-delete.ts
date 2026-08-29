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
 *   purge — everything the account owns is removed: rows in all eight
 *     account-scoped tables (trades, import_batches, ipos, ledger_entries,
 *     trading_sessions, capital_snapshots, broker_connections,
 *     panel_dismissals), the per-trade children (trade_legs,
 *     trade_attachments + their files on disk) and finally the accounts row.
 *     A trash snapshot is written FIRST (no snapshot, no delete — the same
 *     promise lib/queries/delete.ts makes), carrying the account row itself
 *     AND the destroyed scoped rows (ipos, ledger, imports, sessions, capital
 *     history) so restore can recreate the whole book. Broker connections are
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
        tx.delete(panelDismissals).where(eq(panelDismissals.accountId, accountId)).run();

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
      ? `Deleted account “${account.name}” — ${counts.trades} trade${counts.trades === 1 ? "" : "s"} and everything it owned. Trades, imports, IPOs, ledger, sessions and capital history are recoverable from Backup & Restore → Deleted items; broker API credentials and panel dismissals are not.` +
        (failed.length ? ` ${failed.length} attachment file${failed.length === 1 ? "" : "s"} could not be moved into the snapshot.` : "")
      : `Merged “${account.name}” into “${r.target!.name}” — ${counts.trades - doomedIds.length} trade${counts.trades - doomedIds.length === 1 ? "" : "s"} moved` +
        (doomedIds.length ? `, ${doomedIds.length} duplicate${doomedIds.length === 1 ? "" : "s"} skipped (saved to Deleted items)` : "") +
        (sessionDropIds.length ? `, ${sessionDropIds.length} same-day session${sessionDropIds.length === 1 ? "" : "s"} discarded (saved to Deleted items)` : "") +
        (counts.capitalSnapshots ? `, ${counts.capitalSnapshots} capital checkpoint${counts.capitalSnapshots === 1 ? "" : "s"} discarded (saved to Deleted items)` : "") +
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
