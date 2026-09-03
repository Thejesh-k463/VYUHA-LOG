import { todayIstIso } from "@/lib/domain/trading-day";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { KpiCard } from "@/components/kpi-card";
import { ProGate } from "@/components/system/pro-gate";
import { ExportButtons } from "@/components/ui/export-button";
import { getArjunTrades } from "@/lib/queries/trades";
import { getTradeStopEditEntries } from "@/lib/queries/stop-edits";
import { getBarsMap } from "@/lib/queries/price-history";
import { getAliasMap } from "@/lib/queries/aliases";
import { resolveTicker } from "@/lib/analytics/aliases";
import {
  cockpitReport, edgeMeasurable, SESSIONS, MIN_SAMPLE,
  type CockpitTrade, type Bucket,
} from "@/lib/analytics/cockpit";
import { computeMaeMfe, type MaeTradeInput } from "@/lib/analytics/mae-mfe";
import { slReport, slBySetup, tslReport, type SlTrade } from "@/lib/analytics/sl-analysis";
import { winLossReport, rDistribution, tailReport, type WinLossTrade } from "@/lib/analytics/win-loss";
import { edgeMeasurable as kpiMeasurable } from "@/lib/analytics/metrics";
import { exitClock, holdingClock, fragmentation, exitTriggers, type ExitTrade } from "@/lib/analytics/exit-behaviour";
import { stopMigration } from "@/lib/analytics/stop-migration";
import { extractStopEdits } from "@/lib/analytics/stop-edit-mining";
import { runRules } from "@/lib/intelligence/insight";
import { COCKPIT_RULES } from "@/lib/intelligence/rules/cockpit";
import { GOAL_RULES, type GoalRuleFact } from "@/lib/intelligence/rules/goal";
import { goalProgress } from "@/lib/analytics/goal";
import { getGoalView, getAggregateGoalProgress } from "@/lib/queries/goals";
import { getBucketCapital } from "@/lib/queries/capital";
import { dailyPnl } from "@/lib/analytics/metrics";
import { InsightList } from "@/components/intelligence/insight-list";
import { TabShell } from "@/components/trade-craft/tab-shell";
import { StopLossTab } from "@/components/trade-craft/stop-loss-tab";
import { TrailingTab } from "@/components/trade-craft/trailing-tab";
import { WinLossTab } from "@/components/trade-craft/win-loss-tab";
import { ExitsTab } from "@/components/trade-craft/exits-tab";
import { SEGMENT_LABELS } from "@/lib/domain/constants";
import { inr, num } from "@/lib/format";
import { Eye, Clock } from "lucide-react";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import Link from "next/link";

export const dynamic = "force-dynamic";

const pnl = (v: number) => (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground");

/** A horizontal bar whose width is relative to the biggest absolute value in
 *  the set, so small differences stay visible instead of collapsing. */
function EdgeBar({ rows, empty }: { rows: Bucket[]; empty: string }) {
  if (rows.length === 0) return empty ? <EmptyState variant="chart" title={empty} /> : null;
  const max = Math.max(...rows.map((r) => Math.abs(r.expectancy ?? 0)), 1);

  return (
    <div className="space-y-2 p-1">
      {rows.map((r) => {
        const e = r.expectancy ?? 0;
        const pctWidth = Math.max(2, (Math.abs(e) / max) * 100);
        return (
          <div key={r.key} className="flex items-center gap-3">
            <div className="w-[130px] shrink-0 text-xs">
              {r.label}
              {r.thin && (
                <span className="ml-1 text-[10px] text-warning" title={`Only ${r.trades} trades — below the ${MIN_SAMPLE}-trade threshold`}>
                  thin
                </span>
              )}
            </div>
            <div className="relative h-5 flex-1 rounded bg-card-hover/40">
              <div
                className={`absolute inset-y-0 rounded ${e >= 0 ? "left-1/2 bg-profit/60" : "right-1/2 bg-loss/60"}`}
                style={{ width: `${pctWidth / 2}%` }}
              />
              <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
            </div>
            <div className={`w-24 shrink-0 text-right font-mono text-xs tabular-nums ${pnl(e)}`}>
              {inr(e, { decimals: 0 })}
            </div>
            <div className="w-16 shrink-0 text-right font-mono text-[0.6875rem] tabular-nums text-muted-foreground">
              {r.trades}t
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function ArjunsEyePage() {
  const trades = getArjunTrades();

  const rows: CockpitTrade[] = trades.map((t) => ({
    id: t.id,
    symbol: t.symbol,
    segment: t.segment,
    netPnl: t.netPnl,
    buyValue: t.buyValue,
    sellValue: t.sellValue,
    buyDate: t.buyDate,
    sellDate: t.sellDate,
    entryTime: t.entryTime,
    acquisition: t.acquisition,
    acquisitionPrice: t.acquisitionPrice,
    exitTime: t.exitTime,
    isOpen: t.isOpen,
    rMultiple: t.rMultiple,
  }));
  const chargesById = Object.fromEntries(trades.map((t) => [t.id, t.chargesTotal]));

  const rep = cockpitReport(rows, chargesById, SEGMENT_LABELS as Record<string, string>);
  const { time, holding, sizing, tilt, segments } = rep;

  // The findings registry, run WITH the trade rows this time: the two
  // trade-level rules (fast re-entries, size escalation) refuse on the empty
  // array `cockpitReport` passes internally, so this surface runs the registry
  // itself over the same edge-measurable population every panel uses.
  const measurable = rows.filter(edgeMeasurable);
  const cockpitInsights = runRules(COCKPIT_RULES, { time, holding, sizing, tilt, segments, trades: measurable });

  // Goal rules (v3.6): one small goal read; the pace facts are computed from
  // the SAME scoped trade projection every panel above uses — the rules only
  // compare numbers already computed (projection stays lean).
  const today = todayIstIso();
  const capForGoals = getBucketCapital();
  const goalView = getGoalView();
  // All-accounts view: per-account walks summed (getAggregateGoalProgress),
  // never the blended series — see /reports/performance's goal cards.
  const aggGoalProgress = goalView.aggregate ? getAggregateGoalProgress(today) : null;
  const goalFacts: GoalRuleFact[] = goalView.goals.map((g) => {
    const rel = g.bucket === "total" ? trades : trades.filter((t) => t.bucket === g.bucket);
    const realised = [...dailyPnl(rel).entries()].map(([date, net]) => ({ date, net }));
    const cap = g.bucket === "equity" ? capForGoals.equityCapital : g.bucket === "active" ? capForGoals.activeCapital : capForGoals.totalCapital;
    const p =
      aggGoalProgress != null
        ? (aggGoalProgress.get(g.bucket) ?? goalProgress(g, { currentCapital: null, realised: [], today }))
        : goalProgress(g, { currentCapital: cap > 0 ? cap : null, realised, today });
    return {
      bucketLabel: g.bucket === "active" ? "Trade F&O" : g.bucket === "equity" ? "Equity" : "Total",
      measurable: p.measurable,
      runRate30: p.runRate30,
      runRate90: p.runRate90,
      requiredPerWeek: p.requiredPerWeek,
      gapAmount: p.gapAmount,
      daysLeft: p.daysLeft,
    };
  });
  const cutoff90 = new Date(new Date(today + "T00:00:00").getTime() - 89 * 86400000).toISOString().slice(0, 10);
  const realisedDays90 = [...dailyPnl(trades).keys()].filter((d) => d >= cutoff90 && d <= today).length;
  const goalInsights = runRules(GOAL_RULES, { goals: goalFacts, realisedDays90 });

  const insights = [...cockpitInsights, ...goalInsights];

  const closed = trades.filter((t) => !t.isOpen);

  // ── MAE/MFE coverage (EOD bars), shared by the SL and Exits tabs ────────
  const aliasMap = getAliasMap();
  const maeInputs: MaeTradeInput[] = closed.map((t) => {
    const side: "long" | "short" = t.buyQty >= t.sellQty ? "long" : "short";
    const qty = Math.max(t.buyQty, t.sellQty);
    return {
      id: t.id,
      symbol: t.symbol,
      ticker: resolveTicker(t.symbol.toUpperCase(), aliasMap),
      side,
      qty,
      entry: side === "long" ? t.avgBuyPrice : t.avgSellPrice,
      exit: side === "long" ? t.avgSellPrice : t.avgBuyPrice,
      entryDate: side === "long" ? t.buyDate : t.sellDate,
      exitDate: side === "long" ? t.sellDate : t.buyDate,
      netPnl: t.netPnl,
      isOpen: t.isOpen,
      riskAmount: t.riskAmount,
    };
  });
  const maeReport = computeMaeMfe(maeInputs, getBarsMap(maeInputs.map((i) => i.ticker)));
  const maeById = new Map(maeReport.rows.map((r) => [r.id, r]));

  // ── Stop-loss discipline (M1) ───────────────────────────────────────────
  const slTrades: SlTrade[] = closed.map((t) => {
    const mae = maeById.get(t.id);
    return {
      isOpen: t.isOpen,
      netPnl: t.netPnl,
      qty: Math.max(t.buyQty, t.sellQty),
      avgBuyPrice: t.avgBuyPrice,
      avgSellPrice: t.avgSellPrice,
      slPlanned: t.slPlanned,
      trailingSl: t.trailingSl,
      setupTag: t.setupTag,
      // No direction passed: the flat row cannot state one honestly, and
      // resolveDirection excludes (and counts) the ambiguous rows.
      maePerUnit: mae && mae.qty > 0 ? mae.maeRs / mae.qty : null,
    };
  });
  const slRep = slReport(slTrades);
  const slSetups = slBySetup(slTrades);
  const tsl = tslReport(slTrades);

  // ── Stop migration, mined from the audit log ────────────────────────────
  // Direction per trade is knowable from the flat row ONLY while the position
  // is lopsided (open or partially closed): a FULLY-CLOSED trade has
  // sellQty === buyQty, and the flat row cannot say which side entered first.
  // The old `sellQty > buyQty ? "short" : "long"` read every flat short as a
  // long, and widen/tighten INVERTS with direction — a short's stop raised
  // 130→160 (a real widening) classified as a tightening. Flat rows are left
  // OUT of the map, fall to the mining code's unknown-direction drop path, and
  // are counted (`mined.noDirection`) — surfaced on the Trailing tab so the
  // shrunken coverage is stated, never guessed. The intersection with this
  // page's scoped trade ids is what account-scopes the unscoped audit read.
  const directionByTrade = new Map<number, "long" | "short">();
  for (const t of trades) {
    if (t.sellQty !== t.buyQty) directionByTrade.set(t.id, t.sellQty > t.buyQty ? "short" : "long");
  }
  const mined = extractStopEdits(getTradeStopEditEntries(), directionByTrade);
  const migration = stopMigration(mined.edits, new Map(closed.map((t) => [t.id, t.netPnl])));

  // ── Winners vs losers (M2): closed, PRICED trades per the input contract ─
  const wlTrades: WinLossTrade[] = closed
    .filter((t) => kpiMeasurable(t))
    .map((t) => ({
      broker: t.broker,
      bucket: t.bucket,
      segment: t.segment,
      netPnl: t.netPnl,
      grossPnl: t.grossPnl,
      chargesTotal: t.chargesTotal,
      rMultiple: t.rMultiple,
      isOpen: t.isOpen,
      sellDate: t.sellDate,
      buyDate: t.buyDate,
      setupTag: t.setupTag,
      acquisition: t.acquisition,
      acquisitionPrice: t.acquisitionPrice,
      buyValue: t.buyValue,
      slPlanned: t.slPlanned,
      trailingSl: t.trailingSl,
      // hasPlanR's verification inputs: a stop counts as plan-derived only when
      // riskAmount reproduces |avgPrice − stop| × qty (either price side — the
      // flat row states no direction).
      avgBuyPrice: t.avgBuyPrice,
      avgSellPrice: t.avgSellPrice,
      qty: Math.max(t.buyQty, t.sellQty),
      riskAmount: t.riskAmount,
    }));
  const wlRep = winLossReport(wlTrades);
  const rDist = rDistribution(wlTrades);
  const tail = tailReport(wlTrades);

  // ── Exit behaviour ──────────────────────────────────────────────────────
  type ExitRow = ExitTrade & { buyDate: string | null; sellDate: string | null };
  const exitRows: ExitRow[] = closed.map((t) => ({
    netPnl: t.netPnl,
    grossPnl: t.grossPnl,
    buyValue: t.buyValue,
    isOpen: t.isOpen,
    entryTime: t.entryTime,
    exitTime: t.exitTime,
    exitTrigger: t.exitTrigger,
    buyOrderCount: t.buyOrderCount,
    sellOrderCount: t.sellOrderCount,
    capturedPct: maeById.get(t.id)?.capturedPct ?? null,
    buyDate: t.buyDate,
    sellDate: t.sellDate,
  }));
  const clock = exitClock(exitRows);
  const holdingRep = holdingClock(exitRows, (t) => {
    const r = t as ExitRow;
    return r.buyDate != null && r.sellDate != null && r.buyDate === r.sellDate;
  });
  const frag = fragmentation(exitRows);
  const triggers = exitTriggers(exitRows);

  const segCols = [
    { key: "label" as const, label: "Segment" },
    { key: "trades" as const, label: "Trades" },
    { key: "netPnl" as const, label: "Net P&L" },
    { key: "expectancy" as const, label: "Expectancy" },
    { key: "winRate" as const, label: "Win rate %" },
    { key: "charges" as const, label: "Charges" },
    { key: "chargeDragPct" as const, label: "Charge drag %" },
    { key: "avgDaysHeld" as const, label: "Avg days" },
  ];

  const cockpitTab = (
    <div className="space-y-5">
      {/* ── What it found ─────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Eye className="size-4 text-primary" /> What the data says</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <InsightList
            insights={insights}
            emptyText={`Not enough closed trades yet to say anything honestly. Findings need at least ${MIN_SAMPLE} trades in a group — a pattern drawn from fewer is noise, and a journal that guesses once stops being worth trusting.`}
          />
        </CardContent>
      </Card>

      {/* ── Time of day ───────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2"><Clock className="size-4" /> When you actually make money</CardTitle>
          <Badge variant={time.withTime > 0 ? "secondary" : "warning"}>
            {time.withTime} timed · {time.withoutTime} untimed
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          {time.withTime === 0 ? (
            <div className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs">
              <b>No execution times on record.</b> Session analysis needs a{" "}
              <b>tradebook</b> import — a P&amp;L statement carries no timestamps, so there
              is genuinely nothing to analyse. Vyuha will not invent a session for a trade
              whose time it does not know.
            </div>
          ) : (
            <>
              {time.insufficient && (
                <p className="text-xs text-warning">
                  Only {time.withTime} timed trades — below the {MIN_SAMPLE} needed to draw a
                  conclusion. Shown for completeness, not as a finding.
                </p>
              )}
              <div>
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  By session · expectancy per trade
                </div>
                <EdgeBar rows={time.bySession} empty="No timed trades in market hours." />
                {/* Reconciliation, not decoration: the session buckets
                    must account for every timed trade. A non-zero
                    count here usually means a misread time column. */}
                {time.offHours > 0 && (
                  <p className="mt-2 text-xs text-warning">
                    {num(time.offHours)} timed trade{time.offHours === 1 ? "" : "s"} fall outside
                    {SESSIONS[0].from}–{SESSIONS[SESSIONS.length - 1].to} and belong to no session, so they are excluded from the bars
                    above rather than forced into one. Worth checking the import — a broker
                    time column read wrongly looks exactly like this.
                  </p>
                )}
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
                  {SESSIONS.map((s) => (
                    <span key={s.key}>
                      <b>{s.label}</b> {s.from}–{s.to} · {s.note}
                    </span>
                  ))}
                </div>
              </div>
            </>
          )}

          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              By weekday · expectancy per trade
            </div>
            <EdgeBar rows={time.byWeekday} empty="No dated trades yet." />
          </div>
        </CardContent>
      </Card>

      {/* ── Segment scorecard ─────────────────────────────────── */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Which products are worth your capital</CardTitle>
          <ExportButtons filename="arjuns-eye-segments" columns={segCols} rows={segments} />
        </CardHeader>
        <CardContent className="p-0">
          <ReportTable minWidth={760}>
            <ReportThead>
              <ReportTh>Segment</ReportTh>
              <ReportTh align="right">Trades</ReportTh>
              <ReportTh align="right">Net P&amp;L</ReportTh>
              <ReportTh align="right">Expectancy</ReportTh>
              <ReportTh align="right">Win rate</ReportTh>
              <ReportTh align="right">Charges</ReportTh>
              <ReportTh align="right">Charge drag</ReportTh>
              <ReportTh align="right">Avg days</ReportTh>
            </ReportThead>
            <tbody>
              {segments.map((s) => (
                <ReportTr key={s.key}>
                  <ReportTd className="font-medium">
                    {s.label}
                    {s.thin && <span className="ml-1.5 text-[10px] text-warning">thin</span>}
                  </ReportTd>
                  <ReportTd align="right">{s.trades}</ReportTd>
                  <ReportTd align="right" className={pnl(s.netPnl)}>{inr(s.netPnl, { decimals: 0 })}</ReportTd>
                  <ReportTd align="right" className={pnl(s.expectancy ?? 0)}>{s.expectancy == null ? "—" : inr(s.expectancy, { decimals: 0 })}</ReportTd>
                  <ReportTd align="right" muted>{s.winRate == null ? "—" : `${s.winRate.toFixed(0)}%`}</ReportTd>
                  <ReportTd align="right" className="text-warning">{inr(s.charges, { decimals: 0 })}</ReportTd>
                  <ReportTd align="right" muted>{s.chargeDragPct == null ? "—" : `${s.chargeDragPct}%`}</ReportTd>
                  <ReportTd align="right" muted>{s.avgDaysHeld == null ? "—" : num(s.avgDaysHeld, 1)}</ReportTd>
                </ReportTr>
              ))}
            </tbody>
          </ReportTable>
        </CardContent>
      </Card>

      {/* ── Behaviour ─────────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Do you cut winners and hold losers?</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <KpiCard label="Avg win held" value={holding.avgWinDays == null ? "—" : `${holding.avgWinDays}d`} sub={`${holding.winners} winners`} />
              <KpiCard label="Avg loss held" value={holding.avgLossDays == null ? "—" : `${holding.avgLossDays}d`} sub={`${holding.losers} losers`} />
              <KpiCard
                label="Ratio"
                value={holding.ratio == null ? "—" : `${holding.ratio}×`}
                valueClassName={holding.ratio == null ? "" : holding.ratio > 1.5 ? "text-loss" : holding.ratio < 0.8 ? "text-profit" : ""}
                sub="loss ÷ win hold"
              />
            </div>
            <p className="text-[0.6875rem] text-muted-foreground">
              {holding.insufficient
                ? `Needs ${MIN_SAMPLE}+ winners and losers before this means anything.`
                : "Above 1.0 means losers are given more room than winners — the most common structural leak in retail trading."}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Does a loss change how you trade?</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <KpiCard
                label="After a win"
                value={tilt.afterWin.expectancy == null ? "—" : inr(tilt.afterWin.expectancy, { decimals: 0 })}
                valueClassName={pnl(tilt.afterWin.expectancy ?? 0)}
                sub={`${tilt.afterWin.trades} trades`}
              />
              <KpiCard
                label="After a loss"
                value={tilt.afterLoss.expectancy == null ? "—" : inr(tilt.afterLoss.expectancy, { decimals: 0 })}
                valueClassName={pnl(tilt.afterLoss.expectancy ?? 0)}
                sub={`${tilt.afterLoss.trades} trades`}
              />
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[0.6875rem] text-muted-foreground">
              <span>Longest win streak <b className="text-profit">{tilt.longestWinStreak}</b></span>
              <span>Longest loss streak <b className="text-loss">{tilt.longestLossStreak}</b></span>
              <span>Same-day re-entries after a loss <b className={tilt.sameDayReentryAfterLoss > 0 ? "text-warning" : ""}>{tilt.sameDayReentryAfterLoss}</b></span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Sizing ────────────────────────────────────────────── */}
      <Card>
        <CardHeader><CardTitle>Is your conviction rewarded?</CardTitle></CardHeader>
        <CardContent>
          {sizing.insufficient ? (
            <p className="text-sm text-muted-foreground">
              Needs {MIN_SAMPLE * 2}+ closed trades before position size can be split into
              meaningful quartiles.
            </p>
          ) : (
            <>
              <EdgeBar rows={sizing.quartiles} empty="" />
              <p className="mt-3 text-[0.6875rem] text-muted-foreground">
                Positions sorted smallest to largest. If your biggest positions are not your
                best, that is a <b>sizing</b> question rather than a selection one — the
                setups may be fine while the conviction is misplaced.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>How to read this page</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Every finding is gated behind <b>{MIN_SAMPLE} trades</b> in the relevant group.
            Groups below that are marked <b>thin</b> and deliberately excluded from the
            conclusions — &quot;Tuesdays are your best day&quot; drawn from four trades is
            noise dressed as insight.
          </p>
          <p>
            Session analysis needs execution <b>times</b>, which only tradebook imports
            carry. Trades without them are counted as a coverage gap rather than quietly
            assigned to a session.
          </p>
          <p>
            Everything here is <b>descriptive</b>. It reports what your trades already did;
            it does not predict, and it does not tell you what to do next.
          </p>
        </CardContent>
      </Card>
    </div>
  );

  return (
    <>
      <PageHeader
        title="Arjun's Eye"
        description="The Trade Craft cockpit — what kind of trader you are, and where your edge actually comes from."
        actions={
          <div className="flex items-center gap-2">
            {rep.excludedUnpriced > 0 && (
              <Badge variant="warning">{rep.excludedUnpriced} unpriced excluded</Badge>
            )}
            <Badge variant="secondary">{rep.closedTrades} closed trades</Badge>
          </div>
        }
      />
      <div className="space-y-5 p-6">
        <ProGate>
          {/* Stated before any panel: these numbers are computed on a
              population, and the user is entitled to know which one. */}
          {rep.excludedUnpriced > 0 && (
            <Card className="border-warning/40">
              <CardContent className="p-4 text-xs text-muted-foreground">
                <b className="text-warning">
                  {rep.excludedUnpriced} closed trade{rep.excludedUnpriced === 1 ? " is" : "s are"} excluded from every panel below.
                </b>{" "}
                {rep.excludedUnpriced === 1 ? "It was" : "They were"} sold without a purchase on record — usually an
                IPO allotment — so there is no cost to measure an edge against. With a buy value of zero the
                arithmetic would score {rep.excludedUnpriced === 1 ? "it" : "them"} as {rep.excludedUnpriced === 1 ? "a" : ""} 100%
                winner{rep.excludedUnpriced === 1 ? "" : "s"} and lift every expectancy on this page.
                Set a cost on the <a className="underline" href="/trades">Trades</a> page to include {rep.excludedUnpriced === 1 ? "it" : "them"}.
              </CardContent>
            </Card>
          )}
          {rep.closedTrades === 0 ? (
            <EmptyState
              variant="chart"
              title="Nothing to see yet"
              hint={<>Arjun&apos;s Eye reads your closed trades. Import a broker file and come back —
                a <b>tradebook</b> import unlocks the time-of-day analysis, which a P&amp;L
                statement cannot support.</>}
              action={<Button asChild size="sm"><Link href="/import">Import a broker file</Link></Button>}
            />
          ) : (
            <TabShell
              tabs={[
                { key: "cockpit", label: "Cockpit", content: cockpitTab },
                { key: "stops", label: "Stop-losses", content: <StopLossTab report={slRep} setups={slSetups} /> },
                { key: "trailing", label: "Trailing stops", content: <TrailingTab tsl={tsl} migration={migration} excludedNoDirection={mined.noDirection} /> },
                { key: "winloss", label: "Winners vs losers", content: <WinLossTab report={wlRep} dist={rDist} tail={tail} /> },
                { key: "exits", label: "Exits", content: <ExitsTab clock={clock} holding={holdingRep} frag={frag} triggers={triggers} /> },
              ]}
            />
          )}
        </ProGate>
      </div>
    </>
  );
}
