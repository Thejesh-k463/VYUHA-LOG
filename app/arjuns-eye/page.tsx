import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { KpiCard } from "@/components/kpi-card";
import { ProGate } from "@/components/system/pro-gate";
import { ExportButtons } from "@/components/ui/export-button";
import { getTrades } from "@/lib/queries/trades";
import {
  cockpitReport, SESSIONS, MIN_SAMPLE,
  type CockpitTrade, type Bucket, type Finding,
} from "@/lib/analytics/cockpit";
import { SEGMENT_LABELS } from "@/lib/domain/constants";
import { inr, num } from "@/lib/format";
import { Eye, TriangleAlert, CheckCircle2, Info, Clock } from "lucide-react";

export const dynamic = "force-dynamic";

const pnl = (v: number) => (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground");

/** A horizontal bar whose width is relative to the biggest absolute value in
 *  the set, so small differences stay visible instead of collapsing. */
function EdgeBar({ rows, empty }: { rows: Bucket[]; empty: string }) {
  if (rows.length === 0) return <p className="p-4 text-sm text-muted-foreground">{empty}</p>;
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
            <div className="w-16 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
              {r.trades}t
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FindingCard({ f }: { f: Finding }) {
  const Icon = f.tone === "good" ? CheckCircle2 : f.tone === "warn" ? TriangleAlert : Info;
  const tone =
    f.tone === "good" ? "border-profit/40 text-profit"
      : f.tone === "warn" ? "border-warning/45 text-warning"
        : "border-accent/40 text-accent";
  return (
    <div className={`flex items-start gap-3 rounded-lg border-l-2 bg-background/30 p-3 ${tone}`}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div>
        <div className="text-sm font-medium">{f.title}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{f.detail}</div>
      </div>
    </div>
  );
}

export default function ArjunsEyePage() {
  const trades = getTrades();

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

  return (
    <>
      <PageHeader
        title="Arjun's Eye"
        description="The trader's cockpit — what kind of trader you are, and where your edge actually comes from."
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
            <Card>
              <CardContent className="flex flex-col items-center gap-2 p-10 text-center">
                <Eye className="size-7 text-muted-foreground" />
                <p className="text-sm font-medium">Nothing to see yet</p>
                <p className="max-w-md text-xs text-muted-foreground">
                  Arjun&apos;s Eye reads your closed trades. Import a broker file and come back —
                  a <b>tradebook</b> import unlocks the time-of-day analysis, which a P&amp;L
                  statement cannot support.
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              {/* ── What it found ─────────────────────────────────────── */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><Eye className="size-4 text-primary" /> What the data says</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {rep.findings.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Not enough closed trades yet to say anything honestly. Findings need at least{" "}
                      <b>{MIN_SAMPLE}</b> trades in a group — a pattern drawn from fewer is noise,
                      and a journal that guesses once stops being worth trusting.
                    </p>
                  ) : (
                    rep.findings.map((f, i) => <FindingCard key={i} f={f} />)
                  )}
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
                            09:15–15:30 and belong to no session, so they are excluded from the bars
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
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[760px] text-sm">
                      <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 text-left">Segment</th>
                          <th className="px-3 py-2 text-right">Trades</th>
                          <th className="px-3 py-2 text-right">Net P&amp;L</th>
                          <th className="px-3 py-2 text-right">Expectancy</th>
                          <th className="px-3 py-2 text-right">Win rate</th>
                          <th className="px-3 py-2 text-right">Charges</th>
                          <th className="px-3 py-2 text-right">Charge drag</th>
                          <th className="px-3 py-2 text-right">Avg days</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/50">
                        {segments.map((s) => (
                          <tr key={s.key} className="hover:bg-card-hover/50">
                            <td className="px-3 py-2 font-medium">
                              {s.label}
                              {s.thin && <span className="ml-1.5 text-[10px] text-warning">thin</span>}
                            </td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums">{s.trades}</td>
                            <td className={`px-3 py-2 text-right font-mono tabular-nums ${pnl(s.netPnl)}`}>{inr(s.netPnl, { decimals: 0 })}</td>
                            <td className={`px-3 py-2 text-right font-mono tabular-nums ${pnl(s.expectancy ?? 0)}`}>{s.expectancy == null ? "—" : inr(s.expectancy, { decimals: 0 })}</td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">{s.winRate == null ? "—" : `${s.winRate.toFixed(0)}%`}</td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-warning">{inr(s.charges, { decimals: 0 })}</td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">{s.chargeDragPct == null ? "—" : `${s.chargeDragPct}%`}</td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">{s.avgDaysHeld == null ? "—" : num(s.avgDaysHeld, 1)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
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
                    <p className="text-[11px] text-muted-foreground">
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
                    <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-muted-foreground">
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
                      <p className="mt-3 text-[11px] text-muted-foreground">
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
            </>
          )}
        </ProGate>
      </div>
    </>
  );
}
