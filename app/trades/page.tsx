import { PageHeader } from "@/components/layout/page-header";
import { KpiCard } from "@/components/kpi-card";
import { TradesClient } from "@/components/trades/trades-client";
import { getTrades, getTradeStats } from "@/lib/queries/trades";
import { getPlaybooks } from "@/lib/queries/playbooks";
import { getMtfMarginByBroker } from "@/lib/queries/margin";
import { inr } from "@/lib/format";
import { AcquisitionPanel, type PendingBasisTrade } from "@/components/trades/acquisition-panel";
import { summariseAcquisitions, ipoAllottedPnl, hasKnownBasis } from "@/lib/analytics/acquisition";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default function TradesPage() {
  const trades = getTrades();
  const stats = getTradeStats();
  const chargePct = stats.gross !== 0 ? (stats.charges / Math.abs(stats.gross)) * 100 : 0;

  // Sales whose purchase is not in the data — resolved here, at the top, because
  // every hour they stay unresolved is an hour the edge statistics are wrong.
  const basisRows = trades.map((t) => ({
    id: t.id, symbol: t.symbol, sellValue: t.sellValue, buyValue: t.buyValue,
    sellQty: t.sellQty, netPnl: t.netPnl, chargesTotal: t.chargesTotal, sellDate: t.sellDate,
    acquisition: t.acquisition, acquisitionPrice: t.acquisitionPrice, acquisitionDate: t.acquisitionDate,
  }));
  const pending: PendingBasisTrade[] = trades
    .filter((t) => !hasKnownBasis(t))
    .map((t) => ({
      id: t.id, symbol: t.symbol, sellQty: t.sellQty, sellValue: t.sellValue,
      sellDate: t.sellDate, chargesTotal: t.chargesTotal,
      acquisition: t.acquisition, acquisitionPrice: t.acquisitionPrice,
      suggestedPrice: t.suggestedBasisPrice ?? null,
    }));
  const acq = summariseAcquisitions(basisRows);
  const ipo = ipoAllottedPnl(basisRows);

  return (
    <>
      <PageHeader title="Trades" description="The journal — every leg with charges, R-multiple and tags." />
      <div className="space-y-5 p-6">
        <section className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <KpiCard label="Trades" value={stats.count} sub={`${stats.open} open`} />
          <KpiCard label="Net P&L" value={inr(stats.net, { decimals: 0 })} valueClassName={stats.net >= 0 ? "text-profit" : "text-loss"} />
          <KpiCard label="Gross P&L" value={inr(stats.gross, { decimals: 0 })} valueClassName={stats.gross >= 0 ? "text-profit" : "text-loss"} />
          <KpiCard label="Total charges" value={inr(stats.charges, { decimals: 0 })} valueClassName="text-warning" />
          <KpiCard label="Charges / gross" value={`${chargePct.toFixed(1)}%`} sub="charge leak" />
        </section>
        <AcquisitionPanel trades={pending} />

        {/* IPO-allotted P&L, reported APART from trading edge. A listing-day
            pop is not a repeatable skill, and folding it into expectancy would
            overstate how well the trader actually trades. */}
        {(ipo.trades > 0 || ipo.pending > 0) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">IPO allotments — tracked separately</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                Listing gains are not a repeatable trading edge, so they are reported here rather than
                blended into expectancy and win rate. They remain part of your overall Net P&amp;L.
              </p>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
                <KpiCard label="Allotments sold" value={ipo.trades} sub={ipo.pending > 0 ? `${ipo.pending} awaiting a price` : "all priced"} />
                <KpiCard label="Proceeds" value={inr(ipo.proceeds, { decimals: 0 })} />
                <KpiCard label="Issue cost" value={inr(ipo.cost, { decimals: 0 })} />
                <KpiCard label="Charges" value={inr(ipo.charges, { decimals: 0 })} valueClassName="text-warning" />
                <KpiCard label="Net from IPOs" value={inr(ipo.netPnl, { decimals: 0 })} valueClassName={ipo.netPnl >= 0 ? "text-profit" : "text-loss"} />
              </div>
              {acq.pending > 0 && (
                <p className="mt-3 text-xs text-warning">
                  {acq.pending} sale{acq.pending === 1 ? "" : "s"} worth {inr(acq.pendingProceeds, { decimals: 0 })} still
                  {acq.pending === 1 ? " has" : " have"} no cost on record and {acq.pending === 1 ? "is" : "are"} excluded
                  from the totals above and from every edge statistic.
                </p>
              )}
            </CardContent>
          </Card>
        )}

        <TradesClient
          trades={trades}
          playbooks={getPlaybooks().map((p) => ({ id: p.id, name: p.name, archived: p.archived, rules: p.rules }))}
          mtfMarginByBroker={getMtfMarginByBroker()}
        />
      </div>
    </>
  );
}
