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

export const dynamic = "force-dynamic";

// T+1 settlement start through the day before sale proceeds settle = exactly
// (end − buyDate) calendar days — confirmed against Dhan's MTF documentation.
function heldDays(buyDate: string | null, sellDate: string | null, today: string): number {
  if (!buyDate) return 0;
  const end = sellDate ?? today;
  return Math.max(0, Math.floor((new Date(end).getTime() - new Date(buyDate).getTime()) / 86400000));
}

export default function BrokerComparePage() {
  const today = new Date().toISOString().slice(0, 10);
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
          <Card><CardContent className="p-6 text-sm text-muted-foreground">No trades to compare yet.</CardContent></Card>
        ) : (
          <>
            <section className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <KpiCard label="Charges actually recorded" value={inr(report.actualTotal, { decimals: 0 })} sub="across your brokers" />
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
                value={inr(Math.max(0, report.maxSaving), { decimals: 0 })}
                valueClassName={report.maxSaving > 0 ? "text-profit" : "text-muted-foreground"}
                sub="vs recorded charges"
              />
            </section>

            <Card className="p-0">
              <CardHeader><CardTitle>Per-broker breakdown (same trades)</CardTitle></CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-y border-border text-left text-muted-foreground">
                        <th className="px-2.5 py-2 font-medium">Broker</th>
                        <th className="px-2 py-2 text-right font-medium">Brokerage</th>
                        <th className="px-2 py-2 text-right font-medium">Statutory</th>
                        <th className="px-2 py-2 text-right font-medium">GST</th>
                        <th className="px-2 py-2 text-right font-medium">DP</th>
                        <th className="px-2 py-2 text-right font-medium">MTF int.</th>
                        <th className="px-2 py-2 text-right font-medium">Plan fee</th>
                        <th className="px-2.5 py-2 text-right font-medium">Total</th>
                        <th className="px-2.5 py-2 text-right font-medium">vs recorded</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.brokers.map((b) => {
                        const isCheapest = report.cheapest?.broker === b.broker && report.cheapest?.plan === b.plan;
                        return (
                          <tr key={`${b.broker}|${b.plan}`} className={`border-b border-rule ${isCheapest ? "bg-profit/5" : ""}`}>
                            <td className="px-2.5 py-2 font-medium">
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
                            </td>
                            {/* A broker that priced NOTHING must not show ₹0 and a
                                fat green "saving" — that reads as the cheapest
                                option in the table when it is simply absent.
                                Dashes say "no answer", which is the truth. */}
                            {b.covered === 0 ? (
                              <td className="px-2 py-2 text-center text-muted-foreground" colSpan={8}>
                                no rates configured — nothing to compare
                              </td>
                            ) : (
                              <>
                                <td className="px-2 py-2 text-right tabular-nums">{inr(b.brokerage, { decimals: 0 })}</td>
                                <td className="px-2 py-2 text-right tabular-nums">{inr(b.statutory, { decimals: 0 })}</td>
                                <td className="px-2 py-2 text-right tabular-nums">{inr(b.gst, { decimals: 0 })}</td>
                                <td className="px-2 py-2 text-right tabular-nums">{inr(b.dp, { decimals: 0 })}</td>
                                <td className="px-2 py-2 text-right tabular-nums">{inr(b.mtfInterest, { decimals: 0 })}</td>
                                {/* The fee belongs in the table, not a tooltip:
                                    it is the whole reason a paid plan is a
                                    decision rather than a free upgrade. */}
                                <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                                  {b.subscription > 0
                                    ? <span title={`₹${b.subscription / b.months}/month × ${b.months}`}>{inr(b.subscription, { decimals: 0 })}</span>
                                    : "—"}
                                </td>
                                <td className="px-2.5 py-2 text-right font-semibold tabular-nums">
                                  {inr(b.total, { decimals: 0 })}
                                  {!b.complete && <span className="ml-1 text-warning" title="Partial — covers only the trades this broker can price">*</span>}
                                </td>
                                {/* vs recorded is only meaningful against a COMPLETE
                                    total. A partial one compares your whole book
                                    with part of theirs, which always flatters. */}
                                <td className={`px-2.5 py-2 text-right tabular-nums ${!b.complete ? "text-muted-foreground" : b.vsActual < 0 ? "text-profit" : b.vsActual > 0 ? "text-loss" : ""}`}>
                                  {!b.complete
                                    ? "n/a"
                                    : b.vsActual === 0
                                      ? "—"
                                      : `${b.vsActual < 0 ? "−" : "+"}${inr(Math.abs(b.vsActual), { decimals: 0 })}`}
                                </td>
                              </>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>

            <p className="text-[11px] text-muted-foreground">
              Each broker total re-prices the identical trades (turnover, quantities and order counts) on that broker&apos;s
              rate card from charge config — brokerage, DP and MTF interest are the real differentiators; STT/exchange/SEBI/stamp
              are statutory and broker-invariant. &ldquo;vs recorded&rdquo; compares to the charges already stored on your
              trades.
            </p>
            <p className="text-[11px] text-muted-foreground">
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
