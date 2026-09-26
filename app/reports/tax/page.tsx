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
  MTF_NOT_DEDUCTED_NOTE,
  STT_ADDED_BACK_NOTE,
  RATE_CUTOVER_DATE,
  GRANDFATHER_DATE,
  type LossBucket,
} from "@/lib/analytics/capital-gains";
import { buildLossLedger } from "@/lib/analytics/loss-ledger";
import { getBfLossRows, toSeedLots, excludedSeedLots, displayRows, HEAD_LABELS, LOSS_HEADS } from "@/lib/queries/bf-losses";
import { getAccounts, isAggregateView } from "@/lib/queries/accounts";
import { needsPersonChoice, resolveTaxScope, taxScopeHeader } from "@/lib/queries/tax-scope";
import { TaxPersonLine, TaxPersonPicker } from "@/components/reports/tax-person-scope";
import { BfLossEditor } from "@/components/reports/bf-loss-editor";
import { section } from "@/lib/analytics/statute";
import { summariseByCompanyFy, TDS_THRESHOLD, type DividendEvent } from "@/lib/analytics/dividend-tds";
import { inr } from "@/lib/format";
import { Info } from "lucide-react";
import { ProGate } from "@/components/system/pro-gate";
import { FmvEditor } from "@/components/reports/fmv-editor";
import { grandfatherLotsOf, groupGrandfatherLots } from "@/lib/analytics/grandfather-groups";
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
  // v4.5.0 — five capital-gains heads, never one "STCG"/"LTCG" pair. A gold ETF
  // and an equity share are not the same column.
  { key: "stcg111A", label: "STCG 111A" }, { key: "stcgOther", label: "STCG slab/50AA" },
  { key: "ltcg112A", label: "LTCG 112A" }, { key: "ltcg112", label: "LTCG 112" },
  { key: "cgUndetermined", label: "CG head undetermined" },
  { key: "intradaySpeculative", label: "Intraday speculative" },
  { key: "fnoBusiness", label: "F&O business" }, { key: "fnoTurnover", label: "F&O turnover" },
  { key: "charges", label: "Charges" }, { key: "totalRealised", label: "Net realised" },
  { key: "sttAddedBack", label: "STT added back (CG)" },
  { key: "notDeductedMtf", label: "MTF interest + pledge not deducted" },
];

const MONTH_HEAD_COLS = [
  { key: "ym", label: "Month" },
  { key: "stcg111A", label: "STCG 111A" }, { key: "stcgOther", label: "STCG slab/50AA" },
  { key: "ltcg112A", label: "LTCG 112A" }, { key: "ltcg112", label: "LTCG 112" },
  { key: "cgUndetermined", label: "CG head undetermined" },
  { key: "speculative", label: "Intraday speculative" }, { key: "fnoBusiness", label: "F&O business" },
  { key: "charges", label: "Charges" }, { key: "trades", label: "Trades" },
];

export default async function TaxReportPage({
  searchParams,
}: {
  // v4.5.0 wave TP — the person picker's choice arrives here. A VIEW param:
  // nothing is written and nothing is persisted (invariant 9).
  searchParams: Promise<{ person?: string }>;
}) {
  const { person } = await searchParams;
  // TAX PERSON, not account (owner ruling T1): this page's every figure is
  // computed over ONE person's accounts, archived included, and never across
  // two persons. With All accounts selected and more than one person in the
  // book, the picker replaces the page (invariant 6).
  const scope = resolveTaxScope(person);
  const settings = getSettings();
  const fyStartMonth = settings?.fyStartMonth ?? 4;

  if (needsPersonChoice(scope)) {
    return (
      <>
        <PageHeader title="Tax Summary (informational)" description="Per financial year — scaffold only." />
        <div className="space-y-5 p-6">
          <TaxPersonPicker scope={scope} basePath="/reports/tax" />
        </div>
      </>
    );
  }

  // The book projected to the 15 tax columns, exited IPOs folded in, and the
  // capital-gains inputs — one shared builder (lib/queries/tax-itr.ts) feeds
  // this page AND the on-demand /api/tax-itr export, so the two can never
  // drift. Same rows, same order, same JS filters as before — only the 59
  // never-read columns stopped being fetched.
  // `taxRows` carries the RESOLVED asset class and the three non-deductible
  // charge lines — the page never re-derives a head from a segment (v4.5.0).
  // `trades` (the raw projection, open rows included) is read ONLY to list the
  // FMV editor's lots (the parent rows behind the realised book, v4.6.0 W7):
  // every FIGURE on this page comes from `taxRows`, which carries the resolved
  // asset class.
  const { trades, realisedTrades, ipoTaxRows, cgTrades, taxRows } = getTaxBase(person);
  // Undated closed trades bucket under TODAY'S FY — passed explicitly so this
  // page and the analytics module can never disagree on the fallback year.
  const currentFy = deriveCurrentFy(fyStartMonth);
  const rows = taxByFy([...taxRows, ...ipoTaxRows], fyStartMonth, currentFy);
  const pnl = (v: number) => (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground");

  // v4.6.0 W7 (D3) — eligibility through the DATE (`isGrandfatherEligible`),
  // never a byte compare against GRANDFATHER_DATE: a DD-MM-YYYY legacy row
  // '15-06-2019' sorts below '2018-02-01' bytewise and '31-12-2017' above it.
  // The lots the FMV editor targets: the DISTINCT PARENTS behind the realised
  // book (not the closed rows) — a partly-sold pre-2018 staged ladder is open,
  // yet its realised rows already carry its FMV into the tax readers, so it
  // must be editable. Grouped per scrip (symbol + ISIN): one FMV, one Save.
  // The selection is the pure `grandfatherLotsOf` (tests/grandfather-groups.test.ts).
  const grandfatherGroups = groupGrandfatherLots(grandfatherLotsOf(trades, realisedTrades));
  const grandfatherLotCount = grandfatherGroups.reduce((n, g) => n + g.lots.length, 0);
  // v4.6.0 fix wave (DA-9) — the footnote that points at "the card above" is
  // conditioned on the card's OWN selection, not on `cgTrades` (which holds
  // F&O and exited IPOs too): a note with no card was the defect.
  const hasPreGrandfatherLot = grandfatherGroups.length > 0;

  // ITR-schedule export rows are fetched by /api/tax-itr when Export is
  // clicked — shipping all of them as client props serialised ~4.8 MB of
  // never-rendered rows into every visit's RSC payload at 25k trades. Only
  // the count (for the disabled state) is computed here.
  const itrCount = countItrRows(person);
  // Every export carries the person line (owner ruling T1).
  const scopeNote = taxScopeHeader(scope);
  const byFy = aggregateTradesByFy(cgTrades, fyStartMonth, currentFy);
  // Pre-journal brought-forward losses seed the timeline as CarryForwardLots:
  // pruneExpired drops already-expired vintages on entry, the rest absorb
  // oldest-first — exactly like journal-tracked losses (WS5). The SeedGuard
  // drops any lot whose FY the journal itself covers (its loss is already
  // computed from imported trades — seeding it would double-count) plus any
  // future-dated lot; the dropped vintages are named in the warning below.
  // The person's lots, SUMMED across their accounts (design review item 14):
  // one return sets off one person's carried losses, wherever they sit.
  const bfRows = getBfLossRows(scope.accountIds);
  const accountNameById = new Map(getAccounts().map((a) => [a.id, a.name]));
  const bfSourceNames = [...new Set(bfRows.map((r) => accountNameById.get(r.accountId) ?? `#${r.accountId}`))];
  const seedGuard = { journalledFys: new Set(byFy.map((f) => f.fy)), currentFy };
  const ignoredBfRows = excludedSeedLots(bfRows, seedGuard);
  const timeline = computeTaxTimeline(byFy, toSeedLots(bfRows, seedGuard));

  // Loss ledger — surviving carry-forward vintages as of the latest FY in the
  // timeline. Pure re-reading of the timeline (lib/analytics/loss-ledger.ts);
  // no figure on this page changes because of it.
  const lossLedger = buildLossLedger(timeline);
  // Display-only enrichment for SEEDED vintages: the pure ledger honestly
  // reports originalAmount null when the incurring FY predates the timeline —
  // that contract is untouched; where the user STORED the original figure on
  // the lot, the page shows it instead of "—". Never a guess: absent both, the
  // dash stays.
  const seededOriginals = new Map(
    bfRows.filter((r) => r.originalAmount != null).map((r) => [`${r.incurredFy}|${r.head}`, r.originalAmount as number]),
  );
  const ledgerRows = lossLedger.map((r) => ({
    ...r,
    displayOriginal: r.originalAmount ?? seededOriginals.get(`${r.fyIncurred}|${r.bucket}`) ?? null,
  }));
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
  const dividendEvents: DividendEvent[] = getDividendLedgerEntries(scope.accountIds)
    .map((e) => ({
      symbol: e.symbol,
      fy: fyOf(e.date, fyStartMonth, currentFy),
      date: e.date,
      grossAmount: e.amountPaise / 100,
    }));
  const dividendRows = summariseByCompanyFy(dividendEvents);

  // WHEN income arrived, split the way the return splits it. Not a monthly bill.
  const monthHeads = monthlyByHead(
    [...taxRows, ...ipoTaxRows].map((t) => ({
      sellDate: t.sellDate, buyDate: t.buyDate, segment: t.segment, assetClass: t.assetClass,
      netPnl: t.netPnl, grossPnl: t.grossPnl, chargesTotal: t.chargesTotal, isOpen: t.isOpen,
    })),
  );
  const MONTH_HEAD_CAP = 24;
  const monthHeadsShown = monthHeads.slice(-MONTH_HEAD_CAP).reverse();

  return (
    <>
      <PageHeader title="Tax Summary (informational)" description="Per financial year — scaffold only." />
      <div className="space-y-5 p-6">
        <TaxPersonLine scope={scope} />
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
            <ExportButtons filename="vyuha-tax-summary" columns={COLS} rows={rows} note={scopeNote} />
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
                  <ReportTh align="right">STCG 111A</ReportTh>
                  <ReportTh align="right">STCG slab / 50AA</ReportTh>
                  <ReportTh align="right">LTCG 112A</ReportTh>
                  <ReportTh align="right">LTCG 112</ReportTh>
                  <ReportTh align="right">Head undetermined</ReportTh>
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
                      <ReportTd align="right" className={pnl(r.stcg111A)}>{inr(r.stcg111A, { decimals: 0 })}</ReportTd>
                      <ReportTd align="right" className={pnl(r.stcgOther)}>{inr(r.stcgOther, { decimals: 0 })}</ReportTd>
                      <ReportTd align="right" className={pnl(r.ltcg112A)}>{inr(r.ltcg112A, { decimals: 0 })}</ReportTd>
                      <ReportTd align="right" className={pnl(r.ltcg112)}>{inr(r.ltcg112, { decimals: 0 })}</ReportTd>
                      {/* A head the journal cannot determine is printed BLANK,
                          never ₹0 — invariant 6. */}
                      <ReportTd align="right" className={pnl(r.cgUndetermined)}>
                        {r.cgUndetermined === 0 ? "—" : inr(r.cgUndetermined, { decimals: 0 })}
                      </ReportTd>
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
              <ExportButtons filename="vyuha-monthly-by-head" columns={MONTH_HEAD_COLS} rows={monthHeads} note={scopeNote} />
            </CardHeader>
            <CardContent className="p-0">
              <ReportTable>
                <ReportThead>
                  <ReportTh>Month</ReportTh>
                  <ReportTh align="right">STCG 111A</ReportTh>
                  <ReportTh align="right">STCG slab / 50AA</ReportTh>
                  <ReportTh align="right">LTCG 112A</ReportTh>
                  <ReportTh align="right">LTCG 112</ReportTh>
                  <ReportTh align="right">Head undetermined</ReportTh>
                  <ReportTh align="right">Intraday speculative</ReportTh>
                  <ReportTh align="right">F&O business</ReportTh>
                  <ReportTh align="right">Charges</ReportTh>
                  <ReportTh align="right">Trades</ReportTh>
                </ReportThead>
                <tbody>
                  {monthHeadsShown.map((m) => (
                    <ReportTr key={m.ym}>
                      <ReportTd className="font-medium">{m.ym}</ReportTd>
                      <ReportTd align="right" className={pnl(m.stcg111A)}>{inr(m.stcg111A, { decimals: 0 })}</ReportTd>
                      <ReportTd align="right" className={pnl(m.stcgOther)}>{inr(m.stcgOther, { decimals: 0 })}</ReportTd>
                      <ReportTd align="right" className={pnl(m.ltcg112A)}>{inr(m.ltcg112A, { decimals: 0 })}</ReportTd>
                      <ReportTd align="right" className={pnl(m.ltcg112)}>{inr(m.ltcg112, { decimals: 0 })}</ReportTd>
                      <ReportTd align="right" className={pnl(m.cgUndetermined)}>
                        {m.cgUndetermined === 0 ? "—" : inr(m.cgUndetermined, { decimals: 0 })}
                      </ReportTd>
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
              <ItrExportButtons filename="vyuha-capital-gains-itr" total={itrCount} person={scope.personKey} note={scopeNote} />
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
                        {/* BLANK, never ₹0, when the year holds a slab bucket,
                            an undetermined head or an s.112 cell with no CII
                            (invariant 6; owner answer T3). The per-bucket
                            amounts above are complete either way. */}
                        <ReportTd align="right" className="font-medium text-warning" title={r.taxDueBlankReasons.join(" ")}>
                          {r.taxDue == null ? "—" : inr(r.taxDue, { decimals: 0 })}
                        </ReportTd>
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
            {/* The three second-pass rulings, rendered where the figures they
                move are read. Per YEAR, with the amount named — a note without
                a number is not a disclosure. */}
            {rows.some((r) => r.notDeductedMtf > 0 || r.sttAddedBack > 0) && (
              <div className="space-y-2 border-t p-4 text-xs text-muted-foreground">
                {rows
                  .filter((r) => r.notDeductedMtf > 0 || r.sttAddedBack > 0)
                  .map((r) => (
                    <p key={r.fy}>
                      <span className="font-medium text-foreground">FY {r.fy}:</span>{" "}
                      {r.notDeductedMtf > 0 && (
                        <>MTF interest / pledge charges not deducted: {inr(r.notDeductedMtf, { decimals: 0 })}. </>
                      )}
                      {r.sttAddedBack > 0 && <>STT added back into the capital-gains buckets: {inr(r.sttAddedBack, { decimals: 0 })}.</>}
                    </p>
                  ))}
                <p>{MTF_NOT_DEDUCTED_NOTE}</p>
                <p>{STT_ADDED_BACK_NOTE}</p>
              </div>
            )}
            {timeline.some((r) => r.taxDueBlankReasons.length > 0) && (
              <div className="space-y-2 border-t p-4 text-xs text-warning/90">
                {timeline
                  .filter((r) => r.taxDueBlankReasons.length > 0)
                  .map((r) => (
                    <p key={r.fy}>
                      <span className="font-medium">FY {r.fy} — no capital-gains total is stated.</span>{" "}
                      {r.taxDueBlankReasons.join(" ")}
                    </p>
                  ))}
              </div>
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
                    {ledgerRows.map((r) => (
                      <ReportTr key={`${r.fyIncurred}-${r.bucket}`}>
                        <ReportTd>
                          <span className="font-medium">{bucketMeta[r.bucket].label}</span>
                          <span className="mt-0.5 block text-[0.6875rem] text-muted-foreground">{bucketMeta[r.bucket].reach}</span>
                        </ReportTd>
                        <ReportTd className="font-medium">{r.fyIncurred}</ReportTd>
                        <ReportTd align="right" muted>{r.displayOriginal != null ? inr(r.displayOriginal, { decimals: 0 }) : "—"}</ReportTd>
                        <ReportTd align="right" className="text-profit">{r.absorbed > 0 ? inr(r.absorbed, { decimals: 0 }) : "—"}</ReportTd>
                        <ReportTd align="right" className="font-medium text-loss">{inr(r.remaining, { decimals: 0 })}</ReportTd>
                        <ReportTd align="right" muted>{r.expiresAfterFy}</ReportTd>
                      </ReportTr>
                    ))}
                  </tbody>
                </ReportTable>
              )}
              <p className="px-4 py-3 text-[0.6875rem] text-muted-foreground">
                Vintages come from journal data plus any brought-forward losses entered in the card below — seeded
                lots enter the set-off and expiry maths exactly like journal-tracked ones. &ldquo;Absorbed here&rdquo;
                counts only set-off inside this journal&apos;s timeline.
              </p>
            </CardContent>
          </Card>
        )}

        <Card className="p-0">
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Brought-forward losses (pre-journal)</CardTitle>
              <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
                Losses from ITRs filed before you started this journal — one lot per year and head, as your last
                filed return carried them out. Seeded lots enter the set-off and expiry maths above exactly like
                journal-tracked ones.
              </p>
            </div>
            {bfRows.length > 0 && (
              <Badge variant="secondary">{bfRows.length} lot{bfRows.length === 1 ? "" : "s"}</Badge>
            )}
          </CardHeader>
          <CardContent>
            {ignoredBfRows.length > 0 && (
              <p className="mb-3 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 p-2 text-xs text-warning/90">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {ignoredBfRows.map((r) => `${r.incurredFy} (${HEAD_LABELS[r.head as keyof typeof HEAD_LABELS] ?? r.head})`).join(", ")} entered here{" "}
                  {ignoredBfRows.length === 1 ? "is" : "are"} ignored — {ignoredBfRows.length === 1 ? "that FY is" : "those FYs are"} journalled, so
                  the set-off above computes {ignoredBfRows.length === 1 ? "its" : "their"} losses from the imported trades instead. Delete the
                  {ignoredBfRows.length === 1 ? " lot" : " lots"} to clear this notice.
                </span>
              </p>
            )}
            {/* v4.5.0 wave TP — the lots below are the TAX PERSON's, summed
                across their accounts (design review item 14). Each source
                account is named here: a row seeded in a sibling account is
                still the same person's carried loss, and the editor writes
                only to the selected account (invariant 9). */}
            {bfSourceNames.length > 1 && (
              <p className="mb-2 text-xs text-muted-foreground">
                Lots from: {bfSourceNames.join(", ")}. Edits are saved to the selected account.
              </p>
            )}
            <BfLossEditor
              rows={displayRows(bfRows).map((r) => ({
                id: r.id,
                incurredFy: r.incurredFy,
                head: r.head,
                headLabel: HEAD_LABELS[r.head as keyof typeof HEAD_LABELS] ?? r.head,
                amount: r.amount,
                originalAmount: r.originalAmount,
                note: r.note,
                expiresAfterFy: r.expiresAfterFy,
              }))}
              heads={LOSS_HEADS.map((h) => ({ value: h, label: HEAD_LABELS[h] }))}
              aggregate={isAggregateView()}
            />
          </CardContent>
        </Card>

        {grandfatherGroups.length > 0 && (
          <Card className="p-0">
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>LTCG grandfathering — FMV @ {GRANDFATHER_DATE}</CardTitle>
              <Badge variant="warning">
                {grandfatherLotCount} pre-2018 lot{grandfatherLotCount === 1 ? "" : "s"} · {grandfatherGroups.length} scrip
                {grandfatherGroups.length === 1 ? "" : "s"}
              </Badge>
            </CardHeader>
            <CardContent>
              {/* Keyed by person: router.refresh() keeps client state, and one
                  person's typed FMV must never sit on another's same scrip. */}
              {/* v4.6.0 fix wave (UJ-3): keyed on the RESOLVED tax person — without
                  ?person= the person follows the selected account and the
                  switcher only router.refresh()es, so a key of "all" carried an
                  unsaved typed FMV onto the next person's same-scrip group. */}
              <FmvEditor key={scope.personKey} groups={grandfatherGroups} person={person} />
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
            enter each scrip&apos;s FMV in the card above; lots without an FMV fall back to actual cost.</>
          )}{" "}
          <strong>Charges:</strong> STT/CTT and stamp duty are rounded to the rupee per trade row here (per fill on a
          staged ladder); a contract note rounds each head once, so a day with N rows can differ from your bill by up to
          ₹0.50 × N per head.{" "}
          <strong>Exited IPOs</strong> are included as equity-delivery capital gains (acquisition = allotment date).{" "}
          Informational only, not filing advice — verify with a qualified tax professional.
        </p>
        </ProGate>
      </div>
    </>
  );
}
