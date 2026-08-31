import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { AdvanceTaxCalc } from "@/components/reports/advance-tax-calc";
import { getHarvestTrades } from "@/lib/queries/trades";
import { getMtmMap } from "@/lib/queries/mtm";
import { classifyGain } from "@/lib/analytics/capital-gains";
import { getSettings } from "@/lib/queries/settings";
import { computeHarvest, type OpenLot } from "@/lib/analytics/harvest";
import { ProGate } from "@/components/system/pro-gate";

export const dynamic = "force-dynamic";

// Mirrors /reports/harvest: capital-gains harvesting is equity delivery only.
const EQUITY_SEGMENTS = new Set(["eq_delivery", "eq_mtf"]);
const daysHeld = (a: string | null, b: string) =>
  a ? Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000) : 0;

export default function AdvanceTaxPage() {
  const today = new Date().toISOString().slice(0, 10);
  const settings = getSettings();
  const fyStartMonth = settings?.fyStartMonth ?? 4;

  // Financial-year start (ISO) for the current FY.
  const [ty, tm] = today.split("-").map(Number);
  const fyStartYear = tm >= fyStartMonth ? ty : ty - 1;
  const fyStart = `${fyStartYear}-${String(fyStartMonth).padStart(2, "0")}-01`;
  const fyEnd = `${fyStartYear + 1}-03-31`;

  // The harvest projection carries everything this page reads (isOpen,
  // sellDate, netPnl) PLUS the lot fields — one book read instead of the
  // whole-table getTrades() this page used before.
  const trades = getHarvestTrades();

  // Realised net P&L booked this FY (closed, dated trades) — all segments,
  // because the calculator estimates TOTAL tax, not capital gains alone.
  const realisedFy = trades
    .filter((t) => !t.isOpen && t.sellDate && t.sellDate >= fyStart)
    .reduce((s, t) => s + t.netPnl, 0);

  // ── Harvest link (v3.5.0) ────────────────────────────────────────────────
  // Same lot construction and realised-CG window as /reports/harvest, so the
  // headline harvestable-loss figure matches that page to the rupee. Only the
  // total crosses over; lot-level detail stays on /reports/harvest.
  const mtm = getMtmMap();
  const lots: OpenLot[] = trades
    .filter((t) => t.isOpen && EQUITY_SEGMENTS.has(t.segment))
    .map((t) => {
      const qty = Math.max(t.buyQty - t.sellQty, 0) || t.buyQty;
      const price = mtm.get(t.symbol.toUpperCase()) ?? t.closingPrice ?? t.avgBuyPrice;
      const term = daysHeld(t.buyDate, today) >= 365 ? "LT" : "ST";
      return { id: t.id, symbol: t.symbol, qty, entry: t.avgBuyPrice, mtm: price, term, unrealised: (price - t.avgBuyPrice) * qty };
    });

  // classifyGain keeps this loop identical to /reports/harvest — including
  // the 31-Jan-2018 grandfathering path — so the two pages state one figure.
  let realisedStcg = 0;
  let realisedLtcg = 0;
  for (const t of trades) {
    if (t.isOpen || !EQUITY_SEGMENTS.has(t.segment) || !t.sellDate || t.sellDate < fyStart) continue;
    const g = classifyGain({
      segment: t.segment,
      buyDate: t.buyDate,
      sellDate: t.sellDate,
      buyValue: t.buyValue,
      sellValue: t.sellValue,
      netPnl: t.netPnl,
      // Per-share in the column, TOTAL units into classifyGain — same
      // scaling as tax-itr.ts and /reports/harvest.
      fmv31Jan2018: t.fmv31Jan2018 != null && t.buyQty > 0 ? t.fmv31Jan2018 * t.buyQty : null,
    });
    if (g?.bucket === "ltcg") realisedLtcg += g.taxableGain;
    else if (g?.bucket === "stcg") realisedStcg += g.taxableGain;
  }

  const harvest = computeHarvest(lots, realisedStcg, realisedLtcg, today, fyEnd);
  const harvestableLoss = harvest.stLoss + harvest.ltLoss;

  return (
    <>
      <PageHeader
        title="Advance tax planner"
        description="Plan your 15 Jun / Sep / Dec / Mar instalments and avoid 234C interest."
        actions={<Badge variant="secondary">FY from {fyStart}</Badge>}
      />
      <div className="p-6">
        <ProGate>
        <AdvanceTaxCalc
          initialGains={realisedFy}
          today={today}
          fyStartMonth={fyStartMonth}
          harvestableLoss={harvestableLoss}
        />
      </ProGate>
      </div>
    </>
  );
}
