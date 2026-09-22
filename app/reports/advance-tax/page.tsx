import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AdvanceTaxCalc } from "@/components/reports/advance-tax-calc";
import { ChallanEditor, type ChallanEditorRow } from "@/components/reports/challan-editor";
import { getHarvestTrades } from "@/lib/queries/trades";
import { getMtmMap } from "@/lib/queries/mtm";
import { classifyGain, MTF_NOT_DEDUCTED_NOTE } from "@/lib/analytics/capital-gains";
import { assetClassFor, heldMoreThanMonths, holdingMonthsFor } from "@/lib/analytics/cg-heads";
import { getSettings } from "@/lib/queries/settings";
import { computeHarvest, type OpenLot } from "@/lib/analytics/harvest";
import { computeAdvanceTax } from "@/lib/analytics/advance-tax";
import { section } from "@/lib/analytics/statute";
import { advanceTaxFyWindow, challanTotalsByFy, findDuplicateChallan, getChallans, todayIstIso } from "@/lib/queries/challans";
import { getAccounts, isAggregateView } from "@/lib/queries/accounts";
import { needsPersonChoice, resolveTaxScope } from "@/lib/queries/tax-scope";
import { TaxPersonLine, TaxPersonPicker } from "@/components/reports/tax-person-scope";
import { fmtDate, inr } from "@/lib/format";
import { ProGate } from "@/components/system/pro-gate";

export const dynamic = "force-dynamic";

// Mirrors /reports/harvest: capital-gains harvesting is equity delivery only.
const EQUITY_SEGMENTS = new Set(["eq_delivery", "eq_mtf"]);
// The 365-day `daysHeld` helper that stood here is DELETED: the holding period
// is a calendar-month rule with one home, lib/analytics/cg-heads.ts.

export default async function AdvanceTaxPage({
  searchParams,
}: {
  /** v4.5.0 wave TP — the person picker's choice; a view param, never a write. */
  searchParams: Promise<{ person?: string }>;
}) {
  const { person } = await searchParams;
  // TAX PERSON, not account (owner ruling T1): advance tax is one PAN's
  // liability, and the challans that discharge it are that person's wherever
  // they were paid from. Never a figure across two persons (invariant 6).
  const scope = resolveTaxScope(person);
  if (needsPersonChoice(scope)) {
    return (
      <>
        <PageHeader title="Advance tax planner" description="Plan your instalments." />
        <div className="space-y-5 p-6">
          <TaxPersonPicker scope={scope} basePath="/reports/advance-tax" />
        </div>
      </>
    );
  }
  // ONE clock for this page and the ledger it writes to. `todayIstIso()` is the
  // same India-anchored day `upsertChallan` validates against, so the planner
  // cannot say "45% paid" and "₹4,50,000 short now" about the same money, and
  // the editor's `max` cannot sit on yesterday. A UTC `today` did both between
  // 00:00 and 05:30 IST: it dated a challan paid this morning into the future
  // and left `totalShortfallNow` measuring the gap at a day that had passed.
  const today = todayIstIso();
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
  const trades = getHarvestTrades(scope.accountIds);

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
      // v4.5.0 — calendar months, and the class-aware holding period. Kept
      // byte-identical to /reports/harvest so the two pages cannot disagree.
      const assetClass = assetClassFor({ segment: t.segment, isin: t.isin, symbol: t.symbol });
      const term = heldMoreThanMonths(t.buyDate, today, holdingMonthsFor(assetClass, today)) ? "LT" : "ST";
      return { id: t.id, symbol: t.symbol, qty, entry: t.avgBuyPrice, mtm: price, term, unrealised: (price - t.avgBuyPrice) * qty };
    });

  // classifyGain keeps this loop identical to /reports/harvest — including
  // the 31-Jan-2018 grandfathering path — so the two pages state one figure.
  let realisedStcg = 0;
  let realisedLtcg = 0;
  /** Realised this FY with NO determinable head — excluded from both, stated. */
  let realisedUndetermined = 0;
  for (const t of trades) {
    if (t.isOpen || !EQUITY_SEGMENTS.has(t.segment) || !t.sellDate || t.sellDate < fyStart) continue;
    const g = classifyGain({
      segment: t.segment,
      assetClass: assetClassFor({ segment: t.segment, isin: t.isin, symbol: t.symbol }),
      sttCtt: t.sttCtt,
      mtfInterest: t.mtfInterest,
      pledgeCharges: t.pledgeCharges,
      buyDate: t.buyDate,
      sellDate: t.sellDate,
      buyValue: t.buyValue,
      sellValue: t.sellValue,
      netPnl: t.netPnl,
      // Per-share in the column, TOTAL units into classifyGain — same
      // scaling as tax-itr.ts and /reports/harvest.
      fmv31Jan2018: t.fmv31Jan2018 != null && t.buyQty > 0 ? t.fmv31Jan2018 * t.buyQty : null,
    });
    if (g?.bucket === "ltcg112A" || g?.bucket === "ltcg112") realisedLtcg += g.taxableGain;
    else if (g?.bucket === "stcg111A" || g?.bucket === "stcgOther") realisedStcg += g.taxableGain;
    else if (g?.bucket === "cgUndetermined") realisedUndetermined += g.taxableGain;
  }

  const harvest = computeHarvest(lots, realisedStcg, realisedLtcg, today, fyEnd);
  const harvestableLoss = harvest.stLoss + harvest.ltLoss;

  // ── Challan ledger (v3.7, WS4) ───────────────────────────────────────────
  // The FY label and the instalment rungs come from the ENGINE, not from a
  // second copy of the ladder on this page: computeAdvanceTax already derives
  // both from `today` + `fyStartMonth`, so a rung that moves there moves here
  // too. Estimated tax 0 is deliberate — only the dates are read.
  const rungs = computeAdvanceTax({ estimatedAnnualTax: 0, taxPaidToDate: 0, today, fyStartMonth });
  const fy = rungs.fyLabel;
  // The PERSON's challans for the FY, summed across their accounts; each row
  // names the account it was paid from (design review item 14).
  const ledger = challanTotalsByFy(fy, scope.accountIds);
  const aggregate = isAggregateView();
  // s.408(3) draws its line at 31 March whatever the journal's FY start month
  // is, and so does the engine's ladder — so the ledger's own window is the
  // statutory April-to-March year too (advanceTaxFyWindow), and the editor
  // offers exactly the dates upsertChallan will accept and the planner will
  // count. It used to offer two months the planner then threw away.
  const { start: fyWindowStart, end: fyWindowEnd } = advanceTaxFyWindow(fy);
  const marchEnd = fyWindowEnd;
  const countsTowards = (paidOn: string): string => {
    if (paidOn > marchEnd) return `after 31 Mar — self-assessment tax`;
    const rung = rungs.instalments.find((i) => paidOn <= i.dueDate);
    return rung ? `${rung.label} (${rung.cumPct}%)` : `after 15 Mar — still ${fy} advance tax`;
  };

  const accountNameById = new Map(getAccounts().map((a) => [a.id, a.name]));
  const challanRows: ChallanEditorRow[] = getChallans(fy, scope.accountIds).map((r) => ({
    id: r.id,
    paidOn: r.paidOn,
    paidOnLabel: fmtDate(r.paidOn),
    amount: r.amount,
    bsrCode: r.bsrCode,
    challanSerial: r.challanSerial,
    note: r.note,
    // v4.5.0 wave TP — with more than one account in the person, every payment
    // NAMES the account it was made from (design review item 14: sum across
    // the person's accounts, each source named). One account: unchanged text.
    countsTowards: countsTowards(r.paidOn) + (scope.accountIds.length > 1 ? ` · ${accountNameById.get(r.accountId) ?? `#${r.accountId}`}` : ""),
    // findDuplicateChallan declares its amount parameter in PAISE (rupee floats
    // are not safe to compare for equality); this ×100 is that documented
    // parameter boundary, NOT a second money conversion — the row itself stays
    // in rupees everywhere else on this page (invariant 1).
    duplicate: findDuplicateChallan(fy, r.paidOn, Math.round(r.amount * 100), r.id, scope.accountIds) !== null,
  }));

  return (
    <>
      <PageHeader
        title="Advance tax planner"
        description={`Plan your 15 Jun / Sep / Dec / Mar instalments and avoid ${section(fy, "interestDeferment")} interest.`}
        actions={<Badge variant="secondary">FY from {fyStart}</Badge>}
      />
      <div className="space-y-5 p-6">
        <TaxPersonLine scope={scope} />
        <ProGate>
        <AdvanceTaxCalc
          initialGains={realisedFy}
          today={today}
          fyStartMonth={fyStartMonth}
          harvestableLoss={harvestableLoss}
          ledger={ledger}
          // The ledger card rides INTO the calculator's stack as a node, so it
          // can sit under the schedule and above the Assumptions form (v4.4.0
          // default order) while staying a server-rendered card.
          ledgerSlot={
            <Card className="p-0">
              <CardHeader className="flex-row items-start justify-between gap-3">
                <div>
                  <CardTitle>Advance tax paid — challan ledger {fy}</CardTitle>
                  <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
                    One row per payment, dated. With challans here the planner stops applying a single
                    &ldquo;paid so far&rdquo; figure to every rung and measures each instalment against what stood paid on
                    its own due date ({section(fy, "advanceTaxInstalments")}) — which is also how{" "}
                    {section(fy, "interestDeferment")} computes the interest.
                  </p>
                </div>
                {ledger.count > 0 && (
                  <Badge variant="secondary">{ledger.count} payment{ledger.count === 1 ? "" : "s"}</Badge>
                )}
              </CardHeader>
              <CardContent>
                <ChallanEditor
                  rows={challanRows}
                  fy={fy}
                  aggregate={aggregate}
                  minDate={fyWindowStart}
                  maxDate={fyWindowEnd < today ? fyWindowEnd : today}
                />
              </CardContent>
              {/* The second-pass rulings, stated where the realised figures
                  that feed the estimate are read. */}
              <div className="space-y-2 border-t p-4 text-[0.6875rem] text-muted-foreground">
                <p>{MTF_NOT_DEDUCTED_NOTE}</p>
                {realisedUndetermined !== 0 && (
                  <p className="text-warning">
                    {inr(realisedUndetermined, { decimals: 0 })} of gain realised this FY has NO capital-gains head
                    this journal can determine and is excluded from the realised figures the estimate uses. Fix the
                    symbol or ISIN — see Data Quality.
                  </p>
                )}
              </div>
            </Card>
          }
        />
      </ProGate>
      </div>
    </>
  );
}
