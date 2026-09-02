"use client";

import * as React from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KpiCard } from "@/components/kpi-card";
import { computeAdvanceTax } from "@/lib/analytics/advance-tax";
import { section } from "@/lib/analytics/statute";
import { inr, fmtDate } from "@/lib/format";
import { useStoredValue, writeStored } from "@/components/layout/use-stored-value";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";

// ── Persistence ────────────────────────────────────────────────────────────
// Inputs survive a revisit via localStorage under the versioned envelope the
// project standard requires. Storage stays the single source of truth: every
// field below is DERIVED from the stored envelope (or its default), and edits
// write the whole envelope back — no useState mirror, so hydration renders the
// server-prefilled defaults and the stored values land right after.
const STORE_KEY = "vyuha-advance-tax-calc";

interface StoredCalc {
  v: 1;
  /** Absent = track this FY's server-computed figure (the safe default). */
  gains?: number;
  ratePct?: number;
  paid?: number;
  reliefTax?: number;
  reliefPaidInFull?: boolean;
  presumptive?: boolean;
}

function parseStored(raw: string | null): StoredCalc | null {
  if (!raw) return null;
  try {
    const p: unknown = JSON.parse(raw);
    if (!p || typeof p !== "object" || (p as { v?: unknown }).v !== 1) return null;
    return p as StoredCalc;
  } catch {
    return null;
  }
}

/** A stored number is only trusted when it is a finite non-negative number. */
const num = (x: unknown, fallback: number): number =>
  typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : fallback;

/**
 * The FY's dated challan ledger, as `challanTotalsByFy` returns it. Supplied by
 * the server; `count === 0` means the ledger says NOTHING (not "₹0 was paid"),
 * which is why the branch below tests the count and never the total.
 */
export interface AdvanceTaxLedger {
  total: number;
  count: number;
  payments: { date: string; amount: number }[];
}

export function AdvanceTaxCalc({
  initialGains,
  today,
  fyStartMonth,
  harvestableLoss = 0,
  ledger,
}: {
  initialGains: number;
  today: string;
  fyStartMonth: number;
  /** Current harvestable ST+LT unrealised loss (₹), from computeHarvest on the server. */
  harvestableLoss?: number;
  /**
   * The dated challan ledger for this FY (v3.7, WS4). When it holds payments it
   * REPLACES the hand-typed "paid so far" scalar — the stored value is ignored
   * for this FY and the screen says so. Absent or empty, every path below is
   * the v3.5 one, unchanged.
   */
  ledger?: AdvanceTaxLedger;
}) {
  const stored = parseStored(useStoredValue(STORE_KEY));

  const fyGains = Math.max(0, Math.round(initialGains));
  const gains = Math.round(num(stored?.gains, fyGains));
  const ratePct = num(stored?.ratePct, 20);
  const paid = num(stored?.paid, 0);
  const reliefTax = num(stored?.reliefTax, 0);
  const reliefPaidInFull = stored?.reliefPaidInFull === true;
  const presumptive = stored?.presumptive === true;

  // A stored gains figure is a snapshot of a past visit — it must never
  // silently masquerade as this FY's number, so it wears a reset affordance.
  const usingSavedGains = stored?.gains != null && gains !== fyGains;

  const save = (patch: Partial<Omit<StoredCalc, "v">>) => {
    // An explicit `undefined` in the patch clears that key (JSON drops it),
    // which is how "gains" returns to tracking the server figure.
    writeStored(
      STORE_KEY,
      JSON.stringify({ v: 1, gains: stored?.gains, ratePct, paid, reliefTax, reliefPaidInFull, presumptive, ...patch }),
    );
  };

  // ── Ledger vs scalar ─────────────────────────────────────────────────────
  // A dated ledger answers a question the scalar cannot: what stood paid on
  // 15 September? So when challans exist for this FY they replace the typed
  // figure entirely — and the saved scalar is IGNORED, which the screen states
  // rather than swallowing (a silently ignored saved input is a defect here).
  // With no challans, `paidInput` is exactly the v3.5 object: `payments` is
  // absent, so the engine takes its unchanged scalar path.
  const ledgerActive = ledger != null && ledger.count > 0;
  const savedPaid = stored?.paid;
  const savedPaidIgnored = ledgerActive && typeof savedPaid === "number" && savedPaid > 0;
  const paidInput: { taxPaidToDate: number; payments?: { date: string; amount: number }[] } = ledgerActive
    ? { taxPaidToDate: ledger.total, payments: ledger.payments }
    : { taxPaidToDate: paid };

  const estTax = Math.round((gains * ratePct) / 100);
  const plan = computeAdvanceTax({
    estimatedAnnualTax: estTax,
    ...paidInput,
    today,
    fyStartMonth,
    reliefEligibleTax: reliefTax,
    reliefTaxPaidInFull: reliefPaidInFull,
    presumptive,
  });

  // ── Harvest what-if (estimate at the user's blended rate) ────────────────
  // One line only; the per-head set-off arithmetic and lot detail live on
  // /reports/harvest. Applying the whole loss at the blended rate is the same
  // simplification the calculator itself makes, and it is labelled as such.
  let harvest: { taxCut: number; nextCut: number | null } | null = null;
  if (harvestableLoss > 0 && estTax > 0) {
    const estTaxAfter = Math.round((Math.max(0, gains - harvestableLoss) * ratePct) / 100);
    const planAfter = computeAdvanceTax({
      estimatedAnnualTax: estTaxAfter,
      ...paidInput,
      today,
      fyStartMonth,
      reliefEligibleTax: reliefTax,
      reliefTaxPaidInFull: reliefPaidInFull,
      presumptive,
    });
    // `paid` in the scalar path (byte-for-byte v3.5), the engine's own FY total
    // when the ledger is driving — never a mix of the two.
    const paidNow = ledgerActive ? plan.taxPaidToDate : paid;
    const nextPayNow = plan.nextDue ? Math.max(0, plan.nextDue.cumRequired - paidNow) : null;
    const nextPayAfter = planAfter.nextDue ? Math.max(0, planAfter.nextDue.cumRequired - paidNow) : null;
    harvest = {
      taxCut: Math.max(0, estTax - estTaxAfter),
      nextCut: nextPayNow != null && nextPayAfter != null ? Math.max(0, nextPayNow - nextPayAfter) : null,
    };
  }

  const numIn = (v: number, set: (n: number) => void) => (
    <Input
      type="number"
      value={Number.isFinite(v) ? v : 0}
      onChange={(e) => set(Math.max(0, Number(e.target.value) || 0))}
      className="h-8 w-40 tabular-nums"
    />
  );

  const deferment = section(plan.fyLabel, "interestDeferment");

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader><CardTitle>Assumptions</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-5">
            <div className="space-y-1">
              <Label className="text-xs">Estimated taxable gains (FY)</Label>
              {numIn(gains, (n) => save({ gains: n }))}
              {usingSavedGains && (
                <p className="text-[0.6875rem] text-warning">
                  Using your saved figure —{" "}
                  <button
                    type="button"
                    className="underline underline-offset-2 hover:text-foreground"
                    onClick={() => save({ gains: undefined })}
                  >
                    reset to this FY&apos;s {inr(fyGains, { decimals: 0 })}
                  </button>
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Effective tax rate %</Label>
              {numIn(ratePct, (n) => save({ ratePct: n }))}
            </div>
            {/* id, not a testid: the field swaps between an input and a
                read-only ledger figure, and the e2e spec has to be able to ask
                which one is on screen. */}
            <div className="space-y-1" id="advance-tax-paid-field">
              <Label className="text-xs">Advance tax paid so far</Label>
              {ledgerActive ? (
                <>
                  <p className="flex h-8 items-center text-sm font-semibold tabular-nums">
                    {inr(ledger.total, { decimals: 0 })}
                  </p>
                  <p className="max-w-64 text-[0.6875rem] text-muted-foreground">
                    From your challan ledger: {inr(ledger.total, { decimals: 0 })} across {ledger.count} payment
                    {ledger.count === 1 ? "" : "s"}. Each instalment below is measured against what stood paid on its
                    OWN due date — edit the payments in the ledger beneath this calculator.
                  </p>
                  {savedPaidIgnored && (
                    <p className="max-w-64 text-[0.6875rem] text-warning">
                      Your saved figure of {inr(savedPaid, { decimals: 0 })} is IGNORED for {plan.fyLabel} — the dated
                      ledger replaces it, because a date is what the instalment maths needs. It is still saved: remove
                      every challan for this FY and this box goes back to that number.
                    </p>
                  )}
                </>
              ) : (
                numIn(paid, (n) => save({ paid: n }))
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{deferment}(4) relief-eligible tax</Label>
              {numIn(reliefTax, (n) => save({ reliefTax: n }))}
              <p className="max-w-56 text-[0.6875rem] text-muted-foreground">
                Tax on capital gains, dividend, casual income, or business income arising for the FIRST time, that the
                shortfall traces to.
              </p>
            </div>
          </div>
          <div className="mt-3 space-y-1.5">
            <label className="flex cursor-pointer items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={reliefPaidInFull}
                onChange={(e) => save({ reliefPaidInFull: e.target.checked })}
                className="mt-0.5 size-3.5"
              />
              <span>
                The tax on that income was (or will be) paid in full in a remaining instalment or by 31 March — the{" "}
                {deferment}(4) relief is conjunctive and does not arise without this.
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={presumptive}
                onChange={(e) => save({ presumptive: e.target.checked })}
                className="mt-0.5 size-3.5"
              />
              <span>
                Presumptive taxation ({section(plan.fyLabel, "presumptive")}) elected — the whole advance tax then falls
                due in one instalment, 100% by 15 March.
              </span>
            </label>
          </div>
          <p className="mt-2 text-[0.6875rem] text-muted-foreground">
            Gains prefilled from realised FY P&amp;L in this journal. Rate is your blended effective rate (STCG 15/20%,
            LTCG 12.5%, F&amp;O at slab) — adjust to your bracket. Inputs are saved on this device.
            {ledgerActive && (
              <>
                {" "}
                The paid figure is the exception: it comes from the challan ledger below, which is stored in the journal
                and scoped to the selected account.
              </>
            )}
          </p>
        </CardContent>
      </Card>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label={`Est. tax ${plan.fyLabel}`} valueNum={plan.estimatedAnnualTax} format="inr0" sub={`${ratePct}% of gains`} />
        <KpiCard label="Paid so far" value={`${plan.paidPct}%`} valueClassName={plan.paidPct >= 90 ? "text-profit" : plan.paidPct > 0 ? "text-warning" : "text-loss"} sub={inr(plan.taxPaidToDate, { decimals: 0 })} />
        <KpiCard label="Next instalment" value={plan.nextDue ? plan.nextDue.label : "—"} sub={plan.nextDue ? `pay ${inr(Math.max(0, plan.nextDue.cumRequired - plan.taxPaidToDate), { decimals: 0 })}` : "year complete"} />
        <KpiCard label="Deferment interest" valueNum={plan.interest234C} format="inr0" valueClassName={plan.interest234C > 0 ? "text-loss" : "text-profit"} sub={`${deferment} · on shortfalls so far`} />
      </section>

      {harvest && (
        <div className="rounded-lg border-l-2 border-l-accent bg-accent/5 px-3 py-2 text-xs text-foreground">
          Harvesting all currently-available losses ({inr(harvestableLoss, { decimals: 0 })}) would reduce the estimated
          tax by {inr(harvest.taxCut, { decimals: 0 })}
          {harvest.nextCut != null && <> and the next instalment by {inr(harvest.nextCut, { decimals: 0 })}</>}.{" "}
          <span className="text-muted-foreground">
            Estimate at your blended {ratePct}% rate — the per-head set-off and lot detail live on{" "}
            <Link href="/reports/harvest" className="underline underline-offset-2">Tax-loss harvesting</Link>.
          </span>
        </div>
      )}

      <Card className="p-0">
        <CardHeader><CardTitle>Instalment schedule — {plan.fyLabel}</CardTitle></CardHeader>
        <CardContent className="p-0">
          <ReportTable>
            <ReportThead>
              <ReportTh>Due by</ReportTh>
              <ReportTh align="right">Cumulative</ReportTh>
              <ReportTh align="right">Cum. required</ReportTh>
              <ReportTh align="right">This instalment</ReportTh>
              <ReportTh align="right">Shortfall</ReportTh>
              {/* The citation follows the Act that governed THIS year — a
                  hard-coded "234C" mislabels every year from 2026-27 on. */}
              <ReportTh align="right">{deferment}</ReportTh>
              <ReportTh>Status</ReportTh>
            </ReportThead>
            <tbody>
              {plan.instalments.map((i) => {
                const isNext = plan.nextDue?.quarter === i.quarter;
                return (
                  <ReportTr key={i.quarter} className={isNext ? "bg-accent/5" : undefined}>
                    <ReportTd className="font-medium">
                      {i.label}
                      <span className="ml-1 text-[10px] text-muted-foreground">{fmtDate(i.dueDate)}</span>
                    </ReportTd>
                    <ReportTd align="right">{i.cumPct}%</ReportTd>
                    <ReportTd align="right">{inr(i.cumRequired, { decimals: 0 })}</ReportTd>
                    <ReportTd align="right">{inr(i.instalmentAmount, { decimals: 0 })}</ReportTd>
                    <ReportTd align="right" className={i.shortfall > 0 ? "text-loss" : undefined}>
                      {i.shortfall > 0 ? inr(i.shortfall, { decimals: 0 }) : "—"}
                    </ReportTd>
                    <ReportTd align="right" className={i.interest234C > 0 ? "text-loss" : undefined}>
                      {i.interest234C > 0 ? inr(i.interest234C, { decimals: 0 }) : "—"}
                    </ReportTd>
                    <ReportTd>
                      {!i.isDue ? (
                        <Badge variant={isNext ? "accent" : "secondary"}>{isNext ? "next" : "upcoming"}</Badge>
                      ) : i.shortfall > 0 && i.safeHarbourMet ? (
                        // Short on the instalment, but s.425(2) waives the interest.
                        // Without this the row reads as a bug: a shortfall with no interest.
                        <Badge variant="secondary" title={`s.425(2): at least ${i.safeHarbourPct}% paid by ${i.label}`}>
                          short · no interest
                        </Badge>
                      ) : i.shortfall > 0 ? (
                        <Badge variant="loss">short</Badge>
                      ) : (
                        <Badge variant="profit">met</Badge>
                      )}
                    </ReportTd>
                  </ReportTr>
                );
              })}
            </tbody>
          </ReportTable>
        </CardContent>
      </Card>

      {plan.underpaid234B && (
        <div className="rounded-lg border-l-2 border-l-warning bg-warning/5 px-3 py-2 text-xs text-foreground">
          You&apos;ve paid {plan.paidPct}% (&lt; 90%). If the year closes underpaid,{" "}
          {section(plan.fyLabel, "interestAdvanceTax")} adds 1%/month on the unpaid balance from 1 April of the
          following year until you pay — on top of the deferment interest above.
        </div>
      )}

      {plan.notes.length > 0 && (
        <ul className="space-y-1.5 text-xs text-muted-foreground">
          {plan.notes.map((n) => (
            <li key={n} className="border-l-2 border-l-border pl-3">
              {n}
            </li>
          ))}
        </ul>
      )}

      <p className="text-[0.6875rem] text-muted-foreground">
        Planning estimate, not filing advice.{" "}
        {presumptive ? (
          <>
            Under the presumptive election the single due date is 15 Mar at 100%; deferment interest is 1% of the
            shortfall for one month ({deferment}).
          </>
        ) : (
          <>
            Due dates 15 Jun / 15 Sep / 15 Dec / 15 Mar at 15 / 45 / 75 / 100%; deferment interest is 3% / 3% / 3% / 1%
            of each shortfall ({deferment} — the 2025 Act states these as flat rates; the 1961 Act reached the same
            figures as 1%/month).
          </>
        )}
      </p>
    </div>
  );
}
