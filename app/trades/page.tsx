import { PageHeader } from "@/components/layout/page-header";
import { KpiCard } from "@/components/kpi-card";
import { TradesClient } from "@/components/trades/trades-client";
import { getTrades, getTradeStats } from "@/lib/queries/trades";
import { getPlaybooks } from "@/lib/queries/playbooks";
import { inr } from "@/lib/format";

export const dynamic = "force-dynamic";

export default function TradesPage() {
  const trades = getTrades();
  const stats = getTradeStats();
  const chargePct = stats.gross !== 0 ? (stats.charges / Math.abs(stats.gross)) * 100 : 0;

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
        <TradesClient trades={trades} playbooks={getPlaybooks().map((p) => ({ id: p.id, name: p.name, archived: p.archived }))} />
      </div>
    </>
  );
}
