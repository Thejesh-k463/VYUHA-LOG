import { todayIstIso } from "@/lib/domain/trading-day";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getHarvestTrades } from "@/lib/queries/trades";
import { getMtmMap } from "@/lib/queries/mtm";
import { getSettings } from "@/lib/queries/settings";
import { daysBetween, fyWindowFor, type OpenLot } from "@/lib/analytics/harvest";
import { classifyGain } from "@/lib/analytics/capital-gains";
import {
  sttSplit,
  ltcgRunway,
  setOffAsymmetry,
  LIABILITY_CAVEAT,
  NO_WASH_SALE_CAVEAT,
} from "@/lib/analytics/tax-levers";
import { FNO_SEGMENTS } from "@/lib/analytics/turnover";
import { inr } from "@/lib/format";
import { ProGate } from "@/components/system/pro-gate";
import { HarvestSim } from "@/components/reports/harvest-sim";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";

export const dynamic = "force-dynamic";

const EQUITY_SEGMENTS = new Set(["eq_delivery", "eq_mtf"]);
const daysHeld = (a: string | null, b: string) =>
  a ? Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000) : 0;

export default function HarvestPage() {
  const today = todayIstIso();
  // The book projected to the 13 harvest columns (of 74) — same rows, same
  // order, and the filters below are unchanged, so every figure and every
  // rendered row order is identical; only never-read columns stopped being
  // fetched and mapped (this was the whole-book getTrades() call).
  const trades = getHarvestTrades();
  const mtm = getMtmMap();
  const settings = getSettings();
  const fyStartMonth = settings?.fyStartMonth ?? 4;
  // FY window derived from settings.fyStartMonth — the end is the day before
  // the next FY starts, not a hardcoded 31-Mar (see fyWindowFor).
  const { fyStart, fyEnd, fyLabel: currentFy } = fyWindowFor(today, fyStartMonth);
  const daysToFyEnd = daysBetween(today, fyEnd);

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
  // realised-gain figures across the two tax surfaces. classifyGain also
  // applies the 31-Jan-2018 grandfathering (capped-FMV cost basis), so a
  // pre-2018 lot reads the same on both pages.
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
      // fmv31Jan2018 is stored PER SHARE (schema); classifyGain wants the
      // same TOTAL units as buyValue/sellValue — the exact scaling
      // lib/queries/tax-itr.ts uses, so both tax surfaces agree.
      fmv31Jan2018: t.fmv31Jan2018 != null && t.buyQty > 0 ? t.fmv31Jan2018 * t.buyQty : null,
    });
    if (g?.bucket === "ltcg") realisedLtcg += g.taxableGain;
    else if (g?.bucket === "stcg") realisedStcg += g.taxableGain;
  }

  // ── Tax levers (v3.3.0) ────────────────────────────────────────────────
  // Everything here is (A): computable exactly from executed trades. Nothing
  // recommends a transaction. See lib/analytics/tax-levers.ts.
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
        actions={<Badge variant={daysToFyEnd <= 45 ? "warning" : "secondary"}>{daysToFyEnd}d to FY end</Badge>}
      />
      <div className="space-y-5 p-6">
        <ProGate>
        {/* KPIs + what-if simulator. computeHarvest is pure, so it moved into
            the client component and re-runs live on the user's selection —
            the props are all serializable (advance-tax-calc pattern). */}
        <HarvestSim
          lots={lots}
          realisedStcg={realisedStcg}
          realisedLtcg={realisedLtcg}
          today={today}
          fyEnd={fyEnd}
        />

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
          {/* LTCG_THRESHOLD_CAVEAT renders verbatim in HarvestSim, directly
              under the headroom KPI it qualifies. */}
          <p>{NO_WASH_SALE_CAVEAT}</p>
          <p>{LIABILITY_CAVEAT}</p>
        </div>
      </ProGate>
      </div>
    </>
  );
}
