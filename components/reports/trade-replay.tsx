"use client";
import dynamic from "next/dynamic";
import { useState } from "react";
import { Select } from "@/components/ui/select";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";

// lightweight-charts is browser-only: it reaches for `document` the moment a
// chart is created. `ssr: false` is legal here only because this file is a
// client component. Without it the /reports/scaling route would still BUILD
// clean — the page is force-dynamic, so nothing prerenders it — and then 500 on
// every request instead.
const PriceReplayChart = dynamic(() => import("@/components/charts/lw/price-replay-chart"), {
  ssr: false,
  loading: () => <div className="h-80 w-full animate-pulse rounded-md bg-rule" aria-label="Loading chart" />,
});

export interface ReplayTrade { id: number; symbol: string; entry: number; exit: number | null; stop: number | null; target: number | null; bars: { date: string; close: number }[]; legs: { id: number; kind: string; tradeDate: string; price: number; qty: number }[]; }
export function TradeReplay({ trades }: { trades: ReplayTrade[] }) {
  const [id, setId] = useState(trades[0]?.id ?? 0); const trade = trades.find((t) => t.id === id) ?? trades[0];
  if (!trade) return <p className="text-sm text-muted-foreground">No staged position has EOD price-history coverage yet.</p>;
  return <div className="space-y-4"><Select value={String(trade.id)} onChange={(e) => setId(Number(e.target.value))}>{trades.map((t) => <option key={t.id} value={t.id}>#{t.id} · {t.symbol}</option>)}</Select>
    <PriceReplayChart key={trade.id} bars={trade.bars} legs={trade.legs} stop={trade.stop} target={trade.target}/>
    <ReportTable>
      <ReportThead><ReportTh>Seq</ReportTh><ReportTh>Date</ReportTh><ReportTh>Action</ReportTh><ReportTh align="right">Qty</ReportTh><ReportTh align="right">Price</ReportTh></ReportThead>
      <tbody>{trade.legs.map((l, i) => (
        <ReportTr key={l.id}>
          <ReportTd>{i + 1}</ReportTd>
          <ReportTd>{l.tradeDate}</ReportTd>
          <ReportTd className={l.kind === "entry" ? "text-profit" : "text-loss"}>{l.kind}</ReportTd>
          <ReportTd align="right">{l.qty}</ReportTd>
          <ReportTd align="right">{l.price}</ReportTd>
        </ReportTr>
      ))}</tbody>
    </ReportTable>
    {/* No caveat line here: the scaling page renders metricCaveatLine("replayEod")
        directly above this component — lib/domain/metric-help.ts is the single
        source of truth for the EOD-closes caveat (tests/trade-replay-caveat-guard
        reddens if a hand-written copy returns). */}</div>;
}
