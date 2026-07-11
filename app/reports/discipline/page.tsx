import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KpiCard } from "@/components/kpi-card";
import { ExportButtons } from "@/components/ui/export-button";
import { SebiRealityCard } from "@/components/reports/sebi-reality-card";
import { getTrades } from "@/lib/queries/trades";
import { db } from "@/lib/db";
import { riskConfig } from "@/lib/db/schema";
import { breachReport, disciplineByWeek } from "@/lib/analytics/discipline";
import { computeFnoReality } from "@/lib/analytics/sebi-reality";
import { playbookStats, mistakeReport, emotionReport } from "@/lib/analytics/behavior";
import { getPlaybooks } from "@/lib/queries/playbooks";
import { inr } from "@/lib/format";
import Link from "next/link";

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

  // P2.4 — behavioral rollups: which playbooks pay, what mistakes cost, how emotions trade.
  const behaviorTrades = trades.map((t) => ({
    id: t.id, isOpen: t.isOpen, netPnl: t.netPnl, rMultiple: t.rMultiple,
    playbookId: t.playbookId, emotionTag: t.emotionTag, mistakeTags: t.mistakeTags,
  }));
  const breaches = breachReport(trades);
  const pbStats = playbookStats(behaviorTrades, getPlaybooks().map((p) => ({ id: p.id, name: p.name })));
  const mistakes = mistakeReport(behaviorTrades);
  const emotions = emotionReport(behaviorTrades);
  const pnlCls = (v: number) => (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground");

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
            <CardTitle>Entry-time limit breaches</CardTitle>
            {breaches.breachedTrades > 0 && (
              <span className={`text-sm font-semibold tabular-nums ${pnlCls(breaches.closedNet)}`}>
                {inr(breaches.closedNet, { decimals: 0 })} on {breaches.breachedTrades} breached trade{breaches.breachedTrades === 1 ? "" : "s"}
              </span>
            )}
          </CardHeader>
          <CardContent className="p-0">
            {breaches.breachedTrades === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                No trades were entered past a pre-trade limit warning or block. When you save a trade despite the
                limits engine flagging it, the breached rules land here with what they cost.
              </p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-y border-border text-left text-muted-foreground">
                        <th className="px-2.5 py-2 font-medium">Rule breached at entry</th>
                        <th className="px-2 py-2 text-right font-medium">Trades</th>
                        <th className="px-2.5 py-2 text-right font-medium">Closed net P&L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {breaches.perRule.map((b) => (
                        <tr key={b.rule} className="border-b border-border/40">
                          <td className="px-2.5 py-1.5 font-medium">{b.rule}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{b.trades}</td>
                          <td className={`px-2.5 py-1.5 text-right tabular-nums ${pnlCls(b.closedNet)}`}>{inr(b.closedNet, { decimals: 0 })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {breaches.openBreached > 0 && (
                  <p className="px-4 py-3 text-[11px] text-muted-foreground">
                    {breaches.openBreached} breached trade{breaches.openBreached === 1 ? " is" : "s are"} still open —
                    closed net above excludes {breaches.openBreached === 1 ? "it" : "them"}.
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card className="p-0">
            <CardHeader><CardTitle>Playbook expectancy</CardTitle></CardHeader>
            <CardContent className="p-0">
              {pbStats.length === 0 || (pbStats.length === 1 && pbStats[0].playbookId === null) ? (
                <p className="p-4 text-sm text-muted-foreground">
                  No trades tagged to a playbook yet — create setups under{" "}
                  <Link href="/playbooks" className="text-accent underline-offset-2 hover:underline">Playbooks</Link>{" "}
                  and tag trades from the journal (📓) button on Trades.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-y border-border text-left text-muted-foreground">
                        <th className="px-2.5 py-2 font-medium">Playbook</th>
                        <th className="px-2 py-2 text-right font-medium">Trades</th>
                        <th className="px-2 py-2 text-right font-medium">Win rate</th>
                        <th className="px-2 py-2 text-right font-medium">Net</th>
                        <th className="px-2 py-2 text-right font-medium">Expectancy</th>
                        <th className="px-2.5 py-2 text-right font-medium">Avg R</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pbStats.map((s) => (
                        <tr key={s.playbookId ?? "untagged"} className="border-b border-border/40">
                          <td className={`px-2.5 py-1.5 font-medium ${s.playbookId == null ? "text-muted-foreground" : ""}`}>{s.name}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{s.trades}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{s.winRatePct}%</td>
                          <td className={`px-2 py-1.5 text-right tabular-nums ${pnlCls(s.net)}`}>{inr(s.net, { decimals: 0 })}</td>
                          <td className={`px-2 py-1.5 text-right tabular-nums font-medium ${pnlCls(s.expectancy)}`}>{inr(s.expectancy, { decimals: 0 })}/trade</td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums">{s.avgR == null ? "—" : `${s.avgR}R`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="p-0">
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Cost of mistakes</CardTitle>
              {mistakes.mistakeTrades > 0 && (
                <span className={`text-sm font-semibold tabular-nums ${pnlCls(mistakes.mistakeNet)}`}>
                  {inr(mistakes.mistakeNet, { decimals: 0 })} on {mistakes.mistakeTrades} tagged trade{mistakes.mistakeTrades === 1 ? "" : "s"}
                </span>
              )}
            </CardHeader>
            <CardContent className="p-0">
              {mistakes.mistakeTrades === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  No mistakes tagged yet. Honest tagging is the whole point — use the journal (📓) button on a trade
                  and tick what went wrong. The rollup here shows what breaking your rules actually costs.
                </p>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-y border-border text-left text-muted-foreground">
                          <th className="px-2.5 py-2 font-medium">Mistake</th>
                          <th className="px-2 py-2 text-right font-medium">Trades</th>
                          <th className="px-2 py-2 text-right font-medium">Net P&L</th>
                          <th className="px-2.5 py-2 text-right font-medium">Avg / trade</th>
                        </tr>
                      </thead>
                      <tbody>
                        {mistakes.perTag.map((m) => (
                          <tr key={m.tag} className="border-b border-border/40">
                            <td className="px-2.5 py-1.5 font-medium">{m.label}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{m.trades}</td>
                            <td className={`px-2 py-1.5 text-right tabular-nums ${pnlCls(m.net)}`}>{inr(m.net, { decimals: 0 })}</td>
                            <td className={`px-2.5 py-1.5 text-right tabular-nums ${pnlCls(m.avgNet)}`}>{inr(m.avgNet, { decimals: 0 })}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="px-4 py-3 text-[11px] text-muted-foreground">
                    Clean trades average <span className={`font-medium ${pnlCls(mistakes.cleanExpectancy)}`}>{inr(mistakes.cleanExpectancy, { decimals: 0 })}</span>/trade
                    ({mistakes.cleanTrades}); mistake-tagged trades average{" "}
                    <span className={`font-medium ${pnlCls(mistakes.mistakeExpectancy)}`}>{inr(mistakes.mistakeExpectancy, { decimals: 0 })}</span>/trade —
                    an expectancy gap of <span className="font-semibold">{inr(mistakes.expectancyGap, { decimals: 0 })}</span> every time a rule breaks.
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {emotions.length > 0 && (
          <Card className="p-0">
            <CardHeader><CardTitle>Trading by emotion</CardTitle></CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-y border-border text-left text-muted-foreground">
                      <th className="px-2.5 py-2 font-medium">Emotion at entry</th>
                      <th className="px-2 py-2 text-right font-medium">Trades</th>
                      <th className="px-2 py-2 text-right font-medium">Win rate</th>
                      <th className="px-2.5 py-2 text-right font-medium">Net P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {emotions.map((e) => (
                      <tr key={e.tag} className="border-b border-border/40">
                        <td className="px-2.5 py-1.5 font-medium">{e.label}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{e.trades}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{e.winRatePct}%</td>
                        <td className={`px-2.5 py-1.5 text-right tabular-nums ${pnlCls(e.net)}`}>{inr(e.net, { decimals: 0 })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

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
