// TRADE-ROW COLUMN DERIVATIONS (PURE, no DB/React).
//
// The /trades table shows Entry / Exit PRICES, a Qty and an Invested figure
// rather than the raw buy-value / sell-value totals. Every one of those is a
// function of the row's two legs plus its direction, and direction follows the
// ONE reading, `sideOf` (lib/domain/side.ts, v4.6.0 W6): whichever leg carries
// the larger quantity opened the position, and a FLAT row reads its stored
// `side`. Kept here so the maths is unit-tested without a
// table around it, and so a missing side reads as `null` ("—"), never as 0 —
// an opening sell has no buy price, and 0 would look like a real fill.
//
// Money on a Trade row is ALREADY rupees at runtime (`moneyPaise` converts at
// the column boundary) — nothing here divides or multiplies by 100.

import { sideOf } from "./side";

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
  /** Which side opened the row (migration 0077) — read only through `sideOf`. */
  side?: string | null;
  buyDate?: string | null;
  sellDate?: string | null;
}

export type TradeDirection = "long" | "short";

/** The fields the direction reading needs: the legs plus, for a FLAT row, the stored side. */
type DirectionInput = Pick<TradeLegs, "buyQty" | "sellQty" | "side" | "buyDate" | "sellDate">;

/**
 * The side that OPENED the row — delegates to `sideOf` (lib/domain/side.ts,
 * v4.6.0 W6): the larger leg on a lopsided row, the stored `side` on a flat one.
 * Before W6 this was `sellQty > buyQty`, which read every fully-closed short as
 * a long.
 */
export function tradeDirection(t: DirectionInput): TradeDirection {
  return sideOf(t);
}

/**
 * Entry and exit PRICES by direction. A side with zero quantity has no price:
 * it is `null`, never 0, so an open long shows "—" under Exit and an opening
 * short shows "—" under Exit too (its exit is the eventual buy-back).
 */
export function entryExitPrices(
  t: DirectionInput & Pick<TradeLegs, "avgBuyPrice" | "avgSellPrice">,
): { entry: number | null; exit: number | null } {
  const buy = t.buyQty > 0 ? t.avgBuyPrice : null;
  const sell = t.sellQty > 0 ? t.avgSellPrice : null;
  return tradeDirection(t) === "short" ? { entry: sell, exit: buy } : { entry: buy, exit: sell };
}

/** Position size: the opening leg's quantity. */
export function tradeQty(t: DirectionInput): number {
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
