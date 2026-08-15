// TRADE-ROW COLUMN DERIVATIONS (PURE, no DB/React).
//
// The /trades table shows Entry / Exit PRICES, a Qty and an Invested figure
// rather than the raw buy-value / sell-value totals. Every one of those is a
// function of the row's two legs plus its direction, and direction follows the
// convention already used by /strategies, /risk and the Instrument cell:
// whichever leg carries the larger quantity opened the position, so
// short = sellQty > buyQty. Kept here so the maths is unit-tested without a
// table around it, and so a missing side reads as `null` ("—"), never as 0 —
// an opening sell has no buy price, and 0 would look like a real fill.
//
// Money on a Trade row is ALREADY rupees at runtime (`moneyPaise` converts at
// the column boundary) — nothing here divides or multiplies by 100.

/** The slice of a trade row these helpers read. Structural, so a SlimTrade,
 *  a full Trade, or a hand-built fixture all satisfy it. */
export interface TradeLegs {
  buyQty: number;
  sellQty: number;
  avgBuyPrice: number;
  avgSellPrice: number;
  /** Rupees. */
  buyValue: number;
  /** Rupees. */
  sellValue: number;
  segment: string;
  /** Rupees the broker funded on an MTF position; null until resolved. */
  mtfFundedAmount?: number | null;
}

export type TradeDirection = "long" | "short";

/** Short iff the sell leg carries more quantity than the buy leg. */
export function tradeDirection(t: Pick<TradeLegs, "buyQty" | "sellQty">): TradeDirection {
  return t.sellQty > t.buyQty ? "short" : "long";
}

/**
 * Entry and exit PRICES by direction. A side with zero quantity has no price:
 * it is `null`, never 0, so an open long shows "—" under Exit and an opening
 * short shows "—" under Exit too (its exit is the eventual buy-back).
 */
export function entryExitPrices(
  t: Pick<TradeLegs, "buyQty" | "sellQty" | "avgBuyPrice" | "avgSellPrice">,
): { entry: number | null; exit: number | null } {
  const buy = t.buyQty > 0 ? t.avgBuyPrice : null;
  const sell = t.sellQty > 0 ? t.avgSellPrice : null;
  return tradeDirection(t) === "short" ? { entry: sell, exit: buy } : { entry: buy, exit: sell };
}

/** Position size: the opening leg's quantity. */
export function tradeQty(t: Pick<TradeLegs, "buyQty" | "sellQty">): number {
  return tradeDirection(t) === "short" ? t.sellQty : t.buyQty;
}

export interface InvestedSummary {
  /** Rupees the trader themself put in (own contribution on MTF). */
  amount: number;
  mtf: boolean;
  /** Trader's own share of the buy value, whole percent; null when unknown. */
  ownPct: number | null;
  /** Sub-line / tooltip text; null when there is nothing to add. */
  hint: string | null;
}

const MTF_SEGMENT = "eq_mtf";

/** Whole rupees, Indian grouping, for the hint line. */
function inr(v: number): string {
  return `₹${Math.round(v).toLocaleString("en-IN")}`;
}

/**
 * What the trader actually deployed. Non-MTF: the opening leg's value. MTF
 * with a resolved funded amount: buy value minus what the broker funded, with
 * the own-% shown. MTF whose funding is not yet resolved: the full buy value
 * and an explicit "not yet resolved" hint — the percentage is never invented
 * (invariant 6: no fabricated denominators), and a zero buy value yields no %.
 */
export function investedSummary(t: TradeLegs): InvestedSummary {
  if (t.segment !== MTF_SEGMENT) {
    const amount = tradeDirection(t) === "short" ? t.sellValue : t.buyValue;
    return { amount, mtf: false, ownPct: null, hint: null };
  }
  const funded = t.mtfFundedAmount;
  if (funded == null) {
    return { amount: t.buyValue, mtf: true, ownPct: null, hint: "MTF · funding not yet resolved" };
  }
  const own = t.buyValue - funded;
  const ownPct = t.buyValue > 0 ? Math.round((own / t.buyValue) * 100) : null;
  const hint = ownPct == null
    ? `MTF · broker ${inr(funded)}`
    : `MTF · you funded ${ownPct}% · broker ${inr(funded)}`;
  return { amount: own, mtf: true, ownPct, hint };
}
