import { todayIstIso } from "@/lib/domain/trading-day";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { DashboardClient, type DashTrade } from "@/components/dashboard/dashboard-client";
import { AutoMtmRunner } from "@/components/system/auto-mtm-runner";
import { TelegramRunner } from "@/components/system/telegram-runner";
import { AutoPullRunner } from "@/components/system/auto-pull-runner";
import { BreachBanner } from "@/components/risk/breach-banner";
import { ReviewOpenCard } from "@/components/review/review-open-card";
import { scanBreaches } from "@/lib/jobs/auto-mtm";
import { getDashboardTrades } from "@/lib/queries/trades";
import { getSettings, getGlobalRisk } from "@/lib/queries/settings";
import { getBucketCapital } from "@/lib/queries/bucket-capital";
import { getGoalView, getAggregateGoalProgress } from "@/lib/queries/goals";
import { goalProgress } from "@/lib/analytics/goal";
import { dailyPnl } from "@/lib/analytics/metrics";
import { inrCompact } from "@/lib/format";
import { asWorkspace } from "@/lib/domain/workspace";

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  const settings = getSettings();
  const risk = getGlobalRisk();
  // The 13 DashTrade fields are selected in SQL (getDashboardTrades) instead
  // of fetching all 74 columns and projecting here — same rows, same order,
  // same values, ~4× less row-mapping work at 25k trades (perf sweep 2026-08-29).
  const dash: DashTrade[] = getDashboardTrades();

  // ACCOUNT-FIRST (v3.7): the "Total ₹XL" tile read the GLOBAL settings row
  // while the goal badge three lines below already resolved per-account — the
  // same header could show account A's capital next to account B's goal.
  const bucketCapital = getBucketCapital();
  const total = bucketCapital.totalCapital;

  // Compact goal badge (v3.6) — renders ONLY when a goal exists. One goal is
  // summarised (total bucket preferred); the full read lives on /reports/
  // performance. Maths runs on the dash projection already loaded.
  const goalView = getGoalView();
  const goal = goalView.goals.find((g) => g.bucket === "total") ?? goalView.goals[0];
  let goalBadge: string | null = null;
  if (goal) {
    const today = todayIstIso();
    const bc = bucketCapital; // same resolution as the "Total" tile above
    const cap = goal.bucket === "equity" ? bc.equityCapital : goal.bucket === "active" ? bc.activeCapital : bc.totalCapital;
    const rel = goal.bucket === "total" ? dash : dash.filter((t) => t.bucket === goal.bucket);
    const realised = [...dailyPnl(rel).entries()].map(([date, net]) => ({ date, net }));
    // All-accounts view: the honest aggregate is the SUM of each account's own
    // frozen-baseline walk (getAggregateGoalProgress) — walking the blended
    // series from the earliest baseline double-counts pre-baseline profit and
    // lets goal-less accounts inflate the numerator.
    const gp = goalView.aggregate
      ? (getAggregateGoalProgress(today).get(goal.bucket) ??
        goalProgress(goal, { currentCapital: null, realised: [], today }))
      : goalProgress(goal, {
          currentCapital: cap > 0 ? cap : null,
          realised,
          today,
        });
    const label = goal.bucket === "active" ? "F&O" : goal.bucket === "equity" ? "equity" : "";
    goalBadge = gp.measurable
      ? gp.status === "achieved"
        ? `Goal met ${label}`.trim()
        : `Goal ${gp.progressPct != null ? `${Math.round(gp.progressPct)}%` : inrCompact(gp.targetLevel ?? 0)} ${label}`.trim()
      : null; // unmeasurable: the performance page explains; a badge can't say "—" honestly
  }

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Combined cockpit — P&L, risk and edge across both buckets."
        actions={
          <div className="flex items-center gap-2">
            {goalBadge && <Badge variant="secondary">{goalBadge}</Badge>}
            <Badge variant="secondary">Total ₹{(total / 100000).toFixed(1)}L</Badge>
            <Badge variant="secondary">{dash.length} trades</Badge>
          </div>
        }
      />
      <div className="space-y-5 p-6">
        <AutoMtmRunner />
        <TelegramRunner />
        <AutoPullRunner />
        <BreachBanner breaches={scanBreaches()} />
        <ReviewOpenCard />
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
