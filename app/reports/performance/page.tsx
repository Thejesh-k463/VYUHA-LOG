import { PageHeader } from "@/components/layout/page-header";
import { KpiCard } from "@/components/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EquityCurve, UnderwaterCurve } from "@/components/dashboard/charts";
import { monteCarloEquity } from "@/lib/analytics/monte-carlo";
import { getTrades } from "@/lib/queries/trades";
import { getSettings } from "@/lib/queries/settings";
import { getMtmMap } from "@/lib/queries/mtm";
import { getLedgerEntries } from "@/lib/queries/ledger";
import { dailyPnl, equityCurve } from "@/lib/analytics/metrics";
import { computePerformance, timeWeightedReturn, type CashFlowR } from "@/lib/analytics/performance";
import { xirr, type CashFlow } from "@/lib/analytics/xirr";
import { computeBenchmark, type ReturnByDate } from "@/lib/analytics/benchmark";
import { getBenchmarkCloses, getBenchmarkMeta, DEFAULT_BENCHMARK } from "@/lib/queries/benchmark";
import { BenchmarkPanel } from "@/components/reports/benchmark-panel";
import { toPaise, toRupees } from "@/lib/money";
import { inr } from "@/lib/format";

export const dynamic = "force-dynamic";

function daysBetween(a: string, b: string): number {
  return Math.max(0, Math.round((new Date(b + "T00:00:00").getTime() - new Date(a + "T00:00:00").getTime()) / 86400000));
}

const RISK_FREE = 0.07; // India ~7% — used for Sharpe/Sortino
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function cellColor(ret: number | undefined): string {
  if (ret == null) return "transparent";
  if (ret === 0) return "var(--color-card-hover)";
  const intensity = Math.min(1, Math.abs(ret) / 8); // 8% = full intensity
  const a = Math.round((0.15 + intensity * 0.7) * 100);
  return ret > 0
    ? `color-mix(in oklab, var(--color-profit) ${a}%, transparent)`
    : `color-mix(in oklab, var(--color-loss) ${a}%, transparent)`;
}
const sign = (v: number) => (v >= 0 ? "+" : "");
const cls = (v: number | null) => (v == null ? "" : v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground");

export default function PerformancePage() {
  const trades = getTrades();
  const settings = getSettings();
  const capital = (settings?.equityCapital ?? 0) + (settings?.activeCapital ?? 0) || 1700000;

  const daily = [...dailyPnl(trades).entries()].map(([date, net]) => ({ date, net }));
  const p = computePerformance(daily, capital, RISK_FREE);
  const curve = equityCurve(trades);

  // Money-weighted return (XIRR) — derived from the cash ledger (P0.2) + realised/
  // unrealised trading P&L. All in integer paise (P0.1).
  const today = new Date().toISOString().slice(0, 10);
  const goLive = settings?.goLiveDate ?? today;
  const ledger = getLedgerEntries();
  const mtm = getMtmMap();
  const closed = trades.filter((t) => !t.isOpen);
  const open = trades.filter((t) => t.isOpen);
  const realisedPaise = toPaise(closed.reduce((s, t) => s + t.netPnl, 0));
  const unrealisedPaise = toPaise(
    open.reduce((s, t) => {
      const qty = Math.max(t.buyQty - t.sellQty, 0) || t.buyQty;
      const px = mtm.get(t.symbol.toUpperCase()) ?? t.closingPrice ?? t.avgBuyPrice;
      return s + (px - t.avgBuyPrice) * qty;
    }, 0),
  );
  const external = ledger.filter((e) => e.type === "deposit" || e.type === "withdrawal");
  const externalNetPaise = external.reduce((s, e) => s + e.amountPaise, 0);
  const internalLedgerPaise = ledger.filter((e) => e.type !== "deposit" && e.type !== "withdrawal").reduce((s, e) => s + e.amountPaise, 0);
  const openingPaise = toPaise(capital);
  const startDate =
    [goLive, ...closed.map((t) => t.sellDate).filter((d): d is string => !!d), ...ledger.map((e) => e.date)]
      .filter(Boolean)
      .sort()[0] ?? goLive;
  const terminalPaise = openingPaise + externalNetPaise + internalLedgerPaise + realisedPaise + unrealisedPaise;
  const flows: CashFlow[] = [
    { date: startDate, amountPaise: -openingPaise },
    ...external.map((e) => ({ date: e.date, amountPaise: -e.amountPaise })), // deposit(+)→invested(−)
    { date: today, amountPaise: terminalPaise },
  ];
  const xirrRate = xirr(flows);
  const xirrPct = xirrRate == null ? null : Math.round(xirrRate * 1000) / 10;
  const xirrDays = daysBetween(startDate, today);

  // Time-weighted return (TWR) — chains daily P&L returns while neutralising the
  // timing of deposits/withdrawals (the "manager skill" number, vs money-weighted XIRR).
  const twrFlows: CashFlowR[] = external.map((e) => ({ date: e.date, amount: toRupees(e.amountPaise) }));
  const twr = timeWeightedReturn(daily, capital, twrFlows);

  // Benchmark alpha/beta vs the index (P1.1) — regress daily portfolio returns
  // against the pasted index closes. Offline; degrades to a prompt if none loaded.
  const benchCloses = getBenchmarkCloses(DEFAULT_BENCHMARK);
  const benchMeta = getBenchmarkMeta(DEFAULT_BENCHMARK);
  const portfolioReturns: ReturnByDate[] = p.series.map((s) => ({ date: s.date, ret: s.ret }));
  const bench = computeBenchmark(portfolioReturns, benchCloses, RISK_FREE);

  // Underwater curve — the per-day drawdown series already computed by computePerformance.
  const underwater = p.series.map((s) => ({ date: s.date, ddPct: Math.round(s.drawdown * 10000) / 100 }));

  // Monte Carlo — bootstrap the portfolio's own daily returns 2,000× over a 1y horizon.
  // Ruin = the path EVER touching −50% from today's equity. Needs ≥20 trading days.
  const mc = monteCarloEquity(p.series.map((s) => s.ret), p.endEquity);

  // monthly matrix: year -> month -> retPct, + geometric year total
  const years = [...new Set(p.monthly.map((m) => m.year))].sort();
  const byYM = new Map(p.monthly.map((m) => [`${m.year}-${m.month}`, m.retPct]));
  const yearTotal = (y: number) => {
    const g = p.monthly.filter((m) => m.year === y).reduce((acc, m) => acc * (1 + m.retPct / 100), 1);
    return (g - 1) * 100;
  };

  return (
    <>
      <PageHeader
        title="Performance"
        description="Risk-adjusted returns on realised P&L."
        actions={<Badge variant="secondary">vs {Math.round(RISK_FREE * 100)}% risk-free</Badge>}
      />
      <div className="space-y-5 p-6">
        {p.tradingDays === 0 ? (
          <Card><CardContent className="p-6 text-sm text-muted-foreground">No closed trades with dates yet — performance needs a realised P&L history.</CardContent></Card>
        ) : (
          <>
            <section className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
              <KpiCard label="Total return" value={`${sign(p.totalReturnPct)}${p.totalReturnPct}%`} valueClassName={cls(p.totalReturnPct)} sub={`${inr(p.endEquity - p.startEquity, { decimals: 0 })} on ${inr(p.startEquity, { decimals: 0 })}`} />
              <KpiCard label="XIRR (money-weighted)" value={xirrPct == null ? "—" : `${sign(xirrPct)}${xirrPct}%`} valueClassName={cls(xirrPct)} sub={xirrDays >= 30 ? `over ${Math.round(xirrDays / 30)} mo · ledger-derived` : "<30d — unstable"} />
              <KpiCard label="TWR (time-weighted)" value={twr == null ? "—" : `${sign(twr.twrPct)}${twr.twrPct}%`} valueClassName={cls(twr?.twrPct ?? null)} sub={twr == null ? "no history" : twr.annualizedPct == null ? "cumulative · <30d" : `${sign(twr.annualizedPct)}${twr.annualizedPct}% annualised · flow-neutral`} />
              <KpiCard label="CAGR" value={p.cagrPct == null ? "—" : `${sign(p.cagrPct)}${p.cagrPct}%`} valueClassName={cls(p.cagrPct)} sub={p.cagrPct == null ? "<30d window" : "annualised"} />
              <KpiCard label="Sharpe" value={p.sharpe == null ? "—" : p.sharpe.toFixed(2)} valueClassName={cls(p.sharpe)} sub={`Sortino ${p.sortino == null ? "—" : p.sortino.toFixed(2)}`} />
              <KpiCard label="Calmar" value={p.calmar == null ? "—" : p.calmar.toFixed(2)} sub="CAGR ÷ max DD" />
              <KpiCard label="Max drawdown" value={`-${p.maxDrawdownPct}%`} valueClassName="text-loss" sub={inr(p.maxDrawdownAmt, { decimals: 0 })} />
              <KpiCard label="Volatility" value={`${p.volatilityPct}%`} sub="annualised" />
              <KpiCard label="Positive days" value={`${p.positiveDaysPct}%`} sub={`${p.tradingDays} trading days`} />
              <KpiCard label="Best / worst day" value={`${sign(p.bestDayPct)}${p.bestDayPct}% / ${p.worstDayPct}%`} sub={`avg up ${p.avgWinDayPct}% · dn ${p.avgLossDayPct}%`} />
            </section>

            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>Equity curve</CardTitle>
                <Badge variant="secondary">Max DD -{p.maxDrawdownPct}%</Badge>
              </CardHeader>
              <CardContent>{curve.length > 0 ? <EquityCurve data={curve} /> : null}</CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>Underwater curve</CardTitle>
                <Badge variant="secondary">time below the running peak</Badge>
              </CardHeader>
              <CardContent>
                <UnderwaterCurve data={underwater} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>Monte Carlo — 1y forward</CardTitle>
                {mc && <Badge variant="secondary">{mc.paths.toLocaleString("en-IN")} paths · resampling {mc.sampleDays} real days</Badge>}
              </CardHeader>
              <CardContent className="space-y-3">
                {mc ? (
                  <>
                    <section className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
                      <KpiCard label="Risk of ruin" value={`${mc.riskOfRuinPct}%`} valueClassName={mc.riskOfRuinPct > 10 ? "text-loss" : mc.riskOfRuinPct > 2 ? "text-warning" : "text-profit"} sub="ever −50% from today" />
                      <KpiCard label="P(ending down)" value={`${mc.probLossPct}%`} valueClassName={mc.probLossPct > 50 ? "text-loss" : ""} sub="terminal < today's equity" />
                      <KpiCard label="Median outcome" value={inr(mc.terminal.p50, { decimals: 0 })} valueClassName={cls(mc.terminal.p50 - mc.startEquity)} sub={`from ${inr(mc.startEquity, { decimals: 0 })}`} />
                      <KpiCard label="Bad year (p5)" value={inr(mc.terminal.p5, { decimals: 0 })} valueClassName="text-loss" sub="5th percentile" />
                      <KpiCard label="Good year (p95)" value={inr(mc.terminal.p95, { decimals: 0 })} valueClassName="text-profit" sub="95th percentile" />
                    </section>
                    <p className="text-[11px] text-muted-foreground">
                      Bootstrap of your OWN daily returns (no normality assumed): each simulated day replays a random
                      real day, {mc.horizonDays} days forward, {mc.paths.toLocaleString("en-IN")} times. Interquartile
                      range {inr(mc.terminal.p25, { decimals: 0 })} – {inr(mc.terminal.p75, { decimals: 0 })}. Assumes
                      you keep trading exactly like the sampled history — regime changes, position-size changes and
                      luck are not modelled. Informational only.
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">Needs at least 20 trading days of realised history to resample.</p>
                )}
              </CardContent>
            </Card>

            <Card className="p-0">
              <CardHeader><CardTitle>Monthly returns</CardTitle></CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-y border-border text-muted-foreground">
                        <th className="px-2.5 py-2 text-left font-medium">Year</th>
                        {MONTHS.map((m) => <th key={m} className="px-1.5 py-2 text-center font-medium">{m}</th>)}
                        <th className="px-2.5 py-2 text-right font-medium">Year</th>
                      </tr>
                    </thead>
                    <tbody>
                      {years.map((y) => {
                        const yt = yearTotal(y);
                        return (
                          <tr key={y} className="border-b border-border/40">
                            <td className="px-2.5 py-1.5 font-medium">{y}</td>
                            {MONTHS.map((_, i) => {
                              const ret = byYM.get(`${y}-${i + 1}`);
                              return (
                                <td key={i} className="px-1 py-1 text-center tabular-nums" style={{ background: cellColor(ret) }}>
                                  {ret == null ? "" : `${ret > 0 ? "+" : ""}${ret.toFixed(1)}`}
                                </td>
                              );
                            })}
                            <td className={`px-2.5 py-1.5 text-right font-semibold tabular-nums ${cls(yt)}`}>{sign(yt)}{yt.toFixed(1)}%</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>Benchmark — {DEFAULT_BENCHMARK}</CardTitle>
                {bench && (
                  <Badge variant={bench.alphaAnnualPct >= 0 ? "secondary" : "loss"}>
                    {bench.overlapDays} overlapping days
                  </Badge>
                )}
              </CardHeader>
              <CardContent className="space-y-4">
                {bench ? (
                  <section className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
                    <KpiCard label="Alpha (annual)" value={`${sign(bench.alphaAnnualPct)}${bench.alphaAnnualPct}%`} valueClassName={cls(bench.alphaAnnualPct)} sub="excess vs β·market" />
                    <KpiCard label="Beta" value={bench.beta.toFixed(2)} sub={bench.beta > 1 ? "amplified vs index" : bench.beta < 0 ? "inverse to index" : "tracks index"} />
                    <KpiCard label="Correlation" value={bench.correlation.toFixed(2)} sub={`R² ${bench.rSquared.toFixed(2)}`} />
                    <KpiCard label="Portfolio (window)" value={`${sign(bench.portfolioReturnPct)}${bench.portfolioReturnPct}%`} valueClassName={cls(bench.portfolioReturnPct)} sub="over overlap" />
                    <KpiCard label={`${DEFAULT_BENCHMARK} (window)`} value={`${sign(bench.benchmarkReturnPct)}${bench.benchmarkReturnPct}%`} valueClassName={cls(bench.benchmarkReturnPct)} sub="over overlap" />
                  </section>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {benchMeta.count > 0
                      ? `Loaded ${benchMeta.count} ${DEFAULT_BENCHMARK} closes, but fewer than 2 dates overlap with your trading days — load a series that spans your active period.`
                      : `No ${DEFAULT_BENCHMARK} series loaded yet. Paste the index's daily closes below to compute alpha/beta.`}
                  </p>
                )}
                <BenchmarkPanel symbol={DEFAULT_BENCHMARK} meta={benchMeta} />
              </CardContent>
            </Card>

            <p className="text-[11px] text-muted-foreground">
              Time-weighted figures are computed on running equity from the configured starting capital ({inr(capital, { decimals: 0 })}).
              The money-weighted <strong>XIRR</strong> is derived from the cash ledger (deposits/withdrawals) plus realised and
              unrealised trading P&L over {inr(toRupees(terminalPaise), { decimals: 0 })} terminal value — accounting for the
              size and timing of capital. The <strong>TWR</strong> chains daily P&L returns while neutralising the
              timing of deposits/withdrawals — the manager-skill counterpart to XIRR. Sharpe/Sortino use a {Math.round(RISK_FREE * 100)}% annual risk-free rate; ratios annualise with 252 trading days.
            </p>
          </>
        )}
      </div>
    </>
  );
}
