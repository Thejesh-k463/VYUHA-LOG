import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ExportButtons } from "@/components/ui/export-button";
import { getTrades } from "@/lib/queries/trades";
import { getSettings } from "@/lib/queries/settings";
import { getLedgerEntries } from "@/lib/queries/ledger";
import { getIposComputed } from "@/lib/queries/ipos";
import { taxByFy, type TaxTrade } from "@/lib/analytics/tax";
import {
  aggregateTradesByFy,
  computeTaxTimeline,
  classifyGain,
  classifyTerm,
  RATE_CUTOVER_DATE,
  GRANDFATHER_DATE,
  type CapitalGainsTrade,
} from "@/lib/analytics/capital-gains";
import { summariseByCompanyFy, TDS_THRESHOLD, type DividendEvent } from "@/lib/analytics/dividend-tds";
import { inr } from "@/lib/format";
import { Info } from "lucide-react";
import { ProGate } from "@/components/system/pro-gate";
import { FmvEditor } from "@/components/reports/fmv-editor";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import Link from "next/link";

export const dynamic = "force-dynamic";

function fyOf(dateStr: string, fyStartMonth: number, fallback: string): string {
  if (!dateStr) return fallback;
  const d = new Date(dateStr + "T00:00:00");
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const start = m >= fyStartMonth ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

const COLS = [
  { key: "fy", label: "FY" }, { key: "trades", label: "Trades" },
  { key: "stcg", label: "STCG" }, { key: "ltcg", label: "LTCG" },
  { key: "intradaySpeculative", label: "Intraday speculative" },
  { key: "fnoBusiness", label: "F&O business" }, { key: "fnoTurnover", label: "F&O turnover" },
  { key: "charges", label: "Charges" }, { key: "totalRealised", label: "Net realised" },
];

export default function TaxReportPage() {
  const trades = getTrades();
  const settings = getSettings();
  const fyStartMonth = settings?.fyStartMonth ?? 4;

  // Exited IPOs are equity-delivery capital gains but live OUTSIDE the trades
  // table — fold them into BOTH the raw scaffold and the set-off engine so the
  // Tax Summary is complete. Acquisition date = allotment (fallback listing/applied).
  const exitedIpos = getIposComputed().rows.filter((r) => r.realised);
  const ipoTaxRows: TaxTrade[] = exitedIpos.map((r) => ({
    segment: "eq_delivery",
    instrumentType: "equity",
    buyDate: r.allotmentDate ?? r.listingDate ?? r.appliedDate ?? null,
    sellDate: r.exitDate ?? null,
    grossPnl: r.grossPnl,
    netPnl: r.netPnl,
    buyValue: r.investedAllotted,
    sellValue: (r.exitPrice ?? 0) * r.allottedQty,
    chargesTotal: r.charges,
    isOpen: false,
  }));
  const rows = taxByFy([...trades, ...ipoTaxRows], fyStartMonth);
  const pnl = (v: number) => (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground");

  // IND-1 + IND-2 — date-based STCG/LTCG rates + speculative/non-speculative
  // set-off and carry-forward across FYs. Grandfathering uses the per-trade FMV
  // entered below (per-share × qty → same total units as buyValue/sellValue).
  const closedTrades = trades.filter((t) => !t.isOpen);
  const cgTrades: CapitalGainsTrade[] = [
    ...closedTrades.map((t) => ({
      segment: t.segment,
      buyDate: t.buyDate,
      sellDate: t.sellDate,
      buyValue: t.buyValue,
      sellValue: t.sellValue,
      netPnl: t.netPnl,
      fmv31Jan2018: t.fmv31Jan2018 != null && t.buyQty > 0 ? t.fmv31Jan2018 * t.buyQty : null,
    })),
    ...ipoTaxRows.map((r) => ({
      segment: r.segment,
      buyDate: r.buyDate,
      sellDate: r.sellDate,
      buyValue: r.buyValue,
      sellValue: r.sellValue,
      netPnl: r.netPnl,
    })),
  ];
  const hasPreGrandfatherLot = cgTrades.some((t) => t.buyDate != null && t.buyDate < GRANDFATHER_DATE);
  // Pre-2018 closed equity lots — the rows the FMV editor targets.
  const grandfatherRows = closedTrades
    .filter((t) => (t.segment === "eq_delivery" || t.segment === "eq_mtf") && t.buyDate != null && t.buyDate < GRANDFATHER_DATE)
    .map((t) => ({ id: t.id, symbol: t.symbol, buyDate: t.buyDate!, sellDate: t.sellDate, buyQty: t.buyQty, avgBuyPrice: t.avgBuyPrice, fmv31Jan2018: t.fmv31Jan2018 ?? null }));

  // ITR-schedule-shaped per-trade export (closed equity + F&O + exited IPOs).
  const itrRows = cgTrades
    .map((t, i) => {
      const g = classifyGain(t);
      if (!g) return null;
      const isIpo = i >= closedTrades.length;
      const src = isIpo ? exitedIpos[i - closedTrades.length] : closedTrades[i];
      return {
        scrip: isIpo ? `${(src as (typeof exitedIpos)[number]).name} (IPO)` : (src as (typeof closedTrades)[number]).symbol,
        acquired: t.buyDate ?? "",
        sold: t.sellDate ?? "",
        cost: t.buyValue,
        consideration: t.sellValue,
        netGain: t.netPnl,
        term: t.segment === "eq_delivery" || t.segment === "eq_mtf" ? classifyTerm(t.buyDate, t.sellDate) : "",
        head: g.bucket === "stcg" ? "STCG (111A)" : g.bucket === "ltcg" ? "LTCG (112A)" : g.bucket === "speculative" ? "Speculative business" : "Non-speculative business (F&O)",
        taxableGain: g.taxableGain,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r != null);
  const today = new Date();
  const todayY = today.getFullYear();
  const todayFyStart = today.getMonth() + 1 >= fyStartMonth ? todayY : todayY - 1;
  const currentFy = `${todayFyStart}-${String((todayFyStart + 1) % 100).padStart(2, "0")}`;
  const byFy = aggregateTradesByFy(cgTrades, fyStartMonth, currentFy);
  const timeline = computeTaxTimeline(byFy);

  // IND-6 — dividend & TDS: group "dividend" ledger entries (posted by corporate
  // actions) by company + FY and estimate the 10%-above-₹5,000 TDS per section 194.
  const ledgerEntries = getLedgerEntries();
  const dividendEvents: DividendEvent[] = ledgerEntries
    .filter((e) => e.type === "dividend" && e.symbol)
    .map((e) => ({
      symbol: e.symbol!,
      fy: fyOf(e.date, fyStartMonth, currentFy),
      date: e.date,
      grossAmount: e.amountPaise / 100,
    }));
  const dividendRows = summariseByCompanyFy(dividendEvents);

  return (
    <>
      <PageHeader title="Tax Summary (informational)" description="Per financial year — scaffold only." />
      <div className="space-y-5 p-6">
        <ProGate>
        <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-warning/90">
          <Info className="size-4 shrink-0" />
          <div>
            <span className="font-medium">Informational only — not filing advice.</span> Figures use net (post-charge)
            realised P&amp;L and a simplified holding-period rule. F&amp;O turnover uses absolute settlement P&amp;L plus
            option sell premium. Verify with a qualified tax professional before filing.
          </div>
        </div>

        <Card className="p-0">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Per financial year</CardTitle>
            <ExportButtons filename="vyuha-tax-summary" columns={COLS} rows={rows} />
          </CardHeader>
          <CardContent className="p-0">
            {rows.length === 0 ? (
              <EmptyState
                variant="journal"
                title="No closed trades yet"
                hint="Tax figures appear once a trade is closed."
                action={<Button asChild size="sm"><Link href="/import">Import a broker file</Link></Button>}
              />
            ) : (
              <ReportTable>
                <ReportThead>
                  <ReportTh>FY</ReportTh>
                  <ReportTh align="right">STCG (equity)</ReportTh>
                  <ReportTh align="right">LTCG (equity)</ReportTh>
                  <ReportTh align="right">Intraday speculative</ReportTh>
                  <ReportTh align="right">F&O business</ReportTh>
                  <ReportTh align="right">F&O turnover</ReportTh>
                  <ReportTh align="right">Charges</ReportTh>
                  <ReportTh align="right">Net realised</ReportTh>
                </ReportThead>
                <tbody>
                  {rows.map((r) => (
                    <ReportTr key={r.fy}>
                      <ReportTd className="font-medium">{r.fy}</ReportTd>
                      <ReportTd align="right" className={pnl(r.stcg)}>{inr(r.stcg, { decimals: 0 })}</ReportTd>
                      <ReportTd align="right" className={pnl(r.ltcg)}>{inr(r.ltcg, { decimals: 0 })}</ReportTd>
                      <ReportTd align="right" className={pnl(r.intradaySpeculative)}>{inr(r.intradaySpeculative, { decimals: 0 })}</ReportTd>
                      <ReportTd align="right" className={pnl(r.fnoBusiness)}>{inr(r.fnoBusiness, { decimals: 0 })}</ReportTd>
                      <ReportTd align="right" muted>{inr(r.fnoTurnover, { decimals: 0 })}</ReportTd>
                      <ReportTd align="right" className="text-warning">{inr(r.charges, { decimals: 0 })}</ReportTd>
                      <ReportTd align="right" className={`font-medium ${pnl(r.totalRealised)}`}>{inr(r.totalRealised, { decimals: 0 })}</ReportTd>
                    </ReportTr>
                  ))}
                </tbody>
              </ReportTable>
            )}
          </CardContent>
        </Card>

        <Card className="p-0">
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle>Capital-gains tax &amp; set-off (informational)</CardTitle>
            <div className="flex items-center gap-2">
              <ExportButtons
                filename="vyuha-capital-gains-itr"
                columns={[
                  { key: "scrip", label: "Scrip" }, { key: "acquired", label: "Date of acquisition" },
                  { key: "sold", label: "Date of sale" }, { key: "cost", label: "Cost of acquisition" },
                  { key: "consideration", label: "Sale consideration" }, { key: "netGain", label: "Net gain (post-charge)" },
                  { key: "term", label: "Term" }, { key: "head", label: "Head / schedule" },
                  { key: "taxableGain", label: "Taxable gain (grandfathered)" },
                ]}
                rows={itrRows}
              />
              <Badge variant="secondary">rates change {RATE_CUTOVER_DATE}</Badge>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {timeline.length === 0 ? (
              <EmptyState
                variant="journal"
                title="No closed equity-delivery/MTF trades yet"
                action={<Button asChild size="sm"><Link href="/import">Import a broker file</Link></Button>}
              />
            ) : (
              <ReportTable>
                <ReportThead>
                  <ReportTh>FY</ReportTh>
                  <ReportTh align="right">Taxable STCG</ReportTh>
                  <ReportTh align="right">Taxable LTCG</ReportTh>
                  <ReportTh align="right">Cap-gains tax due</ReportTh>
                  <ReportTh align="right">Speculative (biz)</ReportTh>
                  <ReportTh align="right">F&O non-spec (biz)</ReportTh>
                  <ReportTh align="right">B/f loss used</ReportTh>
                  <ReportTh align="right">Loss carried out</ReportTh>
                </ReportThead>
                <tbody>
                  {timeline.map((r) => {
                    const usedTotal = r.usedCarryForward.reduce((s, u) => s + u.amount, 0);
                    const carryTotal = r.newCarryForward.reduce((s, c) => s + c.amount, 0);
                    return (
                      <ReportTr key={r.fy}>
                        <ReportTd className="font-medium">{r.fy}</ReportTd>
                        <ReportTd align="right">{inr(r.taxableStcg, { decimals: 0 })}</ReportTd>
                        <ReportTd align="right">{inr(r.taxableLtcg, { decimals: 0 })}</ReportTd>
                        <ReportTd align="right" className="font-medium text-warning">{inr(r.taxDue, { decimals: 0 })}</ReportTd>
                        <ReportTd align="right" muted>{inr(r.taxableSpeculative, { decimals: 0 })}</ReportTd>
                        <ReportTd align="right" muted>{inr(r.taxableNonSpeculative, { decimals: 0 })}</ReportTd>
                        <ReportTd align="right" className="text-profit">{usedTotal > 0 ? inr(usedTotal, { decimals: 0 }) : "—"}</ReportTd>
                        <ReportTd align="right" className="text-loss">{carryTotal > 0 ? inr(carryTotal, { decimals: 0 }) : "—"}</ReportTd>
                      </ReportTr>
                    );
                  })}
                </tbody>
              </ReportTable>
            )}
          </CardContent>
        </Card>

        {grandfatherRows.length > 0 && (
          <Card className="p-0">
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>LTCG grandfathering — FMV @ {GRANDFATHER_DATE}</CardTitle>
              <Badge variant="warning">{grandfatherRows.length} pre-2018 lot{grandfatherRows.length === 1 ? "" : "s"}</Badge>
            </CardHeader>
            <CardContent>
              <FmvEditor rows={grandfatherRows} />
            </CardContent>
          </Card>
        )}

        <Card className="p-0">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Dividend income &amp; TDS (informational)</CardTitle>
            <Badge variant="secondary">10% above ₹{TDS_THRESHOLD.toLocaleString("en-IN")}/company/FY</Badge>
          </CardHeader>
          <CardContent className="p-0">
            {dividendRows.length === 0 ? (
              <EmptyState
                variant="journal"
                title="No dividend ledger entries yet"
                hint="Post one via a Corporate Action."
              />
            ) : (
              <ReportTable>
                <ReportThead>
                  <ReportTh>FY</ReportTh>
                  <ReportTh>Company</ReportTh>
                  <ReportTh align="right">Gross dividend</ReportTh>
                  <ReportTh align="right">TDS (est.)</ReportTh>
                  <ReportTh align="right">Net credited</ReportTh>
                </ReportThead>
                <tbody>
                  {dividendRows.map((r) => (
                    <ReportTr key={`${r.fy}-${r.symbol}`}>
                      <ReportTd className="font-medium">{r.fy}</ReportTd>
                      <ReportTd>{r.symbol}</ReportTd>
                      <ReportTd align="right" className="text-profit">{inr(r.grossTotal, { decimals: 0 })}</ReportTd>
                      <ReportTd align="right" className="text-warning">{r.thresholdCrossed ? inr(r.tdsTotal, { decimals: 0 }) : "—"}</ReportTd>
                      <ReportTd align="right" className="font-medium">{inr(r.netTotal, { decimals: 0 })}</ReportTd>
                    </ReportTr>
                  ))}
                </tbody>
              </ReportTable>
            )}
          </CardContent>
        </Card>

        <p className="text-[0.6875rem] text-muted-foreground">
          <strong>Rates by sell date:</strong> before {RATE_CUTOVER_DATE} — STCG 15%, LTCG 10%, ₹1L annual LTCG
          exemption; on/after — STCG 20%, LTCG 12.5%, ₹1.25L exemption. A financial year straddling the cutover uses
          each trade&apos;s own date-based rate, gain-weighted into a single FY rate for the set-off calculation — an
          approximation for that transition year; verify the exact split against the official ITR utility or a CA.{" "}
          <strong>Set-off:</strong> short-term capital loss offsets STCG then LTCG; long-term capital loss offsets
          LTCG only; a speculative (intraday equity) loss can only offset speculative gains, this year or carried
          forward up to 4 years; a non-speculative (F&amp;O) loss can offset any other gain in the same year
          (including capital gains) but once carried forward (up to 8 years) only against future business income.{" "}
          <strong>Speculative/F&amp;O columns</strong> are business income taxed at your income-tax slab rate — not
          computed here, since that depends on your total income. <strong>Dividend TDS</strong> is an estimate — the
          10% deduction applies once the company&apos;s aggregate FY dividend to you crosses ₹5,000, per section 194;
          only dividends recorded here via a Corporate Action are counted, so it may understate real TDS if you also
          hold that company through a different demat/broker not tracked in this journal.
          {hasPreGrandfatherLot && (
            <> <strong className="text-warning">Note:</strong> holdings bought before {GRANDFATHER_DATE} qualify for
            LTCG grandfathering (cost = higher of actual cost or 31-Jan-2018 fair value, capped at sale price) —
            enter each lot&apos;s FMV in the card above; lots without an FMV fall back to actual cost.</>
          )}{" "}
          <strong>Exited IPOs</strong> are included as equity-delivery capital gains (acquisition = allotment date).{" "}
          Informational only, not filing advice — verify with a qualified tax professional.
        </p>
        </ProGate>
      </div>
    </>
  );
}
