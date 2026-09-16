/**
 * Linking an IPO record to the holding it became.
 *
 * ZERO DB and ZERO React imports; pure functions over plain data.
 *
 * ── The problem this solves ───────────────────────────────────────────────
 *
 * IPO shares are credited on allotment. They appear in no tradebook as a buy,
 * so a holding built from them arrives with:
 *
 *   • no cost basis   — nothing says what you paid
 *   • no mark price   — nothing says what it is worth now
 *
 * Which means the position sits in the journal contributing nothing: it cannot
 * be scored as a gain or a loss (there is no unrealised result to compute), and
 * it cannot join the edge statistics (there is no basis to measure against).
 *
 * The IPO record holds exactly the two facts that are missing. Linking them
 * makes the holding whole — and because the IPO record is where the user
 * actually knows those numbers, it becomes the SOURCE OF TRUTH for the linked
 * trade rather than a second copy of it.
 *
 * ── What is derived, and what is refused ──────────────────────────────────
 *
 * Cost basis is derived from the issue price minus any category discount —
 * that is arithmetic on numbers the user entered, not a guess.
 *
 * The MARK is only ever a price the user supplied: an exit price if the holding
 * was sold, else the listing price. If neither exists there is NO mark, and the
 * function says so instead of inventing one. A holding with no mark stays
 * honestly unmarked and keeps appearing under "Open" rather than being sorted
 * into a gain or loss it never had.
 */

import { isPriceableExitDate } from "@/lib/analytics/ipo";
import { normalizeDate } from "@/lib/domain/trading-day";

export interface IpoLinkInput {
  /** Issue price per share actually applied at. */
  appliedPrice: number;
  /** Category discount per share (employee/shareholder/retail), if any. */
  discountPerShare?: number | null;
  /** Shares actually allotted. */
  allottedQty: number;
  allotted: boolean;
  /** Price on listing day, when known. */
  listingPrice?: number | null;
  /** Price the holding was sold at, when it has been sold. */
  exitPrice?: number | null;
  allotmentDate?: string | null;
  listingDate?: string | null;
  exitDate?: string | null;
  /**
   * D2 (v4.3.0 wave 2N): was the exit date READABLE as a day in the form the caller
   * read it — before any normalisation it applied?
   *
   * The caller (`app/api/ipos/route.ts#linkInput`) folds the three typed days through
   * the shared calendar so both sides of every comparison are like for like (a legacy
   * day-first '20-02-2026' stored before wave 2M against the '2026-02-20' the save
   * stores). That fold also makes a legacy exit date READABLE, which would silently
   * withdraw Y2's ignore-date allowance from exactly the rows it was written for:
   * measured by the design reviewer, `syncOwnsClose` flips true → false for a legacy
   * row whose Trades sale was corrected to another day, so the sync's own charges
   * freeze on the next re-price and a clear-exit save answers 409 CLOSE_IN_TRADES.
   *
   * So the READABILITY is carried as data, computed on the RAW value, and the three
   * functions below read it instead of re-deriving it from the folded date. Undefined
   * (every other caller, and every stored shape) keeps the original derivation.
   */
  exitDateWasReadable?: boolean;
}

export interface DerivedHolding {
  /** Per-share cost after discount — the basis the journal was missing. */
  costPerShare: number;
  qty: number;
  /** Total invested in the allotted shares. */
  buyValue: number;
  /**
   * The mark, or null when the user has supplied no price to mark against.
   * Null is a real answer here, not a missing value to be filled with zero.
   */
  markPrice: number | null;
  /** Where the mark came from, so the UI can say rather than assert. */
  markSource: "exit" | "listing" | null;
  /** Unrealised P&L at the mark. Null when there is no mark. */
  unrealisedPnl: number | null;
  /** The date the shares were acquired — starts the tax holding period. */
  acquiredOn: string | null;
  /** True once an exit price exists: the position is no longer open. */
  closed: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Turn an IPO record into the numbers a holding needs.
 *
 * Returns null when the IPO produced no shares at all — an unallotted
 * application is not a holding and must not create one.
 */
export function deriveHolding(i: IpoLinkInput): DerivedHolding | null {
  const qty = i.allotted ? Number(i.allottedQty) || 0 : 0;
  if (qty <= 0) return null;

  const discount = Math.max(0, Number(i.discountPerShare) || 0);
  const costPerShare = Math.max(0, r2((Number(i.appliedPrice) || 0) - discount));
  const buyValue = r2(costPerShare * qty);

  // An exit price is a fact about a completed sale, so it wins over a listing
  // price, which is only a snapshot of one day.
  const exit = i.exitPrice != null && Number.isFinite(i.exitPrice) ? Number(i.exitPrice) : null;
  const listing = i.listingPrice != null && Number.isFinite(i.listingPrice) ? Number(i.listingPrice) : null;

  const markPrice = exit ?? listing;
  const markSource: DerivedHolding["markSource"] = exit != null ? "exit" : listing != null ? "listing" : null;

  return {
    costPerShare,
    qty,
    buyValue,
    markPrice,
    markSource,
    unrealisedPnl: markPrice == null ? null : r2((markPrice - costPerShare) * qty),
    acquiredOn: i.allotmentDate ?? i.listingDate ?? null,
    closed: exit != null,
  };
}

/**
 * The patch to apply to a linked trade.
 *
 * Deliberately narrow: it sets the basis, the mark and the acquisition
 * provenance, and touches nothing else. Notes, tags and the journal entry all
 * belong to the trade and are never overwritten by the IPO record. Z2 (wave 2H):
 * an exit the IPO records and prices carries its charges, so the holding it closes
 * nets what /ipos nets.
 */
export interface TradePatch {
  acquisition: "ipo";
  acquisitionPrice: number;
  acquisitionDate: string | null;
  buyQty: number;
  avgBuyPrice: number;
  buyValue: number;
  /** Null keeps the position honestly unmarked. */
  closingPrice: number | null;
  unrealisedPnl: number;
  /** Set only when the IPO records an exit. */
  sellQty: number | null;
  avgSellPrice: number | null;
  sellValue: number | null;
  sellDate: string | null;
  isOpen: boolean;
  grossPnl: number;
  /**
   * Z2 (v4.3.0 wave 2H): the IPO's own computed exit charges, and net = gross − charges.
   * Set only for an exit the caller priced; null states no figure, and the caller keeps
   * the trade's own (an unpriced exit is never charged 0 — invariant 6).
   */
  chargesTotal: number | null;
  netPnl: number | null;
}

/**
 * Build the trade patch from an IPO record.
 *
 * `charges` is passed in rather than computed here because the charge engine
 * lives elsewhere and this module stays pure; the caller supplies whatever the
 * engine says the exit cost — null (the default) when it priced none.
 */
export function tradePatchFromIpo(i: IpoLinkInput, charges: number | null = null): TradePatch | null {
  const h = deriveHolding(i);
  if (!h) return null;

  const exit = h.closed ? Number(i.exitPrice) : null;
  const sellValue = exit != null ? r2(exit * h.qty) : null;
  const grossPnl = sellValue != null ? r2(sellValue - h.buyValue) : 0;
  const chargesTotal = h.closed && charges != null && Number.isFinite(charges) ? r2(charges) : null;

  return {
    acquisition: "ipo",
    acquisitionPrice: h.costPerShare,
    acquisitionDate: h.acquiredOn,
    buyQty: h.qty,
    avgBuyPrice: h.costPerShare,
    buyValue: h.buyValue,
    // Once sold there is no position left to mark.
    closingPrice: h.closed ? null : h.markPrice,
    unrealisedPnl: h.closed ? 0 : (h.unrealisedPnl ?? 0),
    sellQty: h.closed ? h.qty : null,
    avgSellPrice: exit,
    sellValue,
    sellDate: h.closed ? (i.exitDate ?? null) : null,
    isOpen: !h.closed,
    grossPnl,
    chargesTotal,
    netPnl: chargesTotal == null ? null : r2(grossPnl - chargesTotal),
  };
}

/** The linked trade's own sell leg, as stored. */
export interface LinkedSellLeg {
  sellQty: number;
  avgSellPrice: number;
  sellDate: string | null;
}

const sameNumber = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/**
 * D13 (v4.3.0 fix wave 2O) — the day a stored value STATES, on the one calendar.
 *
 * D2 (wave 2N) folds the IPO's three typed days through `normalizeDate` at the
 * route boundary so both sides of every comparison are like for like. The sale's
 * own date was left out of that fold, and v4.2.0 stored a day-first exit date
 * verbatim AND its sync wrote that same string onto the holding — so the 4.2.x
 * population holds '20-02-2026' in both columns, the record's side arrives folded
 * to '2026-02-20', and a raw string compare read the sale as somebody else's:
 * `linkedSyncFor` dropped from 'sync' to 'refuse' and an exit-PRICE correction was
 * answered 409 where the pre-wave route saved it and synced (dates-charges#0).
 *
 * `?? v` keeps a value the calendar cannot read AS IT IS, so a byte-identical
 * unreadable pair still compares equal exactly as before, and the fold is
 * idempotent for the already-ISO value the route hands in.
 */
const dayOf = (v: string | null | undefined): string | null => (v == null ? null : normalizeDate(v) ?? v);

/**
 * X1 (v4.3.0 wave 2H seam fix 5): is this trade's sell leg exactly the exit this
 * IPO record carries — the quantity, price and date the sync writes from it?
 *
 * `ignoreDate` compares the quantity and price alone; it is opt-in and exists for
 * one caller, `syncOwnsClose` below, where the stored date was never readable and
 * so cannot be the date the sync wrote (Y2).
 *
 * D13 (wave 2O): the two dates are compared as the DAYS they state (`dayOf`), not
 * as strings — D2's own rule at the seam D2 did not walk.
 */
export function sellLegIsIpoExit(i: IpoLinkInput, trade: LinkedSellLeg, ignoreDate = false): boolean {
  const p = tradePatchFromIpo(i);
  if (!p || p.sellQty == null || p.avgSellPrice == null) return false;
  return (
    sameNumber(Number(trade.sellQty) || 0, p.sellQty) &&
    sameNumber(Number(trade.avgSellPrice) || 0, p.avgSellPrice) &&
    (ignoreDate || dayOf(trade.sellDate) === dayOf(p.sellDate))
  );
}

function samePatch(a: TradePatch | null, b: TradePatch | null, ignoreSellDate = false): boolean {
  if (!a || !b) return a === b;
  return (Object.keys(a) as (keyof TradePatch)[]).every((k) => (ignoreSellDate && k === "sellDate") || a[k] === b[k]);
}

/** A stored exit date that is present but not a readable day ('2026-02-30', '15-03-2011'). */
const unreadableExitDate = (d: string | null | undefined) => (d ?? "").trim() !== "" && !isPriceableExitDate((d ?? "").trim());

/**
 * Y2's question, asked of the input rather than of the date it now carries: the
 * caller states the raw value's readability when it normalised the date it hands in
 * (`exitDateWasReadable`, D2 wave 2N), and only otherwise is it derived here.
 */
const storedExitUnreadable = (i: IpoLinkInput): boolean =>
  i.exitDateWasReadable === undefined ? unreadableExitDate(i.exitDate) : !i.exitDateWasReadable;

/**
 * What a save of an IPO record may do to the holding it is linked to.
 *   sync   — write the IPO's patch onto the holding (the IPO is its source of truth);
 *   leave  — write nothing to the holding, and save the IPO record;
 *   refuse — save nothing.
 */
export type LinkedSync = "sync" | "leave" | "refuse";

/**
 * X1 (v4.3.0 wave 2H seam fix 5): the sync over a holding with a sale recorded in
 * Trades. V2 recomputed that holding from the IPO around its kept sale, a second
 * writer of gross and open/closed: a notes-only save over a partly sold holding left
 * an OPEN row at gross −400, and a quantity corrected to 20 over 10 sold kept the row
 * CLOSED at buy 20 / sell 10 (seam probe 2026-09-15). The holding is now never
 * recomputed:
 *   - a holding with no sale syncs as always;
 *   - a sale that IS the IPO's exit — as stored or as this save records it — syncs in
 *     full, so clearing an exit made on /ipos re-opens the holding, as that page reads;
 *   - otherwise the sale is the trade's own: a save that changes nothing the sync would
 *     write leaves the holding alone, and any other save is refused.
 * `stored` is the IPO as stored when the save keeps the same link; null for a create or
 * a save that links a different holding (every value is then a new write).
 *
 * Y2 (wave 2H): a stored exit date that cannot be read equals ANY date in the 'leave'
 * comparison, so only a change to what else the sync writes (exit price, quantity, basis,
 * mark) is refused. Measured before: an IPO sold 150 on '2026-02-30' over a sale corrected
 * in Trades to 152 on 2026-03-02 refused every notes-only save (409) — with U3's pre-filled
 * date, with the date cleared — because the date "changed" from one the row never held.
 *
 * Z2 (wave 2H): both sides are built with NO charges, so the patch's charge fields are
 * null on each and compare equal. Charges are written only by a 'sync', from the save's
 * own values; over a sale that is not the IPO's exit nothing is written, so broker and
 * exchange (which change only the charges) stay out of this decision, as X1 left it.
 */
export function linkedSyncFor(args: {
  stored: IpoLinkInput | null;
  next: IpoLinkInput;
  trade: LinkedSellLeg | null;
}): LinkedSync {
  const { stored, next, trade } = args;
  if (!trade || !(Number(trade.sellQty) > 0)) return "sync";
  if (sellLegIsIpoExit(next, trade) || (stored != null && sellLegIsIpoExit(stored, trade))) return "sync";
  if (stored != null && samePatch(tradePatchFromIpo(stored), tradePatchFromIpo(next), storedExitUnreadable(stored))) return "leave";
  return "refuse";
}

/**
 * J4 (v4.3.0 wave 2J): whose close is the holding carrying?
 *
 * A sale that matches the IPO's exit has two possible histories, and X1 read both
 * as one ("the holding's sale IS the IPO's exit"):
 *
 *   • the sync wrote it — the sale equals the IPO's exit AS STORED before this save
 *     (its own earlier write, or a sale identical to it). The sync OWNS that close:
 *     re-pricing the exit on /ipos moves the holding's price and gross, so the
 *     charges it computed for the OLD exit must move with them or the row states a
 *     figure nothing prices any more;
 *   • the user wrote it — the sale equals only the exit BEING RECORDED, having been
 *     entered in Trades first with the broker's own charges. Those are the user's
 *     record and are never rewritten (owner ruling F1).
 *
 * A holding with NO sale is the first case by construction: the sync is about to
 * write the close itself. A create, or a save that links a different holding, has no
 * stored exit it could have written, so a sale there is always the user's.
 *
 * Y2 (wave 2H) carries over: a stored exit date that was never readable cannot be the
 * date the sync wrote, so it equals any date — the quantity and price decide.
 *
 * This answers ownership of the CLOSE only. Whether the charges ON it are also the
 * sync's own is the caller's question (it needs the charge engine): a holding whose
 * sale is the stored exit but whose heads were never the ones the IPO priced keeps
 * every one of them.
 */
export function syncOwnsClose(args: { stored: IpoLinkInput | null; trade: LinkedSellLeg | null }): boolean {
  const { stored, trade } = args;
  if (!trade || !(Number(trade.sellQty) > 0)) return true; // no sale: the sync writes this close
  if (!stored) return false; // a create or a new link: the sale predates the link
  return sellLegIsIpoExit(stored, trade, storedExitUnreadable(stored));
}

/**
 * L3 (v4.3.0 wave 2L): does this save change anything the sync would WRITE onto the
 * linked holding?
 *
 * The same comparison `linkedSyncFor` makes for a holding with a sale recorded in
 * Trades, asked of a holding that is booked elsewhere for another reason — a ladder
 * of `trade_legs` (invariant 5). A save that changes no value the patch carries
 * touches that holding not at all, so it is saved and the holding is left as it is;
 * any other save would rewrite the parent from the allotment and is refused. A create
 * or a save that links a different holding has no stored IPO to compare against, so
 * every value it carries is a new write.
 *
 * Y2 (wave 2H) carries over: a stored exit date that was never readable equals any
 * date, so a form sending it back does not read as a change.
 */
export function syncWouldWrite(args: { stored: IpoLinkInput | null; next: IpoLinkInput }): boolean {
  const { stored, next } = args;
  if (!stored) return true;
  return !samePatch(tradePatchFromIpo(stored), tradePatchFromIpo(next), storedExitUnreadable(stored));
}

/**
 * L3 (v4.3.0 wave 2L) — the sentence the IPO sync writes into a linked holding's
 * `import_notes` beside the exit charges it computes for it.
 *
 * WHY a marker and not a recomputation: wave 2J proved "these charges are the sync's
 * own" by re-pricing the IPO's stored exit against the LIVE `charge_config` and
 * comparing head by head. That check agrees with itself only while the rate card
 * stands still — a rate correction between the sync's write and a later exit edit
 * changed what it produced, ownership was lost for good, and the holding's charges
 * then froze at the old bill while its price, gross and net followed the new exit
 * (measured: a ₹5,000 sale carrying a ₹1,500 sale's ₹2.06, ₹71.69 of net that capital,
 * the tax base and the ITR export all read too high). Provenance is a fact about who
 * wrote the row, which is exactly what the repo's other identity notes record
 * (`dedup-alias:`, the Data Quality stale-close sentence), and no rate edit can erase
 * it.
 *
 * It is dropped by whoever takes the charges over: the trade editor when its save
 * changes a head or the total (owner ruling F1 — a figure the user states is never
 * rewritten), and the sync itself when it re-opens the holding and the charges go.
 */
export const IPO_SYNC_CHARGES_NOTE =
  "Exit charges computed from the linked IPO record's exit price and date; not stated by a broker.";

const notePartsOf = (importNotes: string | null | undefined): string[] =>
  (importNotes ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);

/** Does this holding carry the sync's charge marker? */
export function hasSyncChargesNote(importNotes: string | null | undefined): boolean {
  return notePartsOf(importNotes).includes(IPO_SYNC_CHARGES_NOTE);
}

/** `import_notes` with the marker, once, after every note already there. Idempotent. */
export function withSyncChargesNote(importNotes: string | null): string {
  const parts = notePartsOf(importNotes);
  if (!parts.includes(IPO_SYNC_CHARGES_NOTE)) parts.push(IPO_SYNC_CHARGES_NOTE);
  return parts.join(" | ");
}

/** `import_notes` without the marker, every other note kept in order; null when none is left. */
export function withoutSyncChargesNote(importNotes: string | null): string | null {
  const parts = notePartsOf(importNotes).filter((s) => s !== IPO_SYNC_CHARGES_NOTE);
  return parts.length > 0 ? parts.join(" | ") : null;
}

/**
 * Seed an IPO record FROM an existing holding, for the "this came from an IPO"
 * action on the Trades page.
 *
 * Everything the trade genuinely knows is carried over; everything it cannot
 * know is left blank for the user rather than guessed. In particular the issue
 * price is only pre-filled when the trade actually has a purchase price — for
 * a holding with no basis (the whole reason this feature exists) it stays 0 and
 * the user fills it in.
 */
export interface IpoSeed {
  name: string;
  exchange: string;
  allotted: true;
  allottedQty: number;
  appliedPrice: number;
  lotSize: number;
  lotsApplied: number;
  allotmentDate: string | null;
  listingPrice: number | null;
  notes: string;
}

export function ipoSeedFromTrade(t: {
  symbol: string;
  exchange?: string | null;
  buyQty: number;
  avgBuyPrice?: number | null;
  buyValue?: number;
  buyDate?: string | null;
  closingPrice?: number | null;
}): IpoSeed {
  const qty = Math.max(0, Number(t.buyQty) || 0);
  const price = Number(t.avgBuyPrice) || 0;

  return {
    name: t.symbol,
    exchange: t.exchange ?? "NSE",
    allotted: true,
    allottedQty: qty,
    // Only carried over when the holding actually has a basis; otherwise the
    // user supplies the issue price, which is the fact the journal is missing.
    appliedPrice: price > 0 ? price : 0,
    // Lot size is unknowable from a holding, so the whole quantity is treated
    // as one lot rather than inventing a lot structure.
    lotSize: qty > 0 ? qty : 1,
    lotsApplied: 1,
    allotmentDate: t.buyDate ?? null,
    listingPrice: t.closingPrice != null && t.closingPrice > 0 ? t.closingPrice : null,
    notes: "Created from an existing holding in Trades.",
  };
}
