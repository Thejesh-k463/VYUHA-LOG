import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { KpiCard } from "@/components/kpi-card";
import { getHarvestTrades } from "@/lib/queries/trades";
import { getMtmMap } from "@/lib/queries/mtm";
import { getSettings } from "@/lib/queries/settings";
import { computeHarvest, type OpenLot } from "@/lib/analytics/harvest";
import {
  sttSplit,
  ltcgRunway,
  setOffAsymmetry,
  LTCG_THRESHOLD_CAVEAT,
  LIABILITY_CAVEAT,
  NO_WASH_SALE_CAVEAT,
} from "@/lib/analytics/tax-levers";
import { FNO_SEGMENTS } from "@/lib/analytics/turnover";
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
  // The book projected to the 13 harvest columns (of 74) — same rows, same
  // order, and the filters below are unchanged, so every figure and every
  // rendered row order is identical; only never-read columns stopped being
  // fetched and mapped (this was the whole-book getTrades() call).
  const trades = getHarvestTrades();
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
  // NET (post-charge) P&L — the basis /reports/tax states and taxByFy/
  // classifyGain use; gross here once showed the same FY two different
  // realised-gain figures across the two tax surfaces.
  let realisedStcg = 0;
  let realisedLtcg = 0;
  for (const t of trades) {
    if (t.isOpen || !EQUITY_SEGMENTS.has(t.segment) || !t.sellDate || t.sellDate < fyStart) continue;
    if (daysHeld(t.buyDate, t.sellDate) >= 365) realisedLtcg += t.netPnl;
    else realisedStcg += t.netPnl;
  }

  const r = computeHarvest(lots, realisedStcg, realisedLtcg, today, fyEnd);
  const lossCandidates = r.candidates;

  // ── Tax levers (v3.3.0) ────────────────────────────────────────────────
  // Everything here is (A): computable exactly from executed trades. Nothing
  // recommends a transaction. See lib/analytics/tax-levers.ts.
  const currentFy = `${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, "0")}`;
  const fyClosed = trades.filter((t) => !t.isOpen && t.sellDate != null && t.sellDate >= fyStart);

  const stt = sttSplit(
    fyClosed.map((t) => ({
      segment: t.segment, buyDate: t.buyDate, sellDate: t.sellDate,
      netPnl: t.netPnl, chargesTotal: t.chargesTotal, sttCtt: t.sttCtt, isOpen: t.isOpen,
    })),
    currentFy,
  );

  // The set-off position for THIS year, across every head — not just equity.
  let fnoBusiness = 0;
  let speculative = 0;
  for (const t of fyClosed) {
    if (t.segment === "eq_intraday") speculative += t.netPnl;
    else if (FNO_SEGMENTS.has(t.segment)) fnoBusiness += t.netPnl;
  }
  const setOff = setOffAsymmetry(
    { fnoBusiness, speculative, capitalGains: realisedStcg + realisedLtcg },
    currentFy,
  );

  const runway = ltcgRunway(
    trades
      .filter((t) => t.isOpen)
      .map((t) => {
        const qty = Math.max(t.buyQty - t.sellQty, 0) || t.buyQty;
        const price = mtm.get(t.symbol.toUpperCase()) ?? t.closingPrice ?? t.avgBuyPrice;
        return {
          id: t.id, symbol: t.symbol, segment: t.segment, buyDate: t.buyDate,
          unrealised: (price - t.avgBuyPrice) * qty,
        };
      }),
    today,
  );

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

        {/* The levers a trade book can compute exactly. Deliberately no "sell
            these" ranking: naming a security and prompting a transaction is
            advice, not computation. See lib/analytics/tax-levers.ts. */}
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Set-off: this year vs carried forward</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-xs text-muted-foreground">
              <p>{setOff.rule}</p>
              {setOff.finding && <p className="font-medium text-foreground">{setOff.finding}</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>STT: deductible on one head, forfeited on another</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-xs text-muted-foreground">
              {stt.total > 0 ? (
                <>
                  <p>
                    <span className="font-medium text-profit">{inr(stt.deductible, { decimals: 0 })}</span> of STT/CTT
                    sat on business-head legs across {stt.deductibleTrades} trades and is an allowable expense
                    ({stt.deductibleSection}).{" "}
                    <span className="font-medium text-loss">{inr(stt.forfeited, { decimals: 0 })}</span> sat on
                    {" "}{stt.forfeitedTrades} delivery trades, where it is expressly not deductible
                    ({stt.forfeitedSection}).
                  </p>
                  <p>The same levy, two treatments. Only the head decides which you get.</p>
                </>
              ) : (
                <p>No STT recorded on closed trades yet.</p>
              )}
            </CardContent>
          </Card>
        </div>

        {runway.rows.length > 0 && (
          <Card className="p-0">
            <CardHeader>
              <CardTitle>Holding clock — open delivery lots</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                Days to the 12-month line. This is a fact about dates, not a reason to hold: price risk over the
                remaining days can cost far more than the rate difference saves.
                {runway.undated > 0 && ` ${runway.undated} open lot${runway.undated === 1 ? "" : "s"} carry no buy date and cannot be aged.`}
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <ReportTable>
                <ReportThead>
                  <ReportTh>Symbol</ReportTh>
                  <ReportTh>Bought</ReportTh>
                  <ReportTh align="right">Days held</ReportTh>
                  <ReportTh align="right">To long-term</ReportTh>
                  <ReportTh align="right">Unrealised</ReportTh>
                </ReportThead>
                <tbody>
                  {runway.rows.slice(0, 15).map((row) => (
                    <ReportTr key={row.id}>
                      <ReportTd className="font-medium">{row.symbol}</ReportTd>
                      <ReportTd muted>{row.buyDate}</ReportTd>
                      <ReportTd align="right">{row.daysHeld}</ReportTd>
                      <ReportTd align="right">
                        {row.alreadyLongTerm ? <Badge variant="profit">long-term</Badge> : `${row.daysToLongTerm}d`}
                      </ReportTd>
                      <ReportTd align="right" className={row.unrealised >= 0 ? "text-profit" : "text-loss"}>
                        {inr(row.unrealised, { decimals: 0 })}
                      </ReportTd>
                    </ReportTr>
                  ))}
                </tbody>
              </ReportTable>
              {runway.rows.length > 15 && (
                <p className="px-4 py-2 text-xs text-muted-foreground">
                  Showing 15 of {runway.rows.length} open delivery lots, soonest to cross first.
                </p>
              )}
            </CardContent>
          </Card>
        )}

        <div className="space-y-2 text-[0.6875rem] text-muted-foreground">
          <p>
            Set-off rules: short-term losses offset STCG then LTCG; long-term losses offset LTCG only. Rates are
            resolved from the date of sale. Realised figures are net (post-charge), matching the Tax Summary.
          </p>
          <p>{LTCG_THRESHOLD_CAVEAT}</p>
          <p>{NO_WASH_SALE_CAVEAT}</p>
          <p>{LIABILITY_CAVEAT}</p>
        </div>
      </ProGate>
      </div>
    </>
  );
}
