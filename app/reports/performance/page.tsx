import { todayIstIso } from "@/lib/domain/trading-day";
import { PageHeader } from "@/components/layout/page-header";
import { KpiCard } from "@/components/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EquityCurve, UnderwaterCurve } from "@/components/dashboard/charts";
import { monteCarloEquity } from "@/lib/analytics/monte-carlo";
import { getPerformanceTrades } from "@/lib/queries/trades";
import { getSettings } from "@/lib/queries/settings";
import { getMtmMap } from "@/lib/queries/mtm";
import { getExternalCashFlows, getLedgerAggregates } from "@/lib/queries/ledger";
import { getBucketCapital } from "@/lib/queries/capital";
import { getGoalView, getAggregateGoalProgress } from "@/lib/queries/goals";
import { goalProgress, type GoalBucket } from "@/lib/analytics/goal";
import { dailyPnl, equityCurve, computeKpis } from "@/lib/analytics/metrics";
import { ShareCard } from "@/components/reports/share-card";
import type { ShareStats } from "@/lib/analytics/share-card";
import { computePerformance, timeWeightedReturn, type CashFlowR } from "@/lib/analytics/performance";
import { xirr, type CashFlow } from "@/lib/analytics/xirr";
import { computeBenchmark, type ReturnByDate } from "@/lib/analytics/benchmark";
import { getBenchmarkCloses, getBenchmarkMeta, DEFAULT_BENCHMARK } from "@/lib/queries/benchmark";
import { BenchmarkPanel } from "@/components/reports/benchmark-panel";
import { toPaise, toRupees } from "@/lib/money";
import { inr } from "@/lib/format";
import { metricDetail, metricGlossary } from "@/lib/domain/metric-help";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import Link from "next/link";

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
  // Column-trimmed book (same rows, same order as getTrades — see the
  // projection notes in lib/queries/trades.ts, perf sweep 2026-08-29).
  const trades = getPerformanceTrades();
  const settings = getSettings();
  // Never fabricate a denominator (AGENTS.md #6). This used to fall back to an
  // invented ₹17,00,000 when no capital was configured — which is every fresh
  // install — so every ratio below was silently a return on fiction. With no
  // capital, %-of-equity figures render "—" and the rupee figures (which need
  // no base: ₹ drawdown, day win %, best/worst day ₹) stay exact.
  //
  // ACCOUNT-FIRST (v3.6): this page read the GLOBAL settings capital while the
  // trades above are scoped to the selected account — a second account's view
  // computed its returns on the first account's capital. getBucketCapital owns
  // the `account ?? settings ?? 0` chain (same resolution as getCapitalSummary).
  const capital = getBucketCapital().totalCapital;
  const capitalKnown = capital > 0;
  const setCapitalNudge = "set capital in Settings";

  // Metric education (W1) — every KpiCard opens a registry-backed explainer.
  // The risk-free rate is interpolated from the page constant so the number is
  // stated ONCE; the explainers attach in BOTH capital states, and on a "—"
  // card the note says why it is "—" instead of pretending nothing happened.
  const rfVars = { riskFreePct: `${Math.round(RISK_FREE * 100)}%` };
  const noCapitalNote = capitalKnown
    ? undefined
    : 'This card shows "—" because no starting capital is configured — the figure would otherwise divide by an invented base. Set it under Settings → Capital & Go-Live.';

  const daily = [...dailyPnl(trades).entries()].map(([date, net]) => ({ date, net }));
  // With capital 0 computePerformance falls back to a ₹1 base internally: the
  // series shape and the ₹ drawdown (a peak-to-trough DIFFERENCE, so the base
  // cancels) stay right, while every %-figure is garbage — which is exactly
  // why each one is gated on capitalKnown below.
  const p = computePerformance(daily, capital, RISK_FREE);
  const curve = equityCurve(trades);

  /**
   * How much of the book these time-series metrics can actually see.
   *
   * `dailyPnl` buckets on the exit date, so a closed trade with no date lands
   * on no day and is invisible to total return, CAGR, Sharpe, Sortino and max
   * drawdown alike. An aggregated broker P&L statement (Dhan's, notably)
   * carries no per-trade dates at all — the range lives only in the file
   * header — so a book built from one can be largely absent here while the
   * headline Net P&L on the dashboard counts every rupee.
   *
   * Two numbers that disagree by lakhs, with no explanation, is the exact
   * failure this journal exists to avoid. So the gap is stated, not hidden.
   */
  const closedTrades = trades.filter((t) => !t.isOpen);
  const undated = closedTrades.filter((t) => !t.sellDate);
  const undatedPnl = undated.reduce((s, t) => s + t.netPnl, 0);
  const datedPnl = closedTrades.reduce((s, t) => s + t.netPnl, 0) - undatedPnl;

  // T1.4 — stats for the shareable card (same KPI engine as the dashboard).
  const k = computeKpis(trades);
  const closedNets = trades.filter((t) => !t.isOpen).map((t) => t.netPnl);
  const shareStats: ShareStats = {
    netPnl: k.netPnl,
    winRatePct: k.winRate * 100,
    profitFactor: k.profitFactor,
    avgR: k.avgR,
    trades: k.closedCount,
    expectancy: k.expectancy,
    maxDrawdown: p.maxDrawdownAmt,
    charges: k.charges,
    bestTrade: closedNets.length ? Math.max(...closedNets) : 0,
    worstTrade: closedNets.length ? Math.min(...closedNets) : 0,
  };

  // Money-weighted return (XIRR) — derived from the cash ledger (P0.2) + realised/
  // unrealised trading P&L. All in integer paise (P0.1).
  const today = todayIstIso();

  // ── Expected-capital goals (v3.6) ─────────────────────────────────────────
  // One small read; the maths runs on the trade projection already loaded.
  // No goal set → nothing renders (the empty-state rule).
  const goalView = getGoalView();
  const bucketLabel = (b: GoalBucket) => (b === "active" ? "Trade F&O" : b === "equity" ? "Equity" : "Total");
  const bc = getBucketCapital();
  // All-accounts view: progress is the SUM of each account's own frozen-
  // baseline walk over its own realised days (getAggregateGoalProgress) —
  // never a blended series walked from the earliest baseline, which counted
  // pre-baseline profit twice and let goal-less accounts feed the numerator.
  const aggProgress = goalView.aggregate ? getAggregateGoalProgress(today) : null;
  const goalCards = goalView.goals.map((g) => {
    if (aggProgress) {
      // No blended fallback in the aggregate view — an absent bucket renders
      // notMeasurable ("—") rather than an overstated walk.
      const p = aggProgress.get(g.bucket) ?? goalProgress(g, { currentCapital: null, realised: [], today });
      return { goal: g, progress: p };
    }
    const rel = g.bucket === "total" ? trades : trades.filter((t) => t.bucket === g.bucket);
    const realised = [...dailyPnl(rel).entries()].map(([date, net]) => ({ date, net }));
    const cap = g.bucket === "equity" ? bc.equityCapital : g.bucket === "active" ? bc.activeCapital : bc.totalCapital;
    return { goal: g, progress: goalProgress(g, { currentCapital: cap > 0 ? cap : null, realised, today }) };
  });
  const goLive = settings?.goLiveDate ?? today;
  // The 60k-row ledger never crosses into JS: the external flows come back as
  // rows (XIRR/TWR need each one), and the internal net + earliest date are
  // SQL aggregates over integer paise / ISO-date text — bit-identical to the
  // old whole-ledger reduce (perf sweep 2026-08-29).
  const external = getExternalCashFlows();
  const { internalNetPaise: internalLedgerPaise, minDate: ledgerMinDate } = getLedgerAggregates();
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
  const externalNetPaise = external.reduce((s, e) => s + e.amountPaise, 0);
  const openingPaise = toPaise(capital);
  const startDate =
    [goLive, ...closed.map((t) => t.sellDate).filter((d): d is string => !!d), ...(ledgerMinDate ? [ledgerMinDate] : [])]
      .filter(Boolean)
      .sort()[0] ?? goLive;
  const terminalPaise = openingPaise + externalNetPaise + internalLedgerPaise + realisedPaise + unrealisedPaise;
  const flows: CashFlow[] = [
    { date: startDate, amountPaise: -openingPaise },
    ...external.map((e) => ({ date: e.date, amountPaise: -e.amountPaise })), // deposit(+)→invested(−)
    { date: today, amountPaise: terminalPaise },
  ];
  // XIRR seeds its flow list with the opening capital: without one the rate is
  // a return on a fabricated base, so it is withheld, not approximated.
  const xirrRate = capitalKnown ? xirr(flows) : null;
  const xirrPct = xirrRate == null ? null : Math.round(xirrRate * 1000) / 10;
  const xirrDays = daysBetween(startDate, today);

  // Time-weighted return (TWR) — chains daily P&L returns while neutralising the
  // timing of deposits/withdrawals (the "manager skill" number, vs money-weighted XIRR).
  const twrFlows: CashFlowR[] = external.map((e) => ({ date: e.date, amount: toRupees(e.amountPaise) }));
  const twr = capitalKnown ? timeWeightedReturn(daily, capital, twrFlows) : null;

  // Benchmark alpha/beta vs the index (P1.1) — regress daily portfolio returns
  // against the pasted index closes. Offline; degrades to a prompt if none loaded.
  const benchCloses = getBenchmarkCloses(DEFAULT_BENCHMARK);
  const benchMeta = getBenchmarkMeta(DEFAULT_BENCHMARK);
  const portfolioReturns: ReturnByDate[] = p.series.map((s) => ({ date: s.date, ret: s.ret }));
  // Alpha/beta regress DAILY RETURNS, which are P&L over equity — unusable on
  // the ₹1 fallback base.
  const bench = capitalKnown ? computeBenchmark(portfolioReturns, benchCloses, RISK_FREE) : null;

  // Underwater curve — the per-day drawdown series already computed by computePerformance.
  const underwater = p.series.map((s) => ({ date: s.date, ddPct: Math.round(s.drawdown * 10000) / 100 }));

  // Monte Carlo — bootstrap the portfolio's own daily returns 2,000× over a 1y horizon.
  // Ruin = the path EVER touching −50% from today's equity. Needs ≥20 trading days,
  // and a real equity base — resampling returns on the ₹1 fallback simulates nothing.
  const mc = capitalKnown ? monteCarloEquity(p.series.map((s) => s.ret), p.endEquity) : null;

  // Day stats that survive without a capital base: signs and extremes of the
  // daily nets themselves, no equity denominator involved.
  const dayNets = daily.map((d) => d.net);
  const upDayPct = dayNets.length ? Math.round((dayNets.filter((n) => n > 0).length / dayNets.length) * 10000) / 100 : 0;
  const bestDayNet = dayNets.length ? Math.max(...dayNets) : 0;
  const worstDayNet = dayNets.length ? Math.min(...dayNets) : 0;

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
          <EmptyState
            variant="chart"
            title="No closed trades with dates yet"
            hint="Performance needs a realised P&L history."
            action={<Button asChild size="sm"><Link href="/import">Import a broker file</Link></Button>}
          />
        ) : (
          <>
            {/* Coverage, stated before the numbers rather than after. Every
                metric below is a TIME SERIES, so it can only see trades that
                carry a date — and the dashboard's Net P&L counts trades that
                do not. Naming the gap is the difference between an honest
                partial answer and a wrong one. */}
            {undated.length > 0 && (
              <Card className="border-warning/40">
                <CardContent className="space-y-1.5 p-4 text-sm">
                  <div className="font-medium text-warning">
                    These metrics cover {closedTrades.length - undated.length} of your {closedTrades.length} closed trades.
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {undated.length} closed trades carry <b>no exit date</b>, so they belong to no day
                    and cannot appear in a return series. Every figure on this page — total return,
                    CAGR, Sharpe, Sortino, drawdown — is computed on{" "}
                    <b className={cls(datedPnl)}>{inr(datedPnl, { decimals: 0 })}</b> of realised P&amp;L,
                    while <b className={cls(undatedPnl)}>{inr(undatedPnl, { decimals: 0 })}</b> sits outside it.
                    The dashboard&apos;s Net P&amp;L counts both, which is why the two will not agree.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Aggregated broker P&amp;L statements are the usual cause — Dhan&apos;s puts the
                    date range in the file header only, never on the rows. A{" "}
                    <b>tradebook / transaction import</b> carries per-trade dates and closes the gap.
                  </p>
                </CardContent>
              </Card>
            )}
            {/* Same rule as the coverage card above, for the denominator: no
                configured capital means no %-of-equity figure. "—" plus a
                nudge beats a confident return on an invented ₹17 lakh. */}
            {!capitalKnown && (
              <Card className="border-warning/40">
                <CardContent className="space-y-1.5 p-4 text-sm">
                  <div className="font-medium text-warning">No starting capital is configured.</div>
                  <p className="text-xs text-muted-foreground">
                    Total return, XIRR, TWR, CAGR, Sharpe, Sortino, volatility, Calmar, Monte Carlo and
                    benchmark alpha all divide by your capital base, so they show &quot;—&quot; rather than a
                    number computed on an invented one. Set it under{" "}
                    <Link href="/settings" className="underline">Settings → Capital &amp; Go-Live</Link> to unlock them.
                    Rupee figures (₹ drawdown, best/worst day ₹, day win rate) need no base and are exact.
                  </p>
                </CardContent>
              </Card>
            )}
            <section className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
              <KpiCard label="Total return" value={capitalKnown ? `${sign(p.totalReturnPct)}${p.totalReturnPct}%` : "—"} valueClassName={capitalKnown ? cls(p.totalReturnPct) : ""} sub={capitalKnown ? `${inr(p.endEquity - p.startEquity, { decimals: 0 })} on ${inr(p.startEquity, { decimals: 0 })}${undated.length > 0 ? " · dated only" : ""}` : setCapitalNudge} detail={metricDetail("totalReturn", { note: noCapitalNote })} />
              <KpiCard label="XIRR (money-weighted)" value={xirrPct == null ? "—" : `${sign(xirrPct)}${xirrPct}%`} valueClassName={cls(xirrPct)} sub={!capitalKnown ? setCapitalNudge : xirrDays >= 30 ? `over ${Math.round(xirrDays / 30)} mo · ledger-derived` : "<30d — unstable"} detail={metricDetail("xirr", { note: noCapitalNote })} />
              <KpiCard label="TWR (time-weighted)" value={twr == null ? "—" : `${sign(twr.twrPct)}${twr.twrPct}%`} valueClassName={cls(twr?.twrPct ?? null)} sub={twr == null ? (capitalKnown ? "no history" : setCapitalNudge) : twr.annualizedPct == null ? "cumulative · <30d" : `${sign(twr.annualizedPct)}${twr.annualizedPct}% annualised · flow-neutral`} detail={metricDetail("twr", { note: noCapitalNote })} />
              <KpiCard label="CAGR" value={!capitalKnown || p.cagrPct == null ? "—" : `${sign(p.cagrPct)}${p.cagrPct}%`} valueClassName={capitalKnown ? cls(p.cagrPct) : ""} sub={!capitalKnown ? setCapitalNudge : p.cagrPct == null ? "<30d window" : "annualised"} detail={metricDetail("cagr", { note: noCapitalNote })} />
              <KpiCard label="Sharpe" value={!capitalKnown || p.sharpe == null ? "—" : p.sharpe.toFixed(2)} valueClassName={capitalKnown ? cls(p.sharpe) : ""} sub={!capitalKnown ? setCapitalNudge : `Sortino ${p.sortino == null ? "—" : p.sortino.toFixed(2)}`} detail={metricDetail("sharpe", { vars: rfVars, also: ["sortino"], note: noCapitalNote })} />
              <KpiCard label="Calmar" value={!capitalKnown || p.calmar == null ? "—" : p.calmar.toFixed(2)} sub={capitalKnown ? "CAGR ÷ max DD" : setCapitalNudge} detail={metricDetail("calmar", { note: noCapitalNote })} />
              <KpiCard label="Max drawdown" value={capitalKnown ? `-${p.maxDrawdownPct}%` : inr(p.maxDrawdownAmt > 0 ? -p.maxDrawdownAmt : 0, { decimals: 0 })} valueClassName="text-loss" sub={capitalKnown ? inr(p.maxDrawdownAmt, { decimals: 0 }) : `₹ from peak · ${setCapitalNudge} for %`} detail={metricDetail("maxDrawdown", { note: capitalKnown ? undefined : "Without configured capital the % of equity cannot be computed, so this card shows the ₹ fall from peak — a peak-to-trough difference that needs no base and is exact." })} />
              <KpiCard label="Volatility" value={capitalKnown ? `${p.volatilityPct}%` : "—"} sub={capitalKnown ? "annualised" : setCapitalNudge} detail={metricDetail("volatility", { note: noCapitalNote })} />
              <KpiCard label="Positive days" value={`${capitalKnown ? p.positiveDaysPct : upDayPct}%`} sub={`${p.tradingDays} trading days`} detail={metricDetail("positiveDays")} />
              <KpiCard label="Best / worst day" value={capitalKnown ? `${sign(p.bestDayPct)}${p.bestDayPct}% / ${p.worstDayPct}%` : `${inr(bestDayNet, { decimals: 0 })} / ${inr(worstDayNet, { decimals: 0 })}`} sub={capitalKnown ? `avg up ${p.avgWinDayPct}% · dn ${p.avgLossDayPct}%` : `₹ · ${setCapitalNudge} for %`} detail={metricDetail("bestWorstDay", { note: capitalKnown ? undefined : "Without configured capital the % form is withheld; the ₹ extremes shown need no base and are exact." })} />
            </section>

            {/* Expected-capital goals (v3.6). Rendered only when a goal
                exists; a %-goal without a measurable base shows "—" plus ONE
                Settings nudge (invariant 6), never a confident 0. */}
            {goalCards.map(({ goal, progress: gp }) => (
              <Card key={goal.bucket}>
                <CardHeader className="flex-row items-center justify-between">
                  <CardTitle>Expected capital — {bucketLabel(goal.bucket)}</CardTitle>
                  <Badge variant={gp.status === "achieved" ? "secondary" : gp.status === "pastDue" ? "warning" : "secondary"}>
                    {goal.kind === "absolute" ? `target ${inr(goal.targetAmount ?? 0, { decimals: 0 })}` : `target +${goal.pctTarget}% profit`}
                    {goal.targetDate ? ` · by ${goal.targetDate}` : ""}
                  </Badge>
                </CardHeader>
                <CardContent className="space-y-3">
                  {!gp.measurable ? (
                    <p className="text-sm text-muted-foreground">
                      This goal isn&apos;t measurable yet — {gp.reason === "baseline-unknown" || gp.reason === "capital-unknown"
                        ? <>a %-of-capital walk needs a known base, so the figures show &quot;—&quot; instead of a number computed on an invented one; {setCapitalNudge}</>
                        : <>it carries no target of its own kind; edit it under Settings → Expected capital goals</>}.
                    </p>
                  ) : (
                    <>
                      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                        <KpiCard
                          label="Goal progress"
                          value={gp.progressPct == null ? "—" : `${gp.progressPct}%`}
                          valueClassName={gp.status === "achieved" ? "text-profit" : ""}
                          sub={`${inr(gp.achieved ?? 0, { decimals: 0 })} of ${inr(gp.targetLevel ?? 0, { decimals: 0 })}`}
                          detail={metricDetail("goalProgress")}
                        />
                        <KpiCard
                          label="Goal gap"
                          value={gp.gapAmount != null && gp.gapAmount <= 0 ? "met" : inr(gp.gapAmount ?? 0, { decimals: 0 })}
                          valueClassName={gp.gapAmount != null && gp.gapAmount <= 0 ? "text-profit" : ""}
                          sub={goal.baselineCapital != null ? `baseline ${inr(goal.baselineCapital, { decimals: 0 })} · ${goal.baselineDate}` : "no frozen baseline"}
                          detail={metricDetail("goalGap")}
                        />
                        <KpiCard
                          label="Run-rate (30d)"
                          value={gp.runRate30 == null ? "—" : `${inr(gp.runRate30, { decimals: 0 })}/wk`}
                          valueClassName={cls(gp.runRate30)}
                          sub={gp.runRate90 == null ? "no realised history" : `90d ${inr(gp.runRate90, { decimals: 0 })}/wk`}
                          detail={metricDetail("goalRunRate")}
                        />
                        <KpiCard
                          label="Required pace"
                          value={gp.requiredPerWeek == null ? "—" : `${inr(gp.requiredPerWeek, { decimals: 0 })}/wk`}
                          sub={
                            goal.targetDate == null
                              ? "no target date set"
                              : gp.status === "achieved"
                                ? "goal met"
                                : gp.daysLeft != null && gp.daysLeft < 0
                                  ? `target date passed ${-gp.daysLeft}d ago`
                                  : `${gp.daysLeft}d left`
                          }
                          detail={metricDetail("goalRequiredPace")}
                        />
                      </section>
                      {/* The run-rate line, phrased descriptively — arithmetic, not advice. */}
                      {gp.runRate30 != null && (
                        <p className="text-[0.6875rem] text-muted-foreground">
                          Over the trailing 30 days this bucket realised {inr(gp.runRate30, { decimals: 0 })}/week
                          ({inr(gp.runRate90 ?? 0, { decimals: 0 })}/week over 90)
                          {gp.requiredPerWeek != null
                            ? <>; the remaining {inr(gp.gapAmount ?? 0, { decimals: 0 })} works out to {inr(gp.requiredPerWeek, { decimals: 0 })}/week between now and {goal.targetDate}</>
                            : gp.gapAmount != null && gp.gapAmount > 0
                              ? <>; at that 30-day pace the remaining {inr(gp.gapAmount, { decimals: 0 })} spans roughly {gp.runRate30 > 0 ? `${Math.ceil(gp.gapAmount / gp.runRate30)} weeks` : "— the pace is flat or negative"}</>
                              : null}
                          . Realised, dated trades only.
                        </p>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            ))}

            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>Equity curve</CardTitle>
                <Badge variant="secondary">{capitalKnown ? `Max DD -${p.maxDrawdownPct}%` : `Max DD ${inr(p.maxDrawdownAmt > 0 ? -p.maxDrawdownAmt : 0, { decimals: 0 })}`}</Badge>
              </CardHeader>
              <CardContent>{curve.length > 0 ? <EquityCurve data={curve} /> : null}</CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>Underwater curve</CardTitle>
                <Badge variant="secondary">time below the running peak</Badge>
              </CardHeader>
              <CardContent>
                {capitalKnown ? (
                  <UnderwaterCurve data={underwater} />
                ) : (
                  <p className="text-sm text-muted-foreground">Drawdown as a % of equity needs a capital base — {setCapitalNudge}.</p>
                )}
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
                    <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
                      <KpiCard label="Risk of ruin" value={`${mc.riskOfRuinPct}%`} valueClassName={mc.riskOfRuinPct > 10 ? "text-loss" : mc.riskOfRuinPct > 2 ? "text-warning" : "text-profit"} sub="ever −50% from today" detail={metricDetail("riskOfRuin")} />
                      <KpiCard label="P(ending down)" value={`${mc.probLossPct}%`} valueClassName={mc.probLossPct > 50 ? "text-loss" : ""} sub="terminal < today's equity" detail={metricDetail("probEndingDown")} />
                      <KpiCard label="Median outcome" valueNum={mc.terminal.p50} format="inr0" valueClassName={cls(mc.terminal.p50 - mc.startEquity)} sub={`from ${inr(mc.startEquity, { decimals: 0 })}`} detail={metricDetail("mcOutcomes", { note: "This card: the median (p50) — half the simulated paths ended above it, half below." })} />
                      <KpiCard label="Bad year (p5)" valueNum={mc.terminal.p5} format="inr0" valueClassName="text-loss" sub="5th percentile" detail={metricDetail("mcOutcomes", { note: "This card: the 5th percentile — 95% of simulated paths ended above this figure." })} />
                      <KpiCard label="Good year (p95)" valueNum={mc.terminal.p95} format="inr0" valueClassName="text-profit" sub="95th percentile" detail={metricDetail("mcOutcomes", { note: "This card: the 95th percentile — only 5% of simulated paths ended above this figure." })} />
                    </section>
                    <p className="text-[0.6875rem] text-muted-foreground">
                      Bootstrap of your OWN daily returns (no normality assumed): each simulated day replays a random
                      real day, {mc.horizonDays} days forward, {mc.paths.toLocaleString("en-IN")} times. Interquartile
                      range {inr(mc.terminal.p25, { decimals: 0 })} – {inr(mc.terminal.p75, { decimals: 0 })}. Assumes
                      you keep trading exactly like the sampled history — regime changes, position-size changes and
                      luck are not modelled. Informational only.
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {capitalKnown
                      ? "Needs at least 20 trading days of realised history to resample."
                      : `Resampling % returns needs a real equity base — ${setCapitalNudge}.`}
                  </p>
                )}
              </CardContent>
            </Card>

            <Card className="p-0">
              <CardHeader><CardTitle>Monthly returns</CardTitle></CardHeader>
              <CardContent className="p-0">
                {!capitalKnown ? (
                  <p className="p-4 text-sm text-muted-foreground">Monthly % returns need a capital base — {setCapitalNudge}.</p>
                ) : (
                <ReportTable>
                  <ReportThead>
                    <ReportTh>Year</ReportTh>
                    {MONTHS.map((m) => <ReportTh key={m} className="px-1.5 text-center">{m}</ReportTh>)}
                    <ReportTh align="right">Year</ReportTh>
                  </ReportThead>
                  <tbody>
                    {years.map((y) => {
                      const yt = yearTotal(y);
                      return (
                        <ReportTr key={y}>
                          <ReportTd className="font-medium">{y}</ReportTd>
                          {MONTHS.map((_, i) => {
                            const ret = byYM.get(`${y}-${i + 1}`);
                            return (
                              <ReportTd key={i} className="px-1 py-1 text-center tabular-nums" style={{ background: cellColor(ret) }}>
                                {ret == null ? "" : `${ret > 0 ? "+" : ""}${ret.toFixed(1)}`}
                              </ReportTd>
                            );
                          })}
                          <ReportTd align="right" className={`font-semibold ${cls(yt)}`}>{sign(yt)}{yt.toFixed(1)}%</ReportTd>
                        </ReportTr>
                      );
                    })}
                  </tbody>
                </ReportTable>
                )}
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
                  <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
                    <KpiCard label="Alpha (annual)" value={`${sign(bench.alphaAnnualPct)}${bench.alphaAnnualPct}%`} valueClassName={cls(bench.alphaAnnualPct)} sub="excess vs β·market" detail={metricDetail("alpha", { vars: rfVars })} />
                    <KpiCard label="Beta" value={bench.beta.toFixed(2)} sub={bench.beta > 1 ? "amplified vs index" : bench.beta < 0 ? "inverse to index" : "tracks index"} detail={metricDetail("beta")} />
                    <KpiCard label="Correlation" value={bench.correlation.toFixed(2)} sub={`R² ${bench.rSquared.toFixed(2)}`} detail={metricDetail("correlation")} />
                    <KpiCard label="Portfolio (window)" value={`${sign(bench.portfolioReturnPct)}${bench.portfolioReturnPct}%`} valueClassName={cls(bench.portfolioReturnPct)} sub="over overlap" detail={metricDetail("benchmarkWindow", { note: "This card: your book's chained return over the overlapping days." })} />
                    <KpiCard label={`${DEFAULT_BENCHMARK} (window)`} value={`${sign(bench.benchmarkReturnPct)}${bench.benchmarkReturnPct}%`} valueClassName={cls(bench.benchmarkReturnPct)} sub="over overlap" detail={metricDetail("benchmarkWindow", { note: `This card: ${DEFAULT_BENCHMARK}'s chained return over the same overlapping days.` })} />
                  </section>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {!capitalKnown
                      ? `Alpha/beta regress your daily % returns, which need a capital base — ${setCapitalNudge}.`
                      : benchMeta.count > 0
                        ? `Loaded ${benchMeta.count} ${DEFAULT_BENCHMARK} closes, but fewer than 2 dates overlap with your trading days — load a series that spans your active period.`
                        : `No ${DEFAULT_BENCHMARK} series loaded yet. Paste the index's daily closes below to compute alpha/beta.`}
                  </p>
                )}
                <BenchmarkPanel symbol={DEFAULT_BENCHMARK} meta={benchMeta} />
              </CardContent>
            </Card>

            {capitalKnown ? (
              <p className="text-[0.6875rem] text-muted-foreground">
                Time-weighted figures are computed on running equity from the configured starting capital ({inr(capital, { decimals: 0 })}).
                The money-weighted <strong>XIRR</strong> is derived from the cash ledger (deposits/withdrawals) plus realised and
                unrealised trading P&L over {inr(toRupees(terminalPaise), { decimals: 0 })} terminal value — accounting for the
                size and timing of capital. The <strong>TWR</strong> chains daily P&L returns while neutralising the
                timing of deposits/withdrawals — the manager-skill counterpart to XIRR. Sharpe/Sortino use a {Math.round(RISK_FREE * 100)}% annual risk-free rate; ratios annualise with 252 trading days.
              </p>
            ) : (
              <p className="text-[0.6875rem] text-muted-foreground">
                No starting capital is configured, so every figure that divides by an equity base — total return, XIRR, TWR,
                CAGR, Sharpe, Sortino, volatility, Calmar, Monte Carlo, benchmark alpha — shows &quot;—&quot; instead of a number
                computed on an invented base. Rupee figures need no base and are exact. Set your capital under Settings → Capital &amp; Go-Live.
              </p>
            )}

            <ShareCard stats={shareStats} capital={capital} />

            {/* W1 — what each share-card figure actually is, in this app's
                conventions. The drift test joins these ids against the registry
                so a metric can't appear on the card without a definition here. */}
            <Card>
              <CardHeader><CardTitle>Reading the share card</CardTitle></CardHeader>
              <CardContent>
                <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                  {metricGlossary(["netPnl", "winRate", "profitFactor", "avgR", "trades", "expectancy", "shareMaxDrawdown", "charges", "bestTrade", "worstTrade"]).map((g) => (
                    <div key={g.id}>
                      <dt className="text-xs font-medium">{g.term}</dt>
                      <dd className="text-[0.6875rem] leading-snug text-muted-foreground">{g.meaning} {g.caveat}</dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </>
  );
}
