import { PageHeader } from "@/components/layout/page-header";
import { TrackerClient } from "@/components/trackers/tracker-client";
import { getTrackerTrades } from "@/lib/queries/trades";
import { getMtmMap } from "@/lib/queries/mtm";
import { getSettings } from "@/lib/queries/settings";
import { deriveOpenPositions } from "@/lib/analytics/positions";
import { accrueMtfInterest } from "@/lib/jobs/mtf-accrual";
import { loadRatesMap } from "@/lib/engine/rates-db";
import { findRates, todayIso } from "@/lib/engine/rates";
import { computeTradeCalc } from "@/lib/analytics/trade-calc";
import { getMtfMarginByBroker } from "@/lib/queries/margin";
import type { Broker, Exchange } from "@/lib/domain/constants";

export const dynamic = "force-dynamic";

export default function EquityTrackerPage() {
  const today = new Date().toISOString().slice(0, 10);
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
  const settings = getSettings();

  const rates = loadRatesMap();
  const positions = deriveOpenPositions(trades, mtm, today, getMtfMarginByBroker())
    .filter((p) => p.bucket === "equity")
    .map((p) => {
      if (!p.isMtf || p.qty <= 0) return p;
      // Breakeven sell price: what you'd need to cover round-trip charges +
      // interest accrued so far — needs charge_config rates, which the pure
      // positions.ts module deliberately doesn't touch.
      try {
        const r = findRates(rates, p.broker as Broker, "eq_mtf", p.exchange as Exchange, todayIso());
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
        <TrackerClient variant="equity" positions={positions} closed={closed} closedTotal={closedAll.length} bucketCapital={settings?.equityCapital ?? 0} />
      </div>
    </>
  );
}
