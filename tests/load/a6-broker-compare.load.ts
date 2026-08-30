import { describe, expect, it } from "vitest";
import { compareBrokers, type CompareTrade } from "@/lib/analytics/broker-compare";
import type { ChargeRates } from "@/lib/engine/types";
import { addEpoch, type RatesMap } from "@/lib/engine/rates";
import { report, rng, time } from "./helpers/measure";

/**
 * A6 — Broker cost comparison.
 *
 * `compareBrokers` maps over every broker × plan pair and, inside each, walks
 * the entire book running the full charge engine per trade. That is
 * trades × pairs full charge computations — 25,000 × ~10 = 250,000 at the
 * HEAVY tier — and `/reports/broker-compare` is `force-dynamic` with no
 * memoisation, so it happens again on every render.
 *
 * The shape is INHERENT: answering "what would this book have cost at each
 * broker" genuinely requires pricing each trade at each broker. So this test
 * does not demand it be cheaper. It pins the shape — no more than one charge
 * computation per (trade, pair) — so that adding a broker stays linear in
 * brokers rather than quietly becoming quadratic, and reports the wall time so
 * the cost of adding one is visible before it ships.
 */

const SEGMENTS = ["equity_delivery", "equity_intraday", "futures", "options"];
const EXCHANGES = ["NSE", "BSE"];
const BROKERS = ["zerodha", "dhan", "groww", "angelone", "upstox", "paytm", "kotakneo", "sahi"];
const PLANS = ["default", "plus"];

function makeTrades(count: number): CompareTrade[] {
  const r = rng(11);
  return Array.from({ length: count }, (_, i) => {
    const buyValue = Math.round(r() * 500_000) / 100;
    return {
      segment: SEGMENTS[i % SEGMENTS.length],
      exchange: EXCHANGES[i % EXCHANGES.length],
      buyValue,
      sellValue: Math.round(buyValue * (0.9 + r() * 0.3) * 100) / 100,
      buyQty: 1 + Math.floor(r() * 500),
      sellQty: 1 + Math.floor(r() * 500),
      buyOrderCount: 1,
      sellOrderCount: 1,
      actualCharges: Math.round(r() * 5000) / 100,
      buyDate: "2026-01-05",
      sellDate: "2026-02-09",
    };
  });
}

/** A rates map covering every broker × plan × segment × exchange combination. */
function makeRates(): { ratesMap: RatesMap; pairCount: number } {
  const ratesMap: RatesMap = new Map();
  let pairCount = 0;
  for (const broker of BROKERS) {
    for (const plan of PLANS) {
      pairCount++;
      for (const segment of SEGMENTS) {
        for (const exchange of EXCHANGES) {
          addEpoch(ratesMap, {
            broker, plan, segment, exchange,
            brokeragePct: 0.03,
            brokerageMax: 20,
            brokerageMin: 0,
            deliverySttPct: 0.1,
            intradaySttPct: 0.025,
            futuresSttPct: 0.02,
            optionsSttPct: 0.1,
            exchangeTxnPct: 0.00325,
            sebiPct: 0.0001,
            stampDutyPct: 0.015,
            gstPct: 18,
            dpCharges: 15.34,
            ipftPct: 0,
            mtfInterestPctPerYear: 12,
            pledgeCharges: 0,
          } as unknown as ChargeRates);
        }
      }
    }
  }
  return { ratesMap, pairCount };
}

describe("A6 · broker cost comparison at the HEAVY tier", () => {
  it("prices each trade once per broker plan, and no more", () => {
    const TRADES = 25_000;
    const trades = makeTrades(TRADES);
    const { ratesMap, pairCount } = makeRates();

    const t0 = performance.now();
    const result = compareBrokers(trades, ratesMap, BROKERS);
    const ms = performance.now() - t0;

    const computations = TRADES * pairCount;
    console.log(
      `    ${TRADES.toLocaleString()} trades × ${pairCount} broker-plan pairs = ` +
        `${computations.toLocaleString()} charge computations in ${ms.toFixed(0)} ms`,
    );
    report({ label: `compareBrokers ${TRADES.toLocaleString()} × ${pairCount} pairs`, ms, n: computations, perItemUs: (ms * 1000) / computations }, {
      test: "a6-heavy",
      trades: TRADES,
      pairs: pairCount,
      computations,
    });

    expect(result.brokers.length).toBe(pairCount);
    // Every pair must have priced the whole book — this is what pins the shape.
    for (const c of result.brokers) {
      expect(c.covered + c.missing, `${c.broker}/${c.plan} did not price every trade`).toBe(TRADES);
    }

    // A hang sentinel with wide headroom, not a benchmark. The work is inherent;
    // what this catches is the page becoming unusable, on a force-dynamic route
    // where better-sqlite3's synchronous reads already block the event loop.
    expect(
      ms,
      `broker comparison took ${(ms / 1000).toFixed(1)} s for ${computations.toLocaleString()} ` +
        "charge computations, on a page that recomputes this on every render.",
    ).toBeLessThan(20_000);
  });

  it("scales linearly in brokers, not quadratically", () => {
    // Adding a broker must add its own column of work and nothing else.
    const trades = makeTrades(4_000);
    const { ratesMap } = makeRates();

    const half = BROKERS.slice(0, 4);
    const all = BROKERS;
    const a = time(`${half.length} brokers`, 4_000, () => { compareBrokers(trades, ratesMap, half); });
    const b = time(`${all.length} brokers`, 4_000, () => { compareBrokers(trades, ratesMap, all); });
    const ratio = a.ms > 0 ? b.ms / a.ms : Infinity;
    report(a, { test: "a6-scaling", ratio });
    report(b, { test: "a6-scaling", ratio });
    console.log(`    doubling brokers cost ${ratio.toFixed(2)}× — linear ≈ 2`);

    expect(ratio, `doubling the broker count cost ${ratio.toFixed(1)}× the time`).toBeLessThan(4);
  });
});
