import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { TradeCalculator } from "@/components/calculator/trade-calculator";
import { loadRatesMap } from "@/lib/engine/rates-db";
import { getMarginRates, getMtfMarginByBroker } from "@/lib/queries/margin";
import { getIndexLotSizes } from "@/lib/queries/instruments";

export const dynamic = "force-dynamic";

export default function CalculatorPage() {
  const rates = Object.fromEntries(loadRatesMap());
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
        <TradeCalculator rates={rates} mtfMarginByBroker={mtfMarginByBroker} marginRates={marginRates} indexLots={indexLots} />
      </div>
    </>
  );
}
