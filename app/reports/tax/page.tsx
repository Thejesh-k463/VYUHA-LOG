import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ExportButtons } from "@/components/ui/export-button";
import { ItrExportButtons } from "@/components/reports/itr-export";
import { getSettings } from "@/lib/queries/settings";
import { getDividendLedgerEntries } from "@/lib/queries/ledger";
import { getTaxBase, countItrRows } from "@/lib/queries/tax-itr";
import { taxByFy, currentFy as deriveCurrentFy } from "@/lib/analytics/tax";
import { monthlyByHead, MONTHLY_HEAD_CAVEAT } from "@/lib/analytics/monthly";
import {
  aggregateTradesByFy,
  computeTaxTimeline,
  RATE_CUTOVER_DATE,
  GRANDFATHER_DATE,
  type LossBucket,
} from "@/lib/analytics/capital-gains";
import { buildLossLedger } from "@/lib/analytics/loss-ledger";
import { section } from "@/lib/analytics/statute";
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

const MONTH_HEAD_COLS = [
  { key: "ym", label: "Month" },
  { key: "stcg", label: "STCG" }, { key: "ltcg", label: "LTCG" },
  { key: "speculative", label: "Intraday speculative" }, { key: "fnoBusiness", label: "F&O business" },
  { key: "charges", label: "Charges" }, { key: "trades", label: "Trades" },
];

export default function TaxReportPage() {
  const settings = getSettings();
  const fyStartMonth = settings?.fyStartMonth ?? 4;

  // The book projected to the 15 tax columns, exited IPOs folded in, and the
  // capital-gains inputs — one shared builder (lib/queries/tax-itr.ts) feeds
  // this page AND the on-demand /api/tax-itr export, so the two can never
  // drift. Same rows, same order, same JS filters as before — only the 59
  // never-read columns stopped being fetched.
  const { trades, closedTrades, ipoTaxRows, cgTrades } = getTaxBase();
  // Undated closed trades bucket under TODAY'S FY — passed explicitly so this
  // page and the analytics module can never disagree on the fallback year.
  const currentFy = deriveCurrentFy(fyStartMonth);
  const rows = taxByFy([...trades, ...ipoTaxRows], fyStartMonth, currentFy);
  const pnl = (v: number) => (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground");

  const hasPreGrandfatherLot = cgTrades.some((t) => t.buyDate != null && t.buyDate < GRANDFATHER_DATE);
  // Pre-2018 closed equity lots — the rows the FMV editor targets.
  const grandfatherRows = closedTrades
    .filter((t) => (t.segment === "eq_delivery" || t.segment === "eq_mtf") && t.buyDate != null && t.buyDate < GRANDFATHER_DATE)
    .map((t) => ({ id: t.id, symbol: t.symbol, buyDate: t.buyDate!, sellDate: t.sellDate, buyQty: t.buyQty, avgBuyPrice: t.avgBuyPrice, fmv31Jan2018: t.fmv31Jan2018 ?? null }));

  // ITR-schedule export rows are fetched by /api/tax-itr when Export is
  // clicked — shipping all of them as client props serialised ~4.8 MB of
  // never-rendered rows into every visit's RSC payload at 25k trades. Only
  // the count (for the disabled state) is computed here.
  const itrCount = countItrRows();
  const byFy = aggregateTradesByFy(cgTrades, fyStartMonth, currentFy);
  const timeline = computeTaxTimeline(byFy);

  // Loss ledger — surviving carry-forward vintages as of the latest FY in the
  // timeline. Pure re-reading of the timeline (lib/analytics/loss-ledger.ts);
  // no figure on this page changes because of it.
  const lossLedger = buildLossLedger(timeline);
  const ledgerAsOfFy = timeline.length > 0 ? timeline[timeline.length - 1].fy : currentFy;
  // Set-off reach per bucket, cited under the Act governing the as-of FY.
  const bucketMeta: Record<LossBucket, { label: string; reach: string }> = {
    stcl: { label: "Short-term capital loss", reach: `sets off STCG, then LTCG · ${section(ledgerAsOfFy, "cfCapitalLoss")}` },
    ltcl: { label: "Long-term capital loss", reach: `sets off LTCG only · ${section(ledgerAsOfFy, "cfCapitalLoss")}` },
    speculative: { label: "Speculative (intraday)", reach: `sets off speculative gains only · ${section(ledgerAsOfFy, "speculationLoss")}` },
    nonSpeculative: { label: "Non-speculative (F&O)", reach: `once carried forward, sets off business income only · ${section(ledgerAsOfFy, "cfBusinessLoss")}` },
  };

  // IND-6 — dividend & TDS: group "dividend" ledger entries (posted by corporate
  // actions) by company + FY and estimate the 10%-above-₹5,000 TDS per section 194.
  // Filtered in SQL — see getDividendLedgerEntries; same rows, same order.
  const dividendEvents: DividendEvent[] = getDividendLedgerEntries()
    .map((e) => ({
      symbol: e.symbol,
      fy: fyOf(e.date, fyStartMonth, currentFy),
      date: e.date,
      grossAmount: e.amountPaise / 100,
    }));
  const dividendRows = summariseByCompanyFy(dividendEvents);

  // WHEN income arrived, split the way the return splits it. Not a monthly bill.
  const monthHeads = monthlyByHead(
    [...trades, ...ipoTaxRows].map((t) => ({
      sellDate: t.sellDate, buyDate: t.buyDate, segment: t.segment,
      netPnl: t.netPnl, grossPnl: t.grossPnl, chargesTotal: t.chargesTotal, isOpen: t.isOpen,
    })),
  );
  const MONTH_HEAD_CAP = 24;
  const monthHeadsShown = monthHeads.slice(-MONTH_HEAD_CAP).reverse();

  return (
    <>
      <PageHeader title="Tax Summary (informational)" description="Per financial year — scaffold only." />
      <div className="space-y-5 p-6">
        <ProGate>
        <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-warning/90">
          <Info className="size-4 shrink-0" />
          <div>
            <span className="font-medium">Informational only — not filing advice.</span> Figures use net (post-charge)
            realised P&amp;L and a simplified holding-period rule. F&amp;O turnover follows the ICAI Guidance Note on
            Tax Audit, 11th edition (2026), para 5.11(b) — absolute settlement differences plus premium received on
            the sale of options. That is ICAI guidance, not statute, and your CA may use a different basis. Verify
            with a qualified tax professional before filing.
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

        {/* Realised by head, by MONTH. Deliberately not called a monthly tax
            breakdown: set-off, the LTCG threshold and slab rates are annual, so
            no month has a tax figure of its own. MONTHLY_HEAD_CAVEAT says so. */}
        {monthHeads.length > 0 && (
          <Card className="p-0">
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle>Realised by head, by month</CardTitle>
                <p className="mt-1 max-w-3xl text-xs text-muted-foreground">{MONTHLY_HEAD_CAVEAT}</p>
              </div>
              <ExportButtons filename="vyuha-monthly-by-head" columns={MONTH_HEAD_COLS} rows={monthHeads} />
            </CardHeader>
            <CardContent className="p-0">
              <ReportTable>
                <ReportThead>
                  <ReportTh>Month</ReportTh>
                  <ReportTh align="right">STCG</ReportTh>
                  <ReportTh align="right">LTCG</ReportTh>
                  <ReportTh align="right">Intraday speculative</ReportTh>
                  <ReportTh align="right">F&O business</ReportTh>
                  <ReportTh align="right">Charges</ReportTh>
                  <ReportTh align="right">Trades</ReportTh>
                </ReportThead>
                <tbody>
                  {monthHeadsShown.map((m) => (
                    <ReportTr key={m.ym}>
                      <ReportTd className="font-medium">{m.ym}</ReportTd>
                      <ReportTd align="right" className={pnl(m.stcg)}>{inr(m.stcg, { decimals: 0 })}</ReportTd>
                      <ReportTd align="right" className={pnl(m.ltcg)}>{inr(m.ltcg, { decimals: 0 })}</ReportTd>
                      <ReportTd align="right" className={pnl(m.speculative)}>{inr(m.speculative, { decimals: 0 })}</ReportTd>
                      <ReportTd align="right" className={pnl(m.fnoBusiness)}>{inr(m.fnoBusiness, { decimals: 0 })}</ReportTd>
                      <ReportTd align="right" className="text-warning">{inr(m.charges, { decimals: 0 })}</ReportTd>
                      <ReportTd align="right" muted>{m.trades}</ReportTd>
                    </ReportTr>
                  ))}
                </tbody>
              </ReportTable>
              {monthHeadsShown.length < monthHeads.length && (
                <p className="px-4 py-2 text-xs text-muted-foreground">
                  Showing the most recent {monthHeadsShown.length} of {monthHeads.length} months. Export for all.
                </p>
              )}
            </CardContent>
          </Card>
        )}

        <Card className="p-0">
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle>Capital-gains tax &amp; set-off (informational)</CardTitle>
            <div className="flex items-center gap-2">
              <ItrExportButtons filename="vyuha-capital-gains-itr" total={itrCount} />
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

        {timeline.length > 0 && (
          <Card className="p-0">
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle>Loss ledger — carry-forward vintages</CardTitle>
                <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
                  Unabsorbed losses still carrying forward as of FY {ledgerAsOfFy}, by the year each was incurred.
                  Capital and non-speculative business losses live 8 years; speculative losses live 4.
                </p>
              </div>
              {lossLedger.length > 0 && (
                <Badge variant="secondary">{lossLedger.length} vintage{lossLedger.length === 1 ? "" : "s"}</Badge>
              )}
            </CardHeader>
            <CardContent className="p-0">
              {lossLedger.length === 0 ? (
                <EmptyState
                  variant="journal"
                  title="No losses awaiting set-off"
                  hint={`No unabsorbed loss vintages remain as of FY ${ledgerAsOfFy}.`}
                />
              ) : (
                <ReportTable>
                  <ReportThead>
                    <ReportTh>Bucket</ReportTh>
                    <ReportTh>FY incurred</ReportTh>
                    <ReportTh align="right">Original</ReportTh>
                    <ReportTh align="right">Absorbed here</ReportTh>
                    <ReportTh align="right">Remaining</ReportTh>
                    <ReportTh align="right">Expires after FY</ReportTh>
                  </ReportThead>
                  <tbody>
                    {lossLedger.map((r) => (
                      <ReportTr key={`${r.fyIncurred}-${r.bucket}`}>
                        <ReportTd>
                          <span className="font-medium">{bucketMeta[r.bucket].label}</span>
                          <span className="mt-0.5 block text-[0.6875rem] text-muted-foreground">{bucketMeta[r.bucket].reach}</span>
                        </ReportTd>
                        <ReportTd className="font-medium">{r.fyIncurred}</ReportTd>
                        <ReportTd align="right" muted>{r.originalAmount != null ? inr(r.originalAmount, { decimals: 0 }) : "—"}</ReportTd>
                        <ReportTd align="right" className="text-profit">{r.absorbed > 0 ? inr(r.absorbed, { decimals: 0 }) : "—"}</ReportTd>
                        <ReportTd align="right" className="font-medium text-loss">{inr(r.remaining, { decimals: 0 })}</ReportTd>
                        <ReportTd align="right" muted>{r.expiresAfterFy}</ReportTd>
                      </ReportTr>
                    ))}
                  </tbody>
                </ReportTable>
              )}
              <p className="px-4 py-3 text-[0.6875rem] text-muted-foreground">
                Vintages come from journal data only — brought-forward losses from returns filed before this journal
                began are not yet enterable (planned for v3.6). &ldquo;Absorbed here&rdquo; counts only set-off inside
                this journal&apos;s timeline.
              </p>
            </CardContent>
          </Card>
        )}

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
