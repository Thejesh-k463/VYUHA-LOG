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
  brokerReference,
} from "@/lib/db/schema";
import { recordAudit, recordAuditMany } from "@/lib/audit";
import { carryUnfetchedOnMerge } from "@/lib/import/dhan-unfetched";
import { heldIdentityHashes, readsLong, type RowLegs } from "@/lib/import/close-open-lots";
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
 *     would make the merge look lossless when it was not. A source row that
 *     carries a leg of its OWN beyond what the target records refuses the merge
 *     instead of being dropped (wave 2L) — dropping it would lose that leg. An
 *     `ipos` row naming a dropped duplicate is RE-POINTED at the target's
 *     surviving copy of that trade (wave 2K) rather than unlinked: they are the
 *     same trade, and an unlinked exited IPO beside the target's copy counted
 *     the sale twice. One trade takes ONE record, so a second one is SKIPPED
 *     with its trade rather than re-pointed onto a copy that already has one
 *     (wave 2L).
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

/** The identity columns of one book's trades, as `heldIdentityHashes` reads them. */
const IDENTITY_COLS = {
  id: trades.id,
  broker: trades.broker,
  tradingsymbol: trades.tradingsymbol,
  dedupHash: trades.dedupHash,
  importNotes: trades.importNotes,
  buyQty: trades.buyQty,
  sellQty: trades.sellQty,
  buyDate: trades.buyDate,
  sellDate: trades.sellDate,
};
type IdentityRow = { id: number; broker: string; tradingsymbol: string; dedupHash: string; importNotes: string | null } & RowLegs;

/**
 * What a row the target HOLDS is, read from its own legs: a sell-only row is a
 * sale, a buy-only row a purchase. Only used to name a row in a sentence.
 */
const rowKind = (x: RowLegs) => (x.sellQty > 0 && x.buyQty === 0 ? "sale" : x.buyQty > 0 && x.sellQty === 0 ? "purchase" : "trade");

/**
 * The leg a row was CLOSED with, named only where the row states its direction
 * (lib/trash.ts's reading, same words): a long closes on its sale, a short on
 * its purchase, and a closed row with no ordered dates stays a "trade" rather
 * than a guessed side.
 */
const closingWord = (x: RowLegs) =>
  readsLong(x) ? "sale" : x.sellQty > x.buyQty || (!!x.buyDate && !!x.sellDate && x.sellDate < x.buyDate) ? "purchase" : "trade";

/** Does this row carry BOTH its legs — a leg the other row's identity cannot record? */
const twoLegged = (x: RowLegs) => x.buyQty > 0 && x.sellQty > 0;

/**
 * Y2 (v4.3.0 wave 2I) — the one fact both the preview and the refusal state.
 * Tenseless, so the two cannot drift: each caller adds its own tail.
 *
 * U1-MERGE (wave 2L) — two directions, one helper, for the same reason. The
 * source row either HOLDS the target's identity as an alias (`heldByTarget`
 * false — Y2's original sentence, the target's row is the one that was closed
 * with it) or IS the row a target lot holds as an alias (`heldByTarget` true —
 * the lot was closed with it).
 *
 * D6 (wave 2N) — a THIRD shape on the same sentence: the target holds the
 * source row's OWN hash (`sameIdentity`) on a row that records FEWER legs than
 * the source does. "The whole row twice over" is false there, so the pair is
 * named the same way and the merge refuses instead of dropping a leg.
 */
type IdentityClash = { source: IdentityRow; target: IdentityRow; heldByTarget: boolean; sameIdentity?: boolean };

function identityClash(pair: IdentityClash, targetName: string): string {
  if (pair.sameIdentity) {
    const what = rowKind(pair.target);
    return (
      `Trade #${pair.source.id} (${pair.source.tradingsymbol}) records a ${what} that “${targetName}” already holds ` +
      `(trade #${pair.target.id}, ${pair.target.tradingsymbol}, the same broker and dedup identity), and the target ` +
      `records only one leg of this trade — moving it would count that ${what} twice`
    );
  }
  if (pair.heldByTarget) {
    const what = closingWord(pair.target);
    return (
      `Trade #${pair.source.id} (${pair.source.tradingsymbol}) records a ${what} that “${targetName}” already holds ` +
      `(trade #${pair.target.id}, ${pair.target.tradingsymbol}, which was closed with it) — moving it would count that ${what} twice`
    );
  }
  const what = rowKind(pair.target);
  return (
    `Trade #${pair.source.id} (${pair.source.tradingsymbol}) was closed with a ${what} that “${targetName}” already holds ` +
    `(trade #${pair.target.id}, ${pair.target.tradingsymbol}) — moving it would count that ${what} twice`
  );
}

/**
 * merge: the source trades the target already records, and the one shape a
 * merge cannot express.
 *
 * Y2 (wave 2I) — this compared `dedup_hash` only, so a source row whose hash
 * lives on as a TARGET lot's `dedup-alias:` (a Data Quality join records the
 * sale it consumed on the lot — `withStaleCloseNote`) was not seen as a
 * duplicate and was MOVED: the merged book then held that sale twice, realised
 * inside the closed round trip AND back as an open sell-only row. Identity is
 * ONE predicate (`heldIdentityHashes`, lib/import/close-open-lots.ts — an alias
 * counts only while its holder's closing leg holds quantity), read both ways:
 *
 *   `ids` — the source row's own hash is a hash the target HOLDS (its own, or a
 *     held alias AND the source row carries nothing but the leg that alias
 *     records). Skipped exactly like a same-hash duplicate: snapshotted to
 *     Deleted items, deleted, counted and reported.
 *   `refusal` — either direction where a DROP would lose a leg held on no other
 *     row. The reverse: a source LOT whose held alias names a row the target
 *     stores. The forward (U1-MERGE, wave 2L): a source row the target holds
 *     only as an ALIAS which carries its own other leg — a closed round trip, or
 *     an open long with a sale. Moving it would count that trade twice and
 *     dropping it would lose the leg, so the merge refuses before any write and
 *     names the pair; the rows stay where they are.
 *
 * U1-MERGE is U1's restore-side rule (lib/trash.ts — "no refusal advises
 * deleting a row that carries a leg of its own") read the other way: the forward
 * branch tested only the hash, so a source CLOSED ROUND TRIP whose hash a target
 * lot holds as an alias was deleted whole — its purchase leg, on no other row,
 * and its realised P&L left the merged journal reported as "1 duplicate
 * skipped". A PLAIN one-sided row is unaffected: its whole content is the leg
 * the alias records.
 *
 * Both directions are per (broker, hash), like the unique index.
 */
function identityCollisions(
  accountId: number,
  target: AccountRow,
): { ids: number[]; partnerOf: Map<number, number>; refusal: IdentityClash | null } {
  const key = (broker: string, hash: string) => `${broker.trim().toLowerCase()}|${hash.trim().toLowerCase()}`;
  const targetRows = db.select(IDENTITY_COLS).from(trades).where(eq(trades.accountId, target.id)).all() as IdentityRow[];
  const sourceRows = db.select(IDENTITY_COLS).from(trades).where(eq(trades.accountId, accountId)).all() as IdentityRow[];

  const held = new Map<string, IdentityRow>();
  const ownOnly = new Map<string, IdentityRow>();
  for (const r of targetRows) {
    const own = key(r.broker, r.dedupHash);
    if (!ownOnly.has(own)) ownOnly.set(own, r);
    for (const h of heldIdentityHashes(r)) {
      const k = key(r.broker, h);
      if (!held.has(k)) held.set(k, r);
    }
  }

  const ids: number[] = [];
  // K1 (wave 2K): the surviving TARGET row each dropped source row collides
  // with — the same-hash row, or the lot whose held alias names it. They are
  // the same trade, which is why one of them is dropped, so anything the
  // dropped row was the anchor for (today: `ipos.tradeId`) follows the survivor
  // instead of being cut loose.
  const partnerOf = new Map<number, number>();
  for (const s of sourceRows) {
    const own = key(s.broker, s.dedupHash);
    // A duplicate first: a row the target already records is dropped, and a
    // dropped row moves nothing, so its own aliases cannot double anything.
    const sameHash = ownOnly.get(own);
    const partner = sameHash ?? held.get(own);
    if (partner) {
      // U1-MERGE (wave 2L): the target holds this row only as an ALIAS — the
      // leg its lot was closed with — and this row carries its own other leg
      // besides. Dropping it would lose that leg for good; moving it would
      // count the recorded one twice. Refuse and name the pair, as the reverse
      // direction does.
      //
      // D6 (wave 2N, re-check finding identity#1, data loss): the same-hash
      // half of that class. "A same-hash duplicate is the WHOLE row twice over"
      // is false for the reachable shape — the target's row can be a naked
      // sell-only row while THIS row is that same sale given its own buy leg in
      // the trade editor, which does not re-hash (the reason the alias variant
      // above exists at all). Dropping it deleted the round trip and kept the
      // naked sale: 1,000 of cost basis and 490.25 of realised P&L out of the
      // merged journal, reported as "1 duplicate skipped". So a two-legged
      // source row is refused whenever its partner carries FEWER legs. A
      // two-legged partner still drops (that one IS the whole row twice over),
      // a one-legged source still drops, and a 0-qty row still drops.
      if (twoLegged(s) && (!sameHash || !twoLegged(partner))) {
        return {
          ids: [],
          partnerOf: new Map(),
          refusal: { source: s, target: partner, heldByTarget: true, sameIdentity: !!sameHash },
        };
      }
      ids.push(s.id);
      partnerOf.set(s.id, partner.id);
      continue;
    }
    for (const h of heldIdentityHashes(s)) {
      const k = key(s.broker, h);
      if (k === own) continue;
      const hit = ownOnly.get(k);
      if (hit) return { ids: [], partnerOf: new Map(), refusal: { source: s, target: hit, heldByTarget: false } };
    }
  }
  return { ids, partnerOf, refusal: null };
}

/** An `ipos` row naming a trade this delete destroys, as both callers read it. */
type IpoRef = { ipoId: number; tradeId: number; accountId: number };

/**
 * L7 (v4.3.0 wave 2L) — ONE trade takes ONE IPO record, decided ONCE for the
 * preview and the execution so the two cannot drift.
 *
 * K1 re-points a dropped duplicate's IPO at the target's surviving copy. Where
 * that copy ALREADY carries an IPO record of its own, re-pointing produced two
 * `ipos` rows naming one trade — the state `pushTradeToIpoAction` refuses to
 * create ("Already linked to an IPO record"): /ipos lists both as linked, either
 * syncs onto that one trade row when edited, and `getIpoTradeLinks()` keeps only
 * the last, so the /trades badge names the foreign record.
 *
 * So a record whose partner is already spoken for is SKIPPED, exactly as its
 * trade is: it is snapshotted and deleted with the duplicate it names, whatever
 * account it is filed in, so every book restores whole on an un-merge.
 *
 * D5 (wave 2N, re-check finding identity#0) corrected the half of that sentence
 * that used to read "a record filed in ANOTHER account is left where it stands
 * and unlinked (numerically neutral there — the trade it named was never in that
 * book)". It is neutral only in ITS OWN single-account view: on All accounts,
 * and in the target's own view when the record is filed there, an unlinked
 * exited IPO is realised on its own figure beside the survivor's equity sale —
 * the same sale counted twice, which is the very thing the re-point above cites
 * as its reason to exist.
 *
 * The source's own records are considered first: they are the ones that travel
 * with the trade, so a legacy cross-account row never takes the survivor from
 * the book being merged.
 */
function planIpoLinks(
  refs: IpoRef[],
  partnerOf: Map<number, number>,
  sourceAccountId: number,
): { relinks: { ipoId: number; tradeId: number }[]; skipped: IpoRef[] } {
  const relinks: { ipoId: number; tradeId: number }[] = [];
  const skipped: IpoRef[] = [];
  const rank = (r: IpoRef) => (r.accountId === sourceAccountId ? 0 : 1);
  const candidates = refs
    .filter((r) => partnerOf.has(r.tradeId))
    .sort((a, b) => rank(a) - rank(b) || a.ipoId - b.ipoId);
  if (candidates.length === 0) return { relinks, skipped };
  // Partners that already carry a record — read once, then grown by this plan's
  // own re-points so two records on ONE dropped trade cannot both land either.
  const claimed = new Set(
    collectIdChunks([...new Set(candidates.map((c) => partnerOf.get(c.tradeId)!))], (chunk) =>
      db.select({ tradeId: ipos.tradeId }).from(ipos).where(inArray(ipos.tradeId, chunk)).all(),
    )
      .map((r) => r.tradeId)
      .filter((id): id is number => id != null),
  );
  for (const c of candidates) {
    const partner = partnerOf.get(c.tradeId)!;
    if (claimed.has(partner)) {
      skipped.push(c);
      continue;
    }
    claimed.add(partner);
    relinks.push({ ipoId: c.ipoId, tradeId: partner });
  }
  return { relinks, skipped };
}

/**
 * D5 (v4.3.0 wave 2N) — the OTHER books a skipped IPO record is filed in, named.
 *
 * A record removed from a book the user did not name in this merge is a fact
 * they are entitled to before they press and after it runs: the preview and the
 * result message both say it, off this one list, so the two cannot drift.
 */
function foreignSkipBooks(skipped: readonly IpoRef[], sourceAccountId: number): { count: number; books: string } {
  const foreign = skipped.filter((s) => s.accountId !== sourceAccountId);
  if (foreign.length === 0) return { count: 0, books: "" };
  const ids = [...new Set(foreign.map((s) => s.accountId))].sort((a, b) => a - b);
  const byId = new Map(db.select({ id: accounts.id, name: accounts.name }).from(accounts).all().map((a) => [a.id, a.name]));
  return { count: foreign.length, books: ids.map((id) => `“${byId.get(id) ?? `account ${id}`}”`).join(", ") };
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
    const identity = identityCollisions(opts.accountId, r.target);
    dedupCollisions = identity.ids.length;
    if (dedupCollisions > 0) {
      warnings.push(
        `${dedupCollisions} trade${dedupCollisions === 1 ? " is" : "s are"} already recorded in “${r.target.name}” (same broker and dedup identity) — ${dedupCollisions === 1 ? "it" : "they"} will be skipped and saved to Deleted items, not duplicated.`,
      );
      // K1 (wave 2K): a link the USER made survives the drop — say so before
      // the merge, since it is the one thing a skipped trade still changes.
      // L7 (wave 2L): the sentence pluralises on the DROPPED TRADES, not on the
      // records they carry — one dropped trade with two records read as "2 …
      // are linked to those trades", a blast radius twice the size of the real
      // one — and it states the same split `planIpoLinks` hands the execution.
      const refs = collectIdChunks(identity.ids, (chunk) =>
        db.select({ ipoId: ipos.id, tradeId: ipos.tradeId, accountId: ipos.accountId }).from(ipos).where(inArray(ipos.tradeId, chunk)).all(),
      ) as IpoRef[];
      const plan = planIpoLinks(refs, identity.partnerOf, opts.accountId);
      const dropped = new Set(refs.map((x) => x.tradeId)).size;
      const parts: string[] = [];
      if (plan.relinks.length > 0) {
        parts.push(
          `${plan.relinks.length} will be re-pointed to “${r.target.name}”'s own copy of that trade, never left unlinked (an unlinked exited IPO beside the target's copy counts that sale twice)`,
        );
      }
      if (plan.skipped.length > 0) {
        // D5 (wave 2N): "a record filed in another account is left unlinked"
        // WAS this sentence, and it described a silent double count — an
        // unlinked exited IPO is realised on its own figure beside the
        // survivor's equity sale. Every skipped record is now removed with the
        // duplicate it names, and the books they are filed in are NAMED.
        const n = plan.skipped.length;
        const foreign = foreignSkipBooks(plan.skipped, opts.accountId);
        parts.push(
          `${n} will be removed with the duplicate ${n === 1 ? "it names" : "they name"}, because one trade takes one IPO record` +
            (foreign.count > 0 ? ` — ${foreign.count} filed in ${foreign.books}` : "") +
            ` (saved to Deleted items; an un-merge brings ${n === 1 ? "it" : "them"} back)`,
        );
      }
      if (parts.length > 0) {
        warnings.push(
          `${dropped} dropped trade${dropped === 1 ? "" : "s"} carr${dropped === 1 ? "ies" : "y"} ${refs.length} IPO record${refs.length === 1 ? "" : "s"} — ${parts.join("; ")}.`,
        );
      }
    }
    // Y2: the merge will refuse — say so before the user presses anything.
    if (identity.refusal) {
      warnings.push(
        `${identityClash(identity.refusal, r.target.name)}, and skipping it would drop the other leg it records. ` +
          `The merge will not run until those two rows are resolved.`,
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
  // purge: all of them. merge: only the identity collisions (Y2).
  const identity = mode === "merge" ? identityCollisions(accountId, r.target!) : null;
  // Y2: the one shape a merge cannot express — refused BEFORE the snapshot, so
  // nothing is written and both books stay exactly as they are.
  if (identity?.refusal) {
    return fail(mode, `${identityClash(identity.refusal, r.target!.name)}. Nothing was merged; both accounts are unchanged.`);
  }
  const doomedIds =
    mode === "purge"
      ? db.select({ id: trades.id }).from(trades).where(eq(trades.accountId, accountId)).all().map((x) => x.id)
      : identity!.ids;

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
  // ACCDEL-IPO-REFS (v4.3.0 wave 2J): the IPO records pointing at those trades,
  // gathered BEFORE anything is unlinked — the account-delete counterpart of the
  // `ipoRefs` lib/queries/delete.ts and `removeBrokerRows` write, same envelope
  // shape. Both branches below UNLINK survivors rather than deleting them
  // (purge: rows in OTHER accounts, after this account's own IPOs are gone;
  // merge: any row naming a skipped duplicate — the row itself moves to the
  // target), and `restoreTrashSnapshot`'s re-link loop reads exactly this field.
  // Without it the trade came back under its own id with the link gone: a fact
  // the user recorded (this allotment BECAME that holding) destroyed by a
  // RECOVERABLE operation, and the counted-once rule of wave 2H
  // (CAP-IPO-LINK / TAX-IPO-LINK, keyed on `ipos.trade_id`) left reading a null.
  // The purge's OWN rows are in here too: they ride back inside
  // `accountRows.ipos` with `trade_id` intact, so their ref is inert — the
  // envelope states the whole picture rather than a filtered one.
  const ipoRefRows = collectIdChunks(doomedIds, (chunk) =>
    db.select({ ipoId: ipos.id, tradeId: ipos.tradeId, accountId: ipos.accountId }).from(ipos).where(inArray(ipos.tradeId, chunk)).all(),
  ) as IpoRef[];
  // The envelope's shape is exactly {ipoId, tradeId} — `accountId` is read only
  // by the plan below, and a third key would change a file format restore reads.
  const ipoRefEnvelope = ipoRefRows.map((x) => ({ ipoId: x.ipoId, tradeId: x.tradeId }));

  // ACCDEL-IPO-RELINK (v4.3.0 wave 2K) — merge only: where an IPO names a trade
  // this merge DROPS as a duplicate, the link follows the target's surviving
  // collision partner instead of being cut. Nulling it moved the IPO to the
  // target unlinked while the target's own copy of that trade stayed, so the
  // merged book counted the sale TWICE — once through the trade and once
  // through the IPO, because wave 2H's counted-once rule (CAP-IPO-LINK /
  // TAX-IPO-LINK, and the AIS sale side) keys on `ipos.trade_id`. Measured on a
  // temp book before the fix: capital {equity 490.25, ipo 482.6, total 972.85}
  // and AIS FY totals 2,000 / 3,000 for ONE allotment of 10 shares.
  // The two rows are the SAME trade — that is the whole reason one of them is
  // dropped — so the target's copy is the row the user's link names from now on.
  // `ipoRefs` above still records the ORIGINAL (ipoId → source trade): the
  // pre-merge fact, stated by the envelope whatever the restore then does with
  // it (`restoreTrashSnapshot` re-links only a link that is still NULL, so a
  // re-pointed row is left alone — a link this merge set deliberately is not
  // the restore's to overwrite).
  // L7 (wave 2L) bounds it: one trade takes one IPO record, so a record whose
  // partner already carries one is SKIPPED instead (see `planIpoLinks`).
  const ipoPlan =
    mode === "merge"
      ? planIpoLinks(ipoRefRows, identity!.partnerOf, accountId)
      : { relinks: [] as { ipoId: number; tradeId: number }[], skipped: [] as IpoRef[] };
  const ipoRelinks = ipoPlan.relinks;
  // EVERY skipped record is deleted with the duplicate it names — it must not
  // move to the target as a second record naming one trade, and it must not
  // stay behind unlinked. It is snapshotted below, so the book restores whole:
  // the row rides back inside `accountRows.ipos` with its OWN `accountId`, its
  // own id and its `trade_id` intact, beside the duplicate that comes back with
  // it (`restoreTrashSnapshot` replays those rows verbatim, and the `ipoRefs`
  // loop that runs before the replay is `isNull`-guarded on a row that does not
  // exist yet, so nothing lands twice).
  //
  // D5 (wave 2N, re-check finding identity#0): this was
  // `.filter(s => s.accountId === accountId)`, so only the SOURCE's own copies
  // were removed. A skipped record filed in ANY OTHER account — a legacy
  // cross-account link, or the target's own book — was left where it stood and
  // UNLINKED by the blanket unlink below, and an unlinked exited IPO is
  // realised on its own figure beside the survivor's equity sale: the same sale
  // counted twice, measured {equity 490.25, ipo 482.60, total 972.85} on All
  // accounts and two ITR rows for one sale. That is the exact double count the
  // preview warning above cites as its own reason to re-point, so the L7 bound
  // contradicted its stated reason for half its cases.
  const ipoSkipDeleteIds = ipoPlan.skipped.map((s) => s.ipoId);

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
    // purge: every IPO row of the book. merge: the IPO rows move with the
    // trades, so only the ones L7 SKIPS (a record the survivor does not need)
    // are destroyed — and they ride back with the source book on a restore.
    ipos: asRows(
      mode === "purge"
        ? db.select().from(ipos).where(eq(ipos.accountId, accountId)).all()
        : collectIdChunks(ipoSkipDeleteIds, (chunk) => db.select().from(ipos).where(inArray(ipos.id, chunk)).all()),
    ),
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

  // ── Broker-stated figures (v3.9 `broker_reference`) ──────────────────────
  // purge: every row of the account is destroyed, so every row is snapshotted.
  // merge: the rows MOVE to the target, except the ones the target already
  // states (same broker/source/scope/key/as_of) — the unique index refuses
  // those, so the merge DELETES them and only those are snapshotted. The key
  // is built exactly as `broker_reference_uq` builds it, `as_of` coalesced to
  // '' (SQLite treats NULLs in a unique index as distinct).
  const refKey = (r: { broker: string; sourceId: string; scope: string; key: string; asOf: string | null }) =>
    [r.broker, r.sourceId, r.scope, r.key, r.asOf ?? ""].join("\u0000");
  const sourceRefRows = db.select().from(brokerReference).where(eq(brokerReference.accountId, accountId)).all();
  const destroyedRefRows =
    mode === "purge"
      ? sourceRefRows
      : (() => {
          const held = new Set(
            db.select().from(brokerReference).where(eq(brokerReference.accountId, r.target!.id)).all().map(refKey),
          );
          return sourceRefRows.filter((row) => held.has(refKey(row)));
        })();

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
      // D1 (v4.3.0 wave 2N) — ALWAYS stated, `[]` when this delete broke no
      // link, the same rule delete.ts and `removeBrokerRows` follow.
      // `lib/trash.ts` keys its 4.2.x fallback on the field being ABSENT, and
      // an omitted empty list made a 4.3 envelope byte-identical to a legacy
      // one: the restore then invented a link the user never made
      // (counted-once#0/#1).
      ipoRefs: ipoRefEnvelope,
      account: account as unknown as Record<string, unknown> & { id: number; name: string },
      accountRows: destroyedRows,
      referenceRows: destroyedRefRows.length ? (destroyedRefRows as unknown as Record<string, unknown>[]) : undefined,
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
        // Broker-stated reference figures (v3.9) are per-account like every
        // table above: they describe THIS book's imports, and a row left
        // behind would be invisible (every read is account-scoped) yet still
        // occupy the account in `broker_reference_uq`.
        tx.delete(brokerReference).where(eq(brokerReference.accountId, accountId)).run();
      } else {
        const targetId = r.target!.id;
        // K1: first, the IPO links that follow the target's surviving copy of a
        // dropped duplicate (see `ipoRelinks` above). Keyed on the IPO's own id,
        // so the blanket unlink below still catches every other row.
        const byPartner = new Map<number, number[]>();
        for (const rel of ipoRelinks) {
          const list = byPartner.get(rel.tradeId) ?? [];
          list.push(rel.ipoId);
          byPartner.set(rel.tradeId, list);
        }
        for (const [tradeId, ipoIds] of byPartner) {
          forEachIdChunk(ipoIds, (chunk) => tx.update(ipos).set({ tradeId }).where(inArray(ipos.id, chunk)).run());
        }
        // L7: the records the survivor does not need — deleted BEFORE the
        // account-keyed move below, which would otherwise carry this book's own
        // into the target as a second record naming one trade. Snapshotted
        // above, so they come back with the un-merge, each in its own account
        // (D5, wave 2N: the set is no longer this book's rows alone).
        forEachIdChunk(ipoSkipDeleteIds, (chunk) => tx.delete(ipos).where(inArray(ipos.id, chunk)).run());
        // Unlink anything still pointing at the SKIPPED (deleted) duplicates,
        // then remove them — so the account-keyed moves below cannot violate
        // the dedup unique index.
        forEachIdChunk(doomedIds, (chunk) => tx.update(ipos).set({ tradeId: null }).where(inArray(ipos.tradeId, chunk)).run());
        forEachIdChunk(doomedIds, (chunk) => tx.update(ledgerEntries).set({ refTradeId: null }).where(inArray(ledgerEntries.refTradeId, chunk)).run());
        forEachIdChunk(doomedIds, (chunk) => tx.delete(trades).where(inArray(trades.id, chunk)).run());

        // Account-keyed moves — trade ids never change, so every child link
        // (legs, attachments, ipos.tradeId, ledger refTradeId) survives.
        tx.update(trades).set({ accountId: targetId }).where(eq(trades.accountId, accountId)).run();
        tx.update(importBatches).set({ accountId: targetId }).where(eq(importBatches.accountId, accountId)).run();
        tx.update(ipos).set({ accountId: targetId }).where(eq(ipos.accountId, accountId)).run();
        tx.update(ledgerEntries).set({ accountId: targetId }).where(eq(ledgerEntries.accountId, accountId)).run();
        // Broker reference figures move too. A figure the target already holds
        // (same broker/source/scope/key/as_of — the same statement imported into
        // both accounts) is dropped from the source: the unique index would
        // reject it and the target's copy states the same number.
        tx.run(sql`delete from broker_reference where account_id = ${accountId} and exists (
          select 1 from broker_reference t where t.account_id = ${targetId}
            and t.broker = broker_reference.broker and t.source_id = broker_reference.source_id
            and t.scope = broker_reference.scope and t.key = broker_reference.key
            and coalesce(t.as_of, '') = coalesce(broker_reference.as_of, ''))`);
        tx.update(brokerReference).set({ accountId: targetId }).where(eq(brokerReference.accountId, accountId)).run();

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

        // R10 (v4.3.0 fix wave 1): the source's kept "not fetched" Dhan notices
        // follow its trades, whatever the connections choice — the fact is
        // about the BOOK (lib/import/dhan-unfetched.ts). One append-only row
        // per span names the target; the insert throws, so a failure aborts
        // the merge rather than dropping the notice.
        carryUnfetchedOnMerge(tx, {
          fromAccountId: accountId,
          toAccountId: targetId,
          fromName: account.name,
          toName: r.target!.name,
          source,
        });

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
            : `${account.name} — merged into ${r.target!.name} (${counts.trades - doomedIds.length} moved, ${doomedIds.length} duplicate(s) skipped` +
              (ipoRelinks.length ? `, ${ipoRelinks.length} IPO link(s) re-pointed to the surviving copy` : "") +
              (ipoPlan.skipped.length ? `, ${ipoPlan.skipped.length} duplicate IPO record(s) removed with the duplicate` : "") +
              ")",
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
        (ipoRelinks.length
          ? `, ${ipoRelinks.length} IPO link${ipoRelinks.length === 1 ? "" : "s"} re-pointed to “${r.target!.name}”'s own copy of that trade`
          : "") +
        // D5 (wave 2N): every skipped record is REMOVED with the duplicate it
        // names, so the three-way "left unlinked in its own account" branch is
        // gone — that state was a silent double count. The other books they
        // were filed in are named, because a row removed from a book the user
        // never named is a fact they are owed.
        (ipoPlan.skipped.length
          ? `, ${ipoPlan.skipped.length} duplicate IPO record${ipoPlan.skipped.length === 1 ? "" : "s"} removed with the duplicate (“${r.target!.name}”'s own copy of that trade already carries one` +
            (() => {
              const foreign = foreignSkipBooks(ipoPlan.skipped, accountId);
              return foreign.count > 0 ? `; ${foreign.count} filed in ${foreign.books}` : "";
            })() +
            `; saved to Deleted items, an un-merge brings ${ipoPlan.skipped.length === 1 ? "it" : "them"} back)`
          : "") +
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
