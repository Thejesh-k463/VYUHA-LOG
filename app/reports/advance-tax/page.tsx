import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { AdvanceTaxCalc } from "@/components/reports/advance-tax-calc";
import { getTrades } from "@/lib/queries/trades";
import { getSettings } from "@/lib/queries/settings";

export const dynamic = "force-dynamic";

export default function AdvanceTaxPage() {
  const today = new Date().toISOString().slice(0, 10);
  const settings = getSettings();
  const fyStartMonth = settings?.fyStartMonth ?? 4;

  // Financial-year start (ISO) for the current FY.
  const [ty, tm] = today.split("-").map(Number);
  const fyStartYear = tm >= fyStartMonth ? ty : ty - 1;
  const fyStart = `${fyStartYear}-${String(fyStartMonth).padStart(2, "0")}-01`;

  // Realised net P&L booked this FY (closed, dated trades).
  const realisedFy = getTrades()
    .filter((t) => !t.isOpen && t.sellDate && t.sellDate >= fyStart)
    .reduce((s, t) => s + t.netPnl, 0);

  return (
    <>
      <PageHeader
        title="Advance tax planner"
        description="Plan your 15 Jun / Sep / Dec / Mar instalments and avoid 234C interest."
        actions={<Badge variant="secondary">FY from {fyStart}</Badge>}
      />
      <div className="p-6">
        <AdvanceTaxCalc initialGains={realisedFy} today={today} fyStartMonth={fyStartMonth} />
      </div>
    </>
  );
}
