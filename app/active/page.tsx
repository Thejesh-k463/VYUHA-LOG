import { PageHeader } from "@/components/layout/page-header";
import { TrackerClient } from "@/components/trackers/tracker-client";
import { getTrades } from "@/lib/queries/trades";
import { getMtmMap } from "@/lib/queries/mtm";
import { getSettings } from "@/lib/queries/settings";
import { deriveOpenPositions } from "@/lib/analytics/positions";

export const dynamic = "force-dynamic";

export default function ActiveTrackerPage() {
  const today = new Date().toISOString().slice(0, 10);
  const trades = getTrades();
  const mtm = getMtmMap();
  const settings = getSettings();

  const positions = deriveOpenPositions(trades, mtm, today).filter((p) => p.bucket === "active");
  const closed = trades
    .filter((t) => !t.isOpen && t.bucket === "active")
    .slice(0, 60)
    .map((t) => ({ symbol: t.symbol, segment: t.segment, broker: t.broker, netPnl: t.netPnl, grossPnl: t.grossPnl, sellDate: t.sellDate, rMultiple: t.rMultiple }));

  return (
    <>
      <PageHeader title="Position Tracker — Trade F&O (₹4L)" description="Index/stock options, intraday equity, commodities." />
      <div className="space-y-5 p-6">
        <TrackerClient variant="active" positions={positions} closed={closed} bucketCapital={settings?.activeCapital ?? 400000} />
      </div>
    </>
  );
}
