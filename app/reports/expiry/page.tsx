import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { KpiCard } from "@/components/kpi-card";
import { getTrades } from "@/lib/queries/trades";
import { computeExpiryStats, type ExpiryBucket } from "@/lib/analytics/expiry-stats";
import { inr, fmtDate } from "@/lib/format";

export const dynamic = "force-dynamic";

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
          {b.winRatePct}% win · avg {inr(b.avgPerTrade, { decimals: 0 })}/trade · {b.wins}W / {b.losses}L
        </div>
      </CardContent>
    </Card>
  );
}

export default function ExpiryPage() {
  const today = new Date().toISOString().slice(0, 10);
  const trades = getTrades();
  const s = computeExpiryStats(
    trades.map((t) => ({ segment: t.segment, expiry: t.expiry, sellDate: t.sellDate, isOpen: t.isOpen, netPnl: t.netPnl })),
    today,
  );
  const closedFno = s.expiryDay.trades + s.nonExpiry.trades;

  return (
    <>
      <PageHeader
        title="Expiry analytics"
        description="How your F&O P&L splits between expiry days and the rest — and what's expiring next."
        actions={<Badge variant="secondary">{s.expiryDates.length} expiry days seen</Badge>}
      />
      <div className="space-y-5 p-6">
        {closedFno === 0 && s.upcoming.length === 0 ? (
          <Card><CardContent className="p-6 text-sm text-muted-foreground">No F&O trades yet — this view activates once you trade derivatives.</CardContent></Card>
        ) : (
          <>
            <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <KpiCard label="Expiry-day concentration" value={`${s.concentrationPct}%`} sub={`${s.expiryDay.trades} of ${closedFno} F&O exits`} />
              <KpiCard
                label="Expiry edge"
                value={`${s.netEdgeExpiry >= 0 ? "+" : ""}${inr(s.netEdgeExpiry, { decimals: 0 })}`}
                valueClassName={s.netEdgeExpiry > 0 ? "text-profit" : s.netEdgeExpiry < 0 ? "text-loss" : ""}
                sub="avg/trade vs other days"
              />
              <KpiCard label="Expiry-day net" value={inr(s.expiryDay.net, { decimals: 0 })} valueClassName={s.expiryDay.net >= 0 ? "text-profit" : "text-loss"} sub={`${s.expiryDay.trades} trades`} />
              <KpiCard label="Other-day net" value={inr(s.nonExpiry.net, { decimals: 0 })} valueClassName={s.nonExpiry.net >= 0 ? "text-profit" : "text-loss"} sub={`${s.nonExpiry.trades} trades`} />
            </section>

            <div className="grid gap-3 md:grid-cols-2">
              <BucketCard b={s.expiryDay} highlight />
              <BucketCard b={s.nonExpiry} />
            </div>

            <Card className="p-0">
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>Upcoming expiries (open positions)</CardTitle>
                {s.upcoming.length > 0 ? <Badge variant="warning">{s.upcoming.length}</Badge> : <Badge variant="secondary">none</Badge>}
              </CardHeader>
              <CardContent className="p-0">
                {s.upcoming.length === 0 ? (
                  <p className="p-5 text-sm text-muted-foreground">No open F&O positions with a future expiry.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-y border-border text-left text-muted-foreground">
                          <th className="px-2.5 py-2 font-medium">Expiry</th>
                          <th className="px-2 py-2 text-right font-medium">In</th>
                          <th className="px-2.5 py-2 text-right font-medium">Open positions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.upcoming.map((u) => (
                          <tr key={u.date} className="border-b border-border/40">
                            <td className="px-2.5 py-2 font-medium">{fmtDate(u.date)}</td>
                            <td className="px-2 py-2 text-right">
                              <Badge variant={u.dte <= 3 ? "loss" : u.dte <= 7 ? "warning" : "secondary"}>{u.dte}d</Badge>
                            </td>
                            <td className="px-2.5 py-2 text-right tabular-nums">{u.positions}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>

            <p className="text-[11px] text-muted-foreground">
              The expiry calendar is derived from the distinct expiry dates across your own F&O trades — a closed trade
              whose exit date lands on one of those days counts as an expiry-day trade. Pair with the Surveillance and
              physical-settlement panels on Portfolio Risk before each expiry.
            </p>
          </>
        )}
      </div>
    </>
  );
}
