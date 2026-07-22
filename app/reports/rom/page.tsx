import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ExportButtons } from "@/components/ui/export-button";
import { KpiCard } from "@/components/kpi-card";
import { ProGate } from "@/components/system/pro-gate";
import { getTrades } from "@/lib/queries/trades";
import { getMarginRates } from "@/lib/queries/margin";
import { getPlaybooks } from "@/lib/queries/playbooks";
import { romReport, capitalEfficiencyVerdict, type RomTrade, type RomGroup } from "@/lib/analytics/rom";
import { SEGMENT_LABELS, type Segment } from "@/lib/domain/constants";
import { inr, num } from "@/lib/format";
import { TriangleAlert, Info } from "lucide-react";

export const dynamic = "force-dynamic";

const pnlCls = (v: number) => (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground");
const pct = (v: number | null, dp = 2) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(dp)}%`);

function GroupTable({ rows, empty }: { rows: RomGroup[]; empty: string }) {
  if (rows.length === 0) return <p className="p-4 text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-sm">
        <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left">Group</th>
            <th className="px-3 py-2 text-right">Trades</th>
            <th className="px-3 py-2 text-right">Net P&amp;L</th>
            <th className="px-3 py-2 text-right">Capital deployed</th>
            <th className="px-3 py-2 text-right">ROM</th>
            <th className="px-3 py-2 text-right">ROM / day</th>
            <th className="px-3 py-2 text-right">Annualised</th>
            <th className="px-3 py-2 text-right">Avg days</th>
            <th className="px-3 py-2 text-right">Win rate</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {rows.map((g) => (
            <tr key={g.key} className="hover:bg-card-hover/50">
              <td className="px-3 py-2 font-medium">{g.label}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">{g.trades}</td>
              <td className={`px-3 py-2 text-right font-mono tabular-nums ${pnlCls(g.netPnl)}`}>{inr(g.netPnl, { decimals: 0 })}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">{inr(g.totalCapital, { decimals: 0 })}</td>
              <td className={`px-3 py-2 text-right font-mono tabular-nums ${g.romPct != null ? pnlCls(g.romPct) : ""}`}>{pct(g.romPct)}</td>
              <td className={`px-3 py-2 text-right font-mono tabular-nums ${g.romPerDayPct != null ? pnlCls(g.romPerDayPct) : ""}`}>{pct(g.romPerDayPct, 3)}</td>
              <td className={`px-3 py-2 text-right font-mono tabular-nums ${g.annualisedDisplayPct != null ? pnlCls(g.annualisedDisplayPct) : ""}`}>
                {pct(g.annualisedDisplayPct, 1)}
                {g.annualisedIsExtrapolation && <span className="ml-1 text-[10px] text-warning" title="Linear extrapolation left the meaningful range — capped">*</span>}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">{num(g.avgDaysHeld, 1)}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">{g.winRate == null ? "—" : `${g.winRate.toFixed(0)}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function RomReportPage() {
  const trades = getTrades();
  const rates = getMarginRates();
  const playbooks = getPlaybooks();

  // Closed trades only — an open position has not finished using its capital,
  // so including it would report a return on money still at work.
  const closed: RomTrade[] = trades
    .filter((t) => !t.isOpen)
    .map((t) => ({
      id: t.id,
      symbol: t.symbol,
      broker: t.broker,
      bucket: t.bucket,
      segment: t.segment,
      instrumentType: t.instrumentType,
      optionType: t.optionType,
      strike: t.strike,
      buyQty: t.buyQty,
      avgBuyPrice: t.avgBuyPrice,
      buyValue: t.buyValue,
      sellQty: t.sellQty,
      avgSellPrice: t.avgSellPrice,
      sellValue: t.sellValue,
      netPnl: t.netPnl,
      buyDate: t.buyDate,
      sellDate: t.sellDate,
      playbookId: t.playbookId,
      setupTag: t.setupTag,
    }));

  const report = romReport(closed, rates, {
    segmentLabels: SEGMENT_LABELS as Record<string, string>,
    playbookNames: Object.fromEntries(playbooks.map((p) => [p.id, p.name])),
  });
  const verdict = capitalEfficiencyVerdict(report);
  const o = report.overall;

  const groupCols = [
    { key: "label" as const, label: "Group" },
    { key: "trades" as const, label: "Trades" },
    { key: "netPnl" as const, label: "Net P&L" },
    { key: "totalCapital" as const, label: "Capital deployed" },
    { key: "romPct" as const, label: "ROM %" },
    { key: "romPerDayPct" as const, label: "ROM %/day" },
    { key: "annualisedPct" as const, label: "Annualised % (raw)" },
    { key: "annualisedDisplayPct" as const, label: "Annualised % (capped)" },
    { key: "avgDaysHeld" as const, label: "Avg days" },
    { key: "winRate" as const, label: "Win rate %" },
  ];

  return (
    <>
      <PageHeader
        title="Return on Margin"
        description="What your capital actually earned while it was tied up — not return on turnover."
      />
      <div className="space-y-5 p-6">
        <ProGate>
          {/* ── Headline ───────────────────────────────────────────────── */}
          <section className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <KpiCard
              label="Closed trades"
              value={o.trades}
              sub={report.skipped > 0 ? `${report.skipped} skipped` : "all priced"}
            />
            <KpiCard
              label="Net P&L"
              value={inr(o.netPnl, { decimals: 0 })}
              valueClassName={pnlCls(o.netPnl)}
            />
            <KpiCard
              label="Capital deployed"
              value={inr(o.totalCapital, { decimals: 0 })}
              sub="sum of capital blocked"
            />
            <KpiCard
              label="ROM"
              value={pct(o.romPct)}
              valueClassName={o.romPct != null ? pnlCls(o.romPct) : ""}
              sub="P&L ÷ capital blocked"
            />
            <KpiCard
              label="ROM / day"
              value={pct(o.romPerDayPct, 3)}
              valueClassName={o.romPerDayPct != null ? pnlCls(o.romPerDayPct) : ""}
              sub={o.annualisedDisplayPct != null ? `${pct(o.annualisedDisplayPct, 0)}${o.annualisedIsExtrapolation ? "*" : ""} annualised` : "—"}
            />
          </section>

          {verdict && (
            <Card>
              <CardContent className="flex items-start gap-2.5 p-4 text-sm">
                <Info className="mt-0.5 size-4 shrink-0 text-accent" />
                <span>{verdict}</span>
              </CardContent>
            </Card>
          )}

          {report.missingRates.length > 0 && (
            <Card className="border-warning/40">
              <CardContent className="flex items-start gap-2.5 p-4 text-sm">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                <span>
                  No margin rate configured for{" "}
                  <span className="font-mono">{report.missingRates.join(", ")}</span> — 100% of value was
                  assumed, which <b>understates</b> ROM for those trades. Set the real rates in{" "}
                  <b>Settings → Margin</b> and this page recomputes.
                </span>
              </CardContent>
            </Card>
          )}

          {/* ── By segment ─────────────────────────────────────────────── */}
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>By segment — where capital works hardest</CardTitle>
              <ExportButtons filename="rom-by-segment" columns={groupCols} rows={report.bySegment} />
            </CardHeader>
            <CardContent className="p-0">
              <GroupTable rows={report.bySegment} empty="No closed trades yet." />
            </CardContent>
          </Card>

          {/* ── By playbook ────────────────────────────────────────────── */}
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>By playbook</CardTitle>
              <ExportButtons filename="rom-by-playbook" columns={groupCols} rows={report.byPlaybook} />
            </CardHeader>
            <CardContent className="p-0">
              <GroupTable rows={report.byPlaybook} empty="Tag trades to a playbook to see which setups use capital best." />
            </CardContent>
          </Card>

          {/* ── Leaderboard ────────────────────────────────────────────── */}
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Most capital-efficient trades</CardTitle>
              <Badge variant="secondary">top 25 by ROM/day</Badge>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-sm">
                  <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left">Symbol</th>
                      <th className="px-3 py-2 text-left">Segment</th>
                      <th className="px-3 py-2 text-left">Side</th>
                      <th className="px-3 py-2 text-right">Net P&amp;L</th>
                      <th className="px-3 py-2 text-right">Capital</th>
                      <th className="px-3 py-2 text-right">Days</th>
                      <th className="px-3 py-2 text-right">ROM</th>
                      <th className="px-3 py-2 text-right">ROM / day</th>
                      <th className="px-3 py-2 text-left">Basis</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {report.rows.slice(0, 25).map((r) => (
                      <tr key={r.id} className="hover:bg-card-hover/50">
                        <td className="px-3 py-2 font-medium">{r.symbol}</td>
                        <td className="px-3 py-2 text-muted-foreground">{SEGMENT_LABELS[r.segment as Segment] ?? r.segment}</td>
                        <td className="px-3 py-2">
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${r.side === "short" ? "bg-loss/15 text-loss" : "bg-profit/15 text-profit"}`}>
                            {r.side === "short" ? "Short" : "Long"}
                          </span>
                        </td>
                        <td className={`px-3 py-2 text-right font-mono tabular-nums ${pnlCls(r.netPnl)}`}>{inr(r.netPnl, { decimals: 0 })}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">{inr(r.capital, { decimals: 0 })}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">{r.daysHeld}</td>
                        <td className={`px-3 py-2 text-right font-mono tabular-nums ${r.romPct != null ? pnlCls(r.romPct) : ""}`}>{pct(r.romPct)}</td>
                        <td className={`px-3 py-2 text-right font-mono tabular-nums ${r.romPerDayPct != null ? pnlCls(r.romPerDayPct) : ""}`}>{pct(r.romPerDayPct, 3)}</td>
                        <td className="px-3 py-2 text-[11px] text-muted-foreground">
                          {r.basis}
                          {r.rateAssumed && <span className="ml-1 text-warning">⚠ assumed</span>}
                        </td>
                      </tr>
                    ))}
                    {report.rows.length === 0 && (
                      <tr>
                        <td colSpan={9} className="p-4 text-sm text-muted-foreground">
                          No closed trades with establishable capital yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* ── How it is computed ─────────────────────────────────────── */}
          <Card>
            <CardHeader><CardTitle>How capital blocked is calculated</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>
                The denominator is what was <b>actually tied up</b>, using the same rule as the live margin
                cockpit — so the two views can never disagree:
              </p>
              <ul className="ml-4 list-disc space-y-1">
                <li><b>Long options</b> — the premium paid. They block no SPAN margin, so charging them notional × margin% would invent a requirement that never existed.</li>
                <li><b>Short options</b> — margin against the <b>underlying</b> notional, not the premium. This is why a ₹10,000 credit can tie up ₹1.5 lakh.</li>
                <li><b>Futures &amp; intraday equity</b> — your configured margin % of contract value.</li>
                <li><b>MTF</b> — your own capital only; the broker-funded portion is not yours to count.</li>
                <li><b>Delivery</b> — the full invested value.</li>
              </ul>
              <p>
                <b>ROM/day</b> is weighted by <b>capital-days</b>: ₹1 lakh held for ten days is ten times the
                commitment of ₹1 lakh held for one, and the per-day figure reflects that rather than averaging
                trades equally.
              </p>
              <p>
                <b>Annualised figures marked *</b> were capped. Annualising is a linear extrapolation
                (per-day × 365) and stops meaning anything at the extremes — a book of one-day option
                trades losing 10%/day extrapolates to −3,887%, which is arithmetically correct and
                completely impossible, because you cannot lose more than the capital you put up. The
                downside is floored at −100% and the upside at +1,000%; the uncapped value is still in
                the CSV/XLSX export.
              </p>
              <p>
                Individual trades deliberately show <b>no annualised figure</b> — annualising a single
                intraday scalp produces headline numbers that are arithmetically true and practically
                meaningless. Annualisation appears only in the rollups, where the sample supports it.
              </p>
              <p className="text-xs">
                Informational only. Margin figures are estimates from your editable rate table, not your
                broker&apos;s actual SPAN + exposure calculation — your broker&apos;s RMS remains the source of truth.
              </p>
            </CardContent>
          </Card>
        </ProGate>
      </div>
    </>
  );
}
