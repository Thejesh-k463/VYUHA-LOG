export type QualitySeverity = "critical" | "warning" | "info";

export interface QualityIssue {
  code: string;
  severity: QualitySeverity;
  title: string;
  detail: string;
  count: number;
  href: string;
  ids?: number[];
}

export interface QualityTrade {
  id: number;
  isOpen: boolean;
  acquisition: string | null;
  acquisitionPrice: number | null;
  closingPrice: number | null;
  slPlanned: number | null;
  riskAmount: number | null;
  segment: string;
  mtfFundedAmount: number | null;
  instrumentType: string;
  expiry: string | null;
  strike: number | null;
  optionType: string | null;
  symbol: string;
  // R26 (v4.3.0) — the stale-open check (`staleOpenPairs`) reads these. They
  // are OPTIONAL so a caller that hands in only the fields above gets exactly
  // the report it got before: a row without its book identity is skipped by
  // that check, never guessed at. `getTrades()` rows carry all of them.
  accountId?: number;
  broker?: string;
  exchange?: string;
  tradingsymbol?: string;
  buyQty?: number;
  sellQty?: number;
  /** Per-unit levels — REAL, never rounded (invariant 1). */
  avgBuyPrice?: number;
  avgSellPrice?: number;
  buyDate?: string | null;
  sellDate?: string | null;
  /** SQLite `datetime('now')` — UTC, `YYYY-MM-DD HH:MM:SS`. */
  createdAt?: string | null;
  staged?: boolean;
}

/**
 * One broker identity (the client id / API key that names the CLIENT, never
 * the rotating token) found on connections in more than one account.
 *
 * `maskedIdentity` is masked BY THE CALLER — the plaintext identifier never
 * reaches this module, is never put in an issue's title or detail, and is
 * never written to the audit log. What the user sees here is the same masked
 * form the Import screen already shows beside the stored key.
 */
export interface DuplicateConnectionGroup {
  broker: string;
  /** Display label for `broker` ("Dhan", "Angel One", "OpenAlgo (Zerodha)"). */
  brokerLabel: string;
  maskedIdentity: string;
  accounts: { id: number; name: string }[];
}

/**
 * Trade rows sharing one `(broker, dedupHash)` in more than one account.
 *
 * The dedup hash carries NO account id (lib/import/dedup.ts) and the unique
 * index that enforces it is per account (`trades_account_broker_dedup_uq`), so
 * the same broker record imported into two accounts is stored twice and both
 * copies are counted by the All-accounts view.
 */
export interface DuplicateTradeGroup {
  broker: string;
  brokerLabel: string;
  dedupHash: string;
  symbol: string;
  /**
   * The record's own quantity, or NULL when no row in the group still states
   * it — every copy was merged into a lot by an auto-close, and a merged row's
   * quantity belongs to the lot, not to this record. Rendered "—" (invariant 6:
   * a figure nothing states is never borrowed from a different execution).
   */
  qty: number | null;
  buyDate: string | null;
  sellDate: string | null;
  /** Trade rows in the group, across every account holding it. */
  rows: number;
  /** The row ids, for `affected`. */
  ids: number[];
  /**
   * One entry per account holding the group. `removable` is the ONLY thing the
   * screen and the server action may act on — see `isPlainDuplicateCopy`
   * (a plain copy, or a joined lot whose twin in another account holds the
   * same identity set).
   */
  accounts: { id: number; name: string; rows: number; removable: boolean }[];
}

/**
 * A stored row's IDENTITY, as the duplicate scan needs to weigh it (M-5).
 *
 * A row can stand for more than one broker record: an auto-close (R5) folds an
 * incoming execution into the open lot it closed, so the surviving row keeps
 * its own dedup hash AND carries the consumed execution's hash as an alias
 * (`lotIdentityHashes` in lib/import/close-open-lots.ts). Grouping on the own
 * hash alone therefore MISSES a duplicate; deleting on it alone destroys a
 * merged lot.
 */
export interface DuplicateRowIdentity {
  /** Every hash that stands for this row: its OWN first, then its aliases. */
  identityHashes: readonly string[];
  /**
   * True when an AUTO-CLOSE assembled or reduced this row
   * (`isAutoCloseMerged`, lib/import/close-open-lots.ts). A lot the user joined
   * with its recorded sale from Data Quality is NOT auto-closed (W2-DQ P4).
   */
  autoClosed: boolean;
  /**
   * The account holding the row. Read only by the twin clause of
   * `isPlainDuplicateCopy`; a row without it never matches a twin.
   */
  accountId?: number;
}

/** Two identity sets hold exactly the same hashes, whatever their order. */
function sameIdentitySet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((h) => sb.has(h));
}

/**
 * MAY THIS ROW BE REMOVED as one account's copy of `groupHash`? (M-5, ruling
 * 2026-09-10 — only PLAIN copies get the button; a merged lot is never
 * removable. W2-DQ P4 adds the twin clause.)
 *
 * A row is removable on EITHER of two grounds.
 *
 * (a) PLAIN. Three clauses, and each one alone is enough to refuse:
 *
 *  1. The row's OWN hash is the group hash. A row that joins the group only
 *     through an alias is some OTHER record here; its own record is elsewhere.
 *  2. It carries no aliases. A row with an alias stands for two broker records
 *     at once, and only one of them is the duplicate — deleting the row deletes
 *     the other as well.
 *  3. No auto-close touched it. Clause 2 already catches every alias an
 *     auto-close writes; this clause is stated separately because the alias
 *     derivation is best-effort by construction, and a row the importer MARKED
 *     as merged is not a plain single-source row whatever its hashes say.
 *
 * (b) TWIN (P4). The row is not auto-close-merged, and ANOTHER account in
 *     `group` holds a row whose identity set is set-equal to this row's. A lot
 *     joined with its recorded sale from Data Quality stands for two records
 *     (the buy and the sale), and when the other book joined the same two
 *     records, removing this copy removes nothing the other book does not
 *     still hold. That is the owner's own two-account Dhan case: before this
 *     clause, joining both books left DuplicateFix with no button at all.
 *     Joined in ONE book only, the identity sets differ ({buy, sale} against
 *     {buy} and {sale}) and the joined copy stays unremovable.
 *
 * `group` is every row of the (broker, hash) group, across accounts; a caller
 * that passes none gets clause (a) alone. A group with no removable copy is
 * reported and linked, never offered a delete — `NO_PLAIN_COPY_NOTE`.
 */
export function isPlainDuplicateCopy(
  row: DuplicateRowIdentity,
  groupHash: string,
  group: readonly DuplicateRowIdentity[] = [],
): boolean {
  const [own, ...aliases] = row.identityHashes;
  if (own === groupHash && aliases.length === 0 && !row.autoClosed) return true;
  if (row.autoClosed || row.accountId == null || !row.identityHashes.includes(groupHash)) return false;
  return group.some(
    (o) => o.accountId != null && o.accountId !== row.accountId && sameIdentitySet(o.identityHashes, row.identityHashes),
  );
}

/**
 * What a cross-account duplicate group says when NO copy of it is plain.
 * Descriptive only (SEBI copy rule): it states what the rows are and where the
 * duplicate pull itself is ended, and offers nothing destructive.
 */
export const NO_PLAIN_COPY_NOTE =
  "No copy of this record stands alone: each one also carries an execution that closed a position in its own book, so removing one would delete that record too. The duplicate pull itself ends at Import → Disconnect.";

export interface QualityInputs {
  trades: QualityTrade[];
  markedTradeIds: Set<number>;
  knownSymbols: Set<string>;
  ipoLinkedTradeIds: Set<number>;
  staleMtmCount: number;
  missingAttachmentFiles: number;
  /**
   * Cross-account facts, resolved by a DB reader (lib/import/broker-identity.ts).
   * Optional: they span every account by definition, so a caller that has not
   * read them yet gets exactly the report it got before.
   */
  duplicateConnections?: DuplicateConnectionGroup[];
  duplicateTradeGroups?: DuplicateTradeGroup[];
}

export interface QualityReport {
  score: number;
  issues: QualityIssue[];
  affected: number;
  checked: number;
}

/** Where both cross-account issues send the user: the section that can fix them. */
export const DUPLICATES_HREF = "/data-quality#duplicates";

/** "A", "A and B", "A, B and C" — account names read as a sentence. */
function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The two CROSS-ACCOUNT issues (v4.2.1).
 *
 * Both are facts about more than one account at once, which is why they are
 * resolved outside this module and handed in already masked and already
 * grouped. One issue per duplicated identity, and one per duplicated
 * `(broker, dedupHash)` group — a group is the unit a user can actually fix,
 * so ten shared rows are ten issues only if they are ten different records.
 *
 * Severity follows the file's own rule — "critical" is reserved for gaps that
 * change MONEY. Duplicated TRADE rows already do: the All-accounts view sums
 * both copies, so P&L, turnover and expectancy are all overstated today. A
 * duplicated CONNECTION has not changed a number yet; it is the configuration
 * that produces the duplicates at the next pull, so it is a warning.
 */
export function crossAccountIssues(i: Pick<QualityInputs, "duplicateConnections" | "duplicateTradeGroups">): QualityIssue[] {
  const out: QualityIssue[] = [];

  for (const g of i.duplicateConnections ?? []) {
    if (g.accounts.length < 2) continue;
    out.push({
      code: `duplicate_connection:${g.broker}:${g.accounts.map((a) => a.id).join("-")}`,
      severity: "warning",
      title: `Same ${g.brokerLabel} client connected in ${g.accounts.length} accounts`,
      detail: `${g.brokerLabel} ${g.maskedIdentity} is connected in ${nameList(g.accounts.map((a) => a.name))}. A pull from any of them brings the same trades into each book.`,
      count: g.accounts.length,
      href: DUPLICATES_HREF,
      ids: [],
    });
  }

  for (const g of i.duplicateTradeGroups ?? []) {
    if (g.accounts.length < 2) continue;
    const when = g.sellDate ?? g.buyDate;
    out.push({
      code: `duplicate_trades:${g.broker}:${g.dedupHash.slice(0, 12)}`,
      severity: "critical",
      title: `${g.symbol} held in ${g.accounts.length} accounts as the same ${g.brokerLabel} record`,
      detail: `${g.rows} rows carry one ${g.brokerLabel} record (${g.qty ?? "—"} × ${g.symbol}${when ? `, ${when}` : ""}) in ${nameList(g.accounts.map((a) => a.name))}. The All-accounts view counts every copy.`,
      count: g.rows,
      href: DUPLICATES_HREF,
      ids: g.ids.slice(0, 100),
    });
  }

  return out;
}

// ───────────────── R26 (v4.3.0) — open rows with their sale beside them ─────
//
// Owner ruling R10 half b (06-ANSWERS:224): Data Quality lists the stale open
// rows and closes them with the sale already stored. With auto-close OFF for
// 4.3.0 (06-ANSWERS:353) this is the ONLY remedy: v4.2.0's importer writes a
// SELL of a held lot as its own row — an open, sell-only row (for a Dhan
// /positions pull with `sell_date` NULL) beside the long it actually closed.

/** Where the stale-open issue sends the user: the section that can close them. */
export const STALE_OPEN_HREF = "/data-quality#stale-open";

/**
 * Segments that cannot hold a SHORT: a delivery (or MTF) sell with no buy in
 * the row is a sale of a holding, never a short (M-3). So in these segments a
 * sell-only row is only ever the SALE of a pair, and the reverse reading — the
 * sale as a short that a later buy "covered" — is never produced.
 */
const NO_SHORT_SEGMENTS = new Set(["eq_delivery", "eq_mtf"]);

const IST_OFFSET_MS = 330 * 60_000;

/**
 * The IST calendar day of a stored `created_at` (SQLite `datetime('now')`,
 * which is UTC). A row pulled at 00:30 IST is still the previous day in UTC,
 * and the day it was pulled is the only date a 4.2.0 sale row can offer.
 */
export function istDayOf(createdAt: string | null | undefined): string | null {
  if (!createdAt) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?/.exec(createdAt.trim());
  if (!m) return null;
  if (!m[2]) return m[1];
  const ms = Date.parse(`${m[1]}T${m[2]}Z`);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** One open lot L and the opposite-side row S the book stored beside it. */
export interface StaleOpenPair {
  lotId: number;
  saleId: number;
  accountId: number;
  broker: string;
  symbol: string;
  tradingsymbol: string;
  segment: string;
  exchange: string;
  /** The LOT's side: long = closed by a sale; short = covered by a purchase. */
  side: "long" | "short";
  /** The lot's open quantity. */
  lotQty: number;
  /** The lot's per-unit entry level (REAL). */
  lotPrice: number;
  /** The lot's entry date. */
  lotDate: string;
  /** S's whole quantity, as the row states it. */
  saleQty: number;
  /**
   * The part of S allocated to THIS lot (W2-DQ P1): oldest lot first, a sale's
   * excess carrying to the next lot. Equals `saleQty` unless S is split across
   * lots or is larger than every lot it reaches.
   */
  matchedQty: number;
  /** S's per-unit price (REAL) — what the lot closes at. */
  salePrice: number;
  /** S's own date, or — when S states none — the IST day it was pulled. */
  saleDate: string;
  /** False when `saleDate` is the pull day: the user must confirm it (invariant 6). */
  saleDateStated: boolean;
  /**
   * True only when this ONE whole sale row covers this ONE whole lot exactly:
   * the allocation took all of S and all of the lot's open quantity, and
   * nothing else. A sale split across lots, or a lot covered by part of a sale
   * (or by several sales), is listed, never offered the one-step close —
   * `closeStaleLot` joins one lot to one sale and refuses the rest (PARTIAL).
   * Never true for a staged lot.
   */
  oneClick: boolean;
  /**
   * W2-FIXD2 — the LOT is a staged position: its fills live in `trade_legs`
   * and the parent row is their aggregate (invariants 4 and 5). The one-step
   * join writes the parent row only, with no exit leg, so the ladder would
   * still read open 100 beside a closed parent, and the next rebuild of the
   * ladder would re-open it with the sale row already removed. A staged lot is
   * listed and closed through its own exit (the ladder on /trades), which
   * prices each tranche and keeps R frozen at the first entry;
   * `closeStaleLot` refuses it (STAGED).
   */
  staged: boolean;
}

/**
 * W2-DQ P3 — did the USER record this row's basis? `acquisition` set to
 * anything but `'unknown'` (the importer writes only NULL or `'unknown'`; an
 * ESOP, IPO or gift is the user's own statement), or an acquisition price.
 *
 * A sale carrying a recorded basis is never a stale-close candidate on either
 * pass: its P&L is `(sale − that basis)`, and joining it to a market lot would
 * delete the sale and its basis, re-pricing it against the lot instead.
 */
export function hasRecordedBasis(r: { acquisition: string | null; acquisitionPrice: number | null }): boolean {
  return (r.acquisition != null && r.acquisition !== "unknown") || (r.acquisitionPrice != null && r.acquisitionPrice > 0);
}

/**
 * W2-DQ P2 — an OPEN closing-trade row left on its own after the position it
 * was recorded against was closed some other way (the manual close on /risk
 * after a partial pair, most often). Listed as a warning, never changed
 * automatically.
 */
export interface StaleSaleRow {
  saleId: number;
  accountId: number;
  broker: string;
  symbol: string;
  tradingsymbol: string;
  segment: string;
  exchange: string;
  /** The side of the CLOSED lot: long = this row is a sale; short = a purchase. */
  side: "long" | "short";
  saleQty: number;
  /** Per-unit price (REAL). */
  salePrice: number;
  /** The row's own date, or the IST day it was pulled. */
  saleDate: string;
  saleDateStated: boolean;
  /** The closed opposite-side lots in the book entered on or before it. */
  closedLotIds: number[];
}

type BookRow = QualityTrade & {
  accountId: number;
  broker: string;
  tradingsymbol: string;
  exchange: string;
  buyQty: number;
  sellQty: number;
};

const isoDay = (s: string | null | undefined): string | null => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
const sameQty = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/**
 * An open row read as a lot of `side`. A STAGED row is a lot like any other
 * (W2-FIXD2, seam D2): a holding bought in two fills on one day is one staged
 * row, and the decided P1/P2 rule lists every open lot with a later sale row
 * in its book. What a staged lot never gets is the one-step join — see
 * `StaleOpenPair.staged`.
 */
function isStaleLot(r: BookRow, side: "long" | "short"): boolean {
  if (!r.isOpen) return false;
  if (side === "long") return r.buyQty > r.sellQty;
  // A short is admitted only where a short can exist, and never as a sale
  // whose basis the book could not state: that row is a sale of a holding the
  // file never showed, and pairing a purchase against it would fabricate a
  // P&L (invariant 6; tests/auto-close-off.test.ts case 8).
  return r.sellQty > r.buyQty && !NO_SHORT_SEGMENTS.has(r.segment) && r.acquisition == null;
}

function saleDay(r: BookRow, side: "long" | "short"): { date: string; stated: boolean } | null {
  const stated = isoDay(side === "long" ? r.sellDate : r.buyDate);
  if (stated) return { date: stated, stated: true };
  const pulled = istDayOf(r.createdAt);
  return pulled ? { date: pulled, stated: false } : null;
}

/** A row of sale SHAPE for `side`: a sell-only row closes a long, a buy-only row covers a short. */
const saleShaped = (r: BookRow, side: "long" | "short") =>
  side === "long" ? r.sellQty > 0 && r.buyQty === 0 : r.buyQty > 0 && r.sellQty === 0;

const byDateThenId = (a: { date: string; row: BookRow }, b: { date: string; row: BookRow }) =>
  a.date === b.date ? a.row.id - b.row.id : a.date < b.date ? -1 : 1;

/**
 * A CLOSED row read as a lot of `side`, with its entry date — or null.
 *
 * A closed round trip states both legs, so its direction is read from their
 * dates: a long was bought on or before it was sold (a same-day round trip is
 * a long, as a same-day pair is in `staleOpenPairs`), and a short was sold
 * strictly before it was covered. A short exists only where a short can
 * (`NO_SHORT_SEGMENTS`), and a lot with no entry date is not evidence of
 * anything.
 */
function closedLotEntry(r: BookRow, side: "long" | "short"): string | null {
  if (r.isOpen) return null;
  const buy = isoDay(r.buyDate);
  const sell = isoDay(r.sellDate);
  if (side === "long") return r.buyQty > 0 && buy && (!sell || buy <= sell) ? buy : null;
  if (NO_SHORT_SEGMENTS.has(r.segment)) return null;
  return r.sellQty > 0 && sell && (!buy || sell < buy) ? sell : null;
}

/** Group rows into books: accountId + broker + tradingsymbol + segment + exchange. */
function booksOf(trades: readonly QualityTrade[]): BookRow[][] {
  const books = new Map<string, BookRow[]>();
  for (const t of trades) {
    if (t.accountId == null || !t.broker || !t.tradingsymbol || !t.exchange || t.buyQty == null || t.sellQty == null) continue;
    const k = `${t.accountId}|${t.broker.trim().toLowerCase()}|${t.tradingsymbol.trim().toUpperCase()}|${t.segment}|${t.exchange}`;
    const list = books.get(k);
    if (list) list.push(t as BookRow);
    else books.set(k, [t as BookRow]);
  }
  return [...books.values()];
}

/** The pairs of ONE book. */
function pairsOfBook(rows: readonly BookRow[]): StaleOpenPair[] {
  const out: StaleOpenPair[] = [];
  const asSale = new Set<number>();
  const asLot = new Set<number>();
  for (const side of ["long", "short"] as const) {
    const lots: { row: BookRow; date: string; open: number; left: number }[] = [];
    for (const r of rows) {
      if (asSale.has(r.id) || !isStaleLot(r, side)) continue;
      const date = isoDay(side === "long" ? r.buyDate : r.sellDate);
      if (!date) continue;
      const open = Math.abs(r.buyQty - r.sellQty);
      lots.push({ row: r, date, open, left: open });
    }
    if (lots.length === 0) continue;
    lots.sort(byDateThenId);

    const sales: { row: BookRow; date: string; stated: boolean; qty: number }[] = [];
    for (const r of rows) {
      // P3: a sale whose basis the user recorded is never a candidate.
      if (asLot.has(r.id) || !saleShaped(r, side) || hasRecordedBasis(r)) continue;
      const when = saleDay(r, side);
      if (!when) continue;
      sales.push({ row: r, ...when, qty: side === "long" ? r.sellQty : r.buyQty });
    }
    sales.sort(byDateThenId);

    // P1: FIFO allocation. Each sale, in date order, takes from the oldest lot
    // that still has quantity and is dated on or before it; what is left of
    // the sale carries to the next such lot.
    const links: { lot: (typeof lots)[number]; sale: (typeof sales)[number]; take: number }[] = [];
    for (const s of sales) {
      let remaining = s.qty;
      for (const l of lots) {
        if (remaining <= 1e-9) break;
        if (l.date > s.date) break; // lots are date-ordered: every later one is later still
        if (l.left <= 1e-9 || l.row.id === s.row.id) continue;
        const take = Math.min(remaining, l.left);
        l.left -= take;
        remaining -= take;
        links.push({ lot: l, sale: s, take });
        asSale.add(s.row.id);
        asLot.add(l.row.id);
      }
    }

    for (const { lot, sale: s, take } of links) {
      out.push({
        lotId: lot.row.id,
        saleId: s.row.id,
        accountId: lot.row.accountId,
        broker: lot.row.broker,
        symbol: lot.row.symbol,
        tradingsymbol: lot.row.tradingsymbol,
        segment: lot.row.segment,
        exchange: lot.row.exchange,
        side,
        lotQty: lot.open,
        lotPrice: (side === "long" ? lot.row.avgBuyPrice : lot.row.avgSellPrice) ?? 0,
        lotDate: lot.date,
        saleQty: s.qty,
        matchedQty: take,
        salePrice: (side === "long" ? s.row.avgSellPrice : s.row.avgBuyPrice) ?? 0,
        saleDate: s.date,
        saleDateStated: s.stated,
        // One whole sale row on one whole lot: the link took all of both — and
        // never a staged lot, whose ladder the join would leave open (W2-FIXD2).
        oneClick: sameQty(take, lot.open) && sameQty(take, s.qty) && !lot.row.staged,
        staged: !!lot.row.staged,
      });
    }
  }
  return out;
}

/**
 * PURE: pair each open lot with the opposite-side row(s) stored beside it.
 *
 *  - A SALE (S) is a row of buy-only or sell-only SHAPE, whatever its
 *    `isOpen` — v4.2.0 stored a sale as an open short — whose basis the user
 *    did not record (`hasRecordedBasis`, W2-DQ P3).
 *  - A LOT (L) is an open row whose net side is opposite to S, staged or not
 *    (W2-FIXD2); a staged lot is listed with `staged` and never `oneClick`.
 *  - Same book: accountId + broker + tradingsymbol + segment + exchange.
 *  - S's date (its own, or the IST day it was pulled) is on or after L's
 *    entry date; a lot with no entry date is not evidence of being held.
 *  - Each row takes ONE role. Sales against longs are read first, so a
 *    same-day BUY + SELL is one pair (the buy is the lot), never two.
 *  - ALLOCATION (W2-DQ P1): sales are taken in date order and allocated to
 *    lots oldest lot first; a sale's excess carries to the next lot, so one
 *    sale covering two lots lists BOTH. Every lot a sale reaches is listed,
 *    one entry per (lot, sale) link. A lot no sale quantity reaches is a
 *    position still held, and is not listed.
 *
 * Linear in the book: rows are grouped once, and only a group holding both a
 * lot and a sale does any work.
 */
export function staleOpenPairs(trades: readonly QualityTrade[]): StaleOpenPair[] {
  const out: StaleOpenPair[] = [];
  for (const rows of booksOf(trades)) {
    if (rows.length < 2) continue;
    out.push(...pairsOfBook(rows));
  }
  return out.sort((a, b) => a.tradingsymbol.localeCompare(b.tradingsymbol) || a.lotId - b.lotId || a.saleId - b.saleId);
}

/**
 * PURE (W2-DQ P2): the OPEN closing-trade rows left with no open lot to pair,
 * in a book holding a CLOSED opposite-side lot entered on or before them.
 *
 * Narrow by construction — every clause must hold:
 *  - the row is open, not staged, and of sale SHAPE for the side (sell-only
 *    against a long; buy-only against a short, only where a short can exist);
 *  - its basis is not recorded by the user (`hasRecordedBasis`, P3);
 *  - it takes no part in any stale pair (`staleOpenPairs`): an open lot is
 *    still there to pair it, and that is the stale_open check's job;
 *  - it has a date (its own, or the IST day it was pulled);
 *  - the same book holds a CLOSED lot of the opposite side entered on or
 *    before that date (`closedLotEntry`).
 *
 * It is a WARNING, and nothing here or anywhere offers to change the row.
 */
export function staleSaleRows(trades: readonly QualityTrade[]): StaleSaleRow[] {
  const out: StaleSaleRow[] = [];
  for (const rows of booksOf(trades)) {
    if (rows.length < 2) continue;
    const paired = new Set<number>();
    for (const p of pairsOfBook(rows)) {
      paired.add(p.lotId);
      paired.add(p.saleId);
    }
    for (const side of ["long", "short"] as const) {
      const closed: { row: BookRow; date: string }[] = [];
      for (const r of rows) {
        const date = closedLotEntry(r, side);
        if (date) closed.push({ row: r, date });
      }
      if (closed.length === 0) continue;
      closed.sort(byDateThenId);
      for (const r of rows) {
        if (!r.isOpen || r.staged || paired.has(r.id) || !saleShaped(r, side) || hasRecordedBasis(r)) continue;
        const when = saleDay(r, side);
        if (!when) continue;
        const before = closed.filter((c) => c.row.id !== r.id && c.date <= when.date);
        if (before.length === 0) continue;
        out.push({
          saleId: r.id,
          accountId: r.accountId,
          broker: r.broker,
          symbol: r.symbol,
          tradingsymbol: r.tradingsymbol,
          segment: r.segment,
          exchange: r.exchange,
          side,
          saleQty: side === "long" ? r.sellQty : r.buyQty,
          salePrice: (side === "long" ? r.avgSellPrice : r.avgBuyPrice) ?? 0,
          saleDate: when.date,
          saleDateStated: when.stated,
          closedLotIds: before.map((c) => c.row.id),
        });
      }
    }
  }
  return out.sort((a, b) => a.tradingsymbol.localeCompare(b.tradingsymbol) || a.saleId - b.saleId);
}

/** The user's own journal fields a stored sale row can carry. */
export interface SaleJournalRow {
  notes?: string | null;
  setupTag?: string | null;
  emotionTag?: string | null;
  mistakeTags?: readonly string[] | null;
  playbookId?: number | null;
  exitTrigger?: string | null;
}

/**
 * What of the user's OWN record the sale row holds. Joining removes the row
 * (through the recovery snapshot), so anything listed here would leave the
 * journal with it. Decision (R26): REFUSE and keep the pair listed, rather
 * than carry the fields onto the lot — two rows' notes, tags and screenshots
 * merged by a machine are no longer what the user wrote about either trade.
 */
export function saleJournalFields(row: SaleJournalRow, counts: { attachments: number; legs: number }): string[] {
  const out: string[] = [];
  if (row.notes?.trim()) out.push("notes");
  if (row.setupTag?.trim()) out.push("a setup tag");
  if (row.emotionTag?.trim()) out.push("an emotion tag");
  if (row.mistakeTags && row.mistakeTags.length > 0) out.push("mistake tags");
  if (row.playbookId != null) out.push("a playbook");
  if (row.exitTrigger?.trim()) out.push("an exit reason");
  if (counts.attachments > 0) out.push("attachments");
  if (counts.legs > 0) out.push("legs");
  return out;
}

/** Why a pair whose sale carries journal entries gets no button. Descriptive only. */
export function staleJournalNote(fields: string[], side: "long" | "short"): string {
  const what = side === "long" ? "sale" : "purchase";
  return `The recorded ${what} row carries your own journal entries (${nameList(fields)}), and joining it would delete them with the row, so it is not joined here. Once they are moved onto the position, the join is offered.`;
}

const ISSUE_WEIGHT = { critical: 12, warning: 6, info: 2 } as const;

/** The completeness score for a set of issues. Capped per issue so one gap
 *  cannot swamp the whole score, and floored at 0. */
export function scoreIssues(issues: QualityIssue[]): number {
  const penalty = issues.reduce((s, x) => s + Math.min(30, x.count * ISSUE_WEIGHT[x.severity]), 0);
  return Math.max(0, 100 - penalty);
}

export function assessDataQuality(i: QualityInputs): QualityReport {
  const issues: QualityIssue[] = [];
  const add = (issue: QualityIssue, ids: number[] = []) => { if (issue.count > 0) issues.push({ ...issue, ids: ids.slice(0, 100) }); };

  const basis = i.trades.filter((t) => t.acquisition != null && (!t.acquisitionPrice || t.acquisitionPrice <= 0));
  add({ code: "unknown_basis", severity: "critical", title: "Unknown acquisition cost", detail: "These sales cannot produce trustworthy P&L, tax, expectancy, or ROM until their basis is confirmed.", count: basis.length, href: "/trades?basis=unknown" }, basis.map((t) => t.id));

  // R26 — critical: the book counts the position as open AND the sale as a
  // second position, so holdings, unrealised P&L and tax are all wrong today.
  const staleLots = [...new Set(staleOpenPairs(i.trades).map((p) => p.lotId))];
  add({ code: "stale_open", severity: "critical", title: "Open positions with their closing trade stored beside them", detail: "A later opposite-side row in the same account, broker and scrip was stored as its own row, so the position still reads open and the sale reads as a second position. Holdings, unrealised P&L and tax count both until the two are joined.", count: staleLots.length, href: STALE_OPEN_HREF }, staleLots);

  // W2-DQ P2 — a WARNING, deliberately below stale_open: the position itself is
  // already closed, and the row left beside it is listed, never changed here.
  const staleSales = staleSaleRows(i.trades).map((s) => s.saleId);
  add({ code: "stale_sale", severity: "warning", title: "Closing trades still open with no open position left to close", detail: "An open sale row (or, against a short, purchase row) in the same account, broker and scrip has no open position left to pair with, and a position in that scrip entered on or before it is already closed. Holdings, unrealised P&L and tax read the row as a position of its own. It is listed here and never changed automatically.", count: staleSales.length, href: STALE_OPEN_HREF }, staleSales);

  // EQUITY ONLY, and the exclusion is the fix for a real dead end (v4.2).
  //
  // This counted every open DERIVATIVE as an unmarked position and sent the
  // user to /equity to fix it — where a typed mark for a contract is REFUSED:
  // `mtm_prices` is keyed on the SYMBOL, `getMtmMap()` reads mtm[symbol] first,
  // and M1 (`lib/quotes/persist-mark.ts`, `isCashKey()`) skips derivative rows
  // for exactly that reason, so a contract mark would price the cash position
  // at the option's price. An issue nobody can clear is a permanent score
  // penalty and a permanently red card; the honest report is that this check
  // is about cash positions, until a mark store keyed on the traded contract
  // exists. Option contract COMPLETENESS is still checked, below.
  const unmarked = i.trades.filter(
    (t) => t.isOpen && t.instrumentType === "equity" && !(t.closingPrice && t.closingPrice > 0) && !i.markedTradeIds.has(t.id),
  );
  add({ code: "unmarked_open", severity: "critical", title: "Open positions without a mark", detail: "Unrealised P&L and live risk are incomplete for these positions.", count: unmarked.length, href: "/equity" }, unmarked.map((t) => t.id));

  const unstopped = i.trades.filter((t) => t.isOpen && (t.slPlanned == null || t.riskAmount == null));
  add({ code: "missing_stop", severity: "warning", title: "Open positions without complete risk", detail: "Set both a stop and risk amount so limit, R and cockpit calculations reconcile.", count: unstopped.length, href: "/trades?view=open" }, unstopped.map((t) => t.id));

  const mtf = i.trades.filter((t) => t.segment === "eq_mtf" && (!t.mtfFundedAmount || t.mtfFundedAmount <= 0));
  add({ code: "mtf_funding", severity: "warning", title: "MTF positions without funded principal", detail: "Interest, leverage and own-capital return need the broker-funded amount.", count: mtf.length, href: "/equity?funding=mtf" }, mtf.map((t) => t.id));

  const options = i.trades.filter((t) => t.instrumentType === "option" && (!t.expiry || t.strike == null || !t.optionType));
  add({ code: "option_contract", severity: "warning", title: "Incomplete option contracts", detail: "Expiry, strike and CE/PE are required for Greeks, settlement and seller analytics.", count: options.length, href: "/trades" }, options.map((t) => t.id));

  const instrument = i.trades.filter((t) => !i.knownSymbols.has(t.symbol.toUpperCase()));
  add({ code: "instrument_master", severity: "info", title: "Symbols absent from instrument master", detail: "Sector, lot-size and concentration coverage may be incomplete.", count: new Set(instrument.map((t) => t.symbol)).size, href: "/instruments" }, instrument.map((t) => t.id));

  const ipo = i.trades.filter((t) => t.acquisition === "ipo" && !i.ipoLinkedTradeIds.has(t.id));
  add({ code: "ipo_link", severity: "warning", title: "IPO holdings not linked to an IPO record", detail: "Linking makes allotment basis, listing mark and exit flow from one source of truth.", count: ipo.length, href: "/ipos" }, ipo.map((t) => t.id));

  add({ code: "stale_mtm", severity: "info", title: "Stale MTM marks", detail: "Refresh or confirm prices before relying on unrealised P&L and breach alerts.", count: i.staleMtmCount, href: "/risk" });
  add({ code: "missing_attachment", severity: "warning", title: "Attachment records with missing files", detail: "The journal points to images that are no longer present on disk.", count: i.missingAttachmentFiles, href: "/backup" });

  // Cross-account issues last: they are facts about the accounts, not about
  // the trades this call was handed, and a caller that resolved none is left
  // with exactly the report it had before.
  for (const issue of crossAccountIssues(i)) issues.push(issue);

  return { score: scoreIssues(issues), issues, affected: new Set(issues.flatMap((x) => x.ids ?? [])).size, checked: i.trades.length };
}
