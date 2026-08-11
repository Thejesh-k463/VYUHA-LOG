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
import { playbookStats, mistakeReport, emotionReport, playbookRuleCost, PLAYBOOK_RULE_PREFIX } from "@/lib/analytics/behavior";
import { getPlaybooks } from "@/lib/queries/playbooks";
import { inr } from "@/lib/format";
import Link from "next/link";
import { ProGate } from "@/components/system/pro-gate";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { EmptyState } from "@/components/ui/empty-state";

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
  // Same column, two populations: entry-time limit breaches keep their own
  // table; journal rule-checklist violations ("Playbook: …") get theirs below.
  const breaches = breachReport(
    trades.map((t) => ({
      ...t,
      ruleViolations: (t.ruleViolations ?? []).filter((v) => !v.startsWith(PLAYBOOK_RULE_PREFIX)),
    })),
  );
  const ruleCosts = playbookRuleCost(trades);
  const pbStats = playbookStats(behaviorTrades, getPlaybooks().map((p) => ({ id: p.id, name: p.name })));
  const mistakes = mistakeReport(behaviorTrades);
  const emotions = emotionReport(behaviorTrades);
  const pnlCls = (v: number) => (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground");

  return (
    <>
      <PageHeader title="Discipline Scorecard" description="Weekly adherence to the rules that protect your capital." />
      <div className="space-y-5 p-6">
        <ProGate>
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
              <EmptyState
                variant="playbook"
                title="No trades entered past a limit warning or block"
                hint="When you save a trade despite the limits engine flagging it, the breached rules land here with what they cost."
              />
            ) : (
              <>
                <ReportTable>
                  <ReportThead>
                    <ReportTh>Rule breached at entry</ReportTh>
                    <ReportTh align="right">Trades</ReportTh>
                    <ReportTh align="right">Closed net P&L</ReportTh>
                  </ReportThead>
                  <tbody>
                    {breaches.perRule.map((b) => (
                      <ReportTr key={b.rule}>
                        <ReportTd className="font-medium">{b.rule}</ReportTd>
                        <ReportTd align="right">{b.trades}</ReportTd>
                        <ReportTd align="right" className={pnlCls(b.closedNet)}>{inr(b.closedNet, { decimals: 0 })}</ReportTd>
                      </ReportTr>
                    ))}
                  </tbody>
                </ReportTable>
                {breaches.openBreached > 0 && (
                  <p className="px-4 py-3 text-[0.6875rem] text-muted-foreground">
                    {breaches.openBreached} breached trade{breaches.openBreached === 1 ? " is" : "s are"} still open —
                    closed net above excludes {breaches.openBreached === 1 ? "it" : "them"}.
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <Card className="p-0">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Playbook rules — what breaking each one costs</CardTitle>
            {ruleCosts.length > 0 && (
              <span className={`text-sm font-semibold tabular-nums ${pnlCls(ruleCosts.reduce((s, r) => s + r.closedNet, 0))}`}>
                {inr(ruleCosts.reduce((s, r) => s + r.closedNet, 0), { decimals: 0 })} across {ruleCosts.length} rule{ruleCosts.length === 1 ? "" : "s"}
              </span>
            )}
          </CardHeader>
          <CardContent className="p-0">
            {ruleCosts.length === 0 ? (
              <EmptyState
                variant="playbook"
                title="No playbook rules marked broken yet"
                hint="When you journal a trade (📓) with a playbook attached, its rules appear as a checklist — anything you untick lands here with what it cost you."
              />
            ) : (
              <>
                <ReportTable>
                  <ReportThead>
                    <ReportTh>Rule broken</ReportTh>
                    <ReportTh align="right">Trades</ReportTh>
                    <ReportTh align="right">Closed net P&L</ReportTh>
                    <ReportTh align="right">Avg / trade</ReportTh>
                  </ReportThead>
                  <tbody>
                    {ruleCosts.map((r) => (
                      <ReportTr key={r.rule}>
                        <ReportTd className="font-medium">{r.rule}</ReportTd>
                        <ReportTd align="right">{r.trades}</ReportTd>
                        <ReportTd align="right" className={pnlCls(r.closedNet)}>{inr(r.closedNet, { decimals: 0 })}</ReportTd>
                        <ReportTd align="right" className={pnlCls(r.avgNet ?? 0)}>{r.avgNet == null ? "—" : inr(r.avgNet, { decimals: 0 })}</ReportTd>
                      </ReportTr>
                    ))}
                  </tbody>
                </ReportTable>
                <p className="px-4 py-3 text-[0.6875rem] text-muted-foreground">
                  Honest framing: this is the P&L of trades where you admitted breaking the rule — not proof
                  the break caused the loss. But a rule that keeps sitting at the top of this table is telling
                  you something.
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card className="p-0">
            <CardHeader><CardTitle>Playbook expectancy</CardTitle></CardHeader>
            <CardContent className="p-0">
              {pbStats.length === 0 || (pbStats.length === 1 && pbStats[0].playbookId === null) ? (
                <EmptyState
                  variant="playbook"
                  title="No trades tagged to a playbook yet"
                  hint={<>Create setups under{" "}
                    <Link href="/playbooks" className="text-accent underline-offset-2 hover:underline">Playbooks</Link>{" "}
                    and tag trades from the journal (📓) button on Trades.</>}
                />
              ) : (
                <ReportTable>
                  <ReportThead>
                    <ReportTh>Playbook</ReportTh>
                    <ReportTh align="right">Trades</ReportTh>
                    <ReportTh align="right">Win rate</ReportTh>
                    <ReportTh align="right">Net</ReportTh>
                    <ReportTh align="right">Expectancy</ReportTh>
                    <ReportTh align="right">Avg R</ReportTh>
                  </ReportThead>
                  <tbody>
                    {pbStats.map((s) => (
                      <ReportTr key={s.playbookId ?? "untagged"}>
                        <ReportTd className={`font-medium ${s.playbookId == null ? "text-muted-foreground" : ""}`}>{s.name}</ReportTd>
                        <ReportTd align="right">{s.trades}</ReportTd>
                        <ReportTd align="right">{s.winRatePct}%</ReportTd>
                        <ReportTd align="right" className={pnlCls(s.net)}>{inr(s.net, { decimals: 0 })}</ReportTd>
                        <ReportTd align="right" className={`font-medium ${pnlCls(s.expectancy)}`}>{inr(s.expectancy, { decimals: 0 })}/trade</ReportTd>
                        <ReportTd align="right">{s.avgR == null ? "—" : `${s.avgR}R`}</ReportTd>
                      </ReportTr>
                    ))}
                  </tbody>
                </ReportTable>
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
                <EmptyState
                  variant="journal"
                  title="No mistakes tagged yet"
                  hint="Honest tagging is the whole point — use the journal (📓) button on a trade and tick what went wrong. The rollup here shows what breaking your rules actually costs."
                />
              ) : (
                <>
                  <ReportTable>
                    <ReportThead>
                      <ReportTh>Mistake</ReportTh>
                      <ReportTh align="right">Trades</ReportTh>
                      <ReportTh align="right">Net P&L</ReportTh>
                      <ReportTh align="right">Avg / trade</ReportTh>
                    </ReportThead>
                    <tbody>
                      {mistakes.perTag.map((m) => (
                        <ReportTr key={m.tag}>
                          <ReportTd className="font-medium">{m.label}</ReportTd>
                          <ReportTd align="right">{m.trades}</ReportTd>
                          <ReportTd align="right" className={pnlCls(m.net)}>{inr(m.net, { decimals: 0 })}</ReportTd>
                          <ReportTd align="right" className={pnlCls(m.avgNet)}>{inr(m.avgNet, { decimals: 0 })}</ReportTd>
                        </ReportTr>
                      ))}
                    </tbody>
                  </ReportTable>
                  <p className="px-4 py-3 text-[0.6875rem] text-muted-foreground">
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
              <ReportTable>
                <ReportThead>
                  <ReportTh>Emotion at entry</ReportTh>
                  <ReportTh align="right">Trades</ReportTh>
                  <ReportTh align="right">Win rate</ReportTh>
                  <ReportTh align="right">Net P&L</ReportTh>
                </ReportThead>
                <tbody>
                  {emotions.map((e) => (
                    <ReportTr key={e.tag}>
                      <ReportTd className="font-medium">{e.label}</ReportTd>
                      <ReportTd align="right">{e.trades}</ReportTd>
                      <ReportTd align="right">{e.winRatePct}%</ReportTd>
                      <ReportTd align="right" className={pnlCls(e.net)}>{inr(e.net, { decimals: 0 })}</ReportTd>
                    </ReportTr>
                  ))}
                </tbody>
              </ReportTable>
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
              <EmptyState
                variant="journal"
                title="No closed dated trades yet"
              />
            ) : (
              <ReportTable>
                <ReportThead>
                  <ReportTh>Week</ReportTh>
                  <ReportTh>Starting</ReportTh>
                  <ReportTh align="right">Trades</ReportTh>
                  <ReportTh align="right">Risk cap respected</ReportTh>
                  <ReportTh align="right">Daily stop respected</ReportTh>
                  <ReportTh align="right">SL/target planned</ReportTh>
                  <ReportTh align="right">Score</ReportTh>
                </ReportThead>
                <tbody>
                  {weeks.map((w) => (
                    <ReportTr key={w.week}>
                      <ReportTd className="font-medium">{w.week}</ReportTd>
                      <ReportTd muted>{w.weekStart}</ReportTd>
                      <ReportTd align="right">{w.trades}</ReportTd>
                      <ReportTd align="right">{w.riskCapRespectedPct}%</ReportTd>
                      <ReportTd align="right">{w.dailyStopRespectedPct}%</ReportTd>
                      <ReportTd align="right">{w.planningPct}%</ReportTd>
                      <ReportTd align="right" className={`font-semibold ${scoreColor(w.score)}`}>{w.score}</ReportTd>
                    </ReportTr>
                  ))}
                </tbody>
              </ReportTable>
            )}
          </CardContent>
        </Card>
        <p className="text-[0.6875rem] text-muted-foreground">
          Score = average of three sub-scores: losses kept within the per-trade cap, days kept within the daily stop, and trades with an SL/target recorded. Tag SL/targets in Trades to lift the planning score.
        </p>
      </ProGate>
      </div>
    </>
  );
}
