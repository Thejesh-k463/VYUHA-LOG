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
// and the attachment BYTES. It does not put back anything that was derived
// from them and has since moved on: capital snapshots, session reviews and the
// audit log itself are left exactly as they are. The audit log in particular is
// append-only by design — a restore adds to the history, it does not rewrite
// it.

export const TRASH_VERSION = 1;

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
