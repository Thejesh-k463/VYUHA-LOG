import "server-only";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db, sqlite, trashDir, attachmentsDir } from "@/lib/db";
import { classifyUnsourcedRisk, repriceCapTrades } from "@/lib/queries/risk-cap";
import {
  trades,
  tradeLegs,
  tradeAttachments,
  ledgerEntries,
  accounts,
  ipos,
  importBatches,
  tradingSessions,
  capitalSnapshots,
  weeklyReviews,
  brokerReference,
} from "@/lib/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { recordAudit, type AuditInput } from "@/lib/audit";
import { heldIdentityHashes, readsLong, type RowLegs } from "@/lib/import/close-open-lots";
// L6 (wave 2L): ONE pairing for a record and the holding it became — the restore
// acts on it only where it is unambiguous, Data Quality asks about the rest.
import { uniqueIpoRelinks } from "@/lib/analytics/data-quality";
import {
  TRASH_VERSION,
  trashSnapshotId,
  isTrashSnapshotId,
  validateTrashEnvelope,
  summariseTrash,
  type TrashEnvelope,
  type TrashKind,
  type TrashSummary,
} from "./trash-format";
import {
  ImportSourceError,
  assertAccountExists,
  assertAccountId,
  assertBroker,
} from "@/lib/queries/import-sources";

/**
 * Deleted-trade snapshots — the recovery path for a delete.
 *
 * The shape mirrors `lib/queries/delete.ts` deliberately, because they are two
 * halves of the same promise:
 *
 *   delete  — snapshot BEFORE the transaction, move the bytes AFTER it commits
 *   restore — stage the bytes BEFORE the transaction, swap them in AFTER
 *
 * Both orderings exist so that a failure at any point leaves the database and
 * the files agreeing with each other. A rollback with the bytes already gone is
 * the exact failure the backup work was written to fix.
 *
 * ── Nothing is auto-purged ──────────────────────────────────────────────────
 *
 * There is no retention window and no sweeper. A snapshot is the only copy of
 * something the user asked to delete, and a background job quietly destroying
 * the last copy of a year's journal — on a schedule the user never chose — is
 * a worse failure than a folder that grows. The list reports its size and
 * purging is a deliberate act.
 */

const SNAPSHOT_FILE = "snapshot.json";
const FILES_SUBDIR = "files";

function snapshotDir(id: string): string {
  return path.join(trashDir, id);
}

/** The bytes for one attachment inside a snapshot. Basename-only by
 *  construction — `storedName` reaches here from a database column, and a
 *  separator in it must never escape the snapshot folder. */
function stashedFile(id: string, storedName: string): string | null {
  const safe = path.basename(storedName);
  if (!safe || safe !== storedName) return null;
  return path.join(snapshotDir(id), FILES_SUBDIR, safe);
}

export interface SnapshotInput {
  trades: Record<string, unknown>[];
  legs: Record<string, unknown>[];
  attachments: Record<string, unknown>[];
  /** Ledger entries about to be UNLINKED (not deleted) — see trash-format.ts. */
  ledgerRefs?: { ledgerId: number; tradeId: number }[];
  /** The accounts row being deleted WITH these trades (account deletion only). */
  account?: Record<string, unknown> & { id: number; name: string };
  /** Destroyed account-scoped rows — see trash-format.ts. NEVER broker_connections. */
  accountRows?: TrashEnvelope["accountRows"];
  /** merge only: how the source's pnlRolledIn marker moved — see trash-format.ts. */
  merge?: TrashEnvelope["merge"];
  /** v3: IPO records about to be UNLINKED (not deleted) — see trash-format.ts. */
  ipoRefs?: { ipoId: number; tradeId: number }[];
  /** v4: `broker_reference` rows being DESTROYED — see trash-format.ts. */
  referenceRows?: Record<string, unknown>[];
  /** v3: what produced the snapshot; absent for ordinary deletes. */
  kind?: TrashKind;
  broker?: string;
  reason: string;
  accountId: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** V1: a snapshot record's legs, as `heldIdentityHashes` reads them (unstated = 0 / null). */
const legsOf = (row: Record<string, unknown>): RowLegs => ({
  buyQty: typeof row.buyQty === "number" ? row.buyQty : 0,
  sellQty: typeof row.sellQty === "number" ? row.sellQty : 0,
  buyDate: typeof row.buyDate === "string" ? row.buyDate : null,
  sellDate: typeof row.sellDate === "string" ? row.sellDate : null,
});

/**
 * Write the snapshot for a delete that is about to happen.
 *
 * Throws rather than returning a failure: the caller must ABORT the delete if
 * this does not succeed. Deleting after failing to write the recovery, having
 * just told the user the delete is recoverable, is the one outcome this whole
 * module exists to prevent.
 */
export function writeTrashSnapshot(input: SnapshotInput): string {
  const deletedAt = new Date().toISOString();
  const id = trashSnapshotId(deletedAt, randomBytes(4).toString("hex"));
  const dir = snapshotDir(id);

  const envelope: TrashEnvelope = {
    vyuhaTrash: true,
    v: TRASH_VERSION,
    id,
    deletedAt,
    reason: input.reason,
    accountId: input.accountId,
    // `referenceRows` is COUNTED, not just carried: a figures-only snapshot
    // (a realised-P&L statement that produced broker-stated figures and no
    // book trades) otherwise reported itself as holding nothing — "0 trades"
    // in the list, "0 trades and 0 attachments" in the purge dialog that
    // destroys the only copy of those figures, and excluded from the
    // "N recoverable" badge. Found 2026-09-04, second audit.
    counts: {
      trades: input.trades.length,
      legs: input.legs.length,
      attachments: input.attachments.length,
      referenceRows: (input.referenceRows ?? []).length,
    },
    trades: input.trades,
    legs: input.legs,
    attachments: input.attachments,
    files: [],
    ledgerRefs: input.ledgerRefs ?? [],
    // JSON.stringify drops an undefined field, so ordinary trade deletes keep
    // writing the exact shape they always did.
    account: input.account,
    accountRows: input.accountRows,
    merge: input.merge,
    ipoRefs: input.ipoRefs,
    referenceRows: input.referenceRows,
    kind: input.kind,
    broker: input.broker,
  };

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SNAPSHOT_FILE), JSON.stringify(envelope));
  return id;
}

/**
 * Move attachment bytes into a snapshot instead of deleting them.
 *
 * Called only after the delete transaction has committed. A file that cannot be
 * moved is REPORTED, never thrown: the database is already consistent by then,
 * and an unreadable screenshot must not undo a correct delete. Such a file is
 * left where it is — orphaned but harmless, and reclaimable by hand.
 */
export function stashAttachmentFiles(
  id: string,
  storedNames: string[],
): { stashed: string[]; failed: string[] } {
  const stashed: string[] = [];
  const failed: string[] = [];
  if (storedNames.length === 0) return { stashed, failed };

  const filesDir = path.join(snapshotDir(id), FILES_SUBDIR);
  try {
    fs.mkdirSync(filesDir, { recursive: true });
  } catch {
    return { stashed, failed: storedNames };
  }

  for (const storedName of storedNames) {
    const target = stashedFile(id, storedName);
    if (!target) continue;
    const source = path.join(attachmentsDir, path.basename(storedName));
    try {
      if (fs.existsSync(source)) {
        fs.renameSync(source, target);
        stashed.push(path.basename(storedName));
      }
      // The strip thumbnail is a regenerable sidecar, not user data — it is
      // removed rather than stashed, and its absence (every pre-P6 attachment)
      // is a no-op.
      fs.rmSync(path.join(attachmentsDir, `thumb-${path.basename(storedName)}`), { force: true });
    } catch {
      failed.push(path.basename(storedName));
    }
  }

  // Record which bytes actually made it, so restore does not promise files it
  // does not hold.
  try {
    const env = readEnvelope(id);
    if (env) {
      env.files = stashed;
      fs.writeFileSync(path.join(snapshotDir(id), SNAPSHOT_FILE), JSON.stringify(env));
    }
  } catch {
    /* the rows are still restorable without the file list */
  }

  return { stashed, failed };
}

function readEnvelope(id: string): TrashEnvelope | null {
  if (!isTrashSnapshotId(id)) return null;
  const file = path.join(snapshotDir(id), SNAPSHOT_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return validateTrashEnvelope(parsed).ok ? (parsed as TrashEnvelope) : null;
  } catch {
    return null;
  }
}

function dirSize(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* vanished under us — not worth failing a size read over */
        }
      }
    }
  };
  walk(dir);
  return total;
}

/** Every snapshot on disk, newest first. Unreadable folders are skipped. */
export function listTrashSnapshots(): TrashSummary[] {
  if (!fs.existsSync(trashDir)) return [];
  const out: TrashSummary[] = [];
  for (const entry of fs.readdirSync(trashDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const env = readEnvelope(entry.name);
    if (!env) continue;
    out.push(summariseTrash(env, dirSize(snapshotDir(entry.name))));
  }
  return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

/**
 * D11 (v4.3.0 wave 2P, identity#1) — which of `ids` name a trade that sits in
 * Deleted items. Trash is folders of envelopes, not a table (`writeTrashSnapshot`),
 * so this is the `listTrashSnapshots` read — every envelope parsed once, its
 * `trades[].id` compared. Data Quality calls it ONCE per report and ONLY when an
 * IPO record's reference names no row in the journal (a ghost), so a book with
 * none pays no disk read: an empty set returns before the folder is opened.
 */
export function trashedTradeIds(ids: ReadonlySet<number>): Set<number> {
  const out = new Set<number>();
  if (ids.size === 0 || !fs.existsSync(trashDir)) return out;
  for (const entry of fs.readdirSync(trashDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const env = readEnvelope(entry.name);
    if (!env) continue;
    for (const row of env.trades) {
      const id = row.id;
      if (typeof id === "number" && ids.has(id)) out.add(id);
    }
  }
  return out;
}

export interface TrashRestoreResult {
  ok: boolean;
  restored: number;
  legs: number;
  attachments: number;
  /** Trades that could not come back, and why — never silently dropped. */
  skipped: { id: number; symbol: string; reason: string }[];
  message: string;
  /**
   * v3.8: why a restore refused, for a caller that must branch on the reason
   * rather than on prose. Absent on success and on the older prose-only
   * refusals (a missing snapshot, an account-id conflict).
   *
   *   NEWER_ROWS   — the broker has rows imported since the removal
   *   ACCOUNT_GONE — the account the rows belong to has been deleted since
   */
  code?: "NEWER_ROWS" | "ACCOUNT_GONE";
}

/**
 * Put a snapshot's trades back.
 *
 * ── Why rows can refuse to come back ────────────────────────────────────────
 *
 * Trades are restored under their ORIGINAL ids, so their legs, attachments and
 * audit history line up again. Two things can stand in the way, and both are
 * ordinary rather than exceptional:
 *
 *   1. the id is taken — something else was written after the delete;
 *   2. `trades_account_broker_dedup_uq` rejects it — the user re-imported the
 *      same file, so the trade is already back by another route.
 *
 * Either way the row is SKIPPED and named in the result. Restoring it under a
 * fresh id would silently duplicate a trade and quietly corrupt every figure
 * derived from the book, which is worse than a restore that reports what it
 * could not do.
 *
 * An ACCOUNT-deletion snapshot has one stronger rule: if the account's id or
 * name now belongs to a DIFFERENT account, the whole restore refuses up front
 * — putting the trades anywhere else would merge two books. Only an account
 * that matches the envelope (same name and broker) counts as "already back".
 *
 * The snapshot is left on disk afterwards even on full success. Deleting the
 * only copy of the thing the user has just recovered, at the exact moment they
 * are checking whether the recovery worked, is not a tidy-up.
 */
export function restoreTrashSnapshot(id: string, source = "ui"): TrashRestoreResult {
  const fail = (message: string, code?: TrashRestoreResult["code"]): TrashRestoreResult => ({
    ok: false, restored: 0, legs: 0, attachments: 0, skipped: [], message, ...(code ? { code } : {}),
  });

  if (!isTrashSnapshotId(id)) return fail("That is not a snapshot id.");
  const env = readEnvelope(id);
  if (!env) return fail("That snapshot is missing or unreadable. Nothing was changed.");

  const rows = env.trades as (Record<string, unknown> & { id: number; symbol?: string })[];
  // A v2 account-deletion snapshot can legitimately hold zero trades (the
  // account was empty): the account row itself is still worth restoring.
  if (rows.length === 0 && !env.account && (env.referenceRows?.length ?? 0) === 0) {
    return fail("That snapshot holds no trades.");
  }

  // ── The account these rows belong to must still exist ─────────────────────
  //
  // There is no foreign key on `trades.account_id`, so restoring into an
  // account that has been deleted since plants rows in a book that no longer
  // has a name, a selector entry or a remove path — `countTradesByBroker`
  // answers ACCOUNT_NOT_FOUND for the dead id, so the user cannot even take
  // them out again. Refuse, and never re-home them: putting one book's trades
  // into another account is exactly the merge invariant 8 forbids.
  //
  // An account-DELETION envelope carries `env.account` and recreates the book
  // below, so it is deliberately exempt (its own conflict rules run instead).
  // `accountId` 0 is the aggregate view rather than a place (invariant 9): the
  // rows' own `account_id` values are what get checked in that case.
  if (!env.account) {
    const needed = new Set<number>();
    if (typeof env.accountId === "number" && env.accountId > 0) needed.add(env.accountId);
    for (const r of rows) {
      const a = (r as { accountId?: unknown }).accountId;
      if (typeof a === "number" && a > 0) needed.add(a);
    }
    const missing = [...needed].filter(
      (a) => !db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, a)).get(),
    );
    if (missing.length > 0) {
      return fail(
        `account ${missing.join(", ")} has been deleted since — these trades have nowhere to go, so nothing was restored. ` +
          `Restore that account first (it has its own entry in Deleted items), then restore these trades.`,
        "ACCOUNT_GONE",
      );
    }
  }

  // ── A broker-remove cannot be undone on top of the re-import ──────────────
  //
  // `removeBrokerRows` exists for one workflow: a parser fix changed what a
  // file MEANS, so the broker's rows come out and the file goes back in clean.
  // The re-imported rows carry different hashes and different positions — that
  // is the whole point of the fix — so nothing collides, and a restore run
  // afterwards would put the WRONG rows back beside the right ones and report
  // it as a success. That is the same class of double-book the v3.7 wizard
  // produced. Refuse while any newer row of that (account, broker) is present.
  //
  // `created_at` is `datetime('now')` (`YYYY-MM-DD HH:MM:SS`, UTC) while
  // `deletedAt` is an ISO string, so the cutoff is normalised to the same
  // shape; the comparison is `>=` because the delete took EVERY row of that
  // (account, broker), so anything standing there now in the delete's own
  // second arrived after it.
  if (env.kind === "broker-remove" && typeof env.broker === "string" && env.broker !== "") {
    const cutoff = env.deletedAt.slice(0, 19).replace("T", " ");
    const sameSecond = (s: unknown) => (typeof s === "string" ? s.slice(0, 19).replace("T", " ") : "");
    const newer = db
      .select({ id: trades.id, createdAt: trades.createdAt })
      .from(trades)
      .where(and(eq(trades.accountId, env.accountId), eq(trades.broker, env.broker)))
      .all()
      .filter((r) => sameSecond(r.createdAt) >= cutoff);
    if (newer.length > 0) {
      return fail(
        `${newer.length} ${env.broker} trade${newer.length === 1 ? " was" : "s were"} imported after this removal — ` +
          `remove those first, or restore into an empty broker. Nothing was changed.`,
        "NEWER_ROWS",
      );
    }
  }

  // ── Account conflicts refuse the WHOLE restore (nothing partial) ──────────
  //
  // The trades in an account-deletion snapshot belong to that account's book.
  // If its id or name now belongs to a DIFFERENT account, restoring the trades
  // anyway would silently merge two books — the exact corruption invariant 8
  // exists to prevent — so the restore refuses up front and changes nothing.
  // An account that matches the envelope (same name and broker) is the book
  // itself already back (an earlier restore, or the user recreated it): that
  // is "already restored", and the rows proceed under their original ids.
  let recreateAccount = false;
  let accountAlreadyPresent = false;
  if (env.account) {
    const envBroker = ((env.account as { broker?: string | null }).broker ?? null);
    const holder = db.select().from(accounts).where(eq(accounts.id, env.account.id)).get();
    if (holder) {
      if (holder.name === env.account.name && (holder.broker ?? null) === envBroker) {
        accountAlreadyPresent = true;
      } else {
        return fail(
          `account id ${env.account.id} now belongs to “${holder.name}” — restore skipped to avoid merging two books. Nothing was changed.`,
        );
      }
    } else {
      const nameHolder = db.select().from(accounts).where(eq(accounts.name, env.account.name)).get();
      if (nameHolder) {
        return fail(
          `the account name “${env.account.name}” now belongs to account id ${nameHolder.id} — restore skipped to avoid merging two books. Nothing was changed.`,
        );
      }
      recreateAccount = true;
    }
  }

  const wantedIds = rows.map((r) => r.id);
  const taken = new Set(
    db.select({ id: trades.id }).from(trades).where(inArray(trades.id, wantedIds)).all().map((r) => r.id),
  );

  // ── A joined lot cannot come back beside the sale it already counts ───────
  //
  // S2 (v4.3.0 wave 2H seam pass) — H3's skip below, the other way round. A lot
  // closed from Data Quality keeps its sale's hash as a `dedup-alias:`. When
  // that sale is STORED again (its join snapshot was restored after the lot was
  // deleted), landing the lot would count one sale on two rows. Skipping the lot
  // would lose its buy leg, so the WHOLE restore refuses before any write and
  // names the stored row. Rows that would be skipped anyway (id taken, or their
  // own hash already stored) never refuse.
  //
  // T1 (wave 2H second seam fix) — IDENTITY SETS are compared both ways. The
  // index holds every stored row's own hash AND each of its aliases, and grows
  // with the rows this restore would land ahead of the current one: a sale
  // joined onto ANOTHER lot since is no row, only that lot's alias, and a sale
  // landing earlier in the same snapshot is a row only in the plan.
  //
  // U1 (wave 2H third seam fix) — (a) no refusal advises deleting a row that
  // carries a leg of its own: a LOT holding the sale only as an alias also holds
  // its own purchase, and deleting it lost that purchase for good. Only a plain
  // one-sided row hit on its own hash (S2) keeps the delete-then-restore remedy.
  // (b) an alias counts as HELD only while its holder's closing leg holds
  // quantity (a long's sell leg, a short's buy leg — H1's reading in
  // updateManualTrade): the trade editor re-opening a joined lot keeps the alias
  // for re-import dedup, but that lot no longer records the sale.
  //
  // V1 (wave 2H fourth seam fix) — (b) is ONE predicate for every alias reader
  // (`heldIdentityHashes`, lib/import/close-open-lots.ts): this index, H3's skip
  // in the transaction below and import dedup in commit.ts. An alias that is not
  // held is not identity, so it is never indexed.
  //
  // Y1 (wave 2I) — a snapshot is restored to the state it was CAPTURED from.
  // Rows landing in the SAME restore came out of the same book in the same
  // delete, so the journal held them side by side and restoring both restores
  // exactly that book: a PLANNED holder is never a collision, in either order.
  // T1 refused the whole snapshot there, which lost its unrelated rows too —
  // for an account-deletion snapshot, the entire book — permanently, and named
  // no remedy because nothing was stored to delete. The refusal and the skip
  // apply ONLY against a row ALREADY STORED in the journal.
  {
    type Holder = RowLegs & { id: number; tradingsymbol: string; planned: boolean };
    // The closing leg's name only where the row states its direction; a closed
    // row with no ordered dates stays a "trade" rather than a guessed side.
    const closingWord = (x: Holder) =>
      readsLong(x)
        ? "sale"
        : x.sellQty > x.buyQty || (!!x.buyDate && !!x.sellDate && x.sellDate < x.buyDate)
          ? "purchase"
          : "trade";
    const indexByBook = new Map<string, { own: Map<string, Holder>; alias: Map<string, Holder> }>();
    const indexOf = (accountId: number, broker: string) => {
      const key = `${accountId}|${broker}`;
      let index = indexByBook.get(key);
      if (!index) {
        index = { own: new Map(), alias: new Map() };
        const stored = db
          .select({
            id: trades.id, tradingsymbol: trades.tradingsymbol, dedupHash: trades.dedupHash,
            importNotes: trades.importNotes, buyQty: trades.buyQty, sellQty: trades.sellQty,
            buyDate: trades.buyDate, sellDate: trades.sellDate,
          })
          .from(trades)
          .where(and(eq(trades.accountId, accountId), eq(trades.broker, broker)))
          .all();
        for (const s of stored) {
          const holder: Holder = {
            id: s.id, tradingsymbol: s.tradingsymbol, buyQty: s.buyQty, sellQty: s.sellQty,
            buyDate: s.buyDate, sellDate: s.sellDate, planned: false,
          };
          const own = s.dedupHash.toLowerCase();
          if (!index.own.has(own)) index.own.set(own, holder);
          for (const h of heldIdentityHashes(s)) if (h.toLowerCase() !== own && !index.alias.has(h.toLowerCase())) index.alias.set(h.toLowerCase(), holder);
        }
        indexByBook.set(key, index);
      }
      return index;
    };
    for (const row of rows) {
      if (taken.has(row.id)) continue;
      if (typeof row.accountId !== "number" || typeof row.broker !== "string" || typeof row.dedupHash !== "string") continue;
      const ownHash = row.dedupHash.toLowerCase();
      const aliases = heldIdentityHashes({ dedupHash: ownHash, importNotes: typeof row.importNotes === "string" ? row.importNotes : null, ...legsOf(row) })
        .filter((h) => h !== ownHash);
      const index = indexOf(row.accountId, row.broker);
      // The unique index skips it (a stored row, or one landing earlier here).
      if (index.own.has(ownHash)) continue;
      // H3's skip below: a plain row already recorded in the position it closed.
      // Y1: only where that holder is STORED — a holder landing in this same
      // restore was beside this row in the book the snapshot was taken from.
      const ownHolder = index.alias.get(ownHash);
      if (aliases.length === 0 && ownHolder && !ownHolder.planned) continue;
      const symbol = String(row.tradingsymbol ?? row.symbol ?? "—");
      for (const h of [ownHash, ...aliases]) {
        const byOwn = index.own.get(h);
        // (b) the index holds only HELD aliases (V1), so an alias hit records the sale.
        const hit = byOwn ?? index.alias.get(h);
        if (!hit) continue;
        const oneSided = (hit.sellQty > 0 && hit.buyQty === 0) || (hit.buyQty > 0 && hit.sellQty === 0);
        const what = !byOwn ? closingWord(hit) : hit.sellQty > 0 && hit.buyQty === 0 ? "sale" : hit.buyQty > 0 && hit.sellQty === 0 ? "purchase" : "closing trade";
        // Y1: the holder is a row of this same snapshot, not a stored row —
        // the pair was consistent in the book that was deleted, so both rows
        // come back as they were. `what` is unused on this path.
        if (hit.planned) continue;
        if (h === ownHash) {
          // (a) the holder is a lot recording this row as its alias: it carries
          // its own leg, so nothing here advises deleting it.
          return fail(
            `Trade #${row.id} (${symbol}) is already recorded in trade #${hit.id} (${hit.tradingsymbol}), which was closed with it, ` +
              `so restoring it would count it twice. Nothing was changed; this entry stays in Deleted items.`,
          );
        }
        return fail(
          byOwn
            ? `Trade #${row.id} (${symbol}) was closed with a ${what} that is back in the journal ` +
                `(trade #${hit.id}, ${hit.tradingsymbol}) — restoring it would count that ${what} twice. ` +
                // S2's remedy only for a plain one-sided row: deleting it loses
                // nothing the incoming lot does not already record.
                (oneSided ? `Delete that row, then restore. Nothing was changed.` : `Nothing was changed; this entry stays in Deleted items.`)
            : `Trade #${row.id} (${symbol}) was closed with a ${what} that trade #${hit.id} (${hit.tradingsymbol}) already records, ` +
                `so restoring it would count that ${what} twice. Nothing was changed; this entry stays in Deleted items.`,
        );
      }
      // This row lands: later rows in the snapshot meet its identity too.
      const planned: Holder = { id: row.id, tradingsymbol: symbol, ...legsOf(row), planned: true };
      index.own.set(ownHash, planned);
      for (const h of aliases) if (!index.alias.has(h)) index.alias.set(h, planned);
    }
  }

  const skipped: TrashRestoreResult["skipped"] = [];
  let restored = 0, legs = 0, attachments = 0;
  let extraRestored = 0, extraSkipped = 0;
  // D4 (wave 2O): replayed rows whose trade reference this restore had to clear,
  // because the trade it named was in this envelope and did not come back.
  let unlinkedIpos = 0, unlinkedLedger = 0;

  let accountBack = false;
  let mergeMarkerReturned = false;
  try {
    const res = db.transaction((tx) => {
      // Recreate the deleted account FIRST (v2 account-deletion snapshots), so
      // the rows restored below land in a book that exists again. Conflicts
      // were refused above, so a failure here is genuine and aborts the whole
      // transaction — no silent catch-and-continue.
      if (env.account && recreateAccount) {
        const carried = env.merge?.carried ?? 0;
        const rawMarker = env.account.pnlRolledIn;
        const originalMarker = typeof rawMarker === "number" ? rawMarker : 0;
        // A merged-away source comes back with only the residue of its marker:
        // the `carried` share now marks the moved trades in the TARGET, and is
        // subtracted back from the target below — see trash-format.ts.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tx.insert(accounts).values({ ...env.account, pnlRolledIn: r2(originalMarker - carried) } as any).run();
        accountBack = true;
        recordAudit({
          entity: "account",
          entityId: env.account.id,
          action: "create",
          summary: `${env.account.name} — recreated from deleted items (${id})`,
          after: env.account,
          source,
        });
        if (env.merge && carried !== 0) {
          const target = db.select().from(accounts).where(eq(accounts.id, env.merge.targetId)).get();
          if (target) {
            tx.update(accounts)
              .set({ pnlRolledIn: Math.max(0, r2(target.pnlRolledIn - carried)), updatedAt: new Date().toISOString() })
              .where(eq(accounts.id, env.merge.targetId))
              .run();
            mergeMarkerReturned = true;
          }
        }
      }

      const landed = new Set<number>();
      // H3 (v4.3.0 wave 2H) — the ALIAS hashes of the stored rows, per
      // (account, broker). The unique index sees only each row's own hash, but a
      // Data Quality join keeps the sale it consumed as a `dedup-alias:` on the
      // lot (`withStaleCloseNote`), so restoring that sale would count it twice.
      // Read lazily per book, inside this transaction — and the picture it takes
      // is the STORED one: the first row of a book is checked before any row of
      // that book is inserted, and Y1 adds nothing afterwards, so a snapshot's
      // own rows never make each other skip (they were in that book together).
      const aliasesByBook = new Map<string, Set<string>>();
      const aliasesOf = (accountId: number, broker: string): Set<string> => {
        const key = `${accountId}|${broker}`;
        let set = aliasesByBook.get(key);
        if (!set) {
          set = new Set<string>();
          const stored = tx
            .select({
              dedupHash: trades.dedupHash, importNotes: trades.importNotes,
              buyQty: trades.buyQty, sellQty: trades.sellQty, buyDate: trades.buyDate, sellDate: trades.sellDate,
            })
            .from(trades)
            .where(and(eq(trades.accountId, accountId), eq(trades.broker, broker)))
            .all();
          // V1: HELD aliases only — a lot re-opened in the editor no longer records its sale.
          for (const r of stored) for (const h of heldIdentityHashes(r)) if (h !== r.dedupHash) set.add(h.toLowerCase());
          aliasesByBook.set(key, set);
        }
        return set;
      };
      for (const row of rows) {
        if (taken.has(row.id)) {
          skipped.push({ id: row.id, symbol: String(row.symbol ?? "—"), reason: "a trade with that id is already in the journal" });
          continue;
        }
        const book = typeof row.accountId === "number" && typeof row.broker === "string" ? { accountId: row.accountId, broker: row.broker } : null;
        const ownHash = typeof row.dedupHash === "string" ? row.dedupHash.toLowerCase() : "";
        if (book && ownHash && aliasesOf(book.accountId, book.broker).has(ownHash)) {
          skipped.push({ id: row.id, symbol: String(row.symbol ?? "—"), reason: "an identical trade is already in the journal (recorded in the position it closed)" });
          continue;
        }
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tx.insert(trades).values(row as any).run();
          landed.add(row.id);
          restored++;
          // Y1: a row landing HERE never makes a later row of the same snapshot
          // skip — they were in the book together, so the set stays the STORED
          // picture it was built from (and the pre-flight above agrees).
        } catch (e) {
          // Almost always the dedup unique index: the same file was imported
          // again after the delete, so this trade is already back.
          const msg = e instanceof Error && /unique/i.test(e.message)
            ? "an identical trade is already in the journal (re-imported since the delete)"
            : e instanceof Error ? e.message : "unknown error";
          skipped.push({ id: row.id, symbol: String(row.symbol ?? "—"), reason: msg });
        }
      }

      // D1 (v4.4.0) — a restored row reads in TODAY's cap, not the one it was
      // trashed under. A row from a pre-0073 envelope carries no `riskSource`,
      // so it is classified first by the SAME function the `risk-source-v1`
      // data fix uses; then every landed `'cap'` row is re-priced to the cap
      // its segment resolves to now. Inside this transaction, and only the
      // rows that landed — nothing already in the book moves.
      if (landed.size > 0) {
        const ids = [...landed];
        classifyUnsourcedRisk(sqlite, { ids });
        repriceCapTrades(sqlite, { ids });
      }

      // Children follow only the parents that actually came back — a leg
      // pointing at a trade that was skipped is precisely the orphan this
      // whole delete/restore rework exists to stop creating.
      for (const leg of env.legs as (Record<string, unknown> & { tradeId: number })[]) {
        if (!landed.has(leg.tradeId)) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tx.insert(tradeLegs).values(leg as any).run();
        legs++;
      }
      for (const att of env.attachments as (Record<string, unknown> & { tradeId: number })[]) {
        if (!landed.has(att.tradeId)) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tx.insert(tradeAttachments).values(att as any).run();
        attachments++;
      }

      // Re-point the ledger entries the delete unlinked — but only where the
      // trade actually came back, only where the entry still exists, and only
      // where its ref is still null. An entry someone re-linked by hand since
      // the delete is their decision, not this restore's to overwrite.
      for (const ref of env.ledgerRefs ?? []) {
        if (!landed.has(ref.tradeId)) continue;
        tx.update(ledgerEntries)
          .set({ refTradeId: ref.tradeId })
          .where(and(eq(ledgerEntries.id, ref.ledgerId), isNull(ledgerEntries.refTradeId)))
          .run();
      }
      // v3: the IPO links, under the same three conditions.
      for (const ref of env.ipoRefs ?? []) {
        if (!landed.has(ref.tradeId)) continue;
        tx.update(ipos)
          .set({ tradeId: ref.tradeId })
          .where(and(eq(ipos.id, ref.ipoId), isNull(ipos.tradeId)))
          .run();
      }

      // The account-scoped rows the delete destroyed (v2): imports, sessions,
      // capital checkpoints, IPOs and the account's own ledger entries come
      // back with the book. A row that cannot land (id or unique key taken —
      // e.g. a session date the account has planned again since) is COUNTED,
      // never silently dropped and never duplicated under a fresh id.
      //
      // D4 (v4.3.0 wave 2O, re-check finding identity#0) — a replayed row that
      // NAMES A TRADE gets the gate the `ledgerRefs` and `ipoRefs` loops above
      // have, so this is no longer the one write that ignores what landed
      // (`:792`: "a link onto a row this restore did not bring back is not this
      // restore's to make"). It is keyed on the ENVELOPE, not on `landed`:
      //
      //   envTradeIds.has(ref) && !landed.has(ref)  →  the reference is cleared
      //
      // — the reference named a trade THIS delete removed and this restore could
      // not bring back (the id is taken, or the row is already back by another
      // route), so the row it names is not the row the user linked; `trades.id`
      // is AUTOINCREMENT, so a freed id reappears only against a database whose
      // rowids came from elsewhere (a backup, the desktop template swap) — and
      // then it belongs to an unrelated trade, which the record then badged and
      // whose sale replaced its own in capital, the tax pack, the ITR export and
      // both AIS sides (measured: All accounts `ipoRealised` 482.61 vs 965.22).
      //
      // A reference this delete never touched is REPLAYED VERBATIM. A purge
      // snapshots every `ipos` row of the book, including one naming a holding in
      // ANOTHER account (lib/queries/ipos.ts:163-177), and that trade is not in
      // `landed` because it never left: clearing it would cut a live link and
      // count that sale twice. Hence the envelope clause, not `!landed` alone.
      //
      // The row itself always comes back (invariant 10 — a restore must not lose
      // the journal); unlinked, it is what Data Quality's unlinked-exited
      // question is for, and the count is stated in the message below.
      if (env.account && env.accountRows) {
        const envTradeIds = new Set(rows.map((r) => r.id));
        /** The column naming a trade, for the two tables that have one. */
        const groups: [unknown, Record<string, unknown>[] | undefined, "tradeId" | "refTradeId" | null][] = [
          [importBatches, env.accountRows.importBatches, null],
          [tradingSessions, env.accountRows.tradingSessions, null],
          [capitalSnapshots, env.accountRows.capitalSnapshots, null],
          [ipos, env.accountRows.ipos, "tradeId"],
          [ledgerEntries, env.accountRows.ledgerEntries, "refTradeId"],
          // v3.7: the user's own weekly notes come back with the book. A week
          // the surviving account has since reviewed keeps ITS row — the
          // unique index refuses the insert and it is COUNTED as skipped, not
          // silently duplicated under a fresh id.
          [weeklyReviews, env.accountRows.weeklyReviews, null],
        ];
        for (const [table, tableRows, refColumn] of groups) {
          for (const row of tableRows ?? []) {
            const ref = refColumn ? row[refColumn] : null;
            const cut = typeof ref === "number" && envTradeIds.has(ref) && !landed.has(ref);
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              tx.insert(table as any).values((cut ? { ...row, [refColumn as string]: null } : row) as any).run();
              extraRestored++;
              // Counted only after the row actually landed: a row the unique
              // index refused states nothing about a link.
              if (cut) {
                if (refColumn === "tradeId") unlinkedIpos++;
                else unlinkedLedger++;
              }
            } catch {
              extraSkipped++;
            }
          }
        }
      }

      // v4: the broker-stated reference figures the delete destroyed. NOT
      // gated on `env.account` — an account purge, a broker-remove and a
      // cascading import delete all carry them, and only the first has an
      // account row. Restored under their ORIGINAL ids so `import_batch_id`
      // still names the batch that stored them (`holdsBookTrades`). A row the
      // unique index refuses (the same statement re-imported since) is COUNTED,
      // never duplicated under a fresh id.
      for (const row of env.referenceRows ?? []) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tx.insert(brokerReference).values(row as any).run();
          extraRestored++;
        } catch {
          extraSkipped++;
        }
      }

      // L6 (v4.3.0 wave 2L) — an envelope that carries NO `ipoRefs` at all.
      //
      // 4.2.x deleted a holding by nulling `ipos.trade_id` and storing nothing
      // about it, so restoring such a snapshot on 4.3.0 brought the holding back
      // UNLINKED and the one sale was counted twice — in the capital summary and
      // through it `available`, in the tax pack, in the ITR export and on both
      // AIS sides — with nothing on screen saying the link had gone. The field
      // cannot be invented for an envelope that never had it, so the link is
      // recovered from the book's OWN records: a restored holding flagged
      // `acquisition: 'ipo'` (the value `pushTradeToIpoAction` and the /ipos sync
      // write) is re-pointed by the ONE unlinked record of its account that can
      // be its own — named after the scrip, or (G-G2-1, wave 2M) an exited
      // allotment stating the same quantity and the same allotment and exit days,
      // which is how a record entered under the ISSUE's name is recognised.
      //
      // `uniqueIpoRelinks` is the same pairing Data Quality asks about, over
      // the same SET since D1 (wave 2M) — the account's unlinked records that
      // state an allotment — so the two can never disagree about a candidate
      // either. It is unique in BOTH directions. Anything
      // ambiguous writes NOTHING and stays a question the user answers on /ipos
      // (invariant 6) — the `ipo_record_link` issue names the holding and every
      // candidate. The `isNull` guard below is the ledger/IPO rule of this whole
      // block: a link someone made by hand since the delete is their decision,
      // not this restore's to overwrite.
      //
      // D1 (wave 2N) closes three holes the 2L re-check measured:
      //   - EVERY 4.3 delete writer now states `ipoRefs`, `[]` included, so
      //     `== null` is a pre-4.3.0 envelope and nothing else. A routine
      //     delete + restore of a never-linked holding used to take this path;
      //   - what may be WRITTEN is `ipoRecordNamesHolding` (the scrip's name,
      //     plus the exit shape), never tier B — a record named after another
      //     ISSUE whose four allotment facts coincide claimed the holding, and
      //     its own sale then left capital, tax, ITR and both AIS sides;
      //   - uniqueness is judged over the BOOK's unlinked `acquisition:'ipo'`
      //     holdings of the affected accounts, not just the restored ones. It
      //     was the restored rows alone, so a holding already in the book that
      //     claims the same record was invisible and the record was written onto
      //     whichever holding happened to be in the envelope.
      // The WRITE is still confined to restored rows: a link onto a row this
      // restore did not bring back is not this restore's to make.
      //
      // Runs LAST of the writes, so an account-deletion envelope's own restored
      // `ipos` rows are part of the picture it reads.
      if (env.ipoRefs == null && landed.size > 0) {
        const day = (v: unknown) => (typeof v === "string" ? v : null);
        const restored = rows
          .filter((r) => landed.has(r.id) && r.acquisition === "ipo" && typeof r.accountId === "number")
          .map((r) => ({
            id: r.id,
            accountId: r.accountId as number,
            symbol: typeof r.symbol === "string" ? r.symbol : "",
            tradingsymbol: typeof r.tradingsymbol === "string" ? r.tradingsymbol : null,
            buyQty: typeof r.buyQty === "number" ? r.buyQty : 0,
            // G-G2-1 (wave 2M) — tier B's side of the holding: the envelope
            // already carries the allotment's own days, so a record named after
            // the ISSUE rather than the scrip can still be recognised without
            // resolving a name to a symbol through any list.
            acquisitionDate: day(r.acquisitionDate),
            buyDate: day(r.buyDate),
            sellDate: day(r.sellDate),
            // D1 (wave 2N) — the exit-shape clause's side: an exited record is
            // no candidate for a holding that never sold.
            sellQty: typeof r.sellQty === "number" ? r.sellQty : 0,
          }));
        if (restored.length > 0) {
          const landedIds = new Set(restored.map((h) => h.id));
          // Invariant 8, applied to a write rather than a screen: the accounts
          // this restore touched, never the SELECTED one — a restore is not a
          // view, and 0 is a view (invariant 9), never a book.
          const accountIds = [...new Set(restored.map((h) => h.accountId))];
          const linked = new Set(
            tx.select({ tradeId: ipos.tradeId }).from(ipos).all().map((x) => x.tradeId).filter((x): x is number => x != null),
          );
          const alsoInBook = tx
            .select({
              id: trades.id,
              accountId: trades.accountId,
              symbol: trades.symbol,
              tradingsymbol: trades.tradingsymbol,
              buyQty: trades.buyQty,
              acquisitionDate: trades.acquisitionDate,
              buyDate: trades.buyDate,
              sellDate: trades.sellDate,
              sellQty: trades.sellQty,
            })
            .from(trades)
            .where(and(eq(trades.acquisition, "ipo"), inArray(trades.accountId, accountIds)))
            .all()
            .filter((r) => !landedIds.has(r.id) && !linked.has(r.id));
          const records = tx
            .select({
              id: ipos.id,
              accountId: ipos.accountId,
              name: ipos.name,
              allottedQty: ipos.allottedQty,
              allotted: ipos.allotted,
              exitPrice: ipos.exitPrice,
              exitDate: ipos.exitDate,
              allotmentDate: ipos.allotmentDate,
            })
            .from(ipos)
            // D1 (wave 2M) — the SAME candidate set the report reads
            // (`getUnlinkedExitedIpoRecords`): the unlinked records that state
            // an ALLOTMENT. This read was every unlinked record, so the
            // application row a user keeps beside the allotment — the ticker's
            // name, never allotted — was a second candidate here and invisible
            // to the report: the restore called the holding ambiguous and wrote
            // nothing while its own report said the pairing was unambiguous,
            // and the one sale stayed counted twice.
            .where(and(isNull(ipos.tradeId), eq(ipos.allotted, true)))
            .all();
          for (const link of uniqueIpoRelinks([...restored, ...alsoInBook], records)) {
            if (!landedIds.has(link.tradeId)) continue;
            tx.update(ipos)
              .set({ tradeId: link.tradeId })
              .where(and(eq(ipos.id, link.ipoId), isNull(ipos.tradeId)))
              .run();
          }
        }
      }

      for (const row of rows) {
        if (!landed.has(row.id)) continue;
        recordAudit({
          entity: "trade",
          entityId: row.id,
          action: "update",
          summary: `${String(row.tradingsymbol ?? row.symbol ?? "trade")} — restored from deleted items (${id})`,
          after: row,
          source,
        });
      }

      return { landed };
    });

    // Files only after the commit, and copied rather than moved: if the copy
    // fails the rows are still correct, and the snapshot still holds the only
    // copy of the bytes.
    for (const att of env.attachments as (Record<string, unknown> & { tradeId: number; storedName: string })[]) {
      if (!res.landed.has(att.tradeId)) continue;
      const from = stashedFile(id, att.storedName);
      if (!from || !fs.existsSync(from)) continue;
      try {
        fs.mkdirSync(attachmentsDir, { recursive: true });
        fs.copyFileSync(from, path.join(attachmentsDir, path.basename(att.storedName)));
      } catch {
        /* reported below via the count, not thrown */
      }
    }
  } catch (e) {
    return fail(`Nothing was restored — ${e instanceof Error ? e.message : "unknown error"}. Your journal is unchanged.`);
  }

  const parts = [`Restored ${restored} trade${restored === 1 ? "" : "s"}`];
  if (legs) parts.push(`${legs} leg${legs === 1 ? "" : "s"}`);
  if (attachments) parts.push(`${attachments} attachment${attachments === 1 ? "" : "s"}`);
  let message = `${parts.join(", ")}.`;
  if (env.account) {
    if (accountBack) {
      message += ` The account “${env.account.name}” was recreated.`;
      if (env.merge && env.merge.carried !== 0) {
        message += mergeMarkerReturned
          ? ` ₹${env.merge.carried.toLocaleString("en-IN")} of rolled-in P&L moved back from “${env.merge.targetName}”.`
          : ` The merge target “${env.merge.targetName}” no longer exists, so its rolled-in marker was left untouched.`;
      }
    } else if (accountAlreadyPresent) {
      message += ` The account “${env.account.name}” was already present.`;
    }
  }
  if (extraRestored > 0) {
    message += ` ${extraRestored} related row${extraRestored === 1 ? "" : "s"} (imports, sessions, capital history, IPOs, ledger, weekly reviews, broker-stated figures) came back with it.`;
  }
  if (extraSkipped > 0) {
    message += ` ${extraSkipped} related row${extraSkipped === 1 ? " was" : "s were"} already present and skipped.`;
  }
  // D4 (wave 2O) — a link this restore could not make is SAID, not guessed. The
  // rows themselves came back (they are the user's own records); what they no
  // longer state is a holding.
  //
  // D10 (wave 2P, identity#0 cosmetic) — the sentence names what the user can
  // ACT on, not a question Data Quality may never raise: `ipoAskPairs` asks only
  // beside an unlinked IPO HOLDING of the book, and in this shape the holding is
  // precisely what did not come back — with no other such holding the report is
  // silent, and the numbers are right (the record counts its own exit once,
  // `lib/queries/ipos.ts` `ipoIdsCountedThroughTrades`). What IS reachable: /ipos
  // lists the record unlinked and can link it; a later restore of the holding's
  // own envelope re-links it through `ipoRefs` above.
  if (unlinkedIpos > 0) {
    message +=
      ` ${unlinkedIpos} IPO record${unlinkedIpos === 1 ? "" : "s"} came back unlinked because the holding ` +
      `${unlinkedIpos === 1 ? "it names" : "they name"} could not be restored; ` +
      `${unlinkedIpos === 1 ? "its" : "their"} exit is counted from the record itself, and ` +
      `${unlinkedIpos === 1 ? "it" : "they"} can be linked again on IPOs once the holding is back.`;
  }
  if (unlinkedLedger > 0) {
    message +=
      ` ${unlinkedLedger} ledger entr${unlinkedLedger === 1 ? "y" : "ies"} came back without ` +
      `${unlinkedLedger === 1 ? "its" : "their"} trade reference, for the same reason.`;
  }
  if (skipped.length > 0) {
    message += ` ${skipped.length} could not be restored — ${skipped[0].symbol}: ${skipped[0].reason}${skipped.length > 1 ? `, and ${skipped.length - 1} more` : ""}.`;
  }
  message += " The snapshot was kept.";

  return {
    ok: restored > 0 || skipped.length > 0 || accountBack || accountAlreadyPresent || extraRestored > 0,
    restored,
    legs,
    attachments,
    skipped,
    message,
  };
}

/** Remove a snapshot and its stashed bytes for good. */
export function purgeTrashSnapshot(id: string): { ok: boolean; message: string } {
  if (!isTrashSnapshotId(id)) return { ok: false, message: "That is not a snapshot id." };
  const dir = snapshotDir(id);
  if (!fs.existsSync(dir)) return { ok: false, message: "That snapshot is already gone." };
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, message: "The snapshot was permanently removed. Those trades can no longer be recovered from inside the app." };
  } catch (e) {
    return { ok: false, message: `Could not remove the snapshot — ${e instanceof Error ? e.message : "unknown error"}.` };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Broker-scoped remove (v3.8 W2a)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Largest id list handed to one `inArray(...)` — the same ceiling
 * `lib/queries/delete.ts` documents (SQLITE_MAX_VARIABLE_NUMBER, 999 on the
 * most conservative build). Duplicated rather than imported because delete.ts
 * imports THIS module; a cycle there is avoidable and this is one number.
 */
const REMOVE_ID_CHUNK = 900;

function chunkedRead<T>(ids: number[], run: (chunk: number[]) => T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += REMOVE_ID_CHUNK) out.push(...run(ids.slice(i, i + REMOVE_ID_CHUNK)));
  return out;
}

function chunkedWrite(ids: number[], run: (chunk: number[]) => void): void {
  for (let i = 0; i < ids.length; i += REMOVE_ID_CHUNK) run(ids.slice(i, i + REMOVE_ID_CHUNK));
}

/** The audit action for a broker-scoped remove. Typed through `AuditInput`
 *  so the literal is checked the day `lib/audit.ts` admits it to the union;
 *  until then the column is free text and the row is written verbatim. */
export const REMOVE_BROKER_AUDIT_ACTION = "import.remove-broker" as unknown as AuditInput["action"];

export interface RemoveBrokerInput {
  accountId: unknown;
  broker: unknown;
  /** Recorded as the audit `source`; defaults to "ui". */
  actor?: string;
}

export interface RemoveBrokerResult {
  accountId: number;
  broker: string;
  removed: { trades: number; closed: number; open: number; legs: number; attachments: number; referenceRows: number };
  /** Links nulled, rows kept — restore re-points them. */
  unlinked: { ledgerEntries: number; ipos: number };
  snapshotId: string;
  /** Attachment files that could not be moved into the snapshot. The rows are gone regardless. */
  orphanedFiles: string[];
  message: string;
}

/**
 * Remove EVERY trade one broker put into one account, recoverably.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * A parser fix can change what a file means: the W2a Paytm fix pairs
 * executions on ISIN, merging 35 securities the old parser had split into
 * phantom positions. No hash migration can absorb that — the old rows are
 * not mis-keyed, they are WRONG — so the honest path is: remove the broker's
 * rows, re-import the file clean. This is that remove. It is scoped by
 * (account, broker), never by anything the caller re-derives, so what the
 * import page counted (`countTradesByBroker`) is what goes.
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 *
 * Snapshot FIRST (no snapshot, no delete), then ONE transaction: legs and
 * attachment rows deleted, ledger entries and IPOs UNLINKED (never deleted —
 * they record money that moved and applications the user made), the trades
 * deleted, and ONE audit row whose before/after carry the same keys. Files
 * move into the snapshot only after the commit. The snapshot is an ordinary
 * trade-delete envelope with `kind: "broker-remove"`, so
 * `restoreTrashSnapshot` brings the rows back under their ORIGINAL ids and
 * refuses (per row) anything a re-import has already put back.
 *
 * `trades_fts` needs no statement here: the BEFORE DELETE trigger from
 * migration 0060 removes the tokens as each row goes.
 *
 * Throws `ImportSourceError` (with `.code` and `.status`) for 0/missing
 * account, unknown broker, a vanished account, or a broker with no rows — all
 * BEFORE anything is written. `getWriteAccountId` is deliberately never
 * called: its fallback would resolve an ambiguous 0 to some account.
 */
export function removeBrokerRows(input: RemoveBrokerInput): RemoveBrokerResult {
  const accountId = assertAccountExists(assertAccountId(input.accountId));
  const broker = assertBroker(input.broker);
  const source = input.actor ?? "ui";

  const rows = db.select().from(trades).where(and(eq(trades.accountId, accountId), eq(trades.broker, broker))).all();
  if (rows.length === 0) {
    throw new ImportSourceError("NO_ROWS", `No ${broker} trades in account ${accountId}. Nothing was changed.`);
  }
  const ids = rows.map((r) => r.id);
  const open = rows.filter((r) => r.isOpen).length;
  const closed = rows.length - open;

  const legRows = chunkedRead(ids, (chunk) => db.select().from(tradeLegs).where(inArray(tradeLegs.tradeId, chunk)).all());
  const attachRows = chunkedRead(ids, (chunk) => db.select().from(tradeAttachments).where(inArray(tradeAttachments.tradeId, chunk)).all());
  const ledgerRefRows = chunkedRead(ids, (chunk) =>
    db.select({ ledgerId: ledgerEntries.id, tradeId: ledgerEntries.refTradeId }).from(ledgerEntries).where(inArray(ledgerEntries.refTradeId, chunk)).all(),
  ) as { ledgerId: number; tradeId: number }[];
  const ipoRefRows = chunkedRead(ids, (chunk) =>
    db.select({ ipoId: ipos.id, tradeId: ipos.tradeId }).from(ipos).where(inArray(ipos.tradeId, chunk)).all(),
  ) as { ipoId: number; tradeId: number }[];

  // v4: the figures THIS broker stated about THIS account go with its rows.
  // Leaving them behind is not inert — `reconcile()` (lib/queries/reference.ts)
  // would keep comparing the broker's stated totals against a book that no
  // longer holds any of that broker's trades, and report the whole statement
  // as missing. They ride in the same envelope and come back with the restore.
  const refRows = db
    .select()
    .from(brokerReference)
    .where(and(eq(brokerReference.accountId, accountId), eq(brokerReference.broker, broker)))
    .all();

  const reason = `${broker} rows removed from account ${accountId} for a clean re-import`;
  const snapshotId = writeTrashSnapshot({
    referenceRows: refRows.length ? (refRows as unknown as Record<string, unknown>[]) : undefined,
    trades: rows as unknown as Record<string, unknown>[],
    legs: legRows as unknown as Record<string, unknown>[],
    attachments: attachRows as unknown as Record<string, unknown>[],
    ledgerRefs: ledgerRefRows,
    ipoRefs: ipoRefRows,
    kind: "broker-remove",
    broker,
    reason,
    accountId,
  });

  // The audit view renders CHANGED keys only, so a projection whose only
  // moving figure is `trades` reads "account N: trades 122 → 0" — which says
  // the account was emptied when in fact one broker's rows went and every
  // other broker's stayed. The broker is therefore named in the summary text
  // (below), and the ledger/IPO unlinks — money that moved and applications
  // the user made, silently absent until now — are counted as changing keys.
  // Both projections carry the same key set: `lib/audit.ts` throws in test on
  // any before/after asymmetry.
  const counts = {
    accountId, broker, trades: rows.length, closed, open,
    unlinkedLedger: 0, unlinkedIpos: 0, referenceRows: refRows.length,
  };
  try {
    db.transaction((tx) => {
      chunkedWrite(ids, (chunk) => tx.delete(tradeLegs).where(inArray(tradeLegs.tradeId, chunk)).run());
      chunkedWrite(ids, (chunk) => tx.delete(tradeAttachments).where(inArray(tradeAttachments.tradeId, chunk)).run());
      chunkedWrite(ids, (chunk) => tx.update(ipos).set({ tradeId: null }).where(inArray(ipos.tradeId, chunk)).run());
      chunkedWrite(ids, (chunk) => tx.update(ledgerEntries).set({ refTradeId: null }).where(inArray(ledgerEntries.refTradeId, chunk)).run());
      chunkedWrite(ids, (chunk) => tx.delete(trades).where(inArray(trades.id, chunk)).run());
      // The broker's stated figures for this account, snapshotted above.
      tx.delete(brokerReference).where(and(eq(brokerReference.accountId, accountId), eq(brokerReference.broker, broker))).run();
      // ONE row, symmetric keys: `before` and `after` describe the same five
      // facts, so the audit diff shows exactly the counts that changed and no
      // phantom column. The per-trade before-images live in the snapshot.
      recordAudit({
        entity: "account",
        entityId: accountId,
        action: REMOVE_BROKER_AUDIT_ACTION,
        summary:
          `${broker}: ${rows.length} trade${rows.length === 1 ? "" : "s"} (${closed} closed, ${open} open) removed from account ${accountId} ` +
          `for a clean re-import — the account's other brokers are untouched` +
          (ledgerRefRows.length || ipoRefRows.length
            ? `; ${ledgerRefRows.length} ledger entr${ledgerRefRows.length === 1 ? "y" : "ies"} and ${ipoRefRows.length} IPO${ipoRefRows.length === 1 ? "" : "s"} unlinked (kept)`
            : "") +
          `, snapshot ${snapshotId}`,
        before: counts,
        after: { ...counts, trades: 0, closed: 0, open: 0, referenceRows: 0, unlinkedLedger: ledgerRefRows.length, unlinkedIpos: ipoRefRows.length },
        source,
      });
    });
  } catch (e) {
    // Nothing was deleted, so the recovery it promised is for rows that are
    // still live — leave no orphan snapshot behind to confuse the list.
    try {
      fs.rmSync(snapshotDir(snapshotId), { recursive: true, force: true });
    } catch {
      /* the snapshot is harmless if it stays: every row in it is still in the journal */
    }
    throw e;
  }

  const { failed } = stashAttachmentFiles(snapshotId, attachRows.map((a) => a.storedName));

  return {
    accountId,
    broker,
    removed: { trades: rows.length, closed, open, legs: legRows.length, attachments: attachRows.length, referenceRows: refRows.length },
    unlinked: { ledgerEntries: ledgerRefRows.length, ipos: ipoRefRows.length },
    snapshotId,
    orphanedFiles: failed,
    message:
      `Removed ${rows.length} ${broker} trade${rows.length === 1 ? "" : "s"} (${closed} closed, ${open} open)` +
      (legRows.length ? `, ${legRows.length} leg${legRows.length === 1 ? "" : "s"}` : "") +
      (attachRows.length ? `, ${attachRows.length} attachment${attachRows.length === 1 ? "" : "s"}` : "") +
      (refRows.length ? `, ${refRows.length} broker-stated figure${refRows.length === 1 ? "" : "s"}` : "") +
      ` from account ${accountId}. Recoverable from Backup & Restore → Deleted items.` +
      (failed.length ? ` ${failed.length} attachment file${failed.length === 1 ? "" : "s"} could not be moved into the snapshot.` : ""),
  };
}
