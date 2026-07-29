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
 * provenance, and touches nothing else. Charges, notes, tags and the journal
 * entry all belong to the trade and are never overwritten by the IPO record.
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
}

/**
 * Build the trade patch from an IPO record.
 *
 * `charges` is passed in rather than computed here because the charge engine
 * lives elsewhere and this module stays pure; the caller supplies whatever the
 * engine says the exit cost.
 */
export function tradePatchFromIpo(i: IpoLinkInput, charges = 0): TradePatch | null {
  const h = deriveHolding(i);
  if (!h) return null;

  const exit = h.closed ? Number(i.exitPrice) : null;
  const sellValue = exit != null ? r2(exit * h.qty) : null;
  const grossPnl = sellValue != null ? r2(sellValue - h.buyValue) : 0;

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
    grossPnl: grossPnl - 0 * charges, // charges are applied by the caller on net
  };
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
