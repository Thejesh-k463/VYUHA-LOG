"use client";
import dynamic from "next/dynamic";
import { useState } from "react";
import { Select } from "@/components/ui/select";

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
    <div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr className="border-y border-border text-left text-muted-foreground"><th className="p-2">Seq</th><th className="p-2">Date</th><th className="p-2">Action</th><th className="p-2 text-right">Qty</th><th className="p-2 text-right">Price</th></tr></thead><tbody>{trade.legs.map((l,i) => <tr key={l.id} className="border-b border-rule"><td className="p-2">{i+1}</td><td className="p-2">{l.tradeDate}</td><td className={l.kind === "entry" ? "p-2 text-profit" : "p-2 text-loss"}>{l.kind}</td><td className="p-2 text-right">{l.qty}</td><td className="p-2 text-right">{l.price}</td></tr>)}</tbody></table></div>
    <p className="text-[11px] text-muted-foreground">EOD closes cannot show the intraday path between fills. Markers use recorded fill prices; the line uses imported bhavcopy closes.</p></div>;
}
