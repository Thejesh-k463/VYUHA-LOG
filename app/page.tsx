import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { DashboardClient, type DashTrade } from "@/components/dashboard/dashboard-client";
import { AutoMtmRunner } from "@/components/system/auto-mtm-runner";
import { BreachBanner } from "@/components/risk/breach-banner";
import { scanBreaches } from "@/lib/jobs/auto-mtm";
import { getDashboardTrades } from "@/lib/queries/trades";
import { getSettings, getGlobalRisk } from "@/lib/queries/settings";
import { asWorkspace } from "@/lib/domain/workspace";

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  const settings = getSettings();
  const risk = getGlobalRisk();
  // The 13 DashTrade fields are selected in SQL (getDashboardTrades) instead
  // of fetching all 74 columns and projecting here — same rows, same order,
  // same values, ~4× less row-mapping work at 25k trades (perf sweep 2026-08-29).
  const dash: DashTrade[] = getDashboardTrades();

  const total = (settings?.equityCapital ?? 0) + (settings?.activeCapital ?? 0);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Combined cockpit — P&L, risk and edge across both buckets."
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="secondary">Total ₹{(total / 100000).toFixed(1)}L</Badge>
            <Badge variant="secondary">{dash.length} trades</Badge>
          </div>
        }
      />
      <div className="space-y-5 p-6">
        <AutoMtmRunner />
        <BreachBanner breaches={scanBreaches()} />
        <DashboardClient
          workspace={asWorkspace(settings?.workspace)}
          trades={dash}
          monthlyBase={risk?.monthlyTargetBase ?? 425000}
          monthlyStretch={risk?.monthlyTargetStretch ?? 510000}
        />
      </div>
    </>
  );
}
