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
  /**
   * D7 (wave 2N): open MTF rows whose funded amount the journal never recorded.
   * Every ₹ figure above is built from the STATED amounts only — the estimate
   * that used to stand in for a null was money nothing recorded — so the count
   * of what was left out rides beside them rather than the omission being
   * silent (invariant 6: never fabricate a denominator, and say what is
   * missing). `accrued` is stored money and still counts every row.
   */
  unstated: number;
}

export function TargetEquityClient({
  defaultRisk,
  equityCapital,
  openCount,
  maxOpen,
  topConcentration,
  concentrationLimit,
  monthly,
  monthlyBase,
  monthlyStretch,
  mtf,
}: {
  /** v4.4.0 (D1): every limit below is NULL when the user never set it — the
   *  page no longer substitutes ₹9,500 / 6 / 20% / ₹4.25L / ₹5.1L, and each
   *  surface says "not set" instead (invariant 6). */
  defaultRisk: number | null;
  /** 0 means NOT CONFIGURED — capital-relative figures render "—", never a
   *  stand-in number (the ₹13L fallback fabricated every gauge on a fresh
   *  install; invariant 6). */
  equityCapital: number;
  openCount: number;
  maxOpen: number | null;
  /** pct is null when capital is unknown — the ₹-largest position still names
   *  itself, but no concentration % is invented for it. */
  topConcentration: { symbol: string; pct: number | null } | null;
  concentrationLimit: number | null;
  monthly: { month: string; net: number }[];
  monthlyBase: number | null;
  monthlyStretch: number | null;
  mtf: MtfSummary;
}) {
  const concBreach = concentrationLimit != null && topConcentration?.pct != null && topConcentration.pct > concentrationLimit;
  const limitText = concentrationLimit != null ? `limit ${concentrationLimit}%` : "no concentration limit set";
  const ladder = monthlyBase != null && monthlyStretch != null && monthlyStretch > 0 ? { base: monthlyBase, stretch: monthlyStretch } : null;

  return (
    <div className="space-y-5">
      <section className="grid gap-3 sm:grid-cols-3">
        <Meter label="Max open positions" used={openCount} limit={maxOpen} />
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">Top concentration</div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-lg font-semibold tabular-nums">{topConcentration?.pct != null ? `${topConcentration.pct.toFixed(1)}%` : "—"}</span>
            {concBreach && <Badge variant="loss">over {concentrationLimit}%</Badge>}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {topConcentration == null
              ? <>no open positions · {limitText}</>
              : topConcentration.pct == null
                ? <>{topConcentration.symbol} · % of capital needs capital — set it in Settings</>
                : <>{topConcentration.symbol} · {limitText}</>}
          </div>
        </Card>
        {defaultRisk != null
          ? <KpiCard label="Per-trade max loss" valueNum={defaultRisk} format="inr0" sub={`${equityCapital > 0 ? ((defaultRisk / equityCapital) * 100).toFixed(2) : "—"}% of bucket`} />
          : <KpiCard label="Per-trade max loss" value="—" sub="not set — Settings → Risk rules" />}
      </section>

      <Card>
        <CardHeader><CardTitle>Monthly target ladder (combined buckets)</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {monthly.length === 0 && <p className="text-sm text-muted-foreground">No closed trades yet.</p>}
          {monthly.length > 0 && !ladder && <p className="text-sm text-muted-foreground">Set a monthly target (base and stretch) in Settings → Risk rules to see each month against it.</p>}
          {ladder && monthly.map((m) => {
            const pct = Math.max(0, Math.min(100, (m.net / ladder.stretch) * 100));
            const basePct = (ladder.base / ladder.stretch) * 100;
            const label = new Date(m.month + "-01T00:00:00").toLocaleDateString("en-IN", { month: "short", year: "numeric" });
            return (
              <div key={m.month}>
                <div className="mb-1 flex justify-between text-xs">
                  <span className="text-muted-foreground">{label}</span>
                  <span className={`font-medium tabular-nums ${m.net >= 0 ? "text-profit" : "text-loss"}`}>{inr(m.net, { decimals: 0 })}</span>
                </div>
                <div className="relative h-2.5 rounded-full bg-card-hover">
                  <div className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${pct}%` }} />
                  <div className="absolute inset-y-[-3px] w-0.5 bg-warning" style={{ left: `${Math.min(100, basePct)}%` }} title={`base ${inrCompact(ladder.base)}`} />
                  <div className="absolute inset-y-[-3px] right-0 w-0.5 bg-foreground/50" title={`stretch ${inrCompact(ladder.stretch)}`} />
                </div>
                <div className="mt-0.5 flex justify-between text-[9px] text-muted-foreground">
                  <span>base {inrCompact(ladder.base)}</span><span>stretch {inrCompact(ladder.stretch)}</span>
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
              <KpiCard label="MTF positions" valueNum={mtf.count} format="int" />
              <KpiCard label="Funded" valueNum={mtf.funded} format="inrCompact" />
              <KpiCard label="Blended rate" value={`${(mtf.blendedRate * 100).toFixed(2)}%`} sub="p.a." />
              <KpiCard label="Daily interest" valueNum={mtf.dailyInterest} format="inr0" valueClassName="text-grad-gold" sub={`Accrued ${inrCompact(mtf.accrued)}`} />
              <KpiCard label="Break-even move" value={`${mtf.breakevenMovePct.toFixed(2)}%`} sub="to cover interest" />
            </div>
          )}
          {mtf.unstated > 0 && (
            <p className="mt-3 text-[11px] text-muted-foreground">
              {mtf.unstated} MTF {mtf.unstated === 1 ? "row is" : "rows are"} not in these figures: funding not recorded.
              Record the amount on the position in Trades and it joins them.
            </p>
          )}
        </CardContent>
      </Card>

      <PositionSizeCalc defaultRisk={defaultRisk} equityCapital={equityCapital} />
    </div>
  );
}
