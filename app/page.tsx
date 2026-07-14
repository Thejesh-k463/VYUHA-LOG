import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { DashboardClient, type DashTrade } from "@/components/dashboard/dashboard-client";
import { AutoMtmRunner } from "@/components/system/auto-mtm-runner";
import { BreachBanner } from "@/components/risk/breach-banner";
import { scanBreaches } from "@/lib/jobs/auto-mtm";
import { getTrades } from "@/lib/queries/trades";
import { getSettings, getGlobalRisk } from "@/lib/queries/settings";

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  const settings = getSettings();
  const risk = getGlobalRisk();
  const trades = getTrades();

  const dash: DashTrade[] = trades.map((t) => ({
    broker: t.broker,
    bucket: t.bucket,
    segment: t.segment,
    symbol: t.symbol,
    exchange: t.exchange,
    netPnl: t.netPnl,
    grossPnl: t.grossPnl,
    chargesTotal: t.chargesTotal,
    rMultiple: t.rMultiple,
    isOpen: t.isOpen,
    sellDate: t.sellDate,
    buyDate: t.buyDate,
    setupTag: t.setupTag,
  }));

  const total = (settings?.equityCapital ?? 0) + (settings?.activeCapital ?? 0);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Combined cockpit — P&L, risk and edge across both buckets."
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="secondary">Total ₹{(total / 100000).toFixed(1)}L</Badge>
            <Badge variant="secondary">{trades.length} trades</Badge>
          </div>
        }
      />
      <div className="space-y-5 p-6">
        <AutoMtmRunner />
        <BreachBanner breaches={scanBreaches()} />
        <DashboardClient
          trades={dash}
          monthlyBase={risk?.monthlyTargetBase ?? 425000}
          monthlyStretch={risk?.monthlyTargetStretch ?? 510000}
        />
      </div>
    </>
  );
}
