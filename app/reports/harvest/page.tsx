import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { KpiCard } from "@/components/kpi-card";
import { getTrades } from "@/lib/queries/trades";
import { getMtmMap } from "@/lib/queries/mtm";
import { getSettings } from "@/lib/queries/settings";
import { computeHarvest, type OpenLot } from "@/lib/analytics/harvest";
import { inr } from "@/lib/format";
import { ProGate } from "@/components/system/pro-gate";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { EmptyState } from "@/components/ui/empty-state";

export const dynamic = "force-dynamic";

const EQUITY_SEGMENTS = new Set(["eq_delivery", "eq_mtf"]);
const daysHeld = (a: string | null, b: string) =>
  a ? Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000) : 0;

const statusBadge = { offsets: "profit", partial: "warning", carry: "secondary" } as const;

export default function HarvestPage() {
  const today = new Date().toISOString().slice(0, 10);
  const trades = getTrades();
  const mtm = getMtmMap();
  const settings = getSettings();
  const fyStartMonth = settings?.fyStartMonth ?? 4;
  const [ty, tm] = today.split("-").map(Number);
  const fyStartYear = tm >= fyStartMonth ? ty : ty - 1;
  const fyStart = `${fyStartYear}-${String(fyStartMonth).padStart(2, "0")}-01`;
  const fyEnd = `${fyStartYear + 1}-03-31`;

  // Open equity-delivery lots with an unrealised mark.
  const lots: OpenLot[] = trades
    .filter((t) => t.isOpen && EQUITY_SEGMENTS.has(t.segment))
    .map((t) => {
      const qty = Math.max(t.buyQty - t.sellQty, 0) || t.buyQty;
      const price = mtm.get(t.symbol.toUpperCase()) ?? t.closingPrice ?? t.avgBuyPrice;
      const term = daysHeld(t.buyDate, today) >= 365 ? "LT" : "ST";
      return { id: t.id, symbol: t.symbol, qty, entry: t.avgBuyPrice, mtm: price, term, unrealised: (price - t.avgBuyPrice) * qty };
    });

  // Realised capital gains booked this FY (closed equity, by holding period).
  let realisedStcg = 0;
  let realisedLtcg = 0;
  for (const t of trades) {
    if (t.isOpen || !EQUITY_SEGMENTS.has(t.segment) || !t.sellDate || t.sellDate < fyStart) continue;
    if (daysHeld(t.buyDate, t.sellDate) >= 365) realisedLtcg += t.grossPnl;
    else realisedStcg += t.grossPnl;
  }

  const r = computeHarvest(lots, realisedStcg, realisedLtcg, today, fyEnd);
  const lossCandidates = r.candidates;

  return (
    <>
      <PageHeader
        title="Tax-loss harvesting"
        description="Book unrealised equity losses before 31-Mar to offset realised gains — India has no wash-sale rule."
        actions={<Badge variant={r.daysToFyEnd <= 45 ? "warning" : "secondary"}>{r.daysToFyEnd}d to FY end</Badge>}
      />
      <div className="space-y-5 p-6">
        <ProGate>
        <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          <KpiCard label="Realised STCG (FY)" valueNum={r.realisedStcg} format="inr0" valueClassName={r.realisedStcg >= 0 ? "text-profit" : "text-loss"} sub="short-term" />
          <KpiCard label="Realised LTCG (FY)" valueNum={r.realisedLtcg} format="inr0" valueClassName={r.realisedLtcg >= 0 ? "text-profit" : "text-loss"} sub={`₹1.25L exempt`} />
          <KpiCard label="Harvestable loss" valueNum={r.stLoss + r.ltLoss} format="inr0" valueClassName="text-loss" sub={`ST ${inr(r.stLoss, { decimals: 0 })} · LT ${inr(r.ltLoss, { decimals: 0 })}`} />
          <KpiCard label="Est. tax saved" valueNum={r.taxSaved} format="inr0" valueClassName={r.taxSaved > 0 ? "text-profit" : "text-muted-foreground"} sub="if harvested now" />
          <KpiCard label="Carries forward" valueNum={r.carryForward} format="inr0" sub="beyond this year's gains" />
        </section>

        <Card className="p-0">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Harvest candidates</CardTitle>
            {lossCandidates.length > 0 ? (
              <Badge variant="secondary">{lossCandidates.length} loss positions</Badge>
            ) : null}
          </CardHeader>
          <CardContent className="p-0">
            {lossCandidates.length === 0 ? (
              <EmptyState
                variant="journal"
                title="No open equity positions showing an unrealised loss"
                hint="F&O and intraday are business income and not eligible for capital-gains harvesting."
              />
            ) : (
              <ReportTable>
                <ReportThead>
                  <ReportTh>Symbol</ReportTh>
                  <ReportTh>Term</ReportTh>
                  <ReportTh align="right">Qty</ReportTh>
                  <ReportTh align="right">Unrealised loss</ReportTh>
                  <ReportTh align="right">Offsets now</ReportTh>
                  <ReportTh>Action</ReportTh>
                </ReportThead>
                <tbody>
                  {lossCandidates.map((c) => (
                    <ReportTr key={c.id}>
                      <ReportTd className="font-medium">{c.symbol}</ReportTd>
                      <ReportTd><Badge variant="outline">{c.term}</Badge></ReportTd>
                      <ReportTd align="right">{c.qty}</ReportTd>
                      <ReportTd align="right" className="text-loss">{inr(c.loss, { decimals: 0 })}</ReportTd>
                      <ReportTd align="right">{c.offsetAmount > 0 ? inr(c.offsetAmount, { decimals: 0 }) : "—"}</ReportTd>
                      <ReportTd>
                        <Badge variant={statusBadge[c.status]}>
                          {c.status === "offsets" ? "harvest — offsets gains" : c.status === "partial" ? "harvest — partial offset" : "harvest — carries forward"}
                        </Badge>
                      </ReportTd>
                    </ReportTr>
                  ))}
                </tbody>
              </ReportTable>
            )}
          </CardContent>
        </Card>

        <p className="text-[0.6875rem] text-muted-foreground">
          Set-off rules: short-term losses offset STCG then LTCG; long-term losses offset LTCG only. Tax estimated at the
          post-23-Jul-2024 regime (STCG 20%, LTCG 12.5% beyond the ₹1.25L exemption). No wash-sale rule means you may
          re-buy, but a same-day round-trip can be questioned and changes your holding clock — informational, not advice.
        </p>
      </ProGate>
      </div>
    </>
  );
}
