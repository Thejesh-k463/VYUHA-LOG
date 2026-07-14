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

  return (
    <>
      <PageHeader title="Edge / Setup Analytics" description="Which edges pay — expectancy, win rate and avg R per setup and segment." />
      <div className="space-y-5 p-6">
        <EdgeTable title="By setup tag" rows={bySetup(trades)} labelFor={(k) => k} exportName="vyuha-edge-by-setup" />
        <EdgeTable title="By segment" rows={bySegment(trades)} labelFor={(k) => SEGMENT_LABELS[k as Segment] ?? k} exportName="vyuha-edge-by-segment" />
        <MaeMfeCard report={maeReport} />
        <StopTuningCard tuning={tuning} />
      </div>
    </>
  );
}

/** T2.6 — R-normalized read on stop placement vs the heat trades actually took.
 *  Descriptive of THIS sample only; every suggestion is hedged on purpose. */
function StopTuningCard({ tuning }: { tuning: ReturnType<typeof stopTuningReport> }) {
  if (tuning.sampled === 0) {
    return (
      <Card>
        <CardHeader><CardTitle>Stop tuning (MAE in R)</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Needs closed trades that have BOTH price-history coverage and a recorded risk amount (set an SL
          when adding trades — risk auto-computes). Nothing qualifies yet.
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
        <p className="border-t border-border/60 px-4 py-3 text-[11px] text-muted-foreground">
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
          <p className="p-4 text-sm text-muted-foreground">
            No closed dated trades with price-history coverage yet. Load daily bhavcopies (Portfolio Risk →
            Auto-MTM) to build the EOD bar history that powers MAE/MFE.
            {report.undated > 0 && ` ${report.undated} closed trades have no entry/exit dates (aggregated imports) and can never be covered.`}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
              <KpiCard label="Avg MFE captured" value={report.avgCapturedPct != null ? `${report.avgCapturedPct}%` : "—"} sub="of best favorable move" />
              <KpiCard label="Avg edge ratio" value={report.avgEdgeRatio != null ? `${report.avgEdgeRatio}` : "—"} sub="MFE ÷ MAE" />
              <KpiCard label="Covered trades" value={`${report.covered}`} sub={`${report.uncovered} lack bars`} />
              <KpiCard label="Granularity" value="EOD" sub="intraday extremes unseen" />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-y border-border text-left text-muted-foreground">
                    <th className="px-2.5 py-2 font-medium">Symbol</th>
                    <th className="px-2 py-2 font-medium">Side</th>
                    <th className="px-2 py-2 text-right font-medium">Entry → Exit</th>
                    <th className="px-2 py-2 text-right font-medium">MAE</th>
                    <th className="px-2 py-2 text-right font-medium">MFE</th>
                    <th className="px-2 py-2 text-right font-medium">Captured</th>
                    <th className="px-2 py-2 text-right font-medium">Edge ratio</th>
                    <th className="px-2.5 py-2 text-right font-medium">Net P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((r) => (
                    <tr key={r.id} className="border-b border-border/40">
                      <td className="px-2.5 py-1.5 font-medium">{r.symbol}</td>
                      <td className="px-2 py-1.5 uppercase text-muted-foreground">{r.side}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{num(r.entry)} → {num(r.exit)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-loss">{inr(-r.maeRs, { decimals: 0 })}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-profit">{inr(r.mfeRs, { decimals: 0 })}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.capturedPct != null ? `${r.capturedPct}%` : "—"}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.edgeRatio ?? "—"}</td>
                      <td className={`px-2.5 py-1.5 text-right tabular-nums ${pnl(r.netPnl)}`}>{inr(r.netPnl, { decimals: 0 })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="px-4 py-3 text-[11px] text-muted-foreground">
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
          <p className="p-4 text-sm text-muted-foreground">No closed trades yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-y border-border text-left text-muted-foreground">
                  <th className="px-2.5 py-2 font-medium">{title.includes("setup") ? "Setup" : "Segment"}</th>
                  <th className="px-2.5 py-2 text-right font-medium">Trades</th>
                  <th className="px-2.5 py-2 text-right font-medium">Net P&L</th>
                  <th className="px-2.5 py-2 text-right font-medium">Expectancy</th>
                  <th className="px-2.5 py-2 text-right font-medium">Win rate</th>
                  <th className="px-2.5 py-2 text-right font-medium">Avg R</th>
                  <th className="px-2.5 py-2 text-right font-medium">Charges</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const expectancy = r.count ? r.net / r.count : 0;
                  return (
                    <tr key={r.key} className="border-b border-border/40">
                      <td className="px-2.5 py-1.5 font-medium">{labelFor(r.key)}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">{r.count}</td>
                      <td className={`px-2.5 py-1.5 text-right tabular-nums font-medium ${pnl(r.net)}`}>{num(r.net, 0)}</td>
                      <td className={`px-2.5 py-1.5 text-right tabular-nums ${pnl(expectancy)}`}>{num(expectancy, 0)}</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">{(r.winRate * 100).toFixed(1)}%</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">
                        {r.avgR == null ? "—" : <span className={pnl(r.avgR)}>{r.avgR.toFixed(2)}R</span>}
                      </td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums text-muted-foreground">{num(r.charges, 0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
