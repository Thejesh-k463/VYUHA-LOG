import "server-only";
import { db } from "@/lib/db";
import { ipos } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";
import { computeIpo, ipoSellCharges, summariseIpos, type IpoComputed, type IpoSellCharger, type IpoSummary } from "@/lib/analytics/ipo";
import { computeCharges } from "@/lib/engine/charges";
import { findRates } from "@/lib/engine/rates";
import { todayIstIso } from "@/lib/domain/trading-day";
import { loadRatesMap } from "@/lib/engine/rates-db";
import type { Broker, Exchange } from "@/lib/domain/constants";
import { getSelectedAccountId } from "./accounts";

/**
 * Exit charges from the SAME engine and charge_config rates every other trade
 * uses (invariant 3). The allotment is the buy side — its stamp duty computes
 * on the allotted value, but with buyOrderCount 0 there is no buy brokerage,
 * because an allotment is not a brokered order. Only an IPO that names no
 * broker (or a broker with no rates row) falls back to the pure static
 * estimate, which the analytics module documents as exactly that.
 *
 * Rates are resolved AT THE EXIT DATE, not today: an exit sold before a rate
 * change (e.g. an STT epoch boundary) must keep pricing at the epoch it
 * actually traded in — pricing it at today's rates silently restated its
 * realised net, which flows into capital compounding (B7). A not-yet-exited
 * IPO passes no exit date and prices prospectively at today, which is the
 * only honest choice for a sale that has not happened.
 */
export function chargerFor(
  broker: string | null,
  exchange: string,
  exitDate: string | null,
  ratesMap: ReturnType<typeof loadRatesMap>,
): IpoSellCharger {
  if (!broker) return ipoSellCharges;
  let rates;
  try {
    rates = findRates(ratesMap, broker as Broker, "eq_delivery", (exchange === "BSE" ? "BSE" : "NSE") as Exchange, exitDate ?? todayIstIso());
  } catch {
    return ipoSellCharges;
  }
  return (sellValue, allottedValue) => {
    if (sellValue <= 0) return 0;
    return computeCharges(
      { segment: "eq_delivery", buyValue: allottedValue, sellValue, buyQty: 1, sellQty: 1, buyOrderCount: 0, sellOrderCount: 1 },
      rates,
    ).total;
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
    }, chargerFor(r.broker, r.exchange, r.exitDate, ratesMap)),
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
