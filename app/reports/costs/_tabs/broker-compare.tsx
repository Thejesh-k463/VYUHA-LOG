import { todayIstIso, calendarDaysHeld } from "@/lib/domain/trading-day";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { KpiCard } from "@/components/kpi-card";
import { getTrades } from "@/lib/queries/trades";
import { loadRatesMap } from "@/lib/engine/rates-db";
import { planForView } from "@/lib/queries/broker-plan";
import { compareBrokers, type CompareTrade } from "@/lib/analytics/broker-compare";
import { BROKERS, BROKER_LABELS } from "@/lib/domain/constants";
import { inr } from "@/lib/format";
// D11 (wave 2O): no margin_config read is left on this page — it estimated a
// funded principal the journal never recorded, and that estimate reached every
// broker total, the cheapest pick and the savings headline (mtf#7).
import { mtfComparison } from "@/lib/analytics/mtf-compare";
import { MtfBrokerSection } from "@/components/reports/mtf-broker-section";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import Link from "next/link";

// v4.6.0 W3 — the body of the old /reports/broker-compare screen, now the
// Costs hub's Broker Costs tab. The hub page (../page.tsx) owns the page header
// and the Pro gate; the header's "N trades" badge is data this body computes,
// so it moved into the body's first row, unchanged.


export function BrokerCompareTab() {
  const today = todayIstIso();
  const trades = getTrades();
  const ratesMap = loadRatesMap();

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
            // report an inflated absolute cost). A stored 0 is a STATED amount
            // (bought outright, nothing financed) and re-prices as no interest
            // on every broker — the same null-vs-0 rule the writers keep (V3/X2).
            //
            // D11 (wave 2O, mtf#7 ≡ seams#1) — AND A NULL IS NO LONGER ESTIMATED
            // EITHER. `?? defaultMtfFundedAmount(buyValue, margin_config)` made
            // this the last reader pricing a principal the journal never recorded,
            // and the estimate did not stay in a cell: `compareBrokers` adds MTF
            // interest into every broker's total, so "vs recorded", the cheapest
            // pick and the headline "Headroom to save" all moved when the margin
            // table moved (probed: the page's strings differ at 20% and 50%). The
            // null reaches the engine as 0, which bills neither interest nor
            // pledge (`lib/engine/charges.ts:106`), so every broker's column omits
            // the SAME rows' financing and the comparison stays like-for-like. The
            // omission is stated once below (invariant 6's other half).
            //
            // NOT `missing`: that means "this broker cannot price this trade", and
            // counting it would drop the row's priceable brokerage and STT as well
            // and blank `cheapest` / `maxSaving` for the whole report.
            fundedAmount: t.mtfFundedAmount ?? 0,
            // D7 (wave 2P): the ONE day count every writer prices by (T+1 through
            // settlement, lib/domain/trading-day); an open row is held to today, and
            // a stored date that states no day counts zero rather than NaN.
            daysHeld: calendarDaysHeld(t.buyDate, t.sellDate ?? today),
            pledgeScrips: 1,
          }
        : null,
    actualCharges: t.chargesTotal,
    buyDate: t.buyDate,
    sellDate: t.sellDate,
  }));

  // D11 — the rows every column omits the financing of, counted for the sentence
  // below. The same predicate the `mtf` block above applies, so the count cannot
  // describe a different set from the one that was priced.
  const unstatedMtf = trades.filter((t) => t.segment === "eq_mtf" && t.buyValue > 0 && t.mtfFundedAmount == null).length;

  // Current broker = the one carrying the most trades.
  const counts = new Map<string, number>();
  for (const t of trades) counts.set(t.broker, (counts.get(t.broker) ?? 0) + 1);
  const currentBroker = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  // A2 (v4.5.0 fix list) — "current" is the broker AND THE PLAN the book is
  // actually priced on, resolved by the one rule (`planForView`, which reads
  // the account(s) in view). It used to match `plan === "default"`, so a Plus
  // account read "current" on the Basic row and compared its own bill with a
  // rate card it is not on. A broker the view holds no account with resolves to
  // "default", which is what it is priced at anyway.
  const currentPlan = currentBroker ? planForView(currentBroker, today, ratesMap) : "default";

  const report = compareBrokers(compareTrades, ratesMap, [...BROKERS], currentBroker);
  const label = (b: string) => BROKER_LABELS[b as keyof typeof BROKER_LABELS] ?? b;

  return (
    <>
        <div className="flex justify-end"><Badge variant="secondary">{report.tradeCount} trades</Badge></div>
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
                              {/* D4 (v4.5.0) — "· paid" is a CLAIM ABOUT MONEY and is
                                  made only when the plan actually carries a
                                  subscription. Upstox Plus has none (owner ruling
                                  U3: the ₹10/order premium IS its price), so
                                  labelling it "paid" beside a ₹0 fee would be a
                                  false claim in the very report meant to compare
                                  cost. A zero-fee tier reads "opt-in". */}
                              {b.plan !== "default" && (
                                <Badge
                                  variant="secondary"
                                  title={b.subscription > 0 ? `₹${b.subscription} over ${b.months} month(s)` : "No subscription fee — the plan is priced through its own brokerage"}
                                >
                                  {b.planLabel ?? b.plan} · {b.subscription > 0 ? "paid" : "opt-in"}
                                </Badge>
                              )}
                              {isCheapest ? <Badge variant="profit">cheapest</Badge> : null}
                              {b.broker === currentBroker && b.plan === currentPlan ? <Badge variant="secondary">current</Badge> : null}
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
                {/* v4.6.0 W7 (D4) — the bound of "vs recorded", stated rather
                    than hidden: the statutory heads round per ROW here and
                    once per contract note at the broker (owner answer Q2:
                    accepted and explained, no engine change). */}
                <p className="px-4 py-2 text-[0.6875rem] text-muted-foreground">
                  STT/CTT and stamp duty are rounded to the rupee per trade row here; a
                  contract note rounds each head once, so a day with N rows can differ from your bill by up to ₹0.50 × N
                  per head.
                </p>
              </CardContent>
            </Card>

            {/* D11 — what no column includes, said once and never estimated
                (invariant 6). Financing is the largest component of an MTF
                position, so a report that silently left it out of every column
                would read as a cheaper book than it is. */}
            {unstatedMtf > 0 && (
              <p className="text-[0.6875rem] text-warning">
                {`${unstatedMtf} MTF ${unstatedMtf === 1 ? "trade states" : "trades state"} no funded amount — no financing cost is included for ${unstatedMtf === 1 ? "it" : "them"} in any column.`}{" "}
                Record what the broker funded in the trade editor (Edit → Own capital used) and every column prices it.
              </p>
            )}
            <MtfBrokerSection cmp={mtfCmp} />
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
          </>
        )}
    </>
  );
}
