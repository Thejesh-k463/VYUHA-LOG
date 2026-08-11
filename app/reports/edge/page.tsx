import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ExportButtons } from "@/components/ui/export-button";
import { getTrades } from "@/lib/queries/trades";
import { bySegment, bySetup, type GroupStat } from "@/lib/analytics/metrics";
import { num, inr } from "@/lib/format";
import { SEGMENT_LABELS, type Segment } from "@/lib/domain/constants";
import { computeMaeMfe, stopTuningReport, type MaeTradeInput } from "@/lib/analytics/mae-mfe";
import { getBarsMap } from "@/lib/queries/price-history";
import { getAliasMap } from "@/lib/queries/aliases";
import { resolveTicker } from "@/lib/analytics/aliases";
import { KpiCard } from "@/components/kpi-card";
import { getIndexMembershipMap } from "@/lib/queries/instruments";
import { themeEdge, THEME_MIN_SAMPLE } from "@/lib/analytics/theme-edge";
import { ProGate } from "@/components/system/pro-gate";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import Link from "next/link";

export const dynamic = "force-dynamic";

const COLS = [
  { key: "key", label: "Group" }, { key: "count", label: "Trades" },
  { key: "net", label: "Net" }, { key: "gross", label: "Gross" },
  { key: "charges", label: "Charges" }, { key: "wins", label: "Wins" },
  { key: "winRate", label: "Win rate" }, { key: "avgR", label: "Avg R" },
];

export default function EdgeReportPage() {
  const trades = getTrades();

  // MAE/MFE — EOD-bar excursions for closed dated trades covered by price_history.
  const aliasMap = getAliasMap();
  const maeInputs: MaeTradeInput[] = trades
    .filter((t) => !t.isOpen)
    .map((t) => {
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
  const tuning = stopTuningReport(maeReport.rows);

  // Edge by NSE theme — aliases resolve broker names to the tickers the
  // membership table is keyed on.
  const themes = themeEdge(
    trades.map((t) => ({ symbol: resolveTicker(t.symbol.toUpperCase(), aliasMap), isOpen: t.isOpen, netPnl: t.netPnl })),
    getIndexMembershipMap(),
  );

  return (
    <>
      <PageHeader title="Edge / Setup Analytics" description="Which edges pay — expectancy, win rate and avg R per setup and segment." />
      <div className="space-y-5 p-6">
        <ProGate>
        <EdgeTable title="By setup tag" rows={bySetup(trades)} labelFor={(k) => k} exportName="vyuha-edge-by-setup" />
        <EdgeTable title="By segment" rows={bySegment(trades)} labelFor={(k) => SEGMENT_LABELS[k as Segment] ?? k} exportName="vyuha-edge-by-segment" />
        <ThemeEdgeCard report={themes} />
        <MaeMfeCard report={maeReport} />
        <StopTuningCard tuning={tuning} />
      </ProGate>
      </div>
    </>
  );
}

/** T2.6 — R-normalized read on stop placement vs the heat trades actually took.
 *  Descriptive of THIS sample only; every suggestion is hedged on purpose. */
function ThemeEdgeCard({ report }: { report: ReturnType<typeof themeEdge> }) {
  if (report.rows.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle>By NSE theme</CardTitle></CardHeader>
        <CardContent>
          <EmptyState
            variant="chart"
            title="No thematic tags yet"
            hint={<>Load the bundled NSE map on <span className="text-foreground">Instruments</span> (one click) — it records which thematic indices each of your symbols belongs to, and this card answers where your expectancy actually lives: Defence, Railways PSU, EV, Digital…</>}
            action={<Button asChild size="sm" variant="outline"><Link href="/instruments">Open Instruments</Link></Button>}
          />
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          By NSE theme
          <Badge variant="secondary">
            {report.taggedTrades} of {report.closedTrades} closed trades tagged
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ReportTable>
          <ReportThead>
            <ReportTh>Theme</ReportTh>
            <ReportTh align="right">Trades</ReportTh>
            <ReportTh align="right">Symbols</ReportTh>
            <ReportTh align="right">Net P&L</ReportTh>
            <ReportTh align="right">Win rate</ReportTh>
            <ReportTh align="right">Expectancy</ReportTh>
          </ReportThead>
          <tbody>
            {report.rows.map((r) => (
              <ReportTr key={r.theme}>
                <ReportTd className="font-medium">
                  {r.theme}
                  {!r.trustworthy && (
                    <span className="ml-1.5 text-[10px] text-warning" title={`Fewer than ${THEME_MIN_SAMPLE} trades — treat as anecdote, not edge.`}>
                      thin sample
                    </span>
                  )}
                </ReportTd>
                <ReportTd align="right">{r.trades}</ReportTd>
                <ReportTd align="right">{r.symbols}</ReportTd>
                <ReportTd align="right" className={r.netPnl > 0 ? "text-profit" : r.netPnl < 0 ? "text-loss" : ""}>{inr(r.netPnl, { decimals: 0 })}</ReportTd>
                <ReportTd align="right">{num(r.winRate, 1)}%</ReportTd>
                <ReportTd align="right" className={r.expectancy > 0 ? "text-profit" : r.expectancy < 0 ? "text-loss" : ""}>{inr(r.expectancy, { decimals: 0 })}</ReportTd>
              </ReportTr>
            ))}
          </tbody>
        </ReportTable>
        <p className="text-[0.6875rem] text-muted-foreground">
          Themes <b>overlap</b> — one stock can sit in ten indices, so a trade counts in every theme
          it belongs to and the P&L column deliberately sums to more than your book. Each row is a
          lens, not a slice.{" "}
          {report.untaggedTrades > 0 && (
            <>
              <span className="text-warning">{report.untaggedTrades} closed trades carry no theme tag</span>{" "}
              (symbols outside the index universe, or the map not loaded) — this table describes only the tagged part.
            </>
          )}
        </p>
      </CardContent>
    </Card>
  );
}

function StopTuningCard({ tuning }: { tuning: ReturnType<typeof stopTuningReport> }) {
  if (tuning.sampled === 0) {
    return (
      <Card>
        <CardHeader><CardTitle>Stop tuning (MAE in R)</CardTitle></CardHeader>
        <CardContent>
          <EmptyState
            variant="chart"
            title="Nothing qualifies yet"
            hint="Needs closed trades that have BOTH price-history coverage and a recorded risk amount (set an SL when adding trades — risk auto-computes)."
          />
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className="p-0">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Stop tuning (MAE in R)</CardTitle>
        <Badge variant="outline">{tuning.sampled} trades · {tuning.winners}W / {tuning.losers}L</Badge>
      </CardHeader>
      <CardContent className="p-0">
        <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
          <KpiCard label="Winners' avg heat" value={tuning.avgWinnerMaeR != null ? `${tuning.avgWinnerMaeR}R` : "—"} sub={`median ${tuning.medianWinnerMaeR ?? "—"}R`} />
          <KpiCard label="Winners with ≥0.5R heat" value={tuning.winnersHeatOver50Pct != null ? `${tuning.winnersHeatOver50Pct}%` : "—"} sub="took real pain first" />
          <KpiCard label="Winners with ≥0.8R heat" value={tuning.winnersHeatOver80Pct != null ? `${tuning.winnersHeatOver80Pct}%` : "—"} sub="near-stopouts that paid" />
          <KpiCard label="Losers past 1.1R" value={tuning.losersBeyond1RPct != null ? `${tuning.losersBeyond1RPct}%` : "—"} sub="stops honored late / moved" />
        </div>
        <div className="space-y-1.5 px-4 pb-3">
          {tuning.suggestions.map((s, i) => (
            <p key={i} className="text-xs">
              <span className="mr-1.5 text-warning">▸</span>
              {s}
            </p>
          ))}
        </div>
        <p className="border-t border-border/60 px-4 py-3 text-[0.6875rem] text-muted-foreground">
          Descriptive, not prescriptive: these numbers describe YOUR past sample at EOD granularity. Moving
          a stop changes which trades survive — never retro-fit a stop to this table without forward-testing
          the change small.
        </p>
      </CardContent>
    </Card>
  );
}

function MaeMfeCard({ report }: { report: ReturnType<typeof computeMaeMfe> }) {
  const pnl = (v: number) => (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground");
  return (
    <Card className="p-0">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>MAE / MFE (EOD excursions)</CardTitle>
        {report.covered > 0 && (
          <Badge variant="outline">
            {report.covered} covered · {report.uncovered} no bars · {report.undated} undated
          </Badge>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {report.covered === 0 ? (
          <EmptyState
            variant="chart"
            title="No closed dated trades with price-history coverage yet"
            hint={<>Load daily bhavcopies (Portfolio Risk → Auto-MTM) to build the EOD bar history that powers MAE/MFE.
              {report.undated > 0 && ` ${report.undated} closed trades have no entry/exit dates (aggregated imports) and can never be covered.`}</>}
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
              <KpiCard label="Avg MFE captured" value={report.avgCapturedPct != null ? `${report.avgCapturedPct}%` : "—"} sub="of best favorable move" />
              <KpiCard label="Avg edge ratio" value={report.avgEdgeRatio != null ? `${report.avgEdgeRatio}` : "—"} sub="MFE ÷ MAE" />
              <KpiCard label="Covered trades" value={`${report.covered}`} sub={`${report.uncovered} lack bars`} />
              <KpiCard label="Granularity" value="EOD" sub="intraday extremes unseen" />
            </div>
            <ReportTable>
              <ReportThead>
                <ReportTh>Symbol</ReportTh>
                <ReportTh>Side</ReportTh>
                <ReportTh align="right">Entry → Exit</ReportTh>
                <ReportTh align="right">MAE</ReportTh>
                <ReportTh align="right">MFE</ReportTh>
                <ReportTh align="right">Captured</ReportTh>
                <ReportTh align="right">Edge ratio</ReportTh>
                <ReportTh align="right">Net P&L</ReportTh>
              </ReportThead>
              <tbody>
                {report.rows.map((r) => (
                  <ReportTr key={r.id}>
                    <ReportTd className="font-medium">{r.symbol}</ReportTd>
                    <ReportTd muted className="uppercase">{r.side}</ReportTd>
                    <ReportTd align="right">{num(r.entry)} → {num(r.exit)}</ReportTd>
                    <ReportTd align="right" className="text-loss">{inr(-r.maeRs, { decimals: 0 })}</ReportTd>
                    <ReportTd align="right" className="text-profit">{inr(r.mfeRs, { decimals: 0 })}</ReportTd>
                    <ReportTd align="right">{r.capturedPct != null ? `${r.capturedPct}%` : "—"}</ReportTd>
                    <ReportTd align="right">{r.edgeRatio ?? "—"}</ReportTd>
                    <ReportTd align="right" className={pnl(r.netPnl)}>{inr(r.netPnl, { decimals: 0 })}</ReportTd>
                  </ReportTr>
                ))}
              </tbody>
            </ReportTable>
            <p className="px-4 py-3 text-[0.6875rem] text-muted-foreground">
              MAE = worst move against entry over the holding window; MFE = best move in favour; captured = how much
              of the MFE your exit banked. EOD bars only — same-day extremes between entry and exit are approximate.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function EdgeTable({ title, rows, labelFor, exportName }: { title: string; rows: GroupStat[]; labelFor: (k: string) => string; exportName: string }) {
  const pnl = (v: number) => (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground");
  return (
    <Card className="p-0">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{title}</CardTitle>
        <ExportButtons filename={exportName} columns={COLS} rows={rows} />
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <EmptyState
            variant="journal"
            title="No closed trades yet"
            action={<Button asChild size="sm"><Link href="/import">Import a broker file</Link></Button>}
          />
        ) : (
          <ReportTable>
            <ReportThead>
              <ReportTh>{title.includes("setup") ? "Setup" : "Segment"}</ReportTh>
              <ReportTh align="right">Trades</ReportTh>
              <ReportTh align="right">Net P&L</ReportTh>
              <ReportTh align="right">Expectancy</ReportTh>
              <ReportTh align="right">Win rate</ReportTh>
              <ReportTh align="right">Avg R</ReportTh>
              <ReportTh align="right">Charges</ReportTh>
            </ReportThead>
            <tbody>
              {rows.map((r) => {
                const expectancy = r.count ? r.net / r.count : 0;
                return (
                  <ReportTr key={r.key}>
                    <ReportTd className="font-medium">{labelFor(r.key)}</ReportTd>
                    <ReportTd align="right">{r.count}</ReportTd>
                    <ReportTd align="right" className={`font-medium ${pnl(r.net)}`}>{num(r.net, 0)}</ReportTd>
                    <ReportTd align="right" className={pnl(expectancy)}>{num(expectancy, 0)}</ReportTd>
                    <ReportTd align="right">{(r.winRate * 100).toFixed(1)}%</ReportTd>
                    <ReportTd align="right">
                      {r.avgR == null ? "—" : <span className={pnl(r.avgR)}>{r.avgR.toFixed(2)}R</span>}
                    </ReportTd>
                    <ReportTd align="right" muted>{num(r.charges, 0)}</ReportTd>
                  </ReportTr>
                );
              })}
            </tbody>
          </ReportTable>
        )}
      </CardContent>
    </Card>
  );
}
