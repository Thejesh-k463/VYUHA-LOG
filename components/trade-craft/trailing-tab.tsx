import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { KpiCard } from "@/components/kpi-card";
import { inr, num } from "@/lib/format";
import { MIN_SAMPLE as SL_MIN_SAMPLE, type TslReport } from "@/lib/analytics/sl-analysis";
import { stopMigrationFinding, type StopMigrationReport } from "@/lib/analytics/stop-migration";

/**
 * Trailing-stops tab — M1's tslReport plus the audit-mined stop-migration
 * story. Both refuse below their floors on screen rather than thinning the
 * claim: a win rate over five TSL trades is a coin story, and "you widen
 * stops" off two edits is an accusation, not an insight.
 */
export function TrailingTab({ tsl, migration }: { tsl: TslReport; migration: StopMigrationReport }) {
  const finding = stopMigrationFinding(migration);
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Trades that trailed their stop vs the rest</CardTitle>
          <Badge variant={tsl.withTsl > 0 ? "secondary" : "warning"}>
            {tsl.withTsl} of {tsl.closed} closed trades recorded a TSL
          </Badge>
        </CardHeader>
        <CardContent className="space-y-3">
          {tsl.withTsl === 0 ? (
            <p className="text-sm text-muted-foreground">
              No closed trade has a trailing stop on record yet. Record one on a trade (or on a staged
              tranche) and this panel compares those trades against the rest of the book.
            </p>
          ) : tsl.smallSample ? (
            <p className="text-sm text-muted-foreground">
              {tsl.withTsl} trade{tsl.withTsl === 1 ? "" : "s"} with a trailing stop against {tsl.withoutTsl} without —
              the comparison needs <b>{SL_MIN_SAMPLE}</b> on each side before a win rate stops being a coin story.
              Counted, shown, and deliberately not concluded on.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <KpiCard label="TSL win rate" value={tsl.tslWinRatePct == null ? "—" : `${num(tsl.tslWinRatePct, 0)}%`} sub={`${tsl.withTsl} trades`} />
                <KpiCard label="TSL expectancy" value={tsl.tslExpectancy == null ? "—" : inr(tsl.tslExpectancy, { decimals: 0 })} valueClassName={tsl.tslExpectancy != null && tsl.tslExpectancy < 0 ? "text-loss" : tsl.tslExpectancy != null && tsl.tslExpectancy > 0 ? "text-profit" : ""} sub="per TSL trade" />
                <KpiCard label="Baseline win rate" value={tsl.baselineWinRatePct == null ? "—" : `${num(tsl.baselineWinRatePct, 0)}%`} sub={`${tsl.withoutTsl} trades without a TSL`} />
                <KpiCard label="Expectancy gap" value={tsl.expectancyGapRs == null ? "—" : inr(tsl.expectancyGapRs, { decimals: 0 })} valueClassName={tsl.expectancyGapRs != null && tsl.expectancyGapRs < 0 ? "text-loss" : tsl.expectancyGapRs != null && tsl.expectancyGapRs > 0 ? "text-profit" : ""} sub="TSL minus baseline, per trade" />
              </div>
              <p className="text-[0.6875rem] text-muted-foreground">
                Descriptive, not causal: TSL trades are mostly the hand-journalled ones and the baseline mostly
                imports — the gap says what happened on this book, not what the trailing stop caused.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Stops that moved after entry</CardTitle>
          <Badge variant={migration.widenedTrades > 0 ? "warning" : "secondary"}>
            {migration.measured} trade{migration.measured === 1 ? "" : "s"} with a stop edit on record
          </Badge>
        </CardHeader>
        <CardContent className="space-y-3">
          {finding ? (
            <>
              <p className="text-sm">{finding}</p>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <KpiCard label="Trades widened" valueNum={migration.widenedTrades} format="int" valueClassName={migration.widenedTrades > 0 ? "text-warning" : ""} sub={`${migration.widenEvents} widening edit${migration.widenEvents === 1 ? "" : "s"}`} />
                <KpiCard label="Stops removed" valueNum={migration.removedTrades} format="int" valueClassName={migration.removedTrades > 0 ? "text-loss" : ""} sub="deleted after being set" />
                <KpiCard label="Worst single trade" value={migration.worstTradeWidenings > 0 ? `${migration.worstTradeWidenings}×` : "—"} sub="widenings on one position" />
                <KpiCard label="Widened expectancy" value={migration.expectancyWidened == null ? "—" : inr(migration.expectancyWidened, { decimals: 0 })} valueClassName={migration.expectancyWidened != null && migration.expectancyWidened < 0 ? "text-loss" : ""} sub={`vs ${migration.expectancyDisciplined == null ? "—" : inr(migration.expectancyDisciplined, { decimals: 0 })} untouched`} />
              </div>
            </>
          ) : migration.widenedTrades === 0 ? (
            <p className="text-sm text-muted-foreground">
              No stop on this book was ever widened after entry — on the record the audit trail holds.
              The journal stores only the FINAL stop, so this panel is mined from the audit log, and only
              staged-position stop edits reach it today; a stop changed through the plain editor leaves
              no before-image to mine.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {migration.widenedTrades} trade{migration.widenedTrades === 1 ? "" : "s"} had a stop widened, but
              that is below the sample this panel concludes on. It is counted here rather than dressed up as
              a pattern.
            </p>
          )}
          <p className="text-[0.6875rem] text-muted-foreground">
            Widening means moving the stop AWAY from entry — the edit that grows the loss already agreed to.
            The cost is stated as an expectancy gap against untouched trades, never as counterfactual P&amp;L:
            what the original stop &quot;would have saved&quot; needs a price path the journal does not have.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
