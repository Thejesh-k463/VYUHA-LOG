/**
 * R5 (v4.2.1) — an incoming execution that CLOSES a position the book already
 * holds, decided across rows instead of inside one file.
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
// data fixes. Dedup, the restore re-key and Data Quality all read identity
// through `lotIdentityHashes`, so there is exactly one answer to "which files
// does this row already account for".

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
 * The single door for import dedup (`commit.ts`), the restore re-key
 * (`lib/db/data-fixes.ts`) and the Data Quality report. Pure and total: a row
 * with no notes answers with just its own hash.
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

/**
 * Has this row's identity been frozen by an auto-close?
 *
 * A frozen row's `dedup_hash` no longer describes its own legs, so anything
 * that RE-DERIVES a hash from the legs (the Paytm ISIN re-key, re-run on every
 * restore) must leave it alone — re-keying it would silently disconnect the
 * file that created it and let that file import again (S-2).
 */
export function isLotIdentityFrozen(row: { dedupHash: string; importNotes: string | null }): boolean {
  const notes = row.importNotes ?? "";
  return notes.includes(DEDUP_ALIAS_PREFIX) || notes.includes(AUTO_CLOSE_NOTE);
}

/**
 * Written to `import_notes` on the row an execution left OVER: the file said
 * 100, 40 of it closed lots this account held, and this row is the other 60.
 *
 * A separate sentence from `AUTO_CLOSE_NOTE` on purpose (S-1, round 2): the
 * legacy leg-rehash fallback in `commit.ts` fires on the auto-close sentence,
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
 */
export function withLotCloseNote(importNotes: string | null, closingHash: string): string {
  return withIdentityNote(importNotes, AUTO_CLOSE_NOTE, closingHash);
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

    for (const st of list) {
      if (remaining <= 0) break;
      if (st.qty <= 0) continue;
      if (st.lot.side !== wanted) continue;

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
