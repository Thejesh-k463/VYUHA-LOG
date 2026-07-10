import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
      {/* Report header */}
      <div className="flex items-start justify-between border-b border-border pb-4">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-profit to-accent font-bold text-background">व</span>
            <h1 className="text-2xl font-bold tracking-tight">Vyuha — Performance Report</h1>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Generated {today} · {closed.length} closed trades over {p.tradingDays} trading days · capital {inr(capital, { decimals: 0 })}
          </p>
        </div>
        <PrintButton />
      </div>

      {p.tradingDays === 0 ? (
        <Card><CardContent className="p-6 text-sm text-muted-foreground">No closed trades with dates yet.</CardContent></Card>
      ) : (
        <>
          {/* Scorecard */}
          <section className="grid grid-cols-3 gap-3 md:grid-cols-4">
            <KpiCard label="Net P&L" value={inr(net, { decimals: 0 })} valueClassName={cls(net)} />
            <KpiCard label="Total return" value={`${sign(p.totalReturnPct)}${p.totalReturnPct}%`} valueClassName={cls(p.totalReturnPct)} />
            <KpiCard label="Win rate" value={`${winRate}%`} sub={`${wins}/${closed.length} trades`} />
            <KpiCard label="Max drawdown" value={`-${p.maxDrawdownPct}%`} valueClassName="text-loss" sub={inr(p.maxDrawdownAmt, { decimals: 0 })} />
            <KpiCard label="Sharpe" value={p.sharpe == null ? "—" : p.sharpe.toFixed(2)} sub={`Sortino ${p.sortino == null ? "—" : p.sortino.toFixed(2)}`} />
            <KpiCard label="CAGR" value={p.cagrPct == null ? "—" : `${sign(p.cagrPct)}${p.cagrPct}%`} valueClassName={cls(p.cagrPct)} />
            <KpiCard label="Charges paid" value={inr(charges, { decimals: 0 })} valueClassName="text-warning" />
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
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-y border-border text-muted-foreground">
                      <th className="px-2.5 py-2 text-left font-medium">Year</th>
                      {MONTHS.map((m) => <th key={m} className="px-1.5 py-2 text-center font-medium">{m}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {years.map((y) => (
                      <tr key={y} className="border-b border-border/40">
                        <td className="px-2.5 py-1.5 font-medium">{y}</td>
                        {MONTHS.map((_, i) => {
                          const ret = byYM.get(`${y}-${i + 1}`);
                          return (
                            <td key={i} className={`px-1 py-1 text-center tabular-nums ${ret == null ? "" : cls(ret)}`}>
                              {ret == null ? "" : `${ret > 0 ? "+" : ""}${ret.toFixed(1)}`}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Behavior snapshot */}
          <div className="grid gap-5 md:grid-cols-2 print:grid-cols-2">
            <Card className="p-0">
              <CardHeader><CardTitle>Top playbooks</CardTitle></CardHeader>
              <CardContent className="p-0">
                <table className="w-full text-xs">
                  <tbody>
                    {pbStats.slice(0, 5).map((s) => (
                      <tr key={s.playbookId ?? "untagged"} className="border-b border-border/40">
                        <td className="px-2.5 py-1.5 font-medium">{s.name}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{s.trades} trades</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{s.winRatePct}%</td>
                        <td className={`px-2.5 py-1.5 text-right tabular-nums font-medium ${cls(s.net)}`}>{inr(s.net, { decimals: 0 })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
            <Card className="p-0">
              <CardHeader><CardTitle>Mistake economics</CardTitle></CardHeader>
              <CardContent className="p-4 text-xs text-muted-foreground">
                {mistakes.mistakeTrades === 0 ? (
                  <p>No mistakes tagged in this period.</p>
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
    </div>
  );
}
