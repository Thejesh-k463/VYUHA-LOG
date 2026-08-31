import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { inr, num } from "@/lib/format";
import type {
  BucketStat,
  ExitClockReport,
  FragmentationReport,
  HoldingClockReport,
  TriggerReport,
} from "@/lib/analytics/exit-behaviour";

/**
 * Exits tab — the four exit-behaviour analytics (built 2026-08-30, surfaced
 * here for the first time). Each card leads with its own coverage/exclusion
 * counts: every one of these is computed on the subset of trades that carry
 * the field, and rows that lack it are excluded and counted, never bucketed.
 */

const pnl = (v: number) => (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground");

function StatRows({ rows }: { rows: BucketStat[] }) {
  return (
    <tbody>
      {rows.map((b) => (
        <ReportTr key={b.key}>
          <ReportTd className="font-medium">{b.key}</ReportTd>
          <ReportTd align="right">{b.count}</ReportTd>
          <ReportTd align="right" className={pnl(b.net)}>{inr(b.net, { decimals: 0 })}</ReportTd>
          <ReportTd align="right" muted>{num(b.winRate * 100, 0)}%</ReportTd>
          <ReportTd align="right" className={pnl(b.expectancy)}>{inr(b.expectancy, { decimals: 0 })}</ReportTd>
        </ReportTr>
      ))}
    </tbody>
  );
}

const STAT_HEAD = (
  <ReportThead>
    <ReportTh>Bucket</ReportTh>
    <ReportTh align="right">Trades</ReportTh>
    <ReportTh align="right">Net P&L</ReportTh>
    <ReportTh align="right">Win rate</ReportTh>
    <ReportTh align="right">Expectancy</ReportTh>
  </ReportThead>
);

export function ExitsTab({
  clock,
  holding,
  frag,
  triggers,
}: {
  clock: ExitClockReport;
  holding: HoldingClockReport;
  frag: FragmentationReport;
  triggers: TriggerReport;
}) {
  return (
    <div className="space-y-5">
      {/* ── The exit clock ──────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>When you exit — edge by closing session</CardTitle>
          <Badge variant={clock.withTime > 0 ? "secondary" : "warning"}>
            {clock.withTime} timed · {clock.withoutTime} untimed
          </Badge>
        </CardHeader>
        <CardContent className={clock.bands.length > 0 ? "p-0" : undefined}>
          {clock.withTime === 0 ? (
            <p className="text-sm text-muted-foreground">
              No closed trade carries an exit time — a P&amp;L import has none, a tradebook does. The mirror
              of the entry-side session chart on the Cockpit tab: most damage is done at the exit, and this
              card starts working the moment timed trades arrive.
            </p>
          ) : (
            <>
              <ReportTable minWidth={560}>
                {STAT_HEAD}
                <StatRows rows={clock.bands} />
              </ReportTable>
              <p className="px-4 py-3 text-[0.6875rem] text-muted-foreground">
                Same session bands as the entry-side chart, so the two are directly comparable.
                {clock.offHours > 0 && (
                  <span className="text-warning">
                    {" "}{clock.offHours} timed exit{clock.offHours === 1 ? "" : "s"} fall outside 09:15–15:30 and belong to no
                    session — excluded from the bands, worth checking the import.
                  </span>
                )}
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Time in trade ───────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>How long an intraday position lives</CardTitle>
          <Badge variant={holding.measured > 0 ? "secondary" : "warning"}>
            {holding.measured} measured · {holding.unmeasurable} missing a time
          </Badge>
        </CardHeader>
        <CardContent className={holding.buckets.length > 0 ? "p-0" : undefined}>
          {holding.measured === 0 ? (
            <p className="text-sm text-muted-foreground">
              Needs same-day positions with BOTH an entry and an exit time. Multi-day holding periods are
              covered in days on the Cockpit tab — clock times cannot be subtracted across days.
            </p>
          ) : (
            <>
              <ReportTable minWidth={560}>
                {STAT_HEAD}
                <StatRows rows={holding.buckets} />
              </ReportTable>
              <p className="px-4 py-3 text-[0.6875rem] text-muted-foreground">
                Same-day positions only, minutes between first fill in and exit.
                {holding.unmeasurable > 0 && <> {holding.unmeasurable} intraday position{holding.unmeasurable === 1 ? "" : "s"} lack one of the two times and are excluded, not guessed.</>}
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Order fragmentation ─────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Fills per position — hesitation made visible</CardTitle>
          <Badge variant="secondary">
            {frag.measured} measured{frag.medianFills != null && <> · median {num(frag.medianFills, frag.medianFills % 1 ? 1 : 0)} fills</>}
          </Badge>
        </CardHeader>
        <CardContent className={frag.buckets.length > 0 ? "p-0" : undefined}>
          {frag.measured === 0 ? (
            <p className="text-sm text-muted-foreground">No closed trade carries order counts on both sides.</p>
          ) : (
            <>
              <ReportTable minWidth={560}>
                {STAT_HEAD}
                <StatRows rows={frag.buckets} />
              </ReportTable>
              <p className="px-4 py-3 text-[0.6875rem] text-muted-foreground">
                Executed orders in plus out, per position. Every fill paid brokerage — the cost already sits in
                the charges; this is the habit that produced it.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Why the trade was closed ────────────────────────────────── */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Why trades were closed, and what each reason captured</CardTitle>
          <Badge variant={triggers.answered > 0 ? "secondary" : "warning"}>
            {triggers.answered} answered · {triggers.unanswered} unrecorded
          </Badge>
        </CardHeader>
        <CardContent className={triggers.rows.length > 0 ? "p-0" : undefined}>
          {triggers.answered === 0 ? (
            <p className="text-sm text-muted-foreground">
              No closed trade records an exit reason yet. The trade editor offers a list (target hit, stop hit,
              panic, …) — once filled in, this card crosses the reason with how much of the favourable move the
              exit actually captured.
            </p>
          ) : (
            <>
              <ReportTable minWidth={640}>
                <ReportThead>
                  <ReportTh>Exit reason</ReportTh>
                  <ReportTh align="right">Trades</ReportTh>
                  <ReportTh align="right">Net P&L</ReportTh>
                  <ReportTh align="right">Win rate</ReportTh>
                  <ReportTh align="right">Expectancy</ReportTh>
                  <ReportTh align="right">Move captured</ReportTh>
                </ReportThead>
                <tbody>
                  {triggers.rows.map((r) => (
                    <ReportTr key={r.key}>
                      <ReportTd className="font-medium">{r.key}</ReportTd>
                      <ReportTd align="right">{r.count}</ReportTd>
                      <ReportTd align="right" className={pnl(r.net)}>{inr(r.net, { decimals: 0 })}</ReportTd>
                      <ReportTd align="right" muted>{num(r.winRate * 100, 0)}%</ReportTd>
                      <ReportTd align="right" className={pnl(r.expectancy)}>{inr(r.expectancy, { decimals: 0 })}</ReportTd>
                      <ReportTd align="right" muted>
                        {r.avgCapturedPct == null ? "—" : `${num(r.avgCapturedPct, 0)}%`}
                        {r.capturedFrom > 0 && <span className="ml-1 text-[10px]">({r.capturedFrom} measured)</span>}
                      </ReportTd>
                    </ReportTr>
                  ))}
                </tbody>
              </ReportTable>
              <p className="px-4 py-3 text-[0.6875rem] text-muted-foreground">
                &quot;Move captured&quot; is the share of the best favourable excursion the exit banked, at EOD
                granularity, over the rows with price-history coverage.
                {triggers.unanswered > 0 && <> {triggers.unanswered} closed trade{triggers.unanswered === 1 ? "" : "s"} record no reason and are excluded — an unanswered question is not an answer.</>}
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
