import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KpiCard } from "@/components/kpi-card";
import { ExportButtons } from "@/components/ui/export-button";
import { SebiRealityCard } from "@/components/reports/sebi-reality-card";
import { getTrades } from "@/lib/queries/trades";
import { db } from "@/lib/db";
import { riskConfig } from "@/lib/db/schema";
import { disciplineByWeek } from "@/lib/analytics/discipline";
import { computeFnoReality } from "@/lib/analytics/sebi-reality";

export const dynamic = "force-dynamic";

const COLS = [
  { key: "week", label: "Week" }, { key: "weekStart", label: "Starting" },
  { key: "trades", label: "Trades" }, { key: "riskCapRespectedPct", label: "Risk cap %" },
  { key: "dailyStopRespectedPct", label: "Daily stop %" }, { key: "planningPct", label: "Planned %" },
  { key: "score", label: "Score" },
];

function scoreColor(s: number) {
  return s >= 80 ? "text-profit" : s >= 60 ? "text-warning" : "text-loss";
}

export default function DisciplineReportPage() {
  const trades = getTrades();
  const risk = db.select().from(riskConfig).all();
  const cap = risk.find((r) => r.scope === "global")?.perTradeMaxLoss ?? 9500;
  const stop = risk.find((r) => r.scope === "bucket" && r.key === "active")?.dailyLossStop ?? 25000;

  const weeks = disciplineByWeek(trades, cap, stop);
  const avg = weeks.length ? Math.round((weeks.reduce((s, w) => s + w.score, 0) / weeks.length) * 10) / 10 : 0;
  const latest = weeks[weeks.length - 1];
  const fnoReality = computeFnoReality(trades);

  return (
    <>
      <PageHeader title="Discipline Scorecard" description="Weekly adherence to the rules that protect your capital." />
      <div className="space-y-5 p-6">
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <KpiCard label="Avg weekly score" value={`${avg}`} valueClassName={scoreColor(avg)} sub={`${weeks.length} weeks`} />
          <KpiCard label="Latest week" value={latest ? `${latest.score}` : "—"} valueClassName={latest ? scoreColor(latest.score) : ""} sub={latest?.week} />
          <KpiCard label="Risk cap respected" value={`${cap.toLocaleString("en-IN")}`} sub="per-trade max loss" />
          <KpiCard label="Daily stop" value={`${stop.toLocaleString("en-IN")}`} sub="aggregate/day" />
        </section>

        <SebiRealityCard reality={fnoReality} />

        <Card className="p-0">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Weekly scores</CardTitle>
            <ExportButtons filename="vyuha-discipline" columns={COLS} rows={weeks} />
          </CardHeader>
          <CardContent className="p-0">
            {weeks.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No closed dated trades yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-y border-border text-left text-muted-foreground">
                      <th className="px-2.5 py-2 font-medium">Week</th>
                      <th className="px-2.5 py-2 font-medium">Starting</th>
                      <th className="px-2.5 py-2 text-right font-medium">Trades</th>
                      <th className="px-2.5 py-2 text-right font-medium">Risk cap respected</th>
                      <th className="px-2.5 py-2 text-right font-medium">Daily stop respected</th>
                      <th className="px-2.5 py-2 text-right font-medium">SL/target planned</th>
                      <th className="px-2.5 py-2 text-right font-medium">Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {weeks.map((w) => (
                      <tr key={w.week} className="border-b border-border/40">
                        <td className="px-2.5 py-1.5 font-medium">{w.week}</td>
                        <td className="px-2.5 py-1.5 text-muted-foreground">{w.weekStart}</td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">{w.trades}</td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">{w.riskCapRespectedPct}%</td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">{w.dailyStopRespectedPct}%</td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums">{w.planningPct}%</td>
                        <td className={`px-2.5 py-1.5 text-right tabular-nums font-semibold ${scoreColor(w.score)}`}>{w.score}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
        <p className="text-[11px] text-muted-foreground">
          Score = average of three sub-scores: losses kept within the per-trade cap, days kept within the daily stop, and trades with an SL/target recorded. Tag SL/targets in Trades to lift the planning score.
        </p>
      </div>
    </>
  );
}
