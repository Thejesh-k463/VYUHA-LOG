import "server-only";
import { db } from "@/lib/db";
import { ipos, trades } from "@/lib/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { computeIpo, ipoRatesDate, ipoSellChargeBreakdown, ipoVenue, isPriceableExitDate, summariseIpos, type IpoComputed, type IpoSellCharger, type IpoSummary } from "@/lib/analytics/ipo";
import { ratesForTrade, resolvePlan, statutoryRatesFor } from "@/lib/engine/rates";
import type { ChargeBreakdown, ChargeRates } from "@/lib/engine/types";
import { todayIstIso } from "@/lib/domain/trading-day";
import { loadRatesMap } from "@/lib/engine/rates-db";
import type { Broker } from "@/lib/domain/constants";
import { getSelectedAccountId } from "./accounts";
import { accountScopeWhere } from "./tax-scope";
import { planAccountsById } from "./broker-plan";

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
  /**
   * Wave U — the PLAN of the account this IPO belongs to, resolved by the
   * caller (`resolvePlan`, lib/engine/rates.ts) against this same broker. It
   * only ever narrows the broker branch below; the statutory fallback carries
   * no brokerage at all, so a plan cannot reach it.
   */
  plan = "default",
): (sellValue: number, allottedValue: number) => ChargeBreakdown | null {
  const venue = ipoVenue(exchange);
  let rates: ChargeRates | null = null;
  const resolve = (): ChargeRates => {
    const on = ipoRatesDate(ratesMap, venue, exitDate || todayIstIso());
    if (broker) {
      try {
        // The same sale + allotment-stamp split as the fallback, over the broker's
        // row: exchange txn, SEBI, IPFT and their GST on the SELL value only (W2-IPO2).
        return {
          ...ratesForTrade(ratesMap, { broker: broker as Broker, segment: "eq_delivery", exchange: venue }, on, plan),
          sttSide: "sell",
        };
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
  /** Wave U — the IPO account's plan for this broker; see chargeBreakdownFor. */
  plan = "default",
): IpoSellCharger {
  const breakdown = chargeBreakdownFor(broker, exchange, exitDate, ratesMap, plan);
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
  /** Wave U — the IPO account's plan for this broker; see chargeBreakdownFor. */
  plan = "default",
): (sellValue: number, allottedValue: number) => number | null {
  const charge = sellChargerFor(broker, exchange, exitDate, ratesMap, plan);
  return (sellValue, allottedValue) => {
    const c = charge(sellValue, allottedValue);
    return c == null || typeof c === "number" ? c : c.total;
  };
}

/**
 * U3 (v4.3.0): each row also carries the link facts the edit form needs — whether
 * the linked holding exists and its stored sell date — read in this same
 * account-scoped query (a LEFT JOIN on the IPO's own trade_id), so the form never
 * guesses what the route's sync will compare against. Z2 (wave 2H): also its sell
 * quantity and price, so the form pre-fills the holding's date only for the IPO's own sale.
 */
export function getIposComputed(
  /** v4.5.0 TAX PERSON scope (lib/queries/tax-scope.ts): omitted = the legacy
   *  account scope; an array = this person's accounts; EMPTY = no rows. The tax
   *  surfaces pass it so an IPO gain is filed under the person who realised it. */
  accountIds?: readonly number[],
): { rows: IpoComputed[]; summary: IpoSummary } {
  // The join is account-scoped too (invariant 8, wave 2I): an IPO and the holding
  // it became belong to ONE book, so a trade_id naming another account's row reads
  // as NOT LINKED rather than surfacing that book's sale date, quantity and price
  // on this form — and the route, which re-reads the trade in the IPO's account,
  // then writes nothing to it.
  const q=db.select({ ipo: ipos, linkedTradeId: trades.id, linkedSellDate: trades.sellDate, linkedSellQty: trades.sellQty, linkedSellPrice: trades.avgSellPrice }).from(ipos).leftJoin(trades, and(eq(trades.id, ipos.tradeId), eq(trades.accountId, ipos.accountId)));
  // accountScopeWhere() applies `accountId > 0 ? filter : all` itself when no
  // person scope is passed — the same invariant-8 rule, one implementation.
  const where = accountScopeWhere(ipos.accountId, accountIds);
  const raw=(where?q.where(where):q).orderBy(desc(ipos.createdAt)).all();
  const ratesMap = loadRatesMap();
  // Wave U — each IPO prices on ITS OWN account's plan (an IPO row carries an
  // account_id, so the All-accounts view prices each row in its own book), on
  // the exit date the charger already prices at. One read for the whole page.
  const planAccounts = planAccountsById();
  const rows = raw.map(({ ipo: r, linkedTradeId, linkedSellDate, linkedSellQty, linkedSellPrice }) => ({
    ...computeIpo({
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
    }, sellChargerFor(r.broker, r.exchange, r.exitDate, ratesMap, resolvePlan(planAccounts.get(r.accountId), r.broker, r.exitDate || todayIstIso(), ratesMap))),
    linked: linkedTradeId != null,
    linkedSellDate: linkedTradeId != null ? linkedSellDate : null,
    linkedSellQty: linkedTradeId != null ? linkedSellQty : null,
    linkedSellPrice: linkedTradeId != null ? linkedSellPrice : null,
  }));
  return { rows, summary: summariseIpos(rows) };
}

/**
 * CAP-IPO-LINK / TAX-IPO-LINK (v4.3.0 wave 2H, given ONE home in wave 2L): the
 * ids of the IPOs realised THROUGH a trade the caller has ALREADY counted.
 * `countedTradeIds` is the set of trade ids the consumer counted IN THE CURRENT
 * VIEW; an IPO whose own trade_id is one of them is realised through that trade
 * (the exit saved on /ipos closed it), so the consumer leaves it out and the
 * sale is counted once, from the trades book. An unlinked IPO, or one linking a
 * trade the caller did NOT count (in another account, still open, or gone), is
 * not named and counts its own figure once.
 *
 * Two scopes, deliberately different (wave 2L — they had drifted apart, and the
 * capital summary then stated one sale twice in the All-accounts view while the
 * tax pack, the ITR export and AIS stated it once):
 *   - the IPO ROWS read are account-scoped (invariant 8), matching the rows the
 *     consumers themselves see through `getIposComputed`;
 *   - the LINK is read raw (`ipos.trade_id`), UNSCOPED by account. The IPO's own
 *     account has no bearing on whether its trade was counted, and
 *     `countedTradeIds` already carries the caller's scope. So for an IPO in
 *     account 1 linked to a holding in account 2 — a shape a Trash restore or an
 *     account merge can re-create — account 1 counts the IPO (its holding is not
 *     in view), account 2 counts the holding (the IPO is not in view), and All
 *     accounts counts the holding and leaves the IPO out: once, in every view.
 * Every IPO linking a counted trade is named, since trade_id is not unique.
 *
 * NOT the same question as `getIposComputed`'s link facts, which stay
 * account-scoped (U3/wave 2I): whose sale DATE and price a form may pre-fill is
 * about one book; whether a sale was already counted is about the view.
 */
export function ipoIdsCountedThroughTrades(
  countedTradeIds: ReadonlySet<number>,
  /** v4.5.0 tax-person scope — the SAME rows the consumer saw through
   *  `getIposComputed(accountIds)`, so "already counted" is asked of one view. */
  accountIds?: readonly number[],
): Set<number> {
  const through = new Set<number>();
  if (countedTradeIds.size === 0) return through;
  const q = db.select({ id: ipos.id, tradeId: ipos.tradeId }).from(ipos);
  const where = accountScopeWhere(ipos.accountId, accountIds);
  for (const r of (where ? q.where(where) : q).all()) {
    if (r.tradeId != null && countedTradeIds.has(r.tradeId)) through.add(r.id);
  }
  return through;
}

/**
 * Realised (exited) IPO net P&L — feeds the capital-compounding view.
 *
 * `countedTradeIds` names the trades the caller has ALREADY counted, and the
 * one `ipoIdsCountedThroughTrades` above decides which IPOs that leaves out —
 * the same rule, read the same way, as the tax pack, the ITR export and AIS.
 * With no argument every exited IPO is summed — the IPO book on its own, as
 * /ipos reads it.
 */
export function getIpoRealisedNet(opts: { countedTradeIds?: ReadonlySet<number> } = {}): number {
  const counted = opts.countedTradeIds;
  const throughTrade = counted ? ipoIdsCountedThroughTrades(counted) : null;
  return getIposComputed().rows.filter((r) => r.realised && !throughTrade?.has(r.id)).reduce((s, r) => s + r.netPnl, 0);
}

/** trade id → ipo id, for holdings already pushed to the IPO section. */
export function getIpoTradeLinks(): Map<number, number> {
  const accountId=getSelectedAccountId(); const q=db.select({id:ipos.id,tradeId:ipos.tradeId}).from(ipos); const rows=accountId>0?q.where(eq(ipos.accountId,accountId)).all():q.all();
  const m = new Map<number, number>();
  for (const r of rows) if (r.tradeId != null) m.set(r.tradeId, r.id);
  return m;
}
