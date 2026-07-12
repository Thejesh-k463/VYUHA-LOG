import { PageHeader } from "@/components/layout/page-header";
import { TrackerClient } from "@/components/trackers/tracker-client";
import { getTrades } from "@/lib/queries/trades";
import { getMtmMap } from "@/lib/queries/mtm";
import { getSettings } from "@/lib/queries/settings";
import { deriveOpenPositions } from "@/lib/analytics/positions";
import { accrueMtfInterest } from "@/lib/jobs/mtf-accrual";
import { loadRatesMap } from "@/lib/engine/rates-db";
import { findRates } from "@/lib/engine/rates";
import { computeTradeCalc } from "@/lib/analytics/trade-calc";
import { getMtfMarginByBroker } from "@/lib/queries/margin";
import type { Broker, Exchange } from "@/lib/domain/constants";

export const dynamic = "force-dynamic";

export default function EquityTrackerPage() {
  const today = new Date().toISOString().slice(0, 10);
  accrueMtfInterest(today); // daily MTF interest accrual (idempotent, runs on open)
  const trades = getTrades();
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
        const r = findRates(rates, p.broker as Broker, "eq_mtf", p.exchange as Exchange);
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
  const closed = trades
    .filter((t) => !t.isOpen && t.bucket === "equity")
    .slice(0, 60)
    .map((t) => ({ symbol: t.symbol, segment: t.segment, broker: t.broker, netPnl: t.netPnl, grossPnl: t.grossPnl, sellDate: t.sellDate, rMultiple: t.rMultiple }));

  return (
    <>
      <PageHeader title="Position Tracker — Equity" description="Delivery + MTF holdings, MTM, MTF interest & break-even." />
      <div className="space-y-5 p-6">
        <TrackerClient variant="equity" positions={positions} closed={closed} bucketCapital={settings?.equityCapital ?? 1300000} />
      </div>
    </>
  );
}
