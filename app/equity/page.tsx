import { PageHeader } from "@/components/layout/page-header";
import { TrackerClient } from "@/components/trackers/tracker-client";
import { getTrackerTrades } from "@/lib/queries/trades";
import { getMtmMap } from "@/lib/queries/mtm";
import { getBucketCapital } from "@/lib/queries/bucket-capital";
import { deriveOpenPositions } from "@/lib/analytics/positions";
import { accrueMtfInterest } from "@/lib/jobs/mtf-accrual";
import { loadRatesMap } from "@/lib/engine/rates-db";
import { ratesForTrade } from "@/lib/engine/rates";
import { planForView } from "@/lib/queries/broker-plan";
import { todayIstIso } from "@/lib/domain/trading-day";
import { computeTradeCalc } from "@/lib/analytics/trade-calc";
import type { Broker, Exchange } from "@/lib/domain/constants";

export const dynamic = "force-dynamic";

export default function EquityTrackerPage() {
  const today = todayIstIso();
  /**
   * Guarded: `accrueMtfInterest` resolves charge rates, and `findRates` now
   * throws when no epoch covers the date. A missing rate row must not blank the
   * whole Equity Tracker — the accrual is a background convenience, the page is
   * the user's book. The cosmetic breakeven call below was already guarded; this
   * one, which is load-bearing, was not (adversarial review, 2026-08-30).
   */
  try {
    accrueMtfInterest(today);
  } catch {
    // Interest simply does not accrue this render; nothing is written.
  }
  // Column-trimmed book (same rows, same order as getTrades — see the
  // projection notes in lib/queries/trades.ts, perf sweep 2026-08-29).
  const trades = getTrackerTrades();
  const mtm = getMtmMap();
  // ACCOUNT-FIRST (v3.7): the selected account's own capital, the settings row
  // only as the single-account fallback. Reading the global settings column
  // here showed one account's capital base beside another account's positions.
  const equityCapital = getBucketCapital().equityCapital;

  const rates = loadRatesMap();
  // No margin map: nothing estimates a funded amount any more (D7), so the
  // per-broker own-margin % is read only by the /risk margin check.
  const positions = deriveOpenPositions(trades, mtm, today)
    .filter((p) => p.bucket === "equity")
    .map((p) => {
      // D7 (close-readers#1) — a row whose funding the journal never recorded
      // gets NO breakeven. The price is round-trip charges + interest on the
      // funded principal; with no principal there is no honest figure, and the
      // estimate that used to fill it in was money nothing recorded (invariant
      // 6). The column renders "—", beside /risk's "not priced" and the Trades
      // table's "funding not yet resolved" — one answer on three screens.
      if (!p.isMtf || p.qty <= 0 || p.fundedAmount == null) return p;
      // Breakeven sell price: what you'd need to cover round-trip charges +
      // interest accrued so far — needs charge_config rates, which the pure
      // positions.ts module deliberately doesn't touch.
      try {
        // Wave U — priced on the plan of the account in view for this
        // broker. An open position carries no account id of its own, so
        // `planForView` answers from the view: the selected account's plan, or
        // in the All-accounts view the plan every account on that broker
        // agrees on — "default" when they do not (invariant 6).
        const r = ratesForTrade(
          rates,
          { broker: p.broker as Broker, segment: "eq_mtf", exchange: p.exchange as Exchange, symbol: p.symbol },
          todayIstIso(),
          planForView(p.broker, todayIstIso(), rates),
        );
        const calc = computeTradeCalc(
          {
            segment: "eq_mtf",
            side: "long",
            entry: p.avgPrice,
            sl: p.avgPrice,
            target: p.mtmPrice,
            qty: p.qty,
            mtf: { fundedAmount: p.fundedAmount, daysHeld: p.daysHeld ?? 0 },
          },
          r,
        );
        return { ...p, breakevenPrice: calc.breakevenPrice };
      } catch {
        return p; // no rate card for this broker/exchange combo — leave null
      }
    });
  const closedAll = trades.filter((t) => !t.isOpen && t.bucket === "equity");
  const closed = closedAll
    .slice(0, 60)
    .map((t) => ({ symbol: t.symbol, segment: t.segment, broker: t.broker, netPnl: t.netPnl, grossPnl: t.grossPnl, sellDate: t.sellDate, rMultiple: t.rMultiple }));

  return (
    <>
      <PageHeader title="Position Tracker — Equity" description="Delivery + MTF holdings, MTM, MTF interest & break-even." />
      <div className="space-y-5 p-6">
        {/* 0 = capital not configured; the client renders "—" + a Settings
            nudge. The old ?? 1300000 fabricated every utilisation figure on a
            fresh install (invariant 6). */}
        <TrackerClient variant="equity" positions={positions} closed={closed} closedTotal={closedAll.length} bucketCapital={equityCapital} />
      </div>
    </>
  );
}
