import { todayIstIso } from "@/lib/domain/trading-day";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { KpiCard } from "@/components/kpi-card";
import { getTrades } from "@/lib/queries/trades";
import { loadRatesMap } from "@/lib/engine/rates-db";
import { compareBrokers, type CompareTrade } from "@/lib/analytics/broker-compare";
import { BROKERS, BROKER_LABELS } from "@/lib/domain/constants";
import { inr } from "@/lib/format";
import { ProGate } from "@/components/system/pro-gate";
import { getMtfMarginByBroker } from "@/lib/queries/margin";
import { defaultMtfFundedAmount, DEFAULT_MTF_OWN_MARGIN_PCT } from "@/lib/risk/margin";
import { mtfComparison } from "@/lib/analytics/mtf-compare";
import { MtfBrokerSection } from "@/components/reports/mtf-broker-section";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import Link from "next/link";

export const dynamic = "force-dynamic";

// T+1 settlement start through the day before sale proceeds settle = exactly
// (end − buyDate) calendar days — confirmed against Dhan's MTF documentation.
function heldDays(buyDate: string | null, sellDate: string | null, today: string): number {
  if (!buyDate) return 0;
  const end = sellDate ?? today;
  return Math.max(0, Math.floor((new Date(end).getTime() - new Date(buyDate).getTime()) / 86400000));
}

export default function BrokerComparePage() {
  const today = todayIstIso();
  const trades = getTrades();
  const ratesMap = loadRatesMap();
  const mtfMarginByBroker = getMtfMarginByBroker();

  // MTF across brokers — the delivery/MTF symbols this journal actually trades.
  const mtfCmp = mtfComparison(
    trades.filter((t) => t.segment === "eq_mtf" || t.segment === "eq_delivery").map((t) => t.symbol),
  );

  const compareTrades: CompareTrade[] = trades.map((t) => ({
    segment: t.segment,
    exchange: t.exchange,
    buyValue: t.buyValue,
    sellValue: t.sellValue,
    buyQty: t.buyQty,
    sellQty: t.sellQty,
    buyOrderCount: t.buyOrderCount,
    sellOrderCount: t.sellOrderCount,
    mtf:
      t.segment === "eq_mtf" && t.buyValue > 0
        ? {
            // Re-price on the PERSISTED funded amount, never the full buy value
            // (that assumes 100% broker financing and overstates every broker's
            // MTF interest equally, which would still rank them correctly but
            // report an inflated absolute cost).
            fundedAmount:
              t.mtfFundedAmount && t.mtfFundedAmount > 0
                ? t.mtfFundedAmount
                : defaultMtfFundedAmount(t.buyValue, mtfMarginByBroker[t.broker] ?? DEFAULT_MTF_OWN_MARGIN_PCT),
            daysHeld: heldDays(t.buyDate, t.sellDate, today),
            pledgeScrips: 1,
          }
        : null,
    actualCharges: t.chargesTotal,
    buyDate: t.buyDate,
    sellDate: t.sellDate,
  }));

  // Current broker = the one carrying the most trades.
  const counts = new Map<string, number>();
  for (const t of trades) counts.set(t.broker, (counts.get(t.broker) ?? 0) + 1);
  const currentBroker = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const report = compareBrokers(compareTrades, ratesMap, [...BROKERS], currentBroker);
  const label = (b: string) => BROKER_LABELS[b as keyof typeof BROKER_LABELS] ?? b;

  return (
    <>
      <PageHeader
        title="Broker cost comparison"
        description="Your whole trade history re-priced on every broker's rate card."
        actions={<Badge variant="secondary">{report.tradeCount} trades</Badge>}
      />
      <div className="space-y-5 p-6">
        <ProGate>
        {report.tradeCount === 0 ? (
          <EmptyState
            variant="journal"
            title="No trades to compare yet"
            action={<Button asChild size="sm"><Link href="/import">Import a broker file</Link></Button>}
          />
        ) : (
          <>
            <section className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <KpiCard label="Charges actually recorded" valueNum={report.actualTotal} format="inr0" sub="across your brokers" />
              <KpiCard
                label="Cheapest broker"
                value={
                  report.cheapest
                    ? label(report.cheapest.broker) +
                      (report.cheapest.plan !== "default" ? ` · ${report.cheapest.planLabel ?? report.cheapest.plan}` : "")
                    : "—"
                }
                sub={report.cheapest ? `${inr(report.cheapest.total, { decimals: 0 })} all-in` : ""}
              />
              <KpiCard
                label="Headroom to save"
                valueNum={Math.max(0, report.maxSaving)}
                format="inr0"
                valueClassName={report.maxSaving > 0 ? "text-profit" : "text-muted-foreground"}
                sub="vs recorded charges"
              />
            </section>

            <Card className="p-0">
              <CardHeader><CardTitle>Per-broker breakdown (same trades)</CardTitle></CardHeader>
              <CardContent className="p-0">
                <ReportTable>
                  <ReportThead>
                    <ReportTh>Broker</ReportTh>
                    <ReportTh align="right">Brokerage</ReportTh>
                    <ReportTh align="right">Statutory</ReportTh>
                    <ReportTh align="right">GST</ReportTh>
                    <ReportTh align="right">DP</ReportTh>
                    <ReportTh align="right">MTF int.</ReportTh>
                    <ReportTh align="right">Plan fee</ReportTh>
                    <ReportTh align="right">Total</ReportTh>
                    <ReportTh align="right">vs recorded</ReportTh>
                  </ReportThead>
                  <tbody>
                    {report.brokers.map((b) => {
                      const isCheapest = report.cheapest?.broker === b.broker && report.cheapest?.plan === b.plan;
                      return (
                        <ReportTr key={`${b.broker}|${b.plan}`} className={isCheapest ? "bg-profit/5" : undefined}>
                          <ReportTd className="font-medium">
                            <span className="inline-flex items-center gap-1.5">
                              {label(b.broker)}
                              {/* A paid plan is a different offer from the same
                                  broker, so it gets its own row and its own
                                  label — with the fee it costs. */}
                              {b.plan !== "default" && (
                                <Badge variant="secondary" title={`₹${b.subscription} over ${b.months} month(s)`}>
                                  {b.planLabel ?? b.plan} · paid
                                </Badge>
                              )}
                              {isCheapest ? <Badge variant="profit">cheapest</Badge> : null}
                              {b.broker === currentBroker && b.plan === "default" ? <Badge variant="secondary">current</Badge> : null}
                              {b.missing > 0 ? <Badge variant="warning">{b.missing} unpriced</Badge> : null}
                            </span>
                          </ReportTd>
                          {/* A broker that priced NOTHING must not show ₹0 and a
                              fat green "saving" — that reads as the cheapest
                              option in the table when it is simply absent.
                              Dashes say "no answer", which is the truth. */}
                          {b.covered === 0 ? (
                            <ReportTd className="text-center" muted colSpan={8}>
                              no rates configured — nothing to compare
                            </ReportTd>
                          ) : (
                            <>
                              <ReportTd align="right">{inr(b.brokerage, { decimals: 0 })}</ReportTd>
                              <ReportTd align="right">{inr(b.statutory, { decimals: 0 })}</ReportTd>
                              <ReportTd align="right">{inr(b.gst, { decimals: 0 })}</ReportTd>
                              <ReportTd align="right">{inr(b.dp, { decimals: 0 })}</ReportTd>
                              <ReportTd align="right">{inr(b.mtfInterest, { decimals: 0 })}</ReportTd>
                              {/* The fee belongs in the table, not a tooltip:
                                  it is the whole reason a paid plan is a
                                  decision rather than a free upgrade. */}
                              <ReportTd align="right" muted>
                                {b.subscription > 0
                                  ? <span title={`₹${b.subscription / b.months}/month × ${b.months}`}>{inr(b.subscription, { decimals: 0 })}</span>
                                  : "—"}
                              </ReportTd>
                              <ReportTd align="right" className="font-semibold">
                                {inr(b.total, { decimals: 0 })}
                                {!b.complete && <span className="ml-1 text-warning" title="Partial — covers only the trades this broker can price">*</span>}
                              </ReportTd>
                              {/* vs recorded is only meaningful against a COMPLETE
                                  total. A partial one compares your whole book
                                  with part of theirs, which always flatters. */}
                              <ReportTd align="right" className={!b.complete ? "text-muted-foreground" : b.vsActual < 0 ? "text-profit" : b.vsActual > 0 ? "text-loss" : undefined}>
                                {!b.complete
                                  ? "n/a"
                                  : b.vsActual === 0
                                    ? "—"
                                    : `${b.vsActual < 0 ? "−" : "+"}${inr(Math.abs(b.vsActual), { decimals: 0 })}`}
                              </ReportTd>
                            </>
                          )}
                        </ReportTr>
                      );
                    })}
                  </tbody>
                </ReportTable>
              </CardContent>
            </Card>

            <p className="text-[0.6875rem] text-muted-foreground">
              Each broker total re-prices the identical trades (turnover, quantities and order counts) on that broker&apos;s
              rate card from charge config — brokerage, DP and MTF interest are the real differentiators; STT/exchange/SEBI/stamp
              are statutory and broker-invariant. &ldquo;vs recorded&rdquo; compares to the charges already stored on your
              trades.
            </p>
            <p className="text-[0.6875rem] text-muted-foreground">
              <b>Free and paid plans are listed separately.</b> Most accounts are on a broker&apos;s free tier, so that is
              the row without a badge; a subscription plan appears as its own row because it is a different offer, and its
              monthly fee is charged over the {report.brokers[0]?.months ?? 1} month
              {(report.brokers[0]?.months ?? 1) === 1 ? "" : "s"} your compared trades span and included in the total.
              Comparing a paid plan on brokerage alone would always make it look cheaper than it is. Edit any rate in
              Settings → charge config; a row you edit is yours and later app updates will not overwrite it.
            </p>
            <MtfBrokerSection cmp={mtfCmp} />
          </>
        )}
        </ProGate>
      </div>
    </>
  );
}
