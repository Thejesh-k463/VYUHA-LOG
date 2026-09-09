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
 * 5. NEVER a row against itself, and never a row from the same file against
 *    another row of that file — the caller passes lots the BOOK already holds,
 *    which is what makes this cross-import rather than a second pairing pass.
 * 6. A row that already states both legs (a closed pair) is not an incoming
 *    execution at all and never reaches here; the caller filters it out.
 *
 * Quantities are shares/units; money is rupees at runtime (invariant 1) — the
 * paise boundary is the column, not this module.
 */

/** Round to the paisa. Money crosses this module as rupees. */
const r2 = (n: number) => Math.round(n * 100) / 100;

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
