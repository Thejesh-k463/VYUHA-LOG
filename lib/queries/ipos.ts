import "server-only";
import { db } from "@/lib/db";
import { ipos } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";
import { computeIpo, ipoRatesDate, ipoSellChargeBreakdown, ipoVenue, isPriceableExitDate, summariseIpos, type IpoComputed, type IpoSellCharger, type IpoSummary } from "@/lib/analytics/ipo";
import { findRates, statutoryRatesFor } from "@/lib/engine/rates";
import type { ChargeBreakdown, ChargeRates } from "@/lib/engine/types";
import { todayIstIso } from "@/lib/domain/trading-day";
import { loadRatesMap } from "@/lib/engine/rates-db";
import type { Broker } from "@/lib/domain/constants";
import { getSelectedAccountId } from "./accounts";

/**
 * Exit charges from the SAME engine and charge_config rates every other trade
 * uses (invariant 3). The allotment's value is the base of stamp duty only
 * (and only for an allotment before 1 Jul 2020 — `computeIpo` passes 0 from
 * then, when the issuer bears it, N14):
 * it carries no brokerage (an allotment is not a brokered order) and no
 * exchange-turnover levy — exchange txn, the SEBI fee, IPFT and the GST on
 * them price on the SELL value alone (W2-IPO2), because an allotment is not a
 * transaction on a recognised stock exchange. Brokerage and DP are the
 * broker's charges on the sale. Both paths share `ipoSellChargeBreakdown`.
 *
 * No purchase STT on the allotment (QS-IPO): FATAX56235 row 1 levies purchase
 * STT only where the purchase "is entered into in a recognized stock
 * exchange", and an allotment is not. eq_delivery's row says sttSide 'both',
 * so the broker path prices on a COPY with sttSide 'sell' — the map is never
 * mutated.
 *
 * An IPO that names no broker (or a broker with no row for the date) prices
 * through `ipoSellChargeBreakdown` fed the STATUTORY columns of charge_config
 * at (exchange, date) — `statutoryRatesFor`: no brokerage, no DP (R36). With
 * no row at all it throws, as `findRates` does.
 *
 * Rates are resolved AT THE EXIT DATE, not today: an exit sold before a rate
 * change (e.g. an STT epoch boundary) must keep pricing at the epoch it
 * actually traded in — pricing it at today's rates silently restated its
 * realised net, which flows into capital compounding (B7). A not-yet-exited
 * IPO passes no exit date and prices prospectively at today, which is the
 * only honest choice for a sale that has not happened.
 *
 * A date never throws (N13). Rates are resolved LAZILY — on the first call,
 * which `computeIpo` makes only for an exited IPO — so building a charger for
 * every row reads nothing. An exit date that is not a priceable day
 * (`isPriceableExitDate`) prices to null: not yet priced, shown as "—". A real
 * day before the earliest epoch prices at the earliest schedule
 * (`ipoRatesDate`). Only a missing charge_config row still throws, when priced.
 */
export function chargeBreakdownFor(
  broker: string | null,
  exchange: string,
  exitDate: string | null,
  ratesMap: ReturnType<typeof loadRatesMap>,
): (sellValue: number, allottedValue: number) => ChargeBreakdown | null {
  const venue = ipoVenue(exchange);
  let rates: ChargeRates | null = null;
  const resolve = (): ChargeRates => {
    const on = ipoRatesDate(ratesMap, venue, exitDate || todayIstIso());
    if (broker) {
      try {
        // The same sale + allotment-stamp split as the fallback, over the broker's
        // row: exchange txn, SEBI, IPFT and their GST on the SELL value only (W2-IPO2).
        return { ...findRates(ratesMap, broker as Broker, "eq_delivery", venue, on), sttSide: "sell" };
      } catch {
        /* no row for this broker on this date — the statutory columns below */
      }
    }
    return statutoryRatesFor(ratesMap, "eq_delivery", venue, on);
  };
  return (sellValue, allottedValue) => {
    if (exitDate && !isPriceableExitDate(exitDate)) return null;
    rates ??= resolve();
    return ipoSellChargeBreakdown(sellValue, allottedValue, rates);
  };
}

/** The charger `getIposComputed` injects: the per-head breakdown (the statement label reads it), 0 for no sale, null when not yet priced. */
export function sellChargerFor(
  broker: string | null,
  exchange: string,
  exitDate: string | null,
  ratesMap: ReturnType<typeof loadRatesMap>,
): IpoSellCharger {
  const breakdown = chargeBreakdownFor(broker, exchange, exitDate, ratesMap);
  return (sellValue, allottedValue) => {
    if (exitDate && !isPriceableExitDate(exitDate)) return null;
    return sellValue <= 0 ? 0 : breakdown(sellValue, allottedValue);
  };
}

/** `sellChargerFor`'s total. */
export function chargerFor(
  broker: string | null,
  exchange: string,
  exitDate: string | null,
  ratesMap: ReturnType<typeof loadRatesMap>,
): (sellValue: number, allottedValue: number) => number | null {
  const charge = sellChargerFor(broker, exchange, exitDate, ratesMap);
  return (sellValue, allottedValue) => {
    const c = charge(sellValue, allottedValue);
    return c == null || typeof c === "number" ? c : c.total;
  };
}

export function getIposComputed(): { rows: IpoComputed[]; summary: IpoSummary } {
  const accountId=getSelectedAccountId(); const q=db.select().from(ipos); const raw=(accountId>0?q.where(eq(ipos.accountId,accountId)):q).orderBy(desc(ipos.createdAt)).all();
  const ratesMap = loadRatesMap();
  const rows = raw.map((r) =>
    computeIpo({
      id: r.id,
      name: r.name,
      broker: r.broker,
      exchange: r.exchange,
      board: r.board,
      category: r.category,
      discountPerShare: r.discountPerShare,
      appliedPrice: r.appliedPrice,
      lotSize: r.lotSize,
      lotsApplied: r.lotsApplied,
      allotted: r.allotted,
      allottedQty: r.allottedQty,
      listingPrice: r.listingPrice,
      exitPrice: r.exitPrice,
      appliedDate: r.appliedDate,
      allotmentDate: r.allotmentDate,
      listingDate: r.listingDate,
      exitDate: r.exitDate,
      notes: r.notes,
    }, sellChargerFor(r.broker, r.exchange, r.exitDate, ratesMap)),
  );
  return { rows, summary: summariseIpos(rows) };
}

/** Realised (exited) IPO net P&L — feeds the capital-compounding view. */
export function getIpoRealisedNet(): number {
  return getIposComputed().rows.filter((r) => r.realised).reduce((s, r) => s + r.netPnl, 0);
}

/** trade id → ipo id, for holdings already pushed to the IPO section. */
export function getIpoTradeLinks(): Map<number, number> {
  const accountId=getSelectedAccountId(); const q=db.select({id:ipos.id,tradeId:ipos.tradeId}).from(ipos); const rows=accountId>0?q.where(eq(ipos.accountId,accountId)).all():q.all();
  const m = new Map<number, number>();
  for (const r of rows) if (r.tradeId != null) m.set(r.tradeId, r.id);
  return m;
}
