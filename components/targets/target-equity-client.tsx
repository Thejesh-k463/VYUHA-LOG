"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { KpiCard } from "@/components/kpi-card";
import { Meter } from "./meter";
import { PositionSizeCalc } from "./calculators";
import { inr, inrCompact } from "@/lib/format";

export interface MtfSummary {
  count: number;
  funded: number;
  dailyInterest: number;
  accrued: number;
  blendedRate: number;
  breakevenMovePct: number;
}

export function TargetEquityClient({
  defaultRisk,
  openCount,
  maxOpen,
  topConcentration,
  concentrationLimit,
  monthly,
  monthlyBase,
  monthlyStretch,
  mtf,
}: {
  defaultRisk: number;
  openCount: number;
  maxOpen: number;
  topConcentration: { symbol: string; pct: number } | null;
  concentrationLimit: number;
  monthly: { month: string; net: number }[];
  monthlyBase: number;
  monthlyStretch: number;
  mtf: MtfSummary;
}) {
  const concBreach = topConcentration && topConcentration.pct > concentrationLimit;

  return (
    <div className="space-y-5">
      <PositionSizeCalc defaultRisk={defaultRisk} />

      <section className="grid gap-3 sm:grid-cols-3">
        <Meter label="Max open positions" used={openCount} limit={maxOpen} />
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">Top concentration</div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-lg font-semibold tabular-nums">{topConcentration ? `${topConcentration.pct.toFixed(1)}%` : "—"}</span>
            {concBreach && <Badge variant="loss">over {concentrationLimit}%</Badge>}
          </div>
          <div className="text-[10px] text-muted-foreground">{topConcentration?.symbol ?? "no open positions"} · limit {concentrationLimit}%</div>
        </Card>
        <KpiCard label="Per-trade max loss" value={inr(defaultRisk, { decimals: 0 })} sub={`${((defaultRisk / 1300000) * 100).toFixed(2)}% of bucket`} />
      </section>

      <Card>
        <CardHeader><CardTitle>Monthly target ladder (combined buckets)</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {monthly.length === 0 && <p className="text-sm text-muted-foreground">No closed trades yet.</p>}
          {monthly.map((m) => {
            const pct = Math.max(0, Math.min(100, (m.net / monthlyStretch) * 100));
            const basePct = (monthlyBase / monthlyStretch) * 100;
            const label = new Date(m.month + "-01T00:00:00").toLocaleDateString("en-IN", { month: "short", year: "numeric" });
            return (
              <div key={m.month}>
                <div className="mb-1 flex justify-between text-xs">
                  <span className="text-muted-foreground">{label}</span>
                  <span className={`font-medium tabular-nums ${m.net >= 0 ? "text-profit" : "text-loss"}`}>{inr(m.net, { decimals: 0 })}</span>
                </div>
                <div className="relative h-2.5 rounded-full bg-card-hover">
                  <div className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${pct}%` }} />
                  <div className="absolute inset-y-[-3px] w-0.5 bg-warning" style={{ left: `${Math.min(100, basePct)}%` }} title={`base ${inrCompact(monthlyBase)}`} />
                  <div className="absolute inset-y-[-3px] right-0 w-0.5 bg-foreground/50" title={`stretch ${inrCompact(monthlyStretch)}`} />
                </div>
                <div className="mt-0.5 flex justify-between text-[9px] text-muted-foreground">
                  <span>base {inrCompact(monthlyBase)}</span><span>stretch {inrCompact(monthlyStretch)}</span>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>MTF interest & break-even</CardTitle></CardHeader>
        <CardContent>
          {mtf.count === 0 ? (
            <p className="text-sm text-muted-foreground">No open MTF positions. Tag a delivery position as MTF in Trades to track funding cost.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <KpiCard label="MTF positions" value={mtf.count} />
              <KpiCard label="Funded" value={inrCompact(mtf.funded)} />
              <KpiCard label="Blended rate" value={`${(mtf.blendedRate * 100).toFixed(2)}%`} sub="p.a." />
              <KpiCard label="Daily interest" value={inr(mtf.dailyInterest, { decimals: 0 })} valueClassName="text-warning" sub={`Accrued ${inrCompact(mtf.accrued)}`} />
              <KpiCard label="Break-even move" value={`${mtf.breakevenMovePct.toFixed(2)}%`} sub="to cover interest" />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
