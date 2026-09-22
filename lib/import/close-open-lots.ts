/**
 * R5 (4.3.0 wave 1) — an incoming execution that CLOSES a position the book already
 * holds, decided across rows instead of inside one file.
 *
 * ── SWITCHED OFF FOR 4.3.0 ─────────────────────────────────────────────────
 * By the 2026-09-11 owner ruling (06-ANSWERS, "v4.3.0 release-level-audit
 * rulings", row 1) auto-close does not ship in 4.3.0: `lib/import/commit.ts`
 * is restored to v4.2.0 byte-for-byte, so a SELL of a held lot is written as
 * its own row, exactly as v4.2.0 wrote it. The applier lives in git at d0eda00
 * and is rebuilt in 4.3.1. Until then `planLotCloses`, `withLotCloseNote`,
 * `withScaledRemainderNote` and `splitByRemainder` have NO production caller —
 * they are dormant, pure library code kept with their unit tests. The
 * identity readers below (`lotIdentityHashes`, `isLotIdentityFrozen`,
 * `isAutoCloseMerged`) are
 * still read by Data Quality and the restore re-key — and, since R26, by
 * import dedup in `commit.ts` (preview and commit alike); without alias rows
 * they answer "own hash only, not frozen" for every row. In 4.3.0 the ONE
 * writer of an alias is Data Quality's stale-lot close (`withStaleCloseNote`,
 * called by `closeStaleLot` in commit.ts): a lot joined to the sale the book
 * had stored as its own row answers to that sale's record from then on, so a
 * re-pull of the sale is a duplicate instead of a second open row.
 *
 * Everything below describes the design as wave 1 built it (for 4.3.1).
 *
 * Until now `is_open` was decided one row at a time (`buyQty !== sellQty`,
 * commit.ts), and FIFO existed only WITHIN a single parsed file
 * (`pair-legs.ts`). So a tradebook that sold a holding bought in an earlier
 * import landed as a brand-new SHORT beside the long it actually closed: two
 * open positions in one symbol, no realised P&L, and a "cost basis unknown"
 * flag on a sale whose basis the book was holding all along.
 *
 * This module is the DECISION half and is deliberately pure — no DB, no React,
 * no engine — so every FIFO edge can be unit-tested (`tests/auto-close-fifo.test.ts`).
 * The writing half (row updates, charges, audit) lives in `lib/import/commit.ts`,
 * which is the only file allowed to know what a `trades` row looks like.
 *
 * ── The rules, and why each one is narrow ──────────────────────────────────
 *
 * 1. OPPOSITE SIDE ONLY. A sell closes long lots; a buy covers short lots.
 * 2. SAME BOOK. `accountId` + `broker` + `tradingsymbol` + `segment` +
 *    `exchange` must all match. The owner's ruling names the account and the
 *    symbol; broker/segment/exchange are added because the charges engine
 *    reads its rates per broker × segment × exchange (invariant 3) — closing a
 *    Zerodha delivery lot with a Groww intraday sale would price the exit off
 *    the wrong rate card, and the dedup index is per (account, broker) so a
 *    cross-broker close could not be made idempotent either.
 * 3. FIFO, oldest lot first: by open date, then by row id. A lot with no date
 *    sorts LAST — an unknown date is not evidence of being old.
 * 4. PARTIAL QUANTITIES, both ways: one sale may consume several lots, and one
 *    lot may be consumed by several sales. Money is apportioned by the share
 *    of the lot actually taken, exactly the way `pair-legs.ts` splits a lot.
 * 5. NEVER a row against itself. The planner matches only against the lots the
 *    CALLER passes, and never against another incoming row — so a row can
 *    never close itself, and ordering inside `incomingRows` is the caller's
 *    decision. (v4.3.0 M-2: the caller now folds a row it has just WRITTEN
 *    into that lot list, so a BUY and a later SELL in one file pair up; this
 *    module still sees only "lots" and "incoming", and does not know or care
 *    which file a lot came from.)
 * 6. A row that already states both legs (a closed pair) is not an incoming
 *    execution at all and never reaches here; the caller filters it out.
 *
 * Quantities are shares/units; money is rupees at runtime (invariant 1) — the
 * paise boundary is the column, not this module.
 */

/** Round to the paisa. Money crosses this module as rupees. */
const r2 = (n: number) => Math.round(n * 100) / 100;

// ───────────────────────── a lot's IDENTITY (v4.3.0 S-1) ────────────────────
//
// A close collapses two identities — the lot's row and the incoming execution —
// into one row, and a row can store exactly ONE `dedup_hash`
// (`trades_account_broker_dedup_uq` is (account_id, broker, dedup_hash)).
//
// Wave 1 stored the INCOMING row's hash and recovered the lot's by re-hashing
// the row's own legs. That is not recoverable once the legs move: buy 100,
// sell 40, sell 60 leaves a row whose legs say 60, so the buy file's hash
// (which says 100) is derivable from nothing, and re-importing the buy added a
// phantom open 100 lot (skeptic probe, 2026-09-10).
//
// So identity is now FROZEN and ADDITIVE: the lot keeps the hash it was born
// with for ever, and every hash that also stands for it — one per consuming
// execution — is recorded as an ALIAS in `import_notes`, which is the only
// free-text column that travels with the row through backup, restore and the
// data fixes. Import dedup (commit.ts, preview and commit), the restore re-key
// (`lib/db/data-fixes.ts`) and Data Quality (`lib/import/broker-identity.ts`)
// all read identity through `lotIdentityHashes`. Auto-close is switched off
// for 4.3.0, so no IMPORT writes an alias; Data Quality's stale-lot close does
// (R26, `withStaleCloseNote`), and a restore can bring aliased rows in.

/** Marks one alias hash inside `import_notes`. Segments are joined by " | ". */
export const DEDUP_ALIAS_PREFIX = "dedup-alias:";

/**
 * Written to `import_notes` on every row an auto-close touched — the reduced
 * lot, the row consumed whole and the slice inserted beside it. It is the
 * row's provenance (a derived fact says so — invariant 6) and, for rows
 * written BEFORE aliases existed, the marker that a re-import uses to recover
 * the second identity by re-hashing the legs.
 */
export const AUTO_CLOSE_NOTE =
  "Closed automatically against an open position this account already held (FIFO, oldest lot first).";

/** A dedup hash is a sha1 hex digest — anything else in the notes is prose. */
const HASH_RE = /^[0-9a-f]{40}$/;

/**
 * EVERY hash that stands for this stored row: its own first, then its aliases,
 * de-duplicated and in a stable order.
 *
 * Read by the restore re-key (`lib/db/data-fixes.ts`) and the Data Quality
 * report. Import dedup and the restore skip/refusal read the HELD subset
 * instead (`heldIdentityHashes`, V1): an alias whose lot no longer closes on
 * its trade does not say that trade is recorded.
 * Pure and total: a row with no notes answers with just its own hash, so a
 * book with no alias rows de-duplicates exactly as v4.2.0 did.
 */
export function lotIdentityHashes(row: { dedupHash: string; importNotes: string | null }): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (h: string) => {
    if (!h || seen.has(h)) return;
    seen.add(h);
    out.push(h);
  };
  push(row.dedupHash);
  for (const seg of (row.importNotes ?? "").split("|")) {
    const s = seg.trim();
    if (!s.startsWith(DEDUP_ALIAS_PREFIX)) continue;
    const h = s.slice(DEDUP_ALIAS_PREFIX.length).trim().toLowerCase();
    if (HASH_RE.test(h)) push(h);
  }
  return out;
}

/** A stored row's legs, as the long/short reading needs them. */
export interface RowLegs {
  buyQty: number;
  sellQty: number;
  buyDate: string | null;
  sellDate: string | null;
}

/**
 * Does this row read LONG? The ONE definition (H1, wave 2H; moved here by V1
 * from `lib/trash.ts`, which had copied `updateManualTrade`'s): more bought than
 * sold, or a closed row whose purchase is dated before its sale — a closed row
 * states its direction only through its dates, the exit being the later one.
 */
export function readsLong(x: RowLegs): boolean {
  return x.buyQty > x.sellQty || (x.buyQty === x.sellQty && !!x.buyDate && !!x.sellDate && x.buyDate < x.sellDate);
}

/**
 * V1 (v4.3.0 wave 2H fourth seam fix) — do this row's `dedup-alias:` segments
 * still RECORD the trades they name? Only while its closing leg holds quantity:
 * a long's sell leg, a short's buy leg (`readsLong`).
 *
 * H1 keeps a joined lot's alias when the trade editor re-opens it (sell 0). That
 * lot no longer records the sale, so an alias counted anyway left the sale on
 * no row: its restore was skipped and its re-import deduped. A partial re-make
 * (sell 60 of 100) is the user's own edit and keeps the alias held.
 */
export function aliasHeld(row: RowLegs): boolean {
  return readsLong(row) ? row.sellQty > 0 : row.buyQty > 0;
}

/**
 * The hashes that say "this trade is already recorded here": the row's OWN hash
 * always, its aliases only while `aliasHeld`. The single door for every reader
 * that decides a trade is already in the book — the restore refusal and skip
 * (`lib/trash.ts`) and import dedup (`commit.ts`, preview and commit). The
 * restore re-key and the duplicate scan keep reading `lotIdentityHashes`.
 */
export function heldIdentityHashes(row: { dedupHash: string; importNotes: string | null } & RowLegs): string[] {
  return aliasHeld(row) ? lotIdentityHashes(row) : lotIdentityHashes({ dedupHash: row.dedupHash, importNotes: null });
}

/**
 * Has this row's identity been frozen by an auto-close — or by ANY alias?
 *
 * A frozen row's `dedup_hash` no longer describes its own legs, so anything
 * that RE-DERIVES a hash from the legs (the Paytm ISIN re-key, re-run on every
 * restore) must leave it alone — re-keying it would silently disconnect the
 * file that created it and let that file import again (S-2).
 *
 * W2-DQ P4 keeps this meaning on purpose: a lot joined from Data Quality
 * (`STALE_CLOSE_NOTE` + an alias) is frozen too — its legs now state the sale,
 * so a re-key from them would lose the buy file's identity. Whether a row is a
 * MERGED lot for the duplicate scan is a different question, answered by
 * `isAutoCloseMerged`.
 */
export function isLotIdentityFrozen(row: { dedupHash: string; importNotes: string | null }): boolean {
  const notes = row.importNotes ?? "";
  return notes.includes(DEDUP_ALIAS_PREFIX) || notes.includes(AUTO_CLOSE_NOTE);
}

/**
 * W2-DQ P4 — did an AUTO-CLOSE merge this row? True when the row carries
 * `AUTO_CLOSE_NOTE` or `PARTIAL_CLOSE_NOTE`, or carries an alias WITHOUT
 * `STALE_CLOSE_NOTE` (an alias of unknown provenance is read as merged — the
 * safe answer for a delete).
 *
 * A lot the user joined with its recorded sale from Data Quality is NOT
 * auto-close-merged: its alias is the sale the book itself had stored beside
 * it, so when another account joined the SAME two records the two rows are
 * plain cross-account copies of each other (`isPlainDuplicateCopy`'s twin
 * clause). Read by the duplicate scan (lib/import/broker-identity.ts) only;
 * the restore re-key keeps reading `isLotIdentityFrozen`.
 */
export function isAutoCloseMerged(row: { dedupHash: string; importNotes: string | null }): boolean {
  const notes = row.importNotes ?? "";
  if (notes.includes(AUTO_CLOSE_NOTE) || notes.includes(PARTIAL_CLOSE_NOTE)) return true;
  return notes.includes(DEDUP_ALIAS_PREFIX) && !notes.includes(STALE_CLOSE_NOTE);
}

/**
 * Written to `import_notes` on the row an execution left OVER: the file said
 * 100, 40 of it closed lots this account held, and this row is the other 60.
 *
 * A separate sentence from `AUTO_CLOSE_NOTE` on purpose (S-1, round 2): the
 * legacy leg-rehash fallback in wave 1's `commit.ts` (d0eda00; not in 4.3.0)
 * fires on the auto-close sentence,
 * and re-hashing THIS row's legs would produce exactly the hash a genuine
 * 60-share sale carries — a guess that would then swallow a real file.
 */
export const PARTIAL_CLOSE_NOTE =
  "Part of this execution closed open positions this account already held; this row is what was left of it.";

/** Append `sentence` once and `hash` once as an alias. Order is preserved. */
function withIdentityNote(importNotes: string | null, sentence: string, hash: string): string {
  const parts = (importNotes ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.includes(sentence)) parts.push(sentence);
  const alias = `${DEDUP_ALIAS_PREFIX}${hash}`;
  if (!parts.includes(alias)) parts.push(alias);
  return parts.join(" | ");
}

/**
 * The `import_notes` a lot carries after an execution consumed part or all of
 * it: the provenance sentence once, plus one alias per consuming execution.
 * Idempotent — a lot eaten by three sells ends with three aliases and one
 * sentence, in the order the sells arrived.
 *
 * W2a (design review revision 9): this is now written ONLY where the row is
 * the HOLDER of that execution's hash — a lot consumed WHOLE, which becomes
 * the closed row itself. A partly-consumed lot gets `withAutoClosedLotNote`
 * (the sentence alone) and the slice beside it holds the hash, because ONE
 * execution hash may have exactly ONE holder: two holders made the Trash
 * restore of the slice skip silently ("recorded in the position it closed",
 * `lib/trash.ts:546-551`) and 40 shares of realised P&L disappear.
 */
export function withLotCloseNote(importNotes: string | null, closingHash: string): string {
  return withIdentityNote(importNotes, AUTO_CLOSE_NOTE, closingHash);
}

/**
 * The `import_notes` a PARTLY consumed lot carries: the provenance sentence and
 * NOTHING else (revision 9). It freezes the row's identity
 * (`isLotIdentityFrozen` reads the sentence too), which is the point — the
 * lot's legs no longer state what its hash was built from — while leaving the
 * consuming execution's hash to the one row that holds it.
 */
export function withAutoClosedLotNote(importNotes: string | null): string {
  const parts = (importNotes ?? "").split("|").map((s) => s.trim()).filter(Boolean);
  if (!parts.includes(AUTO_CLOSE_NOTE)) parts.push(AUTO_CLOSE_NOTE);
  return parts.join(" | ");
}

/**
 * Marks the execution a piece of an auto-close belongs to, WITHOUT claiming its
 * identity (revision 9). `lotIdentityHashes` never reads this prefix, so a row
 * carrying it answers to its own hash alone — it is provenance, the thread that
 * ties the pieces of one execution together for the lifecycle work (W3), and
 * the reason a row-level delete of any piece can be refused by name.
 */
export const CLOSED_BY_PREFIX = "closed-by:";

/** Append `closed-by:<hash>` once. Adds no identity. */
export function withClosedByNote(importNotes: string | null, execHash: string): string {
  const parts = (importNotes ?? "").split("|").map((s) => s.trim()).filter(Boolean);
  const seg = `${CLOSED_BY_PREFIX}${execHash}`;
  if (!parts.includes(seg)) parts.push(seg);
  return parts.join(" | ");
}

/**
 * THIS PIECE's share of the closing execution's own stated bill (W3).
 *
 * A closed row's charges are the LOT's share plus the EXECUTION's share (R3),
 * merged into ten columns — and the merge is not invertible from the columns
 * alone: two unknowns, one equation. Un-close needs both halves exactly (it
 * gives the lot its share back and reinstates the execution with the bill the
 * file stated for it), and a re-derivation from quantities would be a rounded
 * guess about money that really moved. So the execution's half is recorded
 * beside the row, in the one free-text column that survives backup, restore and
 * every data fix.
 *
 * Eleven numbers in the column order of `STALE_CHARGE_PARTS` plus the total:
 * `exec-bill:[brokerage,sttCtt,exchangeTxn,sebi,stampDuty,ipft,gst,dpCharges,mtfInterest,pledgeCharges,total]`.
 */
export const EXEC_BILL_PREFIX = "exec-bill:";

/** The eleven numbers, in order. Kept here so both writers use one shape. */
export const EXEC_BILL_HEADS = [
  "brokerage", "sttCtt", "exchangeTxn", "sebi", "stampDuty",
  "ipft", "gst", "dpCharges", "mtfInterest", "pledgeCharges",
] as const;

export type ExecBill = Record<(typeof EXEC_BILL_HEADS)[number], number> & { total: number };

/** Append `exec-bill:[…]` once. Replaces nothing: a row has one closing bill. */
export function withExecBillNote(importNotes: string | null, bill: ExecBill): string {
  const parts = (importNotes ?? "").split("|").map((s) => s.trim()).filter(Boolean);
  if (parts.some((p) => p.startsWith(EXEC_BILL_PREFIX))) return parts.join(" | ");
  const nums = [...EXEC_BILL_HEADS.map((k) => bill[k] ?? 0), bill.total];
  parts.push(`${EXEC_BILL_PREFIX}[${nums.map((n) => Math.round(n * 100) / 100).join(",")}]`);
  return parts.join(" | ");
}

/** The execution's half of this row's bill, or null when the row states none. */
export function execBillFromNotes(importNotes: string | null): ExecBill | null {
  for (const seg of (importNotes ?? "").split("|")) {
    const s = seg.trim();
    if (!s.startsWith(EXEC_BILL_PREFIX)) continue;
    const body = s.slice(EXEC_BILL_PREFIX.length).trim();
    if (!/^\[[-0-9.,\s]*\]$/.test(body)) return null;
    const nums = body.slice(1, -1).split(",").map((x) => Number(x.trim()));
    if (nums.length !== EXEC_BILL_HEADS.length + 1 || nums.some((n) => !Number.isFinite(n))) return null;
    const bill = { total: nums[nums.length - 1]! } as ExecBill;
    EXEC_BILL_HEADS.forEach((k, i) => { bill[k] = nums[i]!; });
    return bill;
  }
  return null;
}

/** Strip every W2a/W3 machine segment, leaving the row's own prose. */
export function withoutAutoCloseNotes(importNotes: string | null): string | null {
  const parts = (importNotes ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s !== AUTO_CLOSE_NOTE && s !== PARTIAL_CLOSE_NOTE)
    .filter((s) => !s.startsWith(CLOSED_BY_PREFIX) && !s.startsWith(EXEC_BILL_PREFIX) && !s.startsWith(DEDUP_ALIAS_PREFIX));
  return parts.length ? parts.join(" | ") : null;
}

/**
 * Is this row a PIECE of an import's auto-close — a reduced lot, a lot it
 * converted, a slice, or what an execution had left over?
 *
 * Read by the delete refusals (W3): a row-level delete of one piece would leave
 * the others describing a close that no longer exists, so it is refused by name
 * and the user is offered un-close. A lot the USER joined from Data Quality
 * (R26, `STALE_CLOSE_NOTE`) is NOT a piece — that join has its own door.
 */
export function isAutoClosePiece(row: { dedupHash: string; importNotes: string | null }): boolean {
  return isAutoCloseMerged(row) || closedByHash(row.importNotes) != null;
}

/**
 * The same question, asked of the row's OWN WORDS only (revision 11).
 *
 * `isAutoClosePiece` inherits `isAutoCloseMerged`'s safe fallback — an alias of
 * UNKNOWN provenance is read as merged, which is the right answer for a delete
 * (refuse and ask) and the wrong one for a MERGE, where every v4.3 alias
 * collision the merge has always resolved (`dedup-alias:` from a Data Quality
 * join, R26) would be refused instead of dropped as the duplicate it is. So the
 * merge asks only for rows that SAY an import closed them: the sentence, the
 * leftover's sentence, or the `closed-by:` thread. Nothing infers it.
 */
export function saysAutoClosePiece(row: { importNotes: string | null }): boolean {
  const notes = row.importNotes ?? "";
  return notes.includes(AUTO_CLOSE_NOTE) || notes.includes(PARTIAL_CLOSE_NOTE) || closedByHash(notes) != null;
}

/**
 * The EXECUTION a piece belongs to — the hash every W3 door names or undoes.
 *
 * It is NOT `dedup_hash`. A lot consumed WHOLE is converted in place and keeps
 * its OWN identity, holding the execution's as a `dedup-alias:` (the one-holder
 * rule, revision 9); reading the column there hands the caller the LOT's hash,
 * and `unCloseExecution` then refuses the commonest shape there is, while the
 * delete refusal looks for the wrong family and lets a leftover row be stranded.
 * The order is the order the pieces state it: the `closed-by:` thread first
 * (a reduced lot, a leftover), then the held alias (a converted lot, a slice
 * that restates its own hash), then the row's own hash.
 */
export function executionHashOfPiece(row: { dedupHash: string; importNotes: string | null }): string {
  const thread = closedByHash(row.importNotes);
  if (thread) return thread;
  // Only a row that SAYS an import closed it may be read through its alias. An
  // alias of unknown provenance — a Data Quality join whose sentence a later
  // editor save dropped — belongs to that join's own door (R26), and reading it
  // here would have the delete refuse a pair `tests/trash-restore-alias.test.ts`
  // pins as deletable.
  if (!(row.importNotes ?? "").includes(AUTO_CLOSE_NOTE)) return row.dedupHash;
  const alias = lotIdentityHashes(row).find((h) => h !== row.dedupHash);
  return alias ?? row.dedupHash;
}

/**
 * The sentence every W3 refusal ends with, so all four doors say one thing
 * (ruling A3: refuse with the reason AND offer "un-close first").
 */
export function unCloseFirstNote(symbol: string, execHash: string): string {
  return `Un-close it first (Trades → the row's menu → "Un-close"), then try again. The closing execution is ${symbol} · ${execHash.slice(0, 12)}.`;
}

/** The execution hash a row was closed by, or null. Never an identity. */
export function closedByHash(importNotes: string | null): string | null {
  for (const seg of (importNotes ?? "").split("|")) {
    const s = seg.trim();
    if (!s.startsWith(CLOSED_BY_PREFIX)) continue;
    const h = s.slice(CLOSED_BY_PREFIX.length).trim().toLowerCase();
    if (HASH_RE.test(h)) return h;
  }
  return null;
}

/**
 * The `import_notes` a SCALED-DOWN remainder row carries (S-1, round 2).
 *
 * Its `dedup_hash` is the WHOLE execution's — the file stated 100 shares — but
 * its legs state only what was left, so the hash no longer describes them and
 * anything that re-derives one from the legs must leave it alone. Stating the
 * row's OWN hash as an alias is what freezes it: `lotIdentityHashes` de-dupes,
 * so the row gains no second identity, and `isLotIdentityFrozen` says yes.
 */
export function withScaledRemainderNote(importNotes: string | null, ownHash: string): string {
  return withIdentityNote(importNotes, PARTIAL_CLOSE_NOTE, ownHash);
}

/**
 * R26 (v4.3.0) — written to `import_notes` on a lot the USER closed from Data
 * Quality with the opposite-side row the book had stored as its own row.
 *
 * Its OWN sentence, not `AUTO_CLOSE_NOTE`: that one says "Closed
 * automatically", and nothing here was automatic — the user confirmed the
 * pair and its date. The alias is what makes a re-pull of the removed row a
 * duplicate; `isLotIdentityFrozen` then reads the lot as frozen, so the
 * restore re-key leaves it alone. It is NOT an auto-close merge
 * (`isAutoCloseMerged`, W2-DQ P4): Data Quality's duplicate scan offers it as
 * a copy when another account holds a row with the same identity set, and
 * never when the other book is unjoined (the identity sets then differ).
 */
export const STALE_CLOSE_NOTE =
  "Closed from Data Quality with a closing trade this account had stored as its own row; that row was removed and its record is kept here as an alias.";

/** The lot's `import_notes` after a Data Quality stale-lot close. Idempotent. */
export function withStaleCloseNote(importNotes: string | null, saleHash: string): string {
  return withIdentityNote(importNotes, STALE_CLOSE_NOTE, saleHash);
}

/**
 * Split ONE money component between a slice and what is left, BY REMAINDER —
 * the wave's own rule (`splitChargesByRemainder`, lib/import/api/dhan.ts).
 *
 * The slice takes its share rounded to the paisa and the remainder takes
 * `total − slice`, so the two ALWAYS sum to `total`. Rounding both halves
 * independently does not: a SEBI fee of ₹0.01 on a lot sold half was stored as
 * 0.01 + 0.01 = ₹0.02 levied against ₹0.01 charged, and ₹1.25 split 50/50 came
 * to ₹1.26 (round-2 audit M-1, 2026-09-10). Applied per COMPONENT, never to a
 * total: the totals are the sums of the components at rest.
 */
export function splitByRemainder(total: number, share: number): { slice: number; keep: number } {
  const slice = r2(total * share);
  return { slice, keep: r2(total - slice) };
}

/**
 * What an import DID to the book's open positions — one counter object, built
 * once in `commit.ts` and read by the file commit, the pull commit, both
 * previews and the auto-pull job (R14, R15, R31, R2).
 *
 * "Closed" counts `closedWhole` ONLY: a sale that merely reduced a lot has not
 * closed a position, and saying it did is R14. "already held in this account"
 * is said only of `closedAgainstStoredLot`, because a buy and a sell inside ONE
 * file were never "already held" (R15).
 */
export interface AutoCloseCounters {
  /** Lots consumed to zero — the only figure the word "closed" may describe. */
  closedWhole: number;
  /** Lots left open with less quantity than before. */
  reduced: number;
  /** Rows written as new open positions (a remainder counts here). */
  openedNew: number;
  /** Closes against a lot the book already held before this file. */
  closedAgainstStoredLot: number;
  /** Closes against a lot THIS file opened earlier in its own order (M-2). */
  closedAgainstThisFilesLot: number;
  /** Executions refused a close because they state no date (R72 / ruling A2). */
  refusedNoDate: number;
}

export const emptyAutoCloseCounters = (): AutoCloseCounters => ({
  closedWhole: 0,
  reduced: 0,
  openedNew: 0,
  closedAgainstStoredLot: 0,
  closedAgainstThisFilesLot: 0,
  refusedNoDate: 0,
});

/**
 * The sentences an import says about what it closed. Pure, so the preview and
 * the commit can never word the same book differently.
 */
export function autoCloseSentences(c: AutoCloseCounters): string[] {
  const out: string[] = [];
  const pos = (n: number) => `${n} position${n === 1 ? "" : "s"}`;
  // R14 — ONLY `closedWhole` may be called "closed". A sale that took 40 of a
  // 100 lot closed nothing; it reduced it, and the sentence below says so.
  // R15 — "already held in this account" is said only when the lots that were
  // closed actually came from the book: a buy and a sell inside ONE file were
  // never "already held".
  if (c.closedWhole > 0) {
    const stored = c.closedAgainstStoredLot > 0;
    const own = c.closedAgainstThisFilesLot > 0;
    const where =
      stored && own
        ? "against open positions — some this account already held, some opened earlier in this same file"
        : own
          ? "against positions opened earlier in this same file"
          : "against open positions this account already held";
    out.push(`${pos(c.closedWhole)} closed ${where} (FIFO, oldest first).`);
  }
  if (c.reduced > 0) {
    out.push(
      `${pos(c.reduced)} reduced, not closed: part of an incoming sale was matched against ${c.reduced === 1 ? "it" : "them"} and the rest is still open.`,
    );
  }
  if (c.refusedNoDate > 0) {
    out.push(
      `${c.refusedNoDate} incoming ${c.refusedNoDate === 1 ? "execution states" : "executions state"} no date, so nothing was closed automatically: both rows stay open and Data Quality lists them under "Open positions with their closing trade stored beside them", where you confirm the date.`,
    );
  }
  return out;
}

/** An open position the book already holds, as this module needs to see it. */
export interface OpenLot {
  /** `trades.id` — the row the applier will reduce or close. */
  id: number;
  accountId: number;
  broker: string;
  tradingsymbol: string;
  segment: string;
  exchange: string;
  /** long = bought and still held; short = sold to open and not yet covered. */
  side: "long" | "short";
  /** Quantity still open on this lot. */
  qty: number;
  /** Per-unit open price — a level, never rounded to paise (invariant 1). */
  price: number;
  /** Rupee value of the open leg. */
  value: number;
  /** Charges already booked on this row. */
  charges: number;
  /** ISO open date, or null when the file carried none. */
  date: string | null;
}

/** A single-sided execution arriving in the file (or pull) being imported. */
export interface IncomingRow {
  /** Stable identity of the row — the dedup hash. Never matched to itself. */
  key: string;
  accountId: number;
  broker: string;
  tradingsymbol: string;
  segment: string;
  exchange: string;
  /** The side this row EXECUTES: a sell closes longs, a buy covers shorts. */
  side: "buy" | "sell";
  qty: number;
  price: number;
  value: number;
  /** Charges computed for the whole incoming row; apportioned per slice. */
  charges: number;
  date: string | null;
}

/** One lot consumed (wholly or partly) by one incoming row. */
export interface LotClose {
  lotId: number;
  /** The incoming row that closed it. */
  rowKey: string;
  tradingsymbol: string;
  /** long = the lot was long and this is a sale; short = a cover. */
  side: "long" | "short";
  /** Quantity closed on this slice. */
  qty: number;
  /** Per-unit CLOSE price (the incoming row's price). */
  price: number;
  /** Close date (the incoming row's date). */
  date: string | null;
  /** The incoming row's charges apportioned to this slice. */
  charges: number;
  /** Per-unit OPEN price, carried through from the lot. */
  openPrice: number;
  /** Rupee value of the open leg consumed by this slice. */
  openValue: number;
  /** The lot's own charges apportioned to this slice. */
  openCharges: number;
  openDate: string | null;
  /**
   * The slice as a fraction of the lot's REMAINING quantity at the moment it
   * was taken — the applier pro-rates the row's money columns by it, the same
   * way `pair-legs.ts` splits `value` and `charges` by `take / lot.qty`.
   */
  lotShare: number;
  /** True when nothing is left of the lot: the applier closes the row itself. */
  fullyConsumed: boolean;
}

/** What is LEFT of a lot this plan touched (qty 0 = wholly consumed). */
export interface LotRemainder {
  lotId: number;
  qty: number;
  value: number;
  charges: number;
}

/** Incoming quantity that matched no lot and must still be written as a row. */
export interface UnmatchedIncoming {
  key: string;
  /** The part of the row that closed nothing — equals `qty` when it matched nothing at all. */
  qty: number;
}

export interface LotClosePlan {
  closes: LotClose[];
  /** Only the lots this plan touched. Untouched lots are not restated. */
  remainders: LotRemainder[];
  /** Incoming rows (or the tail of one) that closed nothing. */
  untouched: UnmatchedIncoming[];
}

/** The book a lot and an execution must share before they can be matched. */
export function matchKey(x: {
  accountId: number;
  broker: string;
  tradingsymbol: string;
  segment: string;
  exchange: string;
}): string {
  return [
    x.accountId,
    x.broker.trim().toLowerCase(),
    x.tradingsymbol.trim().toUpperCase(),
    x.segment,
    x.exchange,
  ].join("|");
}

/** Oldest first; a lot with no date is not assumed to be old, so it sorts last. */
function fifo(a: OpenLot, b: OpenLot): number {
  const da = a.date ?? "";
  const db = b.date ?? "";
  if (da !== db) {
    if (!da) return 1;
    if (!db) return -1;
    return da < db ? -1 : 1;
  }
  return a.id - b.id;
}

/**
 * Plan (never perform) the FIFO close of open lots by incoming executions.
 *
 * Pure: the inputs are not mutated, and the same arguments always produce the
 * same plan. The caller applies `closes` + `remainders` inside its own
 * transaction and writes `untouched` as ordinary rows.
 */
export function planLotCloses(
  openLots: readonly OpenLot[],
  incomingRows: readonly IncomingRow[],
): LotClosePlan {
  type State = { lot: OpenLot; qty: number; value: number; charges: number; touched: boolean };

  const byKey = new Map<string, State[]>();
  for (const lot of openLots) {
    if (lot.qty <= 0) continue;
    const k = matchKey(lot);
    const list = byKey.get(k);
    const state: State = { lot, qty: lot.qty, value: lot.value, charges: lot.charges, touched: false };
    if (list) list.push(state);
    else byKey.set(k, [state]);
  }
  for (const list of byKey.values()) list.sort((a, b) => fifo(a.lot, b.lot));

  const closes: LotClose[] = [];
  const untouched: UnmatchedIncoming[] = [];

  for (const row of incomingRows) {
    if (row.qty <= 0) continue;
    // A sale closes LONG lots; a purchase covers SHORT ones. Same-side lots are
    // additions to the position, not closes, and are left where they are.
    const wanted: OpenLot["side"] = row.side === "sell" ? "long" : "short";
    const list = byKey.get(matchKey(row)) ?? [];
    let remaining = row.qty;

    // R4/R72 (v4.5.0 W2a) — a lot bought AFTER the sale can never be closed by
    // it, and a close with no date is not stored at all. BOTH dates must be
    // stated: an unknown date is not evidence of anything (invariant 6), and a
    // close date sets the charge epoch, the holding period and the MTF day
    // count. A dateless execution therefore matches NOTHING, falls to
    // `untouched`, and is written as an ordinary row — both rows stay open and
    // Data Quality's `stale_open` offers the user the R26 join with a date they
    // confirm. The reachable shape is the same-day partial (buy 100, sell 40):
    // a pull dates only a closed or sell-only row (`api/angelone.ts:326`,
    // `api/upstox.ts:217`).
    if (!row.date) {
      untouched.push({ key: row.key, qty: row.qty });
      continue;
    }

    for (const st of list) {
      if (remaining <= 0) break;
      if (st.qty <= 0) continue;
      if (st.lot.side !== wanted) continue;
      if (!st.lot.date || st.lot.date > row.date) continue;

      const take = Math.min(remaining, st.qty);
      const lotShare = take / st.qty;
      const openValue = r2(st.value * lotShare);
      const openCharges = r2(st.charges * lotShare);

      st.qty = r2(st.qty - take);
      st.value = r2(st.value - openValue);
      st.charges = r2(st.charges - openCharges);
      st.touched = true;
      remaining = r2(remaining - take);

      closes.push({
        lotId: st.lot.id,
        rowKey: row.key,
        tradingsymbol: st.lot.tradingsymbol,
        side: st.lot.side,
        qty: take,
        price: row.price,
        date: row.date,
        // The incoming row's charges belong to the whole row, so each slice
        // carries its share of them — never the whole bill on every slice.
        charges: r2(row.charges * (row.qty > 0 ? take / row.qty : 0)),
        openPrice: st.lot.price,
        openValue,
        openCharges,
        openDate: st.lot.date,
        lotShare,
        fullyConsumed: st.qty <= 0,
      });
    }

    if (remaining > 0) untouched.push({ key: row.key, qty: remaining });
  }

  const remainders: LotRemainder[] = [];
  for (const list of byKey.values()) {
    for (const st of list) {
      if (!st.touched) continue;
      remainders.push({ lotId: st.lot.id, qty: st.qty, value: st.value, charges: st.charges });
    }
  }

  return { closes, remainders, untouched };
}
