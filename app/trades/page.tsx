import { PageHeader } from "@/components/layout/page-header";
import { KpiCard } from "@/components/kpi-card";
import { TradesClient } from "@/components/trades/trades-client";
import { toSlimTrade } from "@/lib/domain/slim-trade";
import { getJournalTrades, tradeStatsOf } from "@/lib/queries/trades";
import { getTradesPage, countTrades } from "@/lib/queries/trades-page";
import { EMPTY_TRADE_FILTERS, type TradeFilters } from "@/lib/domain/trades-filter";
import { parseTradesQuery } from "@/lib/domain/trades-query";
import { defaultBucket } from "@/lib/domain/workspace";
import { getAttachmentCounts } from "@/lib/queries/trades";
import { getEntitlement } from "@/lib/queries/license";
import { getPlaybooks } from "@/lib/queries/playbooks";
import { getMtfMarginByBroker } from "@/lib/queries/margin";
import { getSettings } from "@/lib/queries/settings";
import { asWorkspace } from "@/lib/domain/workspace";
import { inr } from "@/lib/format";
import { AcquisitionPanel, type PendingBasisTrade } from "@/components/trades/acquisition-panel";
import { UnmarkedHoldingsPanel, type UnmarkedHolding } from "@/components/trades/unmarked-holdings-panel";
import { getIpoTradeLinks } from "@/lib/queries/ipos";
import { getAccounts, isAggregateView } from "@/lib/queries/accounts";
import { isMarked } from "@/lib/analytics/trade-status";
import { situationFingerprint } from "@/lib/domain/dismissals";
import { panelHidden } from "@/lib/queries/dismissals";
import { summariseAcquisitions, ipoAllottedPnl, hasKnownBasis } from "@/lib/analytics/acquisition";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function TradesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The deep-link query, read on the SERVER (v3.9).
  //
  // The client used to restore these filters in a mount microtask, which was
  // free while it held the whole book. Now the server decides which page to
  // send, so it has to know the filters BEFORE it queries — otherwise a
  // `?view=open-loss` link would paint 500 unrelated rows and then swap them.
  // Same parser as the client (lib/domain/trades-query.ts), so the two cannot
  // read one href two ways.
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") qs.set(k, v);
  const link = parseTradesQuery(qs.toString());
  // Wire shape + acquisition fields selected in SQL — same rows, order and
  // values as getTrades(), without mapping the 74-column row to use 47
  // (perf sweep 2026-08-29). The KPI strip reduces over the same rows in the
  // same order, so its floats are bit-identical to getTradeStats().
  const trades = getJournalTrades();
  // A6 — only the aggregate view leaves "which account?" unanswered.
  const writeAccounts = isAggregateView() ? getAccounts().filter((a) => !a.archived).map((a) => ({ id: a.id, name: a.name })) : [];
  const stats = tradeStatsOf(trades);
  const workspace = asWorkspace(getSettings()?.workspace);
  // The bucket filter's default comes from the workspace — the CLIENT applied
  // it before v3.9, so the server has to apply the same one or the first page
  // would not be the page the user is about to see.
  const filters: TradeFilters = {
    ...EMPTY_TRADE_FILTERS,
    q: link.symbol,
    segment: link.segment,
    bucket: defaultBucket(workspace),
    view: link.view ?? "all",
    realised: link.realised,
    basisUnknown: link.basis === "unknown",
    from: link.from,
    to: link.to,
  };
  // One page of rows (500) instead of the whole book across the RSC stream,
  // plus the whole-set counts that go around it.
  const firstPage = getTradesPage(filters);
  const bookTotal = countTrades({ ...EMPTY_TRADE_FILTERS });
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

  // Open positions with NO mark. They have no unrealised result, so they sit
  // outside the gain/loss views — and when they also have no cost, they are
  // almost always an IPO allotment, which is credited without ever appearing
  // as a buy.
  const ipoLinks = getIpoTradeLinks();
  const unmarked: UnmarkedHolding[] = trades
    .filter((t) => t.isOpen && !isMarked(t))
    .map((t) => ({
      id: t.id, symbol: t.symbol, buyQty: t.buyQty, buyValue: t.buyValue,
      buyDate: t.buyDate, acquisition: t.acquisition,
      ipoId: ipoLinks.get(t.id) ?? null,
    }));
  const ipo = ipoAllottedPnl(basisRows);

  // Dismiss-with-memory: the fingerprint is THIS set of unmarked holdings.
  // Dismissing hides the panel until the set changes, then it returns.
  const unmarkedFp = situationFingerprint(unmarked.map((h) => `${h.id}:${h.buyQty}`));
  const unmarkedHidden = unmarked.length > 0 && panelHidden("unmarked-holdings", unmarkedFp);

  return (
    <>
      <PageHeader title="Trades" description="The journal — every leg with charges, R-multiple and tags." />
      <div className="space-y-5 p-6">
        <section className="grid grid-cols-2 gap-4 xl:grid-cols-5">
          <KpiCard label="Trades" valueNum={stats.count} format="int" sub={`${stats.open} open`} />
          <KpiCard label="Net P&L" valueNum={stats.net} format="inr0" valueClassName={stats.net >= 0 ? "text-profit" : "text-loss"} />
          <KpiCard label="Gross P&L" valueNum={stats.gross} format="inr0" valueClassName={stats.gross >= 0 ? "text-profit" : "text-loss"} />
          <KpiCard label="Total charges" valueNum={stats.charges} format="inr0" valueClassName="text-grad-gold" />
          <KpiCard label="Charges / gross" value={`${chargePct.toFixed(1)}%`} sub="charge leak" />
        </section>
        <AcquisitionPanel trades={pending} />

        {!unmarkedHidden && <UnmarkedHoldingsPanel holdings={unmarked} fingerprint={unmarkedFp} />}

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
                <KpiCard label="Allotments sold" valueNum={ipo.trades} format="int" sub={ipo.pending > 0 ? `${ipo.pending} awaiting a price` : "all priced"} />
                <KpiCard label="Proceeds" valueNum={ipo.proceeds} format="inr0" />
                <KpiCard label="Issue cost" valueNum={ipo.cost} format="inr0" />
                <KpiCard label="Charges" valueNum={ipo.charges} format="inr0" valueClassName="text-grad-gold" />
                <KpiCard label="Net from IPOs" valueNum={ipo.netPnl} format="inr0" valueClassName={ipo.netPnl >= 0 ? "text-profit" : "text-loss"} />
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
          initialRows={firstPage.rows.map(toSlimTrade)}
          initialCursor={firstPage.nextCursor}
          initialTotal={firstPage.total}
          initialViewCounts={firstPage.viewCounts}
          initialFilters={filters}
          bookTotal={bookTotal}
          // `?basis=unknown` filters to exactly the rows the AcquisitionPanel
          // above lists — same `hasKnownBasis` verdict, ids only, so the slim
          // wire shape does not widen by two columns per row.
          unknownBasisIds={pending.map((t) => t.id)}
          playbooks={getPlaybooks().map((p) => ({ id: p.id, name: p.name, archived: p.archived, rules: p.rules }))}
          mtfMarginByBroker={getMtfMarginByBroker()}
          writeAccounts={writeAccounts}
          attachmentCounts={Object.fromEntries(getAttachmentCounts())}
          pro={getEntitlement().pro}
        />
      </div>
    </>
  );
}
