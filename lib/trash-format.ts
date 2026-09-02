// THE DELETED-TRADES SNAPSHOT FORMAT (PURE, no DB/fs).
//
// Deleting used to be final: the confirmation dialog said so, and
// `restoreDatabase` cannot help because it is whole-database wipe-and-reload —
// it can bring back a night's work only by throwing away everything since.
// That was a fair trade when the only delete was "the row I have selected". It
// is not a fair trade for "every trade in this file" or "everything in this
// date range", which is what the Lenses page and the scope dialogs now offer.
//
// So every delete writes one of these first. It is not a general backup: it
// holds exactly the rows that were about to be removed, and nothing else.
//
// ── Why a folder per snapshot rather than rows in a table ───────────────────
//
// A `deleted_trades` table would be inside the very database the user might be
// about to restore, migrate or corrupt — and it would travel inside backups,
// so restoring a backup would resurrect its trash too. A folder beside the
// database is independent of all of that, survives a restore, and can be
// deleted by hand by someone who has never heard of this app.
//
// ── What is NOT promised ────────────────────────────────────────────────────
//
// Restoring puts back the trade rows, their staged legs, their attachment rows
// and the attachment BYTES — and, for an ACCOUNT-deletion snapshot, the
// destroyed account-scoped rows carried in `accountRows` below. It does not
// put back anything else that was derived from them and has since moved on,
// and the audit log in particular is append-only by design — a restore adds
// to the history, it does not rewrite it. Broker connections are never
// restored because they are never snapshotted (credentials stay out of trash
// files).

// v2 (2026-08-29, account deletion): adds the OPTIONAL `account`, `accountRows`
// and `merge` fields below. The bump is additive — v1 snapshots carry none of
// them and restore exactly as before, because validation accepts any version
// <= TRASH_VERSION and every reader treats the fields as optional.
export const TRASH_VERSION = 2;

export interface TrashEnvelope {
  vyuhaTrash: true;
  v: number;
  /** Snapshot id — also the folder name. */
  id: string;
  deletedAt: string;
  /** The reason recorded on the audit entries, verbatim. */
  reason: string;
  /** The account selected when the delete ran. 0 means the aggregate view. */
  accountId: number;
  counts: { trades: number; legs: number; attachments: number };
  /** Raw rows, exactly as `db.select()` returned them. */
  trades: Record<string, unknown>[];
  legs: Record<string, unknown>[];
  attachments: Record<string, unknown>[];
  /** Attachment `storedName`s whose bytes were moved into the snapshot. */
  files: string[];
  /**
   * Ledger entries whose `refTradeId` pointed at a deleted trade. The entries
   * themselves are KEPT in the journal (they record money that really moved —
   * same reasoning as the IPO unlink) and their ref is set to null; this list
   * is what lets a restore re-point them at the trades it brings back.
   * Optional: snapshots written before 2026-08-12 do not carry it.
   */
  ledgerRefs?: { ledgerId: number; tradeId: number }[];
  /**
   * v2, account deletion only: the `accounts` row that was deleted ALONG WITH
   * these trades — id, name, broker, capital fields, pnlRolledIn and flags,
   * exactly as `db.select()` returned it. Restore recreates the account under
   * its original id when it no longer exists, so the trades land back in their
   * own book instead of pointing at a dead account_id. Absent on ordinary
   * trade deletes and on every v1 snapshot.
   */
  account?: Record<string, unknown> & { id: number; name: string };
  /**
   * v2, account deletion only: rows from the account-scoped tables that were
   * DESTROYED with the account. A purge carries all of them; a merge carries
   * only what the merge discards — the colliding sessions and the source's
   * capital checkpoints (its imports, IPOs and ledger MOVE to the target and
   * need no snapshot). `broker_connections` rows are DELIBERATELY excluded:
   * credentials must never enter a trash file, which is why the delete dialog
   * says they are unrecoverable. `panel_dismissals` are regenerable UI state
   * and are not carried either.
   */
  accountRows?: {
    ipos?: Record<string, unknown>[];
    ledgerEntries?: Record<string, unknown>[];
    importBatches?: Record<string, unknown>[];
    tradingSessions?: Record<string, unknown>[];
    capitalSnapshots?: Record<string, unknown>[];
    /**
     * v3.7: weekly review rows. Carried for the same reason the sessions are —
     * the note is the USER'S OWN PROSE, unlike capital goals or b/f loss lots,
     * which are a line of numbers each and are deliberately not snapshotted.
     * A merge carries only the rows a colliding week consumed (the rest move).
     * Optional, like every key here: snapshots written before v3.7 carry none.
     */
    weeklyReviews?: Record<string, unknown>[];
  };
  /**
   * v2, merge only: how much of the source's `pnlRolledIn` marker was carried
   * into the target — min(source marker, net realised P&L of the trades that
   * actually MOVED), never the full marker (dedup collisions keep their
   * realised P&L out of the target). Restore recreates the source with
   * (original − carried) and subtracts `carried` from the target's marker if
   * the target still exists (floored at 0).
   */
  merge?: { targetId: number; targetName: string; carried: number };
}

/** What the Deleted-items list shows without reading the whole envelope. */
export interface TrashSummary {
  id: string;
  deletedAt: string;
  reason: string;
  accountId: number;
  trades: number;
  legs: number;
  attachments: number;
  /** Distinct symbols, capped — `symbolCount` is the true number. */
  symbols: string[];
  symbolCount: number;
  netPnl: number;
  earliest: string | null;
  latest: string | null;
  /** Bytes on disk, snapshot JSON plus stashed files. */
  sizeBytes: number;
}

/**
 * A filesystem-safe snapshot id built from the delete's own timestamp.
 *
 * The random suffix is not decoration: two deletes inside the same second
 * would otherwise collide on the folder name, and the second would overwrite
 * the first's snapshot — losing the recovery for a delete that reported itself
 * recoverable.
 */
export function trashSnapshotId(deletedAtIso: string, suffix: string): string {
  const stamp = deletedAtIso.replace(/[:.]/g, "-").replace(/[^0-9A-Za-z-]/g, "");
  const safeSuffix = suffix.replace(/[^0-9a-z]/gi, "").slice(0, 8) || "0";
  return `${stamp}-${safeSuffix}`;
}

/**
 * True only for a folder name this module could have produced.
 *
 * Every path that reads or deletes a snapshot runs its id through here first.
 * The id reaches the server from a form field, and `..` or a separator in it
 * would turn "purge this snapshot" into "delete an arbitrary directory".
 */
export function isTrashSnapshotId(id: string): boolean {
  return /^[0-9A-Za-z-]{4,64}$/.test(id) && !id.includes("..");
}

export function validateTrashEnvelope(x: unknown): { ok: boolean; error?: string } {
  if (!x || typeof x !== "object") return { ok: false, error: "Not a snapshot file." };
  const e = x as Partial<TrashEnvelope>;
  if (e.vyuhaTrash !== true) return { ok: false, error: "Not a Vyuha deleted-trades snapshot." };
  if (typeof e.v !== "number") return { ok: false, error: "The snapshot has no version." };
  if (e.v > TRASH_VERSION) {
    return { ok: false, error: `This snapshot was written by a newer version of Vyuha (format ${e.v}, this build reads ${TRASH_VERSION}).` };
  }
  if (!Array.isArray(e.trades)) return { ok: false, error: "The snapshot carries no trades." };
  if (!Array.isArray(e.legs) || !Array.isArray(e.attachments)) return { ok: false, error: "The snapshot is incomplete." };
  if (typeof e.id !== "string" || !isTrashSnapshotId(e.id)) return { ok: false, error: "The snapshot has no usable id." };
  return { ok: true };
}

/** Summarise an envelope for the list, without the caller re-deriving it. */
export function summariseTrash(e: TrashEnvelope, sizeBytes: number): TrashSummary {
  const rows = e.trades as { symbol?: unknown; netPnl?: unknown; buyDate?: unknown; sellDate?: unknown }[];
  const symbols = [...new Set(rows.map((r) => String(r.symbol ?? "")).filter(Boolean))].sort();
  const dates = rows
    .flatMap((r) => [r.buyDate, r.sellDate])
    .filter((d): d is string => typeof d === "string" && d.length > 0)
    .sort();
  const netPnl = rows.reduce((s, r) => s + (typeof r.netPnl === "number" ? r.netPnl : 0), 0);
  return {
    id: e.id,
    deletedAt: e.deletedAt,
    reason: e.reason,
    accountId: e.accountId,
    trades: e.trades.length,
    legs: e.legs.length,
    attachments: e.attachments.length,
    symbols: symbols.slice(0, 6),
    symbolCount: symbols.length,
    netPnl: Math.round(netPnl * 100) / 100,
    earliest: dates[0] ?? null,
    latest: dates[dates.length - 1] ?? null,
    sizeBytes,
  };
}
