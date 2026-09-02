import { PageHeader } from "@/components/layout/page-header";
import { TrackerClient } from "@/components/trackers/tracker-client";
import { getTrackerTrades } from "@/lib/queries/trades";
import { getMtmMap } from "@/lib/queries/mtm";
import { getBucketCapital } from "@/lib/queries/bucket-capital";
import { deriveOpenPositions } from "@/lib/analytics/positions";

export const dynamic = "force-dynamic";

export default function ActiveTrackerPage() {
  const today = new Date().toISOString().slice(0, 10);
  // Column-trimmed book (same rows, same order as getTrades — see the
  // projection notes in lib/queries/trades.ts, perf sweep 2026-08-29).
  const trades = getTrackerTrades();
  const mtm = getMtmMap();
  // ACCOUNT-FIRST (v3.7): the selected account's own capital, the settings row
  // only as the single-account fallback. Reading the global settings column
  // here showed one account's capital base beside another account's positions.
  const activeCapital = getBucketCapital().activeCapital;

  const positions = deriveOpenPositions(trades, mtm, today).filter((p) => p.bucket === "active");
  const closedAll = trades.filter((t) => !t.isOpen && t.bucket === "active");
  const closed = closedAll
    .slice(0, 60)
    .map((t) => ({ symbol: t.symbol, segment: t.segment, broker: t.broker, netPnl: t.netPnl, grossPnl: t.grossPnl, sellDate: t.sellDate, rMultiple: t.rMultiple }));

  return (
    <>
      <PageHeader title="Position Tracker — Trade F&O" description="Index/stock options, intraday equity, commodities." />
      <div className="space-y-5 p-6">
        {/* 0 = capital not configured; the client renders "—" + a Settings
            nudge. The old ?? 400000 fabricated every utilisation figure on a
            fresh install (invariant 6). */}
        <TrackerClient variant="active" positions={positions} closed={closed} closedTotal={closedAll.length} bucketCapital={activeCapital} />
      </div>
    </>
  );
}
