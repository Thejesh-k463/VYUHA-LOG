import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { TradeCalculator } from "@/components/calculator/trade-calculator";
import { loadRatesMap } from "@/lib/engine/rates-db";
import { todayIstIso } from "@/lib/domain/trading-day";
import { getMarginRates, getMtfMarginByBroker } from "@/lib/queries/margin";
import { getIndexLotSizes } from "@/lib/queries/instruments";
import { planForView } from "@/lib/queries/broker-plan";
import { getPlanPricingNotice } from "@/lib/queries/data-quality";
import { BROKERS } from "@/lib/domain/constants";

export const dynamic = "force-dynamic";

export default function CalculatorPage() {
  // The calculator prices a trade you are about to place, so it wants the rates
  // in force TODAY — one epoch per key, resolved here on the server. Sending the
  // whole rate history across the boundary would make the client component
  // responsible for epoch resolution, which is exactly the logic that belongs in
  // one place (lib/engine/rates.ts).
  const today = todayIstIso();
  const ratesMap = loadRatesMap();
  const rates = Object.fromEntries(
    [...ratesMap].flatMap(([k, epochs]) => {
      const live = epochs.find(
        (e) => (e.effectiveFrom ?? "1970-01-01") <= today && (e.effectiveTo == null || today < e.effectiveTo),
      );
      return live ? [[k, live] as const] : [];
    }),
  );
  // A1 (v4.5.0 fix list) — THE PLAN EACH BROKER IS PRICED ON FOR THE ACCOUNT(S)
  // IN VIEW, resolved here, on the server, by the one rule (`planForView`, the
  // same call /sizing-lab makes). The calculator is a client component and must
  // not reach for a query, so the resolved answer crosses the boundary as a
  // plain object: broker → plan. A broker the view holds no account with
  // resolves to "default", and so does an All-accounts view whose accounts
  // disagree on that broker (invariant 6).
  const accountPlans = Object.fromEntries(BROKERS.map((b) => [b, planForView(b, today, ratesMap)]));
  const mtfMarginByBroker = getMtfMarginByBroker();
  // Every DB read stays here — the calculator is a client component and must
  // not reach for a query. A plain object crosses the boundary; the component
  // rebuilds the Map `capitalBlocked` expects.
  const marginRates = Object.fromEntries(getMarginRates());
  // Market lots for the index picker: the user's own fo_mktlots.csv upload,
  // when present — it beats the bundled snapshot in lib/domain/index-contracts.
  const indexLots = getIndexLotSizes();
  return (
    <>
      <PageHeader
        title="Trade calculator"
        description="Size the position, estimate exact charges, net P&L, capital blocked and breakeven before you trade — Equity, F&O or MTF — and solve the target for a net reward:risk."
        actions={<Badge variant="secondary">pre-trade</Badge>}
      />
      <div className="p-6">
        {/* Q-1: the two pre-trade screens name each other. */}
        <p className="pb-4 text-xs text-muted-foreground">
          Position size from a risk budget:{" "}
          <Link href="/sizing-lab" className="underline underline-offset-2 hover:text-foreground">
            Sizing Lab
          </Link>
          .
        </p>
        <TradeCalculator rates={rates} accountPlans={accountPlans} planNotice={getPlanPricingNotice()} mtfMarginByBroker={mtfMarginByBroker} marginRates={marginRates} indexLots={indexLots} />
      </div>
    </>
  );
}
