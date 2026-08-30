// IND-14 — Broker-cost comparison (PURE, no DB/React).
//
// Re-prices the SAME trades under every broker's rate card (from charge_config)
// to quantify switching value: "these trades cost ₹A on your brokers; on broker X
// they'd cost ₹B." Reuses the real charges engine so the numbers tie to reality.
// Statutory components are broker-invariant; brokerage, DP and MTF interest are the
// real differentiators.

import { computeCharges } from "@/lib/engine/charges";
import type { ChargeRates } from "@/lib/engine/types";
import type { Broker, Exchange, Segment } from "@/lib/domain/constants";
import { findRates, pricingDate, todayIso, type RatesMap } from "@/lib/engine/rates";

export interface CompareTrade {
  segment: string;
  exchange: string;
  buyValue: number;
  sellValue: number;
  buyQty: number;
  sellQty: number;
  buyOrderCount: number;
  sellOrderCount: number;
  mtf?: { fundedAmount: number; daysHeld: number; pledgeScrips?: number } | null;
  actualCharges: number; // chargesTotal actually recorded for this trade
  /** Dates. Used to span the subscription months AND to pick the rate epoch
   *  each trade is priced under — a book crossing a statutory rate change must
   *  be compared at the rates that actually applied on each date. */
  buyDate?: string | null;
  sellDate?: string | null;
}

export interface BrokerCost {
  broker: string;
  /** "default" for the free tier; a paid plan gets its own row. */
  plan: string;
  planLabel: string | null;
  /** Subscription over the compared window, amortised from the monthly fee. */
  subscription: number;
  /** Months the compared trades span — what the subscription is charged for. */
  months: number;
  total: number;
  brokerage: number;
  statutory: number; // STT/CTT + exchange + SEBI + stamp + IPFT
  gst: number;
  dp: number;
  mtfInterest: number;
  covered: number; // trades the broker can price (has a rate row)
  missing: number; // trades with no rate row for that broker
  /**
   * True only when this broker could price EVERY trade.
   *
   * A partial total is not comparable with a full one: it is the cost of a
   * SMALLER book, so it is always lower and always flatters. Sahi publishes no
   * MTF interest rate, for instance, so on a book containing MTF positions its
   * total silently omits them. Only a complete broker may be called cheapest.
   */
  complete: boolean;
  vsActual: number; // total − actualTotal (negative = cheaper than what you paid)
}

export interface BrokerCompareReport {
  brokers: BrokerCost[]; // cheapest first
  actualTotal: number; // Σ recorded charges
  tradeCount: number;
  cheapest: BrokerCost | null;
  current: BrokerCost | null; // the named current broker, if provided
  maxSaving: number; // actualTotal − cheapest.total (>0 = headroom to save)
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function compareBrokers(
  trades: CompareTrade[],
  ratesMap: RatesMap,
  brokers: string[],
  currentBroker?: string,
): BrokerCompareReport {
  const actualTotal = r2(trades.reduce((s, t) => s + t.actualCharges, 0));

  /**
   * How long the compared book spans, in months — what a monthly subscription
   * would actually have been charged for.
   *
   * A paid plan judged on brokerage alone always looks cheaper than it is, so
   * the fee has to be in the total or the comparison is an advertisement. With
   * no dates to measure, one month is assumed: it is the smallest honest
   * charge, and understating the fee is the direction that flatters the paid
   * plan, so the UI says which assumption was used.
   */
  const dates = trades
    .map((t) => t.sellDate ?? t.buyDate)
    .filter((d): d is string => !!d)
    .sort();
  const months =
    dates.length >= 2
      ? Math.max(
          1,
          Math.ceil(
            (new Date(dates[dates.length - 1]).getTime() - new Date(dates[0]).getTime()) /
              (30 * 86_400_000),
          ),
        )
      : 1;

  /** Every broker × plan pair present in the rate table. */
  const pairs: { broker: string; plan: string }[] = [];
  for (const broker of brokers) {
    const seen = new Set<string>();
    for (const k of ratesMap.keys()) {
      const [b, plan] = k.split("|");
      if (b === broker && !seen.has(plan)) {
        seen.add(plan);
        pairs.push({ broker, plan });
      }
    }
    if (seen.size === 0) pairs.push({ broker, plan: "default" });
  }

  // Hoisted: `todayIso()` is a wall-clock read and this runs pairs × trades —
  // 400,000 calls at the load suite's heavy tier, where it measured ~44% of the
  // whole comparison's compute. The fallback date is loop-invariant.
  const today = todayIso();
  const inForce = (e: ChargeRates) =>
    (e.effectiveFrom ?? "1970-01-01") <= today && (e.effectiveTo == null || today < e.effectiveTo);

  const costs: BrokerCost[] = pairs.map(({ broker, plan }) => {
    const acc = { total: 0, brokerage: 0, statutory: 0, gst: 0, dp: 0, mtfInterest: 0 };
    let covered = 0;
    let missing = 0;
    for (const t of trades) {
      // Priced at the epoch covering THIS trade's date, not today's rate.
      // findRates throws when no epoch covers it; an unpriceable trade is
      // counted as missing rather than silently priced at the wrong regime.
      let rates;
      try {
        rates = findRates(ratesMap, broker as Broker, t.segment as Segment, t.exchange as Exchange, pricingDate(t, today), plan);
      } catch {
        missing++;
        continue;
      }
      // An MTF trade priced against a broker who publishes NO interest rate
      // would understate that broker by the entire financing cost — the
      // largest single component of an MTF position. Counting it as unpriced
      // is the honest answer, and it stops the broker being called cheapest.
      if (t.segment === "eq_mtf" && rates.mtfRateUnknown) {
        missing++;
        continue;
      }
      const c = computeCharges(
        {
          segment: t.segment as Segment,
          buyValue: t.buyValue,
          sellValue: t.sellValue,
          buyQty: t.buyQty,
          sellQty: t.sellQty,
          buyOrderCount: t.buyOrderCount,
          sellOrderCount: t.sellOrderCount,
          mtf: t.mtf ?? null,
        },
        rates,
      );
      acc.total += c.total;
      acc.brokerage += c.brokerage;
      acc.statutory += c.sttCtt + c.exchangeTxn + c.sebi + c.stampDuty + c.ipft;
      acc.gst += c.gst;
      acc.dp += c.dpCharges;
      acc.mtfInterest += c.mtfInterest;
      covered++;
    }
    // The subscription is part of what the plan costs, so it belongs in the
    // total rather than in a footnote nobody reads.
    // Subscription is a plan-level fact, but it must come from the epoch in
    // force TODAY — the newest row could be a future-dated plan that is not
    // sellable yet, which would quote a fee nobody can pay.
    const epochs = ratesMap.get(`${broker}|${plan}|eq_delivery|NSE`) ?? [];
    const sample = epochs.find(inForce) ?? epochs[0];
    const subscription = r2((sample?.subscriptionMonthly ?? 0) * months);

    return {
      broker,
      plan,
      planLabel: sample?.planLabel ?? null,
      subscription,
      months,
      total: r2(acc.total + subscription),
      brokerage: r2(acc.brokerage),
      statutory: r2(acc.statutory),
      gst: r2(acc.gst),
      dp: r2(acc.dp),
      mtfInterest: r2(acc.mtfInterest),
      covered,
      missing,
      complete: missing === 0 && covered > 0,
      // Comparable only against a complete total; otherwise it is the
      // difference between your whole book and part of someone else's.
      vsActual: r2(acc.total + subscription - actualTotal),
    };
  });

  // Incomplete brokers sort last and can never be "cheapest". Sorting them by
  // total would rank a broker that priced three trades above one that priced
  // three hundred, purely because it was asked to do less work.
  costs.sort(
    (a, b) => (a.complete ? 0 : 1) - (b.complete ? 0 : 1) || b.covered - a.covered || a.total - b.total,
  );
  const cheapest = costs.find((c) => c.complete) ?? null;
  const current = currentBroker ? costs.find((c) => c.broker === currentBroker) ?? null : null;

  return {
    brokers: costs,
    actualTotal,
    tradeCount: trades.length,
    cheapest,
    current,
    maxSaving: cheapest ? r2(actualTotal - cheapest.total) : 0,
  };
}
