"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KpiCard } from "@/components/kpi-card";
import { computeAdvanceTax } from "@/lib/analytics/advance-tax";
import { inr, fmtDate } from "@/lib/format";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";

export function AdvanceTaxCalc({
  initialGains,
  today,
  fyStartMonth,
}: {
  initialGains: number;
  today: string;
  fyStartMonth: number;
}) {
  const [gains, setGains] = useState(Math.max(0, Math.round(initialGains)));
  const [ratePct, setRatePct] = useState(20);
  const [paid, setPaid] = useState(0);

  const estTax = Math.round((gains * ratePct) / 100);
  const plan = computeAdvanceTax({ estimatedAnnualTax: estTax, taxPaidToDate: paid, today, fyStartMonth });

  const numIn = (v: number, set: (n: number) => void) => (
    <Input
      type="number"
      value={Number.isFinite(v) ? v : 0}
      onChange={(e) => set(Math.max(0, Number(e.target.value) || 0))}
      className="h-8 w-40 tabular-nums"
    />
  );

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader><CardTitle>Assumptions</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-5">
            <div className="space-y-1">
              <Label className="text-xs">Estimated taxable gains (FY)</Label>
              {numIn(gains, setGains)}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Effective tax rate %</Label>
              {numIn(ratePct, setRatePct)}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Advance tax paid so far</Label>
              {numIn(paid, setPaid)}
            </div>
          </div>
          <p className="mt-2 text-[0.6875rem] text-muted-foreground">
            Gains prefilled from realised FY P&amp;L in this journal. Rate is your blended effective rate (STCG 15/20%,
            LTCG 12.5%, F&amp;O at slab) — adjust to your bracket.
          </p>
        </CardContent>
      </Card>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label={`Est. tax ${plan.fyLabel}`} valueNum={plan.estimatedAnnualTax} format="inr0" sub={`${ratePct}% of gains`} />
        <KpiCard label="Paid so far" value={`${plan.paidPct}%`} valueClassName={plan.paidPct >= 90 ? "text-profit" : plan.paidPct > 0 ? "text-warning" : "text-loss"} sub={inr(plan.taxPaidToDate, { decimals: 0 })} />
        <KpiCard label="Next instalment" value={plan.nextDue ? plan.nextDue.label : "—"} sub={plan.nextDue ? `pay ${inr(Math.max(0, plan.nextDue.cumRequired - plan.taxPaidToDate), { decimals: 0 })}` : "year complete"} />
        <KpiCard label="234C interest" valueNum={plan.interest234C} format="inr0" valueClassName={plan.interest234C > 0 ? "text-loss" : "text-profit"} sub="on shortfalls so far" />
      </section>

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
              <ReportTh align="right">234C</ReportTh>
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
          You&apos;ve paid {plan.paidPct}% (&lt; 90%). If the year closes underpaid, §234B adds 1%/month on the unpaid
          balance from 1 Apr of the assessment year until you pay — on top of the 234C above.
        </div>
      )}

      <p className="text-[0.6875rem] text-muted-foreground">
        Planning estimate, not filing advice. Due dates 15 Jun / 15 Sep / 15 Dec / 15 Mar at 15 / 45 / 75 / 100%; 234C is
        1%/month (3 months on the first three instalments, 1 on the last) on each shortfall.
      </p>
    </div>
  );
}
