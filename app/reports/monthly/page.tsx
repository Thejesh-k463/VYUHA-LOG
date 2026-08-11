import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { VyuhaMark } from "@/components/brand/mark";
import { KpiCard } from "@/components/kpi-card";
import { EquityCurve } from "@/components/dashboard/charts";
import { PrintButton } from "@/components/reports/print-button";
import { getTrades } from "@/lib/queries/trades";
import { getSettings } from "@/lib/queries/settings";
import { getPlaybooks } from "@/lib/queries/playbooks";
import { dailyPnl, equityCurve } from "@/lib/analytics/metrics";
import { computePerformance } from "@/lib/analytics/performance";
import { playbookStats, mistakeReport } from "@/lib/analytics/behavior";
import { disciplineByWeek } from "@/lib/analytics/discipline";
import { db } from "@/lib/db";
import { riskConfig } from "@/lib/db/schema";
import { inr } from "@/lib/format";
import { ProGate } from "@/components/system/pro-gate";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import Link from "next/link";

export const dynamic = "force-dynamic";

// P2.6 — one-click shareable performance report. Print-optimized: the sidebar
// hides via the layout's print:hidden wrapper; Ctrl+P → "Save as PDF" ships it.

const RISK_FREE = 0.07;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const sign = (v: number) => (v >= 0 ? "+" : "");
const cls = (v: number | null) => (v == null ? "" : v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground");

export default function MonthlyReportPage() {
  const trades = getTrades();
  const settings = getSettings();
  const capital = (settings?.equityCapital ?? 0) + (settings?.activeCapital ?? 0) || 1700000;
  const today = new Date().toISOString().slice(0, 10);

  const daily = [...dailyPnl(trades).entries()].map(([date, net]) => ({ date, net }));
  const p = computePerformance(daily, capital, RISK_FREE);
  const curve = equityCurve(trades);

  const closed = trades.filter((t) => !t.isOpen);
  const wins = closed.filter((t) => t.netPnl > 0).length;
  const winRate = closed.length ? Math.round((wins / closed.length) * 1000) / 10 : 0;
  const net = closed.reduce((s, t) => s + t.netPnl, 0);
  const charges = trades.reduce((s, t) => s + t.chargesTotal, 0);

  const behaviorTrades = trades.map((t) => ({
    id: t.id, isOpen: t.isOpen, netPnl: t.netPnl, rMultiple: t.rMultiple,
    playbookId: t.playbookId, emotionTag: t.emotionTag, mistakeTags: t.mistakeTags,
  }));
  const pbStats = playbookStats(behaviorTrades, getPlaybooks().map((pb) => ({ id: pb.id, name: pb.name })));
  const mistakes = mistakeReport(behaviorTrades);

  const risk = db.select().from(riskConfig).all();
  const cap = risk.find((r) => r.scope === "global")?.perTradeMaxLoss ?? 9500;
  const stop = risk.find((r) => r.scope === "bucket" && r.key === "active")?.dailyLossStop ?? 25000;
  const weeks = disciplineByWeek(trades, cap, stop);
  const disciplineAvg = weeks.length ? Math.round((weeks.reduce((s, w) => s + w.score, 0) / weeks.length) * 10) / 10 : null;

  const years = [...new Set(p.monthly.map((m) => m.year))].sort();
  const byYM = new Map(p.monthly.map((m) => [`${m.year}-${m.month}`, m.retPct]));

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6 print:max-w-none print:p-2">
        <ProGate>
      {/* Report header */}
      <div className="flex items-start justify-between border-b border-border pb-4">
        <div>
          <div className="flex items-center gap-2.5">
            <VyuhaMark size={32} />
            <h1 className="text-2xl font-bold tracking-tight">Vyuha — Performance Report</h1>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Generated {today} · {closed.length} closed trades over {p.tradingDays} trading days · capital {inr(capital, { decimals: 0 })}
          </p>
        </div>
        <PrintButton />
      </div>

      {p.tradingDays === 0 ? (
        <EmptyState
          variant="chart"
          title="No closed trades with dates yet"
          action={<Button asChild size="sm"><Link href="/import">Import a broker file</Link></Button>}
        />
      ) : (
        <>
          {/* Scorecard */}
          <section className="grid grid-cols-3 gap-3 md:grid-cols-4">
            <KpiCard label="Net P&L" valueNum={net} format="inr0" valueClassName={cls(net)} />
            <KpiCard label="Total return" value={`${sign(p.totalReturnPct)}${p.totalReturnPct}%`} valueClassName={cls(p.totalReturnPct)} />
            <KpiCard label="Win rate" value={`${winRate}%`} sub={`${wins}/${closed.length} trades`} />
            <KpiCard label="Max drawdown" value={`-${p.maxDrawdownPct}%`} valueClassName="text-loss" sub={inr(p.maxDrawdownAmt, { decimals: 0 })} />
            <KpiCard label="Sharpe" value={p.sharpe == null ? "—" : p.sharpe.toFixed(2)} sub={`Sortino ${p.sortino == null ? "—" : p.sortino.toFixed(2)}`} />
            <KpiCard label="CAGR" value={p.cagrPct == null ? "—" : `${sign(p.cagrPct)}${p.cagrPct}%`} valueClassName={cls(p.cagrPct)} />
            <KpiCard label="Charges paid" valueNum={charges} format="inr0" valueClassName="text-grad-gold" />
            <KpiCard label="Discipline score" value={disciplineAvg == null ? "—" : `${disciplineAvg}`} sub="weekly average" />
          </section>

          {/* Equity curve */}
          <Card>
            <CardHeader><CardTitle>Equity curve</CardTitle></CardHeader>
            <CardContent>{curve.length > 0 ? <EquityCurve data={curve} /> : null}</CardContent>
          </Card>

          {/* Monthly returns */}
          <Card className="p-0">
            <CardHeader><CardTitle>Monthly returns</CardTitle></CardHeader>
            <CardContent className="p-0">
              <ReportTable>
                <ReportThead>
                  <ReportTh>Year</ReportTh>
                  {MONTHS.map((m) => <ReportTh key={m} className="px-1.5 text-center">{m}</ReportTh>)}
                </ReportThead>
                <tbody>
                  {years.map((y) => (
                    <ReportTr key={y}>
                      <ReportTd className="font-medium">{y}</ReportTd>
                      {MONTHS.map((_, i) => {
                        const ret = byYM.get(`${y}-${i + 1}`);
                        return (
                          <ReportTd key={i} className={`px-1 py-1 text-center tabular-nums ${ret == null ? "" : cls(ret)}`}>
                            {ret == null ? "" : `${ret > 0 ? "+" : ""}${ret.toFixed(1)}`}
                          </ReportTd>
                        );
                      })}
                    </ReportTr>
                  ))}
                </tbody>
              </ReportTable>
            </CardContent>
          </Card>

          {/* Behavior snapshot */}
          <div className="grid gap-5 md:grid-cols-2 print:grid-cols-2">
            <Card className="p-0">
              <CardHeader><CardTitle>Top playbooks</CardTitle></CardHeader>
              <CardContent className="p-0">
                <ReportTable>
                  <tbody>
                    {pbStats.slice(0, 5).map((s) => (
                      <ReportTr key={s.playbookId ?? "untagged"}>
                        <ReportTd className="font-medium">{s.name}</ReportTd>
                        <ReportTd align="right">{s.trades} trades</ReportTd>
                        <ReportTd align="right">{s.winRatePct}%</ReportTd>
                        <ReportTd align="right" className={`font-medium ${cls(s.net)}`}>{inr(s.net, { decimals: 0 })}</ReportTd>
                      </ReportTr>
                    ))}
                  </tbody>
                </ReportTable>
              </CardContent>
            </Card>
            <Card className="p-0">
              <CardHeader><CardTitle>Mistake economics</CardTitle></CardHeader>
              <CardContent className={mistakes.mistakeTrades === 0 ? "p-4" : "p-4 text-xs text-muted-foreground"}>
                {mistakes.mistakeTrades === 0 ? (
                  <EmptyState variant="journal" title="No mistakes tagged in this period" />
                ) : (
                  <p>
                    <span className={`font-semibold ${cls(mistakes.mistakeNet)}`}>{inr(mistakes.mistakeNet, { decimals: 0 })}</span>{" "}
                    across {mistakes.mistakeTrades} mistake-tagged trades. Clean trades averaged{" "}
                    <span className={cls(mistakes.cleanExpectancy)}>{inr(mistakes.cleanExpectancy, { decimals: 0 })}</span>/trade vs{" "}
                    <span className={cls(mistakes.mistakeExpectancy)}>{inr(mistakes.mistakeExpectancy, { decimals: 0 })}</span> when rules broke —
                    a gap of <span className="font-semibold text-foreground">{inr(mistakes.expectancyGap, { decimals: 0 })}</span> per trade.
                    {mistakes.perTag[0] && <> Worst habit: <span className="font-medium text-foreground">{mistakes.perTag[0].label}</span> ({inr(mistakes.perTag[0].net, { decimals: 0 })}).</>}
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          <p className="border-t border-border pt-3 text-[10px] text-muted-foreground">
            Generated by Vyuha — local-first trade journal for Indian markets. Time-weighted figures computed on
            running equity from configured capital; Sharpe/Sortino vs {Math.round(RISK_FREE * 100)}% risk-free,
            annualised over 252 trading days. Informational only — not investment advice.
          </p>
        </>
      )}
    </ProGate>
      </div>
  );
}
