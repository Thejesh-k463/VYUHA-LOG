import { todayIstIso } from "@/lib/domain/trading-day";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { KpiCard } from "@/components/kpi-card";
import { getTrades } from "@/lib/queries/trades";
import { computeExpiryStats, type ExpiryBucket } from "@/lib/analytics/expiry-stats";
import { inr, fmtDate, signOf } from "@/lib/format";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { EmptyState } from "@/components/ui/empty-state";

// v4.6.0 W3 — the body of the old /reports/expiry screen, now the Capital &
// Expiry hub's Expiry tab. The hub page (../page.tsx) owns the page header and
// the Pro gate; the header's "N expiry days seen" badge is data this body
// computes, so it moved into the body's first row, unchanged.

function BucketCard({ b, highlight }: { b: ExpiryBucket; highlight?: boolean }) {
  const tone = b.net > 0 ? "text-profit" : b.net < 0 ? "text-loss" : "text-muted-foreground";
  return (
    <Card className={highlight ? "border-accent/40" : ""}>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{b.label}</CardTitle>
        <Badge variant="secondary">{b.trades} trades</Badge>
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-bold tabular-nums ${tone}`}>{inr(b.net, { decimals: 0 })}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {b.winRatePct == null ? "—" : `${b.winRatePct}%`} win · avg {inr(b.avgPerTrade, { decimals: 0 })}/trade · {b.wins}W / {b.losses}L
        </div>
      </CardContent>
    </Card>
  );
}

export function ExpiryTab() {
  const today = todayIstIso();
  const trades = getTrades();
  const s = computeExpiryStats(
    trades.map((t) => ({ segment: t.segment, expiry: t.expiry, sellDate: t.sellDate, isOpen: t.isOpen, netPnl: t.netPnl })),
    today,
  );
  const closedFno = s.expiryDay.trades + s.nonExpiry.trades;

  return (
    <>
        <div className="flex justify-end"><Badge variant="secondary">{s.expiryDates.length} expiry days seen</Badge></div>
        {closedFno === 0 && s.upcoming.length === 0 ? (
          <EmptyState
            variant="chart"
            title="No F&O trades yet"
            hint="This view activates once you trade derivatives."
          />
        ) : (
          <>
            <Card className="p-0">
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>Upcoming expiries (open positions)</CardTitle>
                {s.upcoming.length > 0 ? <Badge variant="warning">{s.upcoming.length}</Badge> : <Badge variant="secondary">none</Badge>}
              </CardHeader>
              <CardContent className="p-0">
                {s.upcoming.length === 0 ? (
                  <EmptyState
                    variant="journal"
                    title="No open F&O positions with a future expiry"
                  />
                ) : (
                  <ReportTable>
                    <ReportThead>
                      <ReportTh>Expiry</ReportTh>
                      <ReportTh align="right">In</ReportTh>
                      <ReportTh align="right">Open positions</ReportTh>
                    </ReportThead>
                    <tbody>
                      {s.upcoming.map((u) => (
                        <ReportTr key={u.date}>
                          <ReportTd className="font-medium">{fmtDate(u.date)}</ReportTd>
                          <ReportTd className="text-right">
                            <Badge variant={u.dte <= 3 ? "loss" : u.dte <= 7 ? "warning" : "secondary"}>{u.dte}d</Badge>
                          </ReportTd>
                          <ReportTd align="right">{u.positions}</ReportTd>
                        </ReportTr>
                      ))}
                    </tbody>
                  </ReportTable>
                )}
              </CardContent>
            </Card>

            <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <KpiCard label="Expiry-day concentration" value={s.concentrationPct == null ? "—" : `${s.concentrationPct}%`} sub={`${s.expiryDay.trades} of ${closedFno} F&O exits`} />
              <KpiCard
                label="Expiry edge"
                value={s.netEdgeExpiry == null ? "—" : `${signOf(s.netEdgeExpiry)}${inr(Math.abs(s.netEdgeExpiry), { decimals: 0 })}`}
                valueClassName={s.netEdgeExpiry == null ? "" : s.netEdgeExpiry > 0 ? "text-profit" : s.netEdgeExpiry < 0 ? "text-loss" : ""}
                sub="avg/trade vs other days"
              />
              <KpiCard label="Expiry-day net" valueNum={s.expiryDay.net} format="inr0" valueClassName={s.expiryDay.net >= 0 ? "text-profit" : "text-loss"} sub={`${s.expiryDay.trades} trades`} />
              <KpiCard label="Other-day net" valueNum={s.nonExpiry.net} format="inr0" valueClassName={s.nonExpiry.net >= 0 ? "text-profit" : "text-loss"} sub={`${s.nonExpiry.trades} trades`} />
            </section>

            <div className="grid gap-3 md:grid-cols-2">
              <BucketCard b={s.expiryDay} highlight />
              <BucketCard b={s.nonExpiry} />
            </div>

            <p className="text-[0.6875rem] text-muted-foreground">
              The expiry calendar is derived from the distinct expiry dates across your own F&O trades — a closed trade
              whose exit date lands on one of those days counts as an expiry-day trade. Pair with the Surveillance and
              physical-settlement panels on Portfolio Risk before each expiry.
            </p>
          </>
        )}
    </>
  );
}
