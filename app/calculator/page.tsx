import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { TradeCalculator } from "@/components/calculator/trade-calculator";
import { loadRatesMap } from "@/lib/engine/rates-db";

export const dynamic = "force-dynamic";

export default function CalculatorPage() {
  const rates = Object.fromEntries(loadRatesMap());
  return (
    <>
      <PageHeader
        title="Trade calculator"
        description="Estimate exact charges, net P&L and breakeven before you trade — Equity, F&O or MTF — and project across N trades."
        actions={<Badge variant="secondary">pre-trade</Badge>}
      />
      <div className="p-6">
        <TradeCalculator rates={rates} />
      </div>
    </>
  );
}
