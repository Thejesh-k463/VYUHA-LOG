"use client";

// What-if harvest simulator (v3.5.0). The maths is 100% lib/analytics/harvest.ts
// (pure, unit-tested) — this component only holds the selection state and
// re-runs computeHarvest on it. Everything it receives is serializable
// (pattern: components/reports/advance-tax-calc.tsx).
//
// Design contract (lib/analytics/tax-levers.ts): the simulation is USER-
// initiated. Nothing is pre-selected, nothing is ranked as "best to sell", and
// no copy tells the user to transact. The user ticks lots; the set-off rules
// re-run on the ticked subset. That is a what-if, not a recommendation.

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { KpiCard } from "@/components/kpi-card";
import {
  computeHarvest,
  ltcgExemptionHeadroom,
  partialLot,
  type OpenLot,
} from "@/lib/analytics/harvest";
import { LTCG_THRESHOLD_CAVEAT } from "@/lib/analytics/tax-levers";
import { inr } from "@/lib/format";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { EmptyState } from "@/components/ui/empty-state";

const statusBadge = { offsets: "profit", partial: "warning", carry: "secondary" } as const;

export function HarvestSim({
  lots,
  realisedStcg,
  realisedLtcg,
  today,
  fyEnd,
}: {
  lots: OpenLot[];
  realisedStcg: number;
  realisedLtcg: number;
  today: string;
  fyEnd: string;
}) {
  // lot id → simulated qty. Absent = not selected. DELIBERATELY starts empty:
  // the default state models nothing, and only the user adds to it.
  const [selQty, setSelQty] = useState<Record<number, number>>({});

  const byId = useMemo(() => new Map(lots.map((l) => [l.id, l])), [lots]);

  // Whole-book figures — identical to what the server used to render.
  const full = useMemo(
    () => computeHarvest(lots, realisedStcg, realisedLtcg, today, fyEnd),
    [lots, realisedStcg, realisedLtcg, today, fyEnd],
  );

  const selectedLots = useMemo(
    () =>
      Object.entries(selQty).flatMap(([id, q]) => {
        const l = byId.get(Number(id));
        return l && q > 0 ? [partialLot(l, q)] : [];
      }),
    [selQty, byId],
  );

  // The same pure function, on only what the user ticked.
  const sim = useMemo(
    () => computeHarvest(selectedLots, realisedStcg, realisedLtcg, today, fyEnd),
    [selectedLots, realisedStcg, realisedLtcg, today, fyEnd],
  );
  const anySelected = selectedLots.length > 0;
  const simOffsets = sim.stclVsStcg + sim.stclVsLtcg + sim.ltclVsLtcg;

  const headroom = ltcgExemptionHeadroom(realisedLtcg, full.rates.ltcgExemption);
  const lossCandidates = full.candidates;

  const toggle = (id: number, checked: boolean) => {
    setSelQty((s) => {
      const next = { ...s };
      if (checked) next[id] = byId.get(id)?.qty ?? 0;
      else delete next[id];
      return next;
    });
  };

  const setQty = (id: number, raw: number) => {
    const lot = byId.get(id);
    if (!lot) return;
    const q = Math.min(Math.max(0, Math.floor(raw) || 0), lot.qty);
    setSelQty((s) => ({ ...s, [id]: q }));
  };

  return (
    <>
      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Realised STCG (FY)" valueNum={full.realisedStcg} format="inr0" valueClassName={full.realisedStcg >= 0 ? "text-profit" : "text-loss"} sub="short-term" />
        <KpiCard label="Realised LTCG (FY)" valueNum={full.realisedLtcg} format="inr0" valueClassName={full.realisedLtcg >= 0 ? "text-profit" : "text-loss"} sub={`${inr(full.rates.ltcgExemption, { decimals: 0 })} exempt`} />
        <KpiCard label="LTCG exemption headroom" valueNum={headroom} format="inr0" valueClassName={headroom > 0 ? "text-profit" : "text-muted-foreground"} sub="upper bound — see the note below" />
        <KpiCard label="Harvestable loss" valueNum={full.stLoss + full.ltLoss} format="inr0" valueClassName="text-loss" sub={`ST ${inr(full.stLoss, { decimals: 0 })} · LT ${inr(full.ltLoss, { decimals: 0 })}`} />
        <KpiCard label="Est. tax saved" valueNum={full.taxSaved} format="inr0" valueClassName={full.taxSaved > 0 ? "text-profit" : "text-muted-foreground"} sub="if every loss were harvested now" />
        <KpiCard label="Carries forward" valueNum={full.carryForward} format="inr0" sub="beyond this year's gains" />
      </section>
      <p className="text-[0.6875rem] text-muted-foreground">{LTCG_THRESHOLD_CAVEAT}</p>

      <Card className="p-0">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Harvest candidates — what-if</CardTitle>
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
            <>
              <p className="px-4 pb-3 text-xs text-muted-foreground">
                Tick a lot (and optionally trim its quantity) to model booking that loss before FY end. Nothing is
                pre-selected and nothing here is a recommendation — the figures below simply re-run the set-off
                rules on whatever you tick.
              </p>
              <ReportTable>
                <ReportThead>
                  <ReportTh>Simulate</ReportTh>
                  <ReportTh>Symbol</ReportTh>
                  <ReportTh>Term</ReportTh>
                  <ReportTh align="right">Qty</ReportTh>
                  <ReportTh align="right">Unrealised loss</ReportTh>
                  <ReportTh align="right">Offsets now</ReportTh>
                  <ReportTh>If harvested</ReportTh>
                </ReportThead>
                <tbody>
                  {lossCandidates.map((c) => {
                    const q = selQty[c.id] ?? 0;
                    const checked = c.id in selQty;
                    return (
                      <ReportTr key={c.id}>
                        <ReportTd>
                          <span className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              className="size-3.5 accent-[var(--color-primary)]"
                              checked={checked}
                              onChange={(e) => toggle(c.id, e.target.checked)}
                              aria-label={`Include ${c.symbol} in the what-if`}
                            />
                            {checked && (
                              <Input
                                type="number"
                                min={0}
                                max={c.qty}
                                value={q}
                                onChange={(e) => setQty(c.id, Number(e.target.value))}
                                className="h-7 w-20 tabular-nums"
                                aria-label={`Quantity of ${c.symbol} to simulate`}
                              />
                            )}
                          </span>
                        </ReportTd>
                        <ReportTd className="font-medium">{c.symbol}</ReportTd>
                        <ReportTd><Badge variant="outline">{c.term}</Badge></ReportTd>
                        <ReportTd align="right">{c.qty}</ReportTd>
                        <ReportTd align="right" className="text-loss">{inr(c.loss, { decimals: 0 })}</ReportTd>
                        <ReportTd align="right">{c.offsetAmount > 0 ? inr(c.offsetAmount, { decimals: 0 }) : "—"}</ReportTd>
                        <ReportTd>
                          <Badge variant={statusBadge[c.status]}>
                            {c.status === "offsets" ? "offsets gains" : c.status === "partial" ? "partial offset" : "carries forward"}
                          </Badge>
                        </ReportTd>
                      </ReportTr>
                    );
                  })}
                </tbody>
              </ReportTable>

              <div className="border-t border-border/50 px-4 py-3">
                {anySelected ? (
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <KpiCard label="Selected loss" valueNum={sim.stLoss + sim.ltLoss} format="inr0" valueClassName="text-loss" sub={`ST ${inr(sim.stLoss, { decimals: 0 })} · LT ${inr(sim.ltLoss, { decimals: 0 })}`} />
                    <KpiCard label="Offsets gains now" valueNum={simOffsets} format="inr0" sub="against this FY's realised gains" />
                    <KpiCard label="Est. tax saved" valueNum={sim.taxSaved} format="inr0" valueClassName={sim.taxSaved > 0 ? "text-profit" : "text-muted-foreground"} sub="on the ticked lots alone" />
                    <KpiCard label="Carries forward" valueNum={sim.carryForward} format="inr0" sub="loss beyond offsettable gains" />
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No lots ticked — the what-if is empty until you add to it.
                  </p>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
