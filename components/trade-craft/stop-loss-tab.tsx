import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { KpiCard } from "@/components/kpi-card";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { EmptyState } from "@/components/ui/empty-state";
import { inr, num } from "@/lib/format";
import {
  MIN_SAMPLE as SL_MIN_SAMPLE,
  STOP_TOLERANCE_PCT,
  type SlReport,
  type SetupSlStat,
} from "@/lib/analytics/sl-analysis";

/**
 * Stop-losses tab — M1's slReport/slBySetup rendered with COVERAGE first.
 * `slPlanned` is null on 100% of imported trades, so "SL recorded on N of M
 * losers" is the headline, not a footnote; every number below it is computed
 * on the recorded subset and says so.
 */
export function StopLossTab({ report, setups }: { report: SlReport; setups: SetupSlStat[] }) {
  const covPct = report.slCoveragePct;
  const lowCoverage = covPct == null || covPct < 50;

  return (
    <div className="space-y-5">
      {/* Coverage is the FIRST line on this tab, by design. */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>How often a loser had a stop on record</CardTitle>
          <Badge variant={lowCoverage ? "warning" : "secondary"}>
            {report.withSl} of {report.closed} closed trades carry a stop
          </Badge>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm">
            <b>SL recorded on {report.losingWithSl} of {report.losingTrades} losers</b>
            {covPct != null && <span className="text-muted-foreground"> ({num(covPct, 0)}%)</span>}
            {report.losingWithoutSl > 0 && (
              <span className="text-muted-foreground">
                {" "}— the other {report.losingWithoutSl} lost without a recorded plan to measure against.
              </span>
            )}
          </p>
          {report.lossGapRs != null && (
            <p className="text-xs text-muted-foreground">
              Losers that recorded a stop averaged <b className="text-foreground">{inr(report.avgLossWithSl ?? 0, { decimals: 0 })}</b> per
              trade, against <b className="text-foreground">{inr(report.avgLossWithoutSl ?? 0, { decimals: 0 })}</b> for losers without one —
              a gap of {inr(Math.abs(report.lossGapRs), { decimals: 0 })} per trade. Descriptive, not causal: the
              no-stop population is largely the imported one.
            </p>
          )}
          {lowCoverage && (
            <p className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs">
              Imports never carry a planned stop, so most of this book has none on record. These
              panels sharpen as stops get recorded — a stop set when the trade is opened is the one
              number that lets the journal measure discipline instead of guessing at it.
            </p>
          )}
        </CardContent>
      </Card>

      {report.withSl === 0 ? (
        <Card>
          <CardContent className="p-6">
            <EmptyState
              variant="chart"
              title="No recorded stops to analyse yet"
              hint="Add or edit a trade with its planned SL (or use staged positions, whose tranches carry stops) and this tab starts measuring exits against the plan."
            />
          </CardContent>
        </Card>
      ) : (
        <>
          {/* ── Losing exits vs the stop they recorded ─────────────────── */}
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Where losing exits landed against the stop</CardTitle>
              <Badge variant="secondary">
                {report.losersClassified} of {report.losingWithSl} stop-recorded losers classified
              </Badge>
            </CardHeader>
            <CardContent className="space-y-3">
              {report.losersClassified === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No stop-recorded loser could be classified
                  {report.excludedLosers > 0 && <> — {report.excludedLosers} losing row{report.excludedLosers === 1 ? "" : "s"} had no derivable direction or missing prices and {report.excludedLosers === 1 ? "was" : "were"} excluded rather than guessed</>}.
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <KpiCard label="Held to the stop" valueNum={report.heldToStop} format="int" sub={`within ±${(STOP_TOLERANCE_PCT * 100).toFixed(1)}% of the level`} />
                    <KpiCard label="Slipped past it" valueNum={report.slippedPast} format="int" valueClassName={report.slippedPast > 0 ? "text-loss" : ""} sub="exited beyond the stop" />
                    <KpiCard label="Exited early" valueNum={report.exitedEarly} format="int" sub="cut before the stop" />
                    <KpiCard
                      label="Avg slippage"
                      value={report.avgSlippageRs == null ? "—" : inr(report.avgSlippageRs, { decimals: 0 })}
                      valueClassName={report.avgSlippageRs != null ? "text-loss" : ""}
                      sub={report.avgSlippageR != null ? `${report.avgSlippageR}R over ${report.slippageRFrom} trades` : "per slipped trade"}
                    />
                  </div>
                  {report.totalSlippageRs > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Exits beyond the recorded stop cost <b className="text-loss">{inr(report.totalSlippageRs, { decimals: 0 })}</b> more
                      than the stops themselves allowed, across {report.slippedPast} trade{report.slippedPast === 1 ? "" : "s"}.
                      R here is derived from the recorded stop distance, never from a generic risk cap.
                    </p>
                  )}
                  {report.excludedLosers > 0 && (
                    <p className="text-[0.6875rem] text-muted-foreground">
                      {report.excludedLosers} stop-recorded losing row{report.excludedLosers === 1 ? "" : "s"} excluded: the flat trade row
                      stores no direction, and where the stop sits between the two average prices — exactly where
                      slipped stops land — long and short cannot be told apart honestly.
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {/* ── Winners against the stop they never paid ───────────────── */}
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Winners and the stop they never paid</CardTitle>
              <Badge variant={report.winnersMeasured > 0 ? "secondary" : "warning"}>
                {report.winnersMeasured} of {report.winnersWithSl} measured
              </Badge>
            </CardHeader>
            <CardContent className="space-y-3">
              {report.winnersMeasured === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {report.winnersWithSl > 0
                    ? "No winner with a recorded stop has price-history coverage yet, so how close they came to stopping out is unmeasured — not assumed safe. Load daily bhavcopies (Portfolio Risk → Auto-MTM) to measure it."
                    : report.excludedWinners > 0
                      ? `${report.excludedWinners} winner${report.excludedWinners === 1 ? "" : "s"} recorded a stop, but ${report.excludedWinners === 1 ? "its" : "their"} direction could not be derived, so ${report.excludedWinners === 1 ? "it was" : "they were"} excluded rather than guessed.`
                      : "No winners carry a recorded stop yet."}
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                    <KpiCard label="Never risked the stop" valueNum={report.winnersNeverRisked} format="int" sub="adverse move stayed inside half the stop distance" />
                    <KpiCard label="Nearly stopped out" valueNum={report.winnersNearStop} format="int" valueClassName={report.winnersNearStop > 0 ? "text-warning" : ""} sub="came within tolerance of the stop, then paid" />
                    <KpiCard label="Measured winners" valueNum={report.winnersMeasured} format="int" sub={`of ${report.winnersWithSl} with a stop`} />
                  </div>
                  <p className="text-[0.6875rem] text-muted-foreground">
                    Measured at EOD granularity — intraday extremes are invisible, so &quot;nearly stopped out&quot; is a floor, not a ceiling.
                  </p>
                </>
              )}
              {report.excludedWinners > 0 && report.winnersWithSl > 0 && (
                <p className="text-[0.6875rem] text-muted-foreground">
                  {report.excludedWinners} stop-recorded winner{report.excludedWinners === 1 ? "" : "s"} excluded: direction
                  could not be derived from the flat row, so {report.excludedWinners === 1 ? "it is" : "they are"} left out rather than guessed.
                </p>
              )}
            </CardContent>
          </Card>

          {/* ── Per-setup discipline ───────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle>Stop discipline by setup</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {setups.length === 0 ? (
                <p className="p-6 text-sm text-muted-foreground">No stop-recorded closed trades to group yet.</p>
              ) : (
                <>
                  <ReportTable minWidth={640}>
                    <ReportThead>
                      <ReportTh>Setup</ReportTh>
                      <ReportTh align="right">With stop</ReportTh>
                      <ReportTh align="right">Held</ReportTh>
                      <ReportTh align="right">Slipped</ReportTh>
                      <ReportTh align="right">Cut early</ReportTh>
                      <ReportTh align="right">Slippage</ReportTh>
                    </ReportThead>
                    <tbody>
                      {setups.map((s) => (
                        <ReportTr key={s.key}>
                          <ReportTd className="font-medium">
                            {s.key}
                            {s.smallSample && (
                              <span className="ml-1.5 text-[10px] text-warning" title={`Fewer than ${SL_MIN_SAMPLE} stop-recorded trades — read with caution, don't rank on it.`}>
                                thin
                              </span>
                            )}
                          </ReportTd>
                          <ReportTd align="right">{s.closedWithSl}</ReportTd>
                          <ReportTd align="right">{s.heldToStop}</ReportTd>
                          <ReportTd align="right" className={s.slippedPast > 0 ? "text-loss" : ""}>{s.slippedPast}</ReportTd>
                          <ReportTd align="right">{s.exitedEarly}</ReportTd>
                          <ReportTd align="right" className={s.totalSlippageRs > 0 ? "text-loss" : ""} >
                            {s.totalSlippageRs > 0 ? inr(s.totalSlippageRs, { decimals: 0 }) : "—"}
                          </ReportTd>
                        </ReportTr>
                      ))}
                    </tbody>
                  </ReportTable>
                  <p className="px-4 py-3 text-[0.6875rem] text-muted-foreground">
                    Only closed trades with a recorded stop appear here; winners count toward the group but only
                    losers are classified against the stop.
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
