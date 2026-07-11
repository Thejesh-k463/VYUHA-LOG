"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Meter } from "./meter";
import { OptionLotCalc } from "./calculators";
import { dailyLossStatus } from "@/lib/risk/calculators";
import { inr } from "@/lib/format";
import { SEGMENT_LABELS, type Segment } from "@/lib/domain/constants";
import { OctagonAlert, ShieldCheck } from "lucide-react";

export interface DailySummary {
  date: string;
  net: number;
  optionTrades: number;
  intradayTrades: number;
  commodityTrades: number;
}
export interface SegLimit {
  segment: Segment;
  perTradeMaxLoss: number;
  maxTradesDay: number | null;
  todayCount: number;
}

export function TargetActiveClient({
  daily,
  limits,
  openOptions,
  segLimits,
  defaultRisk,
  undatedActive,
}: {
  daily: DailySummary[];
  limits: { dailyLossStop: number; optionsMaxTrades: number; intradayMaxTrades: number; commodityMaxTrades: number; optionsMaxOpen: number };
  openOptions: number;
  segLimits: SegLimit[];
  defaultRisk: number;
  undatedActive: number;
}) {
  // default to the worst-loss day (most relevant for a risk cockpit)
  const worst = daily.reduce<DailySummary | null>((w, d) => (w == null || d.net < w.net ? d : w), null);
  const [date, setDate] = React.useState(worst?.date ?? "");
  const day = daily.find((d) => d.date === date) ?? worst ?? null;

  const status = dailyLossStatus({ netToday: day?.net ?? 0, dailyStop: limits.dailyLossStop });

  return (
    <div className="space-y-5">
      {/* Hard-stop cockpit banner */}
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          Reviewing day:{" "}
          <Select value={date} onChange={(e) => setDate(e.target.value)} className="ml-1 inline-flex h-7 w-40">
            {daily.length === 0 && <option value="">no dated days</option>}
            {daily.map((d) => <option key={d.date} value={d.date}>{d.date}</option>)}
          </Select>
        </div>
      </div>

      {status.hit ? (
        <Card className="border-loss bg-loss/10">
          <CardContent className="flex items-center gap-3 p-5">
            <OctagonAlert className="size-8 text-loss" />
            <div>
              <div className="text-lg font-bold text-loss">STOP TRADING — daily loss limit hit</div>
              <div className="text-sm text-loss/80">
                Day net {inr(status.netToday)} · crossed the ₹{limits.dailyLossStop.toLocaleString("en-IN")} aggregate stop.
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-profit/30">
          <CardContent className="flex items-center justify-between gap-3 p-5">
            <div className="flex items-center gap-3">
              <ShieldCheck className="size-7 text-profit" />
              <div>
                <div className="text-base font-semibold">Within daily loss limit</div>
                <div className="text-sm text-muted-foreground">Day net <span className={status.netToday >= 0 ? "text-profit" : "text-loss"}>{inr(status.netToday)}</span></div>
              </div>
            </div>
            <div className="text-right text-sm">
              <div className="text-muted-foreground">Loss budget left</div>
              <div className="text-lg font-semibold tabular-nums">{inr(status.remaining, { decimals: 0 })}</div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* loss budget meter */}
      <Card className="p-3">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Daily loss used</span>
          <span className="tabular-nums">{inr(status.lossSoFar, { decimals: 0 })} / {inr(limits.dailyLossStop, { decimals: 0 })}</span>
        </div>
        <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-card-hover">
          <div className="h-full rounded-full" style={{ width: `${status.pctUsed * 100}%`, background: status.hit ? "var(--color-loss)" : status.pctUsed > 0.8 ? "var(--color-warning)" : "var(--color-primary)" }} />
        </div>
      </Card>

      {/* counters */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Meter label="Options trades / day" used={day?.optionTrades ?? 0} limit={limits.optionsMaxTrades} />
        <Meter label="Intraday eq trades / day" used={day?.intradayTrades ?? 0} limit={limits.intradayMaxTrades} />
        <Meter label="Commodity trades / day" used={day?.commodityTrades ?? 0} limit={limits.commodityMaxTrades} />
        <Meter label="Open options positions" used={openOptions} limit={limits.optionsMaxOpen} />
      </section>

      {/* per-segment sub-limits */}
      <Card>
        <CardHeader><CardTitle>Per-segment sub-limits</CardTitle></CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {segLimits.map((s) => (
              <div key={s.segment} className="rounded-md border border-border bg-card-hover/30 p-3">
                <div className="text-xs font-medium">{SEGMENT_LABELS[s.segment]}</div>
                <div className="mt-1.5 space-y-1 text-[11px] text-muted-foreground">
                  <div className="flex justify-between"><span>Per-trade cap</span><span className="tabular-nums text-foreground">{inr(s.perTradeMaxLoss, { decimals: 0 })}</span></div>
                  <div className="flex justify-between"><span>Max trades/day</span><span className="tabular-nums text-foreground">{s.maxTradesDay ?? "—"}</span></div>
                  <div className="flex justify-between"><span>Today</span><span className="tabular-nums text-foreground">{s.todayCount}</span></div>
                </div>
              </div>
            ))}
          </div>
          {undatedActive > 0 && (
            <p className="mt-3 text-[11px] text-muted-foreground">
              Note: {undatedActive} Trade F&O-bucket trades (e.g. Dhan options) have no date in the P&L file and aren&apos;t attributed to a day. Add a tradebook import or manual dates for full daily counters.
            </p>
          )}
        </CardContent>
      </Card>

      <OptionLotCalc defaultRisk={defaultRisk} />
    </div>
  );
}
