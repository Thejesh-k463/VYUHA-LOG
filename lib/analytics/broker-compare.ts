// IND-14 — Broker-cost comparison (PURE, no DB/React).
//
// Re-prices the SAME trades under every broker's rate card (from charge_config)
// to quantify switching value: "these trades cost ₹A on your brokers; on broker X
// they'd cost ₹B." Reuses the real charges engine so the numbers tie to reality.
// Statutory components are broker-invariant; brokerage, DP and MTF interest are the
// real differentiators.

import { computeCharges } from "@/lib/engine/charges";
import type { ChargeRates } from "@/lib/engine/types";
import type { Segment } from "@/lib/domain/constants";

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
}

export interface BrokerCost {
  broker: string;
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
  ratesMap: Map<string, ChargeRates>,
  brokers: string[],
  currentBroker?: string,
): BrokerCompareReport {
  const actualTotal = r2(trades.reduce((s, t) => s + t.actualCharges, 0));

  const costs: BrokerCost[] = brokers.map((broker) => {
    const acc = { total: 0, brokerage: 0, statutory: 0, gst: 0, dp: 0, mtfInterest: 0 };
    let covered = 0;
    let missing = 0;
    for (const t of trades) {
      const rates = ratesMap.get(`${broker}|${t.segment}|${t.exchange}`);
      if (!rates) {
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
    return {
      broker,
      total: r2(acc.total),
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
      vsActual: r2(acc.total - actualTotal),
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
