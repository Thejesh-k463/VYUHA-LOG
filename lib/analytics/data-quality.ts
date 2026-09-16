import { DEDUP_ALIAS_PREFIX, STALE_CLOSE_NOTE, lotIdentityHashes } from "@/lib/import/close-open-lots";
import { normalizeDate } from "@/lib/domain/trading-day";

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
  /** M2 (wave 2G) — read only to tell a lot the Data Quality join closed (`closedByStaleJoin`). */
  importNotes?: string | null;
  /**
   * H3 (wave 2H) — read only by `staleJoinExempts`: a joined lot is exempt for
   * a sale whose hash is NOT one of its identity hashes. A row without it is
   * never shown to be another record, so the joined lot then counts.
   */
  dedupHash?: string;
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
  /**
   * L6 (v4.3.0 wave 2L) — EXITED IPO records with no holding attached, resolved
   * by the DB reader. Optional in the same way: a caller that has not read them
   * gets exactly the report it got before. Only exited records are carried,
   * because an unlinked exited record is the one that states a sale of its own
   * beside the holding's.
   */
  unlinkedIpoRecords?: IpoRecordFacts[];
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
   * Never true for a staged lot, a staged sale (`saleStaged`), or an
   * `ambiguous` pair.
   */
  oneClick: boolean;
  /**
   * R2-DQ N7/N8 — the book is NOT unambiguous: it holds a CLOSED lot of this
   * side entered on or before the sale AND exited on or after this lot's entry
   * (or with no stated exit) — it overlapped the lot being joined
   * (`closedLotIds`; R2F-DQ narrowed it so a round trip closed before this lot
   * was bought, e.g. a year earlier, leaves the pair one-click). A lot closed some
   * other way (its ladder exit, the manual close on /risk) may already have
   * taken this sale's quantity, and FIFO re-pairs the leftover sale row with
   * the next held lot — joining the two would count the sale twice. Such a
   * pair is listed for review (the `stale_review` warning, not the critical
   * `stale_open`), never one-click, and `closeStaleLot` refuses it
   * (AMBIGUOUS). A question is better than a confident wrong answer.
   */
  ambiguous: boolean;
  /** The closed lots of this side in the book entered on or before the sale and exited on or after this lot's entry (or with no stated exit). */
  closedLotIds: number[];
  /**
   * R2-DQ N9/N10 — the SALE row is staged: it was recorded in several fills
   * (its executions live in `trade_legs`). The one-step join deletes the sale
   * row, fills and all, so it is never offered for such a sale.
   */
  saleStaged: boolean;
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
 * dates: a long was bought before it was sold, and a short was sold before it
 * was covered. A short exists only where a short can (`NO_SHORT_SEGMENTS`),
 * and a lot with no entry date is not evidence of anything.
 *
 * R2-DQ N12 — a row whose buy and sell dates are EQUAL has no knowable
 * direction where a short can exist: a same-day write-and-cover of an option
 * reads exactly like a same-day buy-and-sell. `sameDay` says what to do with
 * it:
 *  - "evidence" (the `stale_sale` warning): it is not counted as a closed lot
 *    of either side, so a later genuine sell-to-open write of the contract is
 *    never called a closing trade with no open position;
 *  - "possible" (the N7/N8 ambiguity test): it MAY have been a lot of this
 *    side, so it counts — it cannot be ruled out as the position that already
 *    took the sale.
 * In a segment that cannot hold a short (delivery, MTF), a closed row is a
 * long whatever its dates, so its direction is known and it counts either way.
 */
function closedLotEntry(r: BookRow, side: "long" | "short", sameDay: "evidence" | "possible"): string | null {
  if (r.isOpen) return null;
  const buy = isoDay(r.buyDate);
  const sell = isoDay(r.sellDate);
  const noShort = NO_SHORT_SEGMENTS.has(r.segment);
  const sameDayCounts = sameDay === "possible" || noShort;
  if (side === "long") return r.buyQty > 0 && buy && (!sell || buy < sell || (buy === sell && sameDayCounts)) ? buy : null;
  if (noShort) return null;
  return r.sellQty > 0 && sell && (!buy || sell < buy || (sell === buy && sameDay === "possible")) ? sell : null;
}

/**
 * R2F-DQ — the EXIT date of a closed row read as a lot of `side` (a long exits
 * on its sell date, a short on its cover date), or null when the row states
 * none. Null is not evidence that the lot closed before anything, so the
 * ambiguity test counts such a lot.
 */
function closedLotExit(r: BookRow, side: "long" | "short"): string | null {
  return isoDay(side === "long" ? r.sellDate : r.buyDate);
}

/**
 * M2 (wave 2G) — was this row closed by the Data Quality join itself? It then
 * carries `STALE_CLOSE_NOTE` and its sale's alias (`withStaleCloseNote`). The
 * trade editor and `closePosition` drop the sentence (keeping the alias) when
 * they re-make the close (H1, wave 2H), so a row still carrying both is a
 * close the join made and nobody changed since. An alias of any other
 * provenance, or the sentence with no alias, is not.
 */
function closedByStaleJoin(r: BookRow): boolean {
  const parts = (r.importNotes ?? "").split("|").map((s) => s.trim());
  return parts.includes(STALE_CLOSE_NOTE) && parts.some((s) => s.startsWith(DEDUP_ALIAS_PREFIX));
}

/** Two per-unit prices equal at the paisa. Only compared, never stored rounded (invariant 1). */
const samePaisa = (a: number, b: number) => Math.round(a * 100) === Math.round(b * 100);

/**
 * Y3 (wave 2I) — does this row STATE a per-unit price?
 *
 * `trades.avg_sell_price` / `avg_buy_price` are NOT NULL DEFAULT 0, so a stored
 * row with quantity and no price arrives as 0: 0 IS the unstated value, and the
 * null/non-finite guards alone could never fire for a stored row. A row that
 * states no price never proves a sale differs from a close.
 */
const statedPrice = (p: number | null | undefined): p is number => p != null && Number.isFinite(p) && p !== 0;

/**
 * H3 (wave 2H) — may the closed row `c` be left out of the ambiguity test for
 * the link to `sale`? M2 exempted a joined lot for EVERY link; that made three
 * reachable books one-click onto a sale the lot already counts. Exempt ONLY
 * when all of these hold:
 *  (c) `c` is still the join's close (`closedByStaleJoin`: sentence + alias);
 *  (a) the sale is not one of `c`'s records — its hash is none of
 *      `lotIdentityHashes(c)` (a sale restored from Deleted items keeps the
 *      hash the join recorded as the alias). A sale stating no hash cannot be
 *      shown to be another record;
 *  (b) the sale does not restate `c`'s close: not the same closing quantity
 *      AND the same closing price at the paisa (the same sale re-arriving from
 *      another file kind carries another hash). A genuine sibling identical in
 *      both is refused too — the accepted cost: a question is always better
 *      than a confident wrong answer.
 * Otherwise `c` counts exactly as a close made elsewhere.
 */
function staleJoinExempts(c: BookRow, sale: BookRow, side: "long" | "short"): boolean {
  if (!closedByStaleJoin(c)) return false;
  const saleHash = sale.dedupHash?.trim().toLowerCase();
  if (!saleHash) return false;
  const identity = lotIdentityHashes({ dedupHash: c.dedupHash ?? "", importNotes: c.importNotes ?? null });
  if (identity.some((h) => h.trim().toLowerCase() === saleHash)) return false;
  const [closeQty, closePrice, saleQty, salePrice] =
    side === "long" ? [c.sellQty, c.avgSellPrice, sale.sellQty, sale.avgSellPrice] : [c.buyQty, c.avgBuyPrice, sale.buyQty, sale.avgBuyPrice];
  // A price either row does not state never proves the sale differs — and an
  // unstated price arrives as 0 (Y3), which is why the code asks `statedPrice`
  // and not `!= null`. Both quantities are stated here (the sale is sale-shaped).
  const restates =
    sameQty(saleQty, closeQty) && (!statedPrice(salePrice) || !statedPrice(closePrice) || samePaisa(salePrice, closePrice));
  return !restates;
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

    // R2-DQ N7/N8: the closed lots of this side, for the ambiguity test.
    const closed: { row: BookRow; date: string; exit: string | null }[] = [];
    for (const r of rows) {
      const date = closedLotEntry(r, side, "possible");
      if (date) closed.push({ row: r, date, exit: closedLotExit(r, side) });
    }
    closed.sort(byDateThenId);

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
      // R2F-DQ: only a closed lot that OVERLAPPED this lot — exited on or after
      // its entry, or with no stated exit — can have taken the sale.
      const closedLotIds = closed
        .filter((c) => c.row.id !== s.row.id && c.date <= s.date && (c.exit == null || c.exit >= lot.date) && !staleJoinExempts(c.row, s.row, side))
        .map((c) => c.row.id);
      const ambiguous = closedLotIds.length > 0;
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
        // never a staged lot, whose ladder the join would leave open (W2-FIXD2),
        // never a sale recorded in several fills (R2-DQ N10), and never in a
        // book where a closed lot may already have taken the sale (N7/N8).
        oneClick: sameQty(take, lot.open) && sameQty(take, s.qty) && !lot.row.staged && !s.row.staged && !ambiguous,
        staged: !!lot.row.staged,
        ambiguous,
        closedLotIds,
        saleStaged: !!s.row.staged,
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
 *  - AMBIGUITY (R2-DQ N7/N8, narrowed by R2F-DQ): a link whose book holds a
 *    CLOSED lot of the same side entered on or before the sale and exited on
 *    or after the linked lot's entry (or with no stated exit) is `ambiguous` —
 *    listed for review, never one-click. A lot closed before the linked lot
 *    was entered cannot have taken the sale, and does not count. Nor does a
 *    lot the Data Quality join itself closed (M2), but only for a link whose
 *    sale is not that lot's record and does not restate its close (H3,
 *    `staleJoinExempts`).
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
 *  - the row is open and of sale SHAPE for the side (sell-only against a
 *    long; buy-only against a short, only where a short can exist). A STAGED
 *    sale — recorded in several fills — is listed like any other (R2-DQ N9):
 *    after the manual close it is otherwise listed nowhere;
 *  - its basis is not recorded by the user (`hasRecordedBasis`, P3);
 *  - it takes no part in any stale pair (`staleOpenPairs`): an open lot is
 *    still there to pair it, and that is the stale_open check's job;
 *  - it has a date (its own, or the IST day it was pulled);
 *  - the same book holds a CLOSED lot of the opposite side entered on or
 *    before that date (`closedLotEntry`, "evidence": a same-day round trip of
 *    a contract has no knowable direction and is not counted — R2-DQ N12).
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
        const date = closedLotEntry(r, side, "evidence");
        if (date) closed.push({ row: r, date });
      }
      if (closed.length === 0) continue;
      closed.sort(byDateThenId);
      for (const r of rows) {
        if (!r.isOpen || paired.has(r.id) || !saleShaped(r, side) || hasRecordedBasis(r)) continue;
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
export function saleJournalFields(row: SaleJournalRow, counts: { attachments: number }): string[] {
  const out: string[] = [];
  if (row.notes?.trim()) out.push("notes");
  if (row.setupTag?.trim()) out.push("a setup tag");
  if (row.emotionTag?.trim()) out.push("an emotion tag");
  if (row.mistakeTags && row.mistakeTags.length > 0) out.push("mistake tags");
  if (row.playbookId != null) out.push("a playbook");
  if (row.exitTrigger?.trim()) out.push("an exit reason");
  if (counts.attachments > 0) out.push("attachments");
  // R2-DQ N10 — `trade_legs` on a sale row are NOT listed here: they are the
  // sale's recorded fills (an import writes one "Imported execution" leg per
  // fill), not the user's journal, and they cannot be "moved onto the
  // position". `staleFillsNote` states them.
  return out;
}

/** Why a pair whose sale carries journal entries gets no button. Descriptive only. */
export function staleJournalNote(fields: string[], side: "long" | "short"): string {
  const what = side === "long" ? "sale" : "purchase";
  return `The recorded ${what} row carries your own journal entries (${nameList(fields)}), and joining it would delete them with the row, so it is not joined here. Once they are moved onto the position, the join is offered.`;
}

/**
 * R2-DQ N10 — why a pair whose SALE was recorded in several fills gets no
 * button. The fills are the sale's own record, so the sentence names them as
 * that and says the one-step join is not offered for such a sale; the card
 * links to Trades, where the row and its fills are. Descriptive only.
 */
export function staleFillsNote(side: "long" | "short"): string {
  const what = side === "long" ? "sale" : "purchase";
  return `The recorded ${what} was recorded in several fills, stored on its row as the ${what}'s recorded fills. The one-step join is not offered for a ${what} recorded in several fills, because joining removes the row together with its fills. The row and its fills are in Trades.`;
}

/**
 * R2-DQ N7/N8 — why an `ambiguous` pair gets no button. Descriptive only: it
 * states which closed position makes the pairing uncertain, and that nothing
 * is joined in one step.
 */
export function staleAmbiguousNote(p: Pick<StaleOpenPair, "side" | "tradingsymbol" | "closedLotIds">): string {
  const what = p.side === "long" ? "sale" : "purchase";
  const ids = p.closedLotIds.map((id) => `#${id}`).join(", ");
  return `A position in ${p.tradingsymbol} entered on or before this ${what} is already closed (trade ${ids}), so the recorded ${what} may already be counted in that close. The two rows are listed here for review and are not joined in one step.`;
}

// ───────────── L6 (v4.3.0 wave 2L) — an IPO record with no holding ──────────
//
// An exited IPO record and the holding it became are ONE sale. The link column
// (`ipos.trade_id`) is what every consumer keys on to count it once — capital,
// the tax pack, the ITR export and both AIS sides. A Trash envelope written
// before the link was snapshotted (4.2.x) restores the holding with the link
// gone, and so does any hand-unlink: the record states the exit, the holding
// states the same sale, and both are counted.
//
// The pairing below is the ONE definition of "these two could be the same
// allotment", shared by the Trash restore (which acts on it only where it is
// unambiguous) and this report (which asks). It is a QUESTION, never a
// conclusion: a holding with more than one candidate is never linked for the
// user (invariant 6).
//
// G-G2-1 (wave 2M) — a record entered on /ipos is named after the ISSUE ("Tata
// Technologies Limited"), not the scrip (TATATECH), so the name tier matched
// nothing and neither the link nor the question was raised: the sale was
// counted twice in silence. The match gained a second tier built only from
// facts both rows state (an exited allotment, the same quantity, the same
// allotment and exit days), and the REPORT now asks about every unlinked
// holding that shares a book with an unlinked exited record, matched or not.
// A name is not resolved to a symbol through any list: a freshly listed issue
// is in no bundled map, and that is the population this finding is about.

/** Where the orphan-pair issue sends the user: the section that can link them. */
export const IPO_LINK_HREF = "/ipos";

/** Trimmed, upper-cased scrip label — the only form the two sides are compared in. */
const scripKey = (s: string | null | undefined): string => (typeof s === "string" ? s.trim().toUpperCase() : "");

/** An IPO record with no holding attached, as the pairing reads it. */
export interface IpoRecordFacts {
  id: number;
  accountId: number;
  /** The record's own name, as /ipos shows it. `pushTradeToIpoAction` writes the SYMBOL here. */
  name: string;
  /** Shares allotted; 0 states nothing to compare. */
  allottedQty: number;
  // G-G2-1 (wave 2M) — the facts tier B is built from. OPTIONAL, so a caller
  // that reads only the four fields above still gets tier A exactly as before.
  /** Whether shares were allotted at all. FALSE is the application row a user
   *  keeps beside the allotment: no allotment, so no allotment's record (D1).
   *  ABSENT is unstated, and unstated is not evidence either way. */
  allotted?: boolean;
  /** The exit the record states. Null/absent = never exited, so nothing to pair. */
  exitPrice?: number | null;
  /** The record's own exit day; compared against the holding's sell day. */
  exitDate?: string | null;
  /** Allotment day — the acquisition, and what the holding's buy day is compared to. */
  allotmentDate?: string | null;
}

/** A holding flagged as an IPO allotment with no record pointing at it. */
export interface IpoHoldingFacts {
  id: number;
  accountId?: number;
  symbol?: string;
  tradingsymbol?: string | null;
  buyQty?: number;
  // G-G2-1 (wave 2M) — the holding's own side of tier B.
  acquisitionDate?: string | null;
  buyDate?: string | null;
  sellDate?: string | null;
  /**
   * D1 (wave 2N, re-check finding counted-once#1) — does the holding record a
   * SALE of its own? A record that states an exit is no candidate for a holding
   * that never sold: attaching one wrote a link the book does not support, left
   * the double count it was supposed to settle exactly where it was, and the
   * next save of that record on /ipos would have closed the position with a sale
   * it never had (`tradePatchFromIpo`). ABSENT is unstated, and unstated is not
   * evidence either way — so `ipoRecordNamesHolding` REFUSES rather than assume.
   */
  sellQty?: number;
}

/** Same book — 0 is a view, never a book (invariant 9), and an absent account id never matches. */
const sameBook = (record: IpoRecordFacts, trade: IpoHoldingFacts): boolean =>
  typeof trade.accountId === "number" && trade.accountId === record.accountId;

/** Quantities stated on both sides and equal; `null` when either states none. */
function sameAllottedQty(record: IpoRecordFacts, trade: IpoHoldingFacts): boolean | null {
  const rq = Number(record.allottedQty) || 0;
  const tq = Number(trade.buyQty) || 0;
  if (!(rq > 0) || !(tq > 0)) return null;
  return Math.abs(rq - tq) <= 1e-9;
}

/**
 * The ISO day a stored IPO or holding date states, or null.
 *
 * D2 (wave 2M, seam finding F29): this was `isoDay`, a SHAPE test — it accepted
 * `2026-02-31` and `0002-06-15`, so two impossible dates compared EQUAL and the
 * pairing read a weaker calendar than every other reader in the tree, and it
 * read a day-first date (`20-02-2026`, which /ipos stored verbatim until this
 * wave) as no day at all. `normalizeDate` is the ONE calendar (invariant 2:
 * `lib/domain/trading-day` is pure), so a legacy value stored before the route
 * normalised it is still recognised as the day it states, and a day that does
 * not exist is a day neither side states.
 */
const ipoDay = (s: string | null | undefined): string | null => normalizeDate(s ?? null);

/**
 * Does this record state an EXIT of its own — `computeIpo`'s rule (allotted,
 * with an exit price)? That is the record that can be counted twice beside the
 * holding's own sale, and it is what raises the question.
 */
const statesAnExit = (record: IpoRecordFacts): boolean =>
  record.allotted === true && Number.isFinite(record.exitPrice ?? NaN);

/**
 * TIER A — the record is NAMED after the scrip.
 *
 * The form `pushTradeToIpoAction` writes (it puts the SYMBOL in `name`), plus
 * the same allotted quantity where BOTH state one — an unstated quantity is not
 * evidence either way, so it does not exclude.
 */
function matchesByName(record: IpoRecordFacts, trade: IpoHoldingFacts): boolean {
  const name = scripKey(record.name);
  if (!name) return false;
  if (name !== scripKey(trade.symbol) && name !== scripKey(trade.tradingsymbol)) return false;
  return sameAllottedQty(record, trade) !== false;
}

/**
 * TIER B (G-G2-1, wave 2M) — the record is named after the ISSUE, and the
 * ALLOTMENT itself is what the two sides state identically.
 *
 * A record entered on /ipos carries the issue's name ("Tata Technologies
 * Limited") beside a holding symbol of TATATECH, so tier A matches nothing and
 * the same sale was counted twice in silence. Every clause here is still a fact
 * both rows already state, and all of them are required together:
 * an allotment that exited, the same number of shares, the same allotment day
 * as the holding's acquisition, and the same exit day as the holding's sale.
 * Quantity alone or a date alone would collide across retail lots, so neither
 * is a clause on its own; an unreadable or absent date on EITHER side is not a
 * match — `ipoDay` answers null for both, and the `statesAnExit` guard refuses
 * that before the two nulls can compare equal.
 */
function matchesByExit(record: IpoRecordFacts, trade: IpoHoldingFacts): boolean {
  if (!statesAnExit(record)) return false;
  if (sameAllottedQty(record, trade) !== true) return false;
  const allotted = ipoDay(record.allotmentDate);
  if (!allotted || allotted !== ipoDay(trade.acquisitionDate ?? trade.buyDate)) return false;
  const exited = ipoDay(record.exitDate);
  if (!exited || exited !== ipoDay(trade.sellDate)) return false;
  return true;
}

/**
 * D1 (wave 2N) — the record NAMES this holding: what a Trash restore may WRITE.
 *
 * `matchesByExit` (tier B) carries no scrip fact — `ipos` has no symbol or ISIN
 * column — so a record named after ANOTHER issue whose four allotment facts
 * coincide claimed the holding, and the counted-once rule then dropped that
 * record's OWN sale from the capital summary, the tax pack, the ITR export and
 * both AIS sides (re-check finding counted-once#0, a silent wrong number). Two
 * IPOs allotted on one day in the same lot size and sold on listing day is an
 * ordinary retail pattern, so all four facts together are no identity.
 *
 * What a restore may write is therefore the NAME tier alone — the only clause
 * that carries the scrip — plus an EXIT-SHAPE clause: a record that states an
 * exit belongs to a holding that HAS a sale. Tier B is not demoted to nothing:
 * it still MARKS a candidate in the question (`ipoRecordMatchesHolding`), where
 * the user settles it.
 */
export function ipoRecordNamesHolding(record: IpoRecordFacts, trade: IpoHoldingFacts): boolean {
  if (!sameBook(record, trade)) return false;
  if (record.allotted === false) return false;
  if (!matchesByName(record, trade)) return false;
  // An exit is no allotment's record until that allotment sold. An ABSENT
  // `sellQty` states nothing, and a link is not written on nothing.
  if (statesAnExit(record) && !(typeof trade.sellQty === "number" && trade.sellQty > 0)) return false;
  return true;
}

/**
 * Could this record be this holding's own allotment?
 *
 * Deliberately narrow, and every clause is a FACT both sides state. Two tiers,
 * either of which is a match, both inside ONE book:
 *   - A: the record's name IS the scrip (`matchesByName`);
 *   - B: the record is an exited allotment whose quantity and both dates are
 *     the holding's own (`matchesByExit`).
 * A match MARKS and orders a candidate in the question; since D1 (wave 2N) it is
 * NOT what a restore may write — that is `ipoRecordNamesHolding`, read by
 * `uniqueIpoRelinks`. Everything else is a question (invariant 6).
 */
export function ipoRecordMatchesHolding(record: IpoRecordFacts, trade: IpoHoldingFacts): boolean {
  if (!sameBook(record, trade)) return false;
  // D1 (wave 2M, seam finding F28) — ONE candidate rule, stated here as well as
  // in the two SQL reads: a record that states NO allotment is no allotment's
  // record. The application row a user keeps beside the allotment carries the
  // SCRIP's name and no allotted quantity, which is exactly tier A's rule minus
  // its quantity clause, so it claimed the holding, made the pair ambiguous and
  // stopped a Trash restore writing the link its own report called unambiguous.
  // An UNSTATED `allotted` (a caller reading only the older four fields) is
  // unchanged: not evidence either way, as before.
  if (record.allotted === false) return false;
  return matchesByName(record, trade) || matchesByExit(record, trade);
}

/** One holding that no IPO record points at, and every record that could be its own. */
export interface IpoOrphanPair {
  tradeId: number;
  /** The holding's scrip, as it is stored. */
  symbol: string;
  recordIds: number[];
  recordNames: string[];
  /** The book both sides are in — the match itself required the same account. */
  accountId?: number;
  /** D1 (wave 2N): does the holding record a sale? Absent = unstated. */
  holdingSold?: boolean;
}

/**
 * Every unlinked holding with at least one candidate record, candidates kept
 * whole — what the report MARKS (tier A ∪ tier B).
 */
export function ipoOrphanPairs(
  trades: readonly IpoHoldingFacts[],
  records: readonly IpoRecordFacts[],
): IpoOrphanPair[] {
  const out: IpoOrphanPair[] = [];
  for (const t of trades) {
    const cands = records.filter((r) => ipoRecordMatchesHolding(r, t));
    if (cands.length === 0) continue;
    out.push({
      tradeId: t.id,
      symbol: t.tradingsymbol || t.symbol || "—",
      recordIds: cands.map((r) => r.id),
      recordNames: cands.map((r) => r.name),
      accountId: t.accountId,
      holdingSold: typeof t.sellQty === "number" ? t.sellQty > 0 : undefined,
    });
  }
  return out;
}

/**
 * The pairs that can only be read one way — what a restore may write.
 *
 * TWO conditions, and both are needed:
 *
 *   AMBIGUITY is judged on the MARK rule (`ipoRecordMatchesHolding`, tier A ∪
 *   tier B), unique in BOTH directions: one candidate record for the holding,
 *   and one holding claiming that record. Two holdings of the same scrip and
 *   quantity reaching for one record is as ambiguous as one holding reaching for
 *   two, and "whichever the loop met first" is not an answer. Judging it on the
 *   narrower write rule instead would make a pairing the report calls ambiguous
 *   writable — and a WRITE silences the question (`assessDataQuality` asks only
 *   about UNLINKED holdings), which is the shape of the defect this wave fixed.
 *
 *   The one surviving candidate must then satisfy the WRITE rule
 *   (`ipoRecordNamesHolding`, D1 wave 2N): the record's own NAME is the scrip,
 *   and an exited record belongs to a holding that sold. Tier B carries no scrip
 *   fact, so a unique tier-B match can still be another issue's record
 *   (counted-once#0) — it is MARKED and asked about, never written.
 *
 * Both directions are counted over everything the caller hands in, which is why
 * `lib/trash.ts` hands in the book's OTHER unlinked `acquisition:'ipo'` holdings
 * of the affected accounts as well as the restored ones (counted-once#1).
 */
export function uniqueIpoRelinks(
  trades: readonly IpoHoldingFacts[],
  records: readonly IpoRecordFacts[],
): { tradeId: number; ipoId: number }[] {
  const pairs = ipoOrphanPairs(trades, records);
  const claims = new Map<number, number>();
  for (const p of pairs) for (const id of p.recordIds) claims.set(id, (claims.get(id) ?? 0) + 1);
  const recordById = new Map(records.map((r) => [r.id, r]));
  const tradeById = new Map(trades.map((t) => [t.id, t]));
  const out: { tradeId: number; ipoId: number }[] = [];
  for (const p of pairs) {
    const ipoId = p.recordIds[0];
    if (p.recordIds.length !== 1 || claims.get(ipoId) !== 1) continue;
    const record = recordById.get(ipoId);
    const trade = tradeById.get(p.tradeId);
    if (!record || !trade || !ipoRecordNamesHolding(record, trade)) continue;
    out.push({ tradeId: p.tradeId, ipoId });
  }
  return out;
}

/**
 * One holding, and every unlinked exited record of its book — what is ASKED.
 *
 * G-G2-1 (wave 2M): the question is raised whether or not anything matches.
 * Matching is a NARROW rule about facts (`ipoRecordMatchesHolding`), and a
 * record named after the issue rather than the scrip matches nothing — so
 * asking only about matches left the commonest shape of the double count
 * unnamed and unasked. The candidates are ordered matching-first and each is
 * marked, so the note says which ones the two rows themselves agree about and
 * which are merely the other unlinked exits of the same book.
 *
 * D1 (wave 2M, seam finding F28) — the records handed in are the account's
 * unlinked ALLOTTED ones, exited or not: the SAME set `lib/trash.ts` hands
 * `uniqueIpoRelinks` on a restore, so the report can never name a set the
 * restore did not see (`getUnlinkedExitedIpoRecords` is the only caller that
 * reads them from the database). What is ASKED still needs the double count to
 * exist, so the question is raised only beside a record that STATES AN EXIT;
 * the un-exited allotments of the same book are listed with it, because they
 * are candidates a restore weighed and are why it may have written nothing.
 * Account-scoped by construction (invariant 8): a record of another book is
 * never a candidate, and a holding that states no account has no book to ask in.
 */
export interface IpoAskPair extends IpoOrphanPair {
  /** Per candidate, in the same order: do the two rows' own facts match? */
  matched: boolean[];
  /** Per candidate, in the same order: does it state an exit of its own? */
  exited: boolean[];
}

export function ipoAskPairs(
  trades: readonly IpoHoldingFacts[],
  records: readonly IpoRecordFacts[],
): IpoAskPair[] {
  const out: IpoAskPair[] = [];
  for (const t of trades) {
    const inBook = records.filter((r) => sameBook(r, t) && r.allotted !== false);
    // No exited record in the book, no sale stated twice — nothing to ask about.
    if (!inBook.some(statesAnExit)) continue;
    const matching = inBook.filter((r) => ipoRecordMatchesHolding(r, t));
    const rest = inBook.filter((r) => !ipoRecordMatchesHolding(r, t));
    const cands = [...matching, ...rest];
    out.push({
      tradeId: t.id,
      symbol: t.tradingsymbol || t.symbol || "—",
      recordIds: cands.map((r) => r.id),
      recordNames: cands.map((r) => r.name),
      accountId: t.accountId,
      holdingSold: typeof t.sellQty === "number" ? t.sellQty > 0 : undefined,
      matched: cands.map((_, k) => k < matching.length),
      exited: cands.map(statesAnExit),
    });
  }
  return out;
}

/**
 * What an orphan pair SAYS. Descriptive only: the facts, the consequence, where
 * to settle it.
 *
 * D1 (wave 2M): the candidates are now the book's unlinked ALLOTTED records, so
 * the sentence about the double count still counts only the ones that STATE AN
 * EXIT — that is the sale stated twice — and an allotment with no exit stated is
 * named in a sentence of its own, as a candidate a restore also weighed. A
 * caller that states no `exited` flags reads exactly as before (every candidate
 * an exited one), which is what `ipoOrphanPairs` hands it.
 *
 * D1 (wave 2N): the consequence sentence BRANCHES on the holding's own sale.
 * A holding that records no sale states no second one, so claiming that "the
 * sale is counted once in IPOs and again as the holding's own sale" is a figure
 * the book does not hold (invariant 6) — and that is now the common case, since
 * a restore no longer attaches an exited record to a holding that never sold.
 * An UNSTATED `holdingSold` reads exactly as before.
 */
export function ipoOrphanNote(p: IpoOrphanPair & { matched?: boolean[]; exited?: boolean[] }): string {
  const named = (k: number) => `#${p.recordIds[k]} ${p.recordNames[k]}${p.matched?.[k] ? " (matches this holding)" : ""}`;
  const list = (ks: number[]) => {
    const all = ks.map(named);
    return all.slice(0, 5).join(", ") + (all.length > 5 ? ` and ${all.length - 5} more` : "");
  };
  const keys = p.recordIds.map((_, k) => k);
  const exited = keys.filter((k) => p.exited?.[k] ?? true);
  const unexited = keys.filter((k) => !(p.exited?.[k] ?? true));
  const many = exited.length > 1;
  const also = unexited.length
    ? `The same account also holds ${unexited.length === 1 ? "an allotted IPO record" : `${unexited.length} allotted IPO records`} ` +
      `with no holding attached and no exit stated (${list(unexited)}), which a restore reads as ` +
      `${unexited.length === 1 ? "a candidate" : "candidates"} for this holding too. `
    : "";
  const consequence =
    p.holdingSold === false
      ? `${many ? "Those records state" : "The record states"} that exit under IPOs and this holding records no sale, ` +
        `so the record's exit is the only one stated; linking them keeps one allotment in one place. `
      : `${many ? "Those records state" : "The record states"} that exit under IPOs and the holding states its own sale ` +
        `under Trades: if ${many ? "one of them is" : "this record is"} this holding's allotment, that sale is counted ` +
        `once in IPOs and again as the holding's own sale — in the capital summary, the tax pack, the ITR export and ` +
        `both AIS sides — until one names the other. `;
  return (
    `Trade #${p.tradeId} (${p.symbol}) is recorded as an IPO allotment and no IPO record points at it, while ` +
    `${many ? `${exited.length} exited IPO records` : "an exited IPO record"} in the same account ` +
    `${many ? "state" : "states"} an exit with no holding attached (${list(exited)}). ` +
    consequence +
    also +
    `Open IPOs and set the holding on the record that is its own.`
  );
}

/**
 * D1 (wave 2N, re-check finding counted-once#3) — ONE question for the holdings
 * of a book that NO record's own facts match.
 *
 * The 2M design raised the question for every unlinked `acquisition:'ipo'`
 * holding that shares a book with an unlinked exited record. With six such
 * holdings and one stray record that measured six identical warnings and a
 * completeness score of 22, every detail naming the same single candidate. A
 * holding a record actually matches still keeps its own issue — that pair is
 * the unit the user settles; the rest say the same thing once.
 */
export function ipoOrphanGroupNote(pairs: readonly IpoAskPair[]): string {
  const holdings = pairs.map((p) => `#${p.tradeId} (${p.symbol})`);
  const shown = (xs: string[]) => xs.slice(0, 5).join(", ") + (xs.length > 5 ? ` and ${xs.length - 5} more` : "");
  const seen = new Map<number, string>();
  for (const p of pairs) {
    p.recordIds.forEach((id, k) => {
      if (p.exited[k] && !seen.has(id)) seen.set(id, `#${id} ${p.recordNames[k]}`);
    });
  }
  const records = [...seen.values()];
  const n = holdings.length;
  const m = records.length;
  return (
    `${n} ${n === 1 ? "holding is" : "holdings are"} recorded as IPO allotments with no IPO record pointing at ` +
    `${n === 1 ? "it" : "them"} (${shown(holdings)}), while ${m} exited IPO ${m === 1 ? "record" : "records"} in the ` +
    `same account ${m === 1 ? "states" : "state"} an exit with no holding attached (${shown(records)}). No ` +
    `${m === 1 ? "record's" : "records'"} own facts — the scrip's name, or the allotment's quantity and days — are ` +
    `${n === 1 ? "this holding's" : "any of these holdings'"}, so nothing here can be paired without you naming it. ` +
    `A holding that sold, beside a record that states an exit, is one sale counted twice — in the capital summary, ` +
    `the tax pack, the ITR export and both AIS sides — until one names the other. ` +
    `Open IPOs and set the holding on the record that is its own.`
  );
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
  const stalePairs = staleOpenPairs(i.trades);
  const staleLots = [...new Set(stalePairs.filter((p) => !p.ambiguous).map((p) => p.lotId))];
  add({ code: "stale_open", severity: "critical", title: "Open positions with their closing trade stored beside them", detail: "A later opposite-side row in the same account, broker and scrip was stored as its own row, so the position still reads open and the sale reads as a second position. Holdings, unrealised P&L and tax count both until the two are joined.", count: staleLots.length, href: STALE_OPEN_HREF }, staleLots);

  // W2-DQ P2 — a WARNING, deliberately below stale_open: the position itself is
  // already closed, and the row left beside it is listed, never changed here.
  const staleSales = staleSaleRows(i.trades).map((s) => s.saleId);
  add({ code: "stale_sale", severity: "warning", title: "Closing trades still open with no open position left to close", detail: "An open sale row (or, against a short, purchase row) in the same account, broker and scrip has no open position left to pair with, and a position in that scrip entered on or before it is already closed. Holdings, unrealised P&L and tax read the row as a position of its own. It is listed here and never changed automatically.", count: staleSales.length, href: STALE_OPEN_HREF }, staleSales);

  // R2-DQ N7/N8 — a WARNING, not the critical stale_open: the sale pairs by
  // date with a held position, but a position closed some other way may
  // already have taken it, so the pair is listed for review and never joined.
  const reviewSales = [...new Set(stalePairs.filter((p) => p.ambiguous).map((p) => p.saleId))];
  add({ code: "stale_review", severity: "warning", title: "Closing trades beside an open position and an already-closed one", detail: "An open sale row (or, against a short, purchase row) pairs by date with an open position in the same account, broker and scrip, but a position in that scrip entered on or before it is already closed, so the row may already be counted in that close. The rows are listed here for review and are not joined in one step.", count: reviewSales.length, href: STALE_OPEN_HREF }, reviewSales);

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

  // X2 reader (wave 2I) — a STATED 0 is a statement: the position is 100% the
  // trader's own capital, and since X2 that 0 survives every writer. The old
  // `!x || <= 0` rule flagged it as missing, telling the user to set what they
  // had just set. Only a row that states NOTHING — null, absent or non-finite —
  // is listed, the same null-vs-0 rule every other reader now uses.
  const mtf = i.trades.filter((t) => t.segment === "eq_mtf" && !Number.isFinite(t.mtfFundedAmount ?? NaN));
  // D7 (wave 2N) — the detail says what the missing amount COSTS the user, now
  // that nothing estimates it: /equity, the leverage ratio and the /risk margin
  // check all leave the row out rather than price it at the margin default.
  add({ code: "mtf_funding", severity: "warning", title: "MTF positions without funded principal", detail: "Interest, leverage and own-capital return need the broker-funded amount — own capital, leverage and the margin check leave the row out until it is recorded.", count: mtf.length, href: "/equity?funding=mtf" }, mtf.map((t) => t.id));

  const options = i.trades.filter((t) => t.instrumentType === "option" && (!t.expiry || t.strike == null || !t.optionType));
  add({ code: "option_contract", severity: "warning", title: "Incomplete option contracts", detail: "Expiry, strike and CE/PE are required for Greeks, settlement and seller analytics.", count: options.length, href: "/trades" }, options.map((t) => t.id));

  const instrument = i.trades.filter((t) => !i.knownSymbols.has(t.symbol.toUpperCase()));
  add({ code: "instrument_master", severity: "info", title: "Symbols absent from instrument master", detail: "Sector, lot-size and concentration coverage may be incomplete.", count: new Set(instrument.map((t) => t.symbol)).size, href: "/instruments" }, instrument.map((t) => t.id));

  const ipo = i.trades.filter((t) => t.acquisition === "ipo" && !i.ipoLinkedTradeIds.has(t.id));
  add({ code: "ipo_link", severity: "warning", title: "IPO holdings not linked to an IPO record", detail: "Linking makes allotment basis, listing mark and exit flow from one source of truth. A holding sold on its own row while its IPO record also states an exit is counted once in IPOs and again as that holding's own sale until one names the other.", count: ipo.length, href: "/ipos" }, ipo.map((t) => t.id));

  // L6 — one issue per unlinked holding that an exited record could belong to,
  // because the pair is the unit the user can settle (the cross-account issues
  // above are grouped the same way). It is raised whatever produced the pair —
  // a pre-4.3.0 Trash envelope restored with its link gone, a hand-unlink, or a
  // record and a holding that were simply never linked. `ipo_link` above still
  // counts the holding as unlinked; this one names the records it could be.
  //
  // G-G2-1 (wave 2M): `ipoAskPairs`, not `ipoOrphanPairs` — the question is
  // raised for every unlinked holding that shares a book with an unlinked
  // exited record, matched or not. `ipoOrphanPairs` stays what a RESTORE may
  // act on (`uniqueIpoRelinks`); a question costs the user a look, a wrong link
  // costs them a number.
  //
  // D1 (wave 2N, counted-once#3): a holding with at least one MARKED candidate
  // keeps its own issue — that pair is the unit the user settles. Holdings that
  // no record's facts match are GROUPED into one issue per account: six such
  // holdings beside one stray record raised six identical warnings and floored
  // the completeness score at 22, every detail naming the same candidate.
  const askPairs = ipoAskPairs(ipo, i.unlinkedIpoRecords ?? []);
  const unmatchedByAccount = new Map<number, IpoAskPair[]>();
  for (const p of askPairs) {
    if (p.matched.some(Boolean)) {
      add({ code: `ipo_record_link:${p.tradeId}`, severity: "warning", title: "IPO record not linked to its holding", detail: ipoOrphanNote(p), count: 1, href: IPO_LINK_HREF }, [p.tradeId]);
      continue;
    }
    // `sameBook` made the pair, so the account is always a number here.
    const key = p.accountId as number;
    const list = unmatchedByAccount.get(key) ?? [];
    list.push(p);
    unmatchedByAccount.set(key, list);
  }
  for (const [accountId, pairs] of [...unmatchedByAccount.entries()].sort((a, b) => a[0] - b[0])) {
    add(
      { code: `ipo_record_link:account:${accountId}`, severity: "warning", title: "IPO records not linked to their holdings", detail: ipoOrphanGroupNote(pairs), count: 1, href: IPO_LINK_HREF },
      pairs.map((p) => p.tradeId),
    );
  }

  add({ code: "stale_mtm", severity: "info", title: "Stale MTM marks", detail: "Refresh or confirm prices before relying on unrealised P&L and breach alerts.", count: i.staleMtmCount, href: "/risk" });
  add({ code: "missing_attachment", severity: "warning", title: "Attachment records with missing files", detail: "The journal points to images that are no longer present on disk.", count: i.missingAttachmentFiles, href: "/backup" });

  // Cross-account issues last: they are facts about the accounts, not about
  // the trades this call was handed, and a caller that resolved none is left
  // with exactly the report it had before.
  for (const issue of crossAccountIssues(i)) issues.push(issue);

  return { score: scoreIssues(issues), issues, affected: new Set(issues.flatMap((x) => x.ids ?? [])).size, checked: i.trades.length };
}
