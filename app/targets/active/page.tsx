import { todayIstIso } from "@/lib/domain/trading-day";
import { PageHeader } from "@/components/layout/page-header";
import { TargetActiveClient, type DailySummary, type SegLimit } from "@/components/targets/target-active-client";
import { getTrades } from "@/lib/queries/trades";
import { getMtmMap } from "@/lib/queries/mtm";
import { db } from "@/lib/db";
import { riskConfig } from "@/lib/db/schema";
import { deriveOpenPositions } from "@/lib/analytics/positions";
import { dailyPnl } from "@/lib/analytics/metrics";
import { getGoalView } from "@/lib/queries/goals";
import { getBucketCapital } from "@/lib/queries/capital";
import { goalProgress } from "@/lib/analytics/goal";
import { GoalStrip } from "@/components/targets/goal-strip";
import type { Segment } from "@/lib/domain/constants";

export const dynamic = "force-dynamic";

const OPTION_SEGS = ["index_option", "stock_option"];
const COMMODITY_SEGS = ["commodity_option", "commodity_future"];

export default function TargetActivePage() {
  const today = todayIstIso();
  const trades = getTrades();
  const mtm = getMtmMap();
  const risk = db.select().from(riskConfig).all();
  const activeRisk = risk.find((r) => r.scope === "bucket" && r.key === "active");
  const segRisk = (key: string) => risk.find((r) => r.scope === "segment" && r.key === key);

  // daily summaries for active bucket (dated, closed trades)
  const byDate = new Map<string, DailySummary>();
  let undatedActive = 0;
  for (const t of trades) {
    if (t.bucket !== "active" || t.isOpen) continue;
    if (!t.sellDate) { undatedActive++; continue; }
    const d = byDate.get(t.sellDate) ?? { date: t.sellDate, net: 0, optionTrades: 0, intradayTrades: 0, commodityTrades: 0 };
    d.net = Math.round((d.net + t.netPnl) * 100) / 100;
    if (OPTION_SEGS.includes(t.segment)) d.optionTrades++;
    else if (t.segment === "eq_intraday") d.intradayTrades++;
    else if (COMMODITY_SEGS.includes(t.segment)) d.commodityTrades++;
    byDate.set(t.sellDate, d);
  }
  const daily = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  // open option positions
  const positions = deriveOpenPositions(trades, mtm, today).filter((p) => p.bucket === "active");
  const openOptions = positions.filter((p) => OPTION_SEGS.includes(p.segment)).length;

  const worst = daily.reduce<DailySummary | null>((w, d) => (w == null || d.net < w.net ? d : w), null);
  const countOn = (seg: (s: string) => boolean) =>
    worst ? trades.filter((t) => t.bucket === "active" && !t.isOpen && t.sellDate === worst.date && seg(t.segment)).length : 0;

  const segLimits: SegLimit[] = [
    { segment: "index_option", ...segCfg("index_option") },
    { segment: "stock_option", ...segCfg("stock_option") },
    { segment: "eq_intraday", ...segCfg("eq_intraday") },
    { segment: "commodity_option", ...segCfg("commodity_option") },
  ];
  function segCfg(key: Segment): { perTradeMaxLoss: number | null; maxTradesDay: number | null; todayCount: number } {
    const c = segRisk(key);
    const todayCount =
      key === "eq_intraday" ? countOn((s) => s === "eq_intraday")
        : COMMODITY_SEGS.includes(key) ? countOn((s) => COMMODITY_SEGS.includes(s))
          : countOn((s) => s === key);
    // Null, never a stand-in (invariant 6). This page used to read `?? 9500`
    // per segment, `?? 25000` for the day and `?? 9500` for the lot sizer —
    // three limits the user may never have seen, printed on a risk cockpit as
    // though they were their own rules. `risk_config` columns are nullable and
    // the Settings risk editor writes NULL, so this is reachable, not
    // theoretical. The same refusal the discipline and monthly reports made in
    // v3.7.0; tests/discipline-page-guard.test.ts now covers this file too.
    return { perTradeMaxLoss: c?.perTradeMaxLoss ?? null, maxTradesDay: c?.maxTradesDay ?? null, todayCount };
  }

  // Expected-capital goal for THIS bucket (v3.6) — nothing renders without one.
  const activeGoal = getGoalView().goals.find((g) => g.bucket === "active") ?? null;
  const goalProg = activeGoal
    ? goalProgress(activeGoal, {
        currentCapital: getBucketCapital().activeCapital > 0 ? getBucketCapital().activeCapital : null,
        realised: [...dailyPnl(trades.filter((t) => t.bucket === "active")).entries()].map(([date, net]) => ({ date, net })),
        today,
      })
    : null;

  return (
    <>
      <PageHeader title="Target Tracker — Trade F&O" description="Daily max-loss cockpit, trade counters, per-segment limits, lot sizing." />
      <div className="space-y-5 p-6">
        {activeGoal && goalProg && <GoalStrip goal={activeGoal} progress={goalProg} />}
        <TargetActiveClient
          daily={daily}
          limits={{
            dailyLossStop: activeRisk?.dailyLossStop ?? null,
            optionsMaxTrades: segRisk("index_option")?.maxTradesDay ?? activeRisk?.maxTradesDay ?? 15,
            intradayMaxTrades: segRisk("eq_intraday")?.maxTradesDay ?? 12,
            commodityMaxTrades: segRisk("commodity_option")?.maxTradesDay ?? 10,
            optionsMaxOpen: activeRisk?.maxOpen ?? 8,
          }}
          openOptions={openOptions}
          segLimits={segLimits}
          defaultRisk={risk.find((r) => r.scope === "global")?.perTradeMaxLoss ?? null}
          undatedActive={undatedActive}
        />
      </div>
    </>
  );
}
