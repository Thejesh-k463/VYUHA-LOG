import { PageHeader } from "@/components/layout/page-header";
import { TrackerClient } from "@/components/trackers/tracker-client";
import { getTrades } from "@/lib/queries/trades";
import { getMtmMap } from "@/lib/queries/mtm";
import { getSettings } from "@/lib/queries/settings";
import { deriveOpenPositions } from "@/lib/analytics/positions";
import { accrueMtfInterest } from "@/lib/jobs/mtf-accrual";

export const dynamic = "force-dynamic";

export default function EquityTrackerPage() {
  const today = new Date().toISOString().slice(0, 10);
  accrueMtfInterest(today); // daily MTF interest accrual (idempotent, runs on open)
  const trades = getTrades();
  const mtm = getMtmMap();
  const settings = getSettings();

  const positions = deriveOpenPositions(trades, mtm, today).filter((p) => p.bucket === "equity");
  const closed = trades
    .filter((t) => !t.isOpen && t.bucket === "equity")
    .slice(0, 60)
    .map((t) => ({ symbol: t.symbol, segment: t.segment, broker: t.broker, netPnl: t.netPnl, grossPnl: t.grossPnl, sellDate: t.sellDate, rMultiple: t.rMultiple }));

  return (
    <>
      <PageHeader title="Position Tracker — Equity (₹13L)" description="Delivery + MTF holdings, MTM, MTF interest & break-even." />
      <div className="space-y-5 p-6">
        <TrackerClient variant="equity" positions={positions} closed={closed} bucketCapital={settings?.equityCapital ?? 1300000} />
      </div>
    </>
  );
}
