import { eq, inArray } from "drizzle-orm";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { KpiCard } from "@/components/kpi-card";
import { TradeReplay } from "@/components/reports/trade-replay";
import { db } from "@/lib/db";
import { priceHistory, tradeLegs } from "@/lib/db/schema";
import { scalingQuality } from "@/lib/analytics/scaling-quality";
import { inr } from "@/lib/format";
import { getTrades } from "@/lib/queries/trades";
import { ProGate } from "@/components/system/pro-gate";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { EmptyState } from "@/components/ui/empty-state";

export const dynamic = "force-dynamic";
export default function ScalingPage() {
  const staged = getTrades().filter((t) => t.staged); const ids = staged.map((t) => t.id); const legs = ids.length ? db.select().from(tradeLegs).where(inArray(tradeLegs.tradeId, ids)).all() : [];
  const report = scalingQuality(staged.map((t) => ({ id: t.id, symbol: t.symbol, direction: t.sellQty > t.buyQty ? "short" as const : "long" as const, legs: legs.filter((l) => l.tradeId === t.id).map((l) => ({ ...l, kind: l.kind === "exit" ? "exit" as const : "entry" as const })) })));
  const replays = staged.map((t) => { const ls = legs.filter((l) => l.tradeId === t.id).sort((a,b) => a.seq-b.seq); const from = ls[0]?.tradeDate; const to = ls[ls.length-1]?.tradeDate; const bars = db.select({ date: priceHistory.date, close: priceHistory.close }).from(priceHistory).where(eq(priceHistory.symbol, t.symbol.toUpperCase())).all().filter((b) => (!from || b.date >= from) && (!to || b.date <= to)); return { id: t.id, symbol: t.symbol, entry: ls.find((l) => l.kind === "entry")?.price ?? 0, exit: ls.findLast?.((l) => l.kind === "exit")?.price ?? null, stop: t.slPlanned, target: t.targetPlanned, bars, legs: ls.map((l) => ({ id: l.id, kind: l.kind, tradeDate: l.tradeDate, price: l.price, qty: l.qty })) }; }).filter((x) => x.bars.length);
  return <><PageHeader title="Scaling Quality & Trade Replay" description="Did the ladder improve the trade, and what path did price take around each fill?" /> <div className="space-y-5 p-6"><ProGate><div className="grid gap-3 sm:grid-cols-4"><KpiCard label="Closed ladders" valueNum={report.closed} format="int" /><KpiCard label="Scaling improved" valueNum={report.improved} format="int" /><KpiCard label="Scaling harmed" valueNum={report.harmed} format="int" /><KpiCard label="Total scaling impact" valueNum={report.totalImpact} /></div>
  <Card className="p-0"><CardHeader><CardTitle>First-entry-only comparison</CardTitle></CardHeader><CardContent className="p-0">{report.rows.length ? (
    <ReportTable>
      <ReportThead>
        <ReportTh>Trade</ReportTh>
        <ReportTh>Shape</ReportTh>
        <ReportTh align="right">Actual</ReportTh>
        <ReportTh align="right">First entry only</ReportTh>
        <ReportTh align="right">Scaling impact</ReportTh>
        <ReportTh>Read</ReportTh>
      </ReportThead>
      <tbody>{report.rows.map((r) => (
        <ReportTr key={r.id}>
          <ReportTd className="font-medium">#{r.id} {r.symbol}</ReportTd>
          <ReportTd>{r.entries} in · {r.exits} out</ReportTd>
          <ReportTd align="right">{inr(r.actualNet)}</ReportTd>
          <ReportTd align="right">{r.firstEntryOnlyNet == null ? "—" : inr(r.firstEntryOnlyNet)}</ReportTd>
          <ReportTd align="right" className={r.scalingImpact != null && r.scalingImpact >= 0 ? "text-profit" : "text-loss"}>{r.scalingImpact == null ? "—" : inr(r.scalingImpact)}</ReportTd>
          <ReportTd><Badge variant={r.verdict === "improved" ? "profit" : r.verdict === "harmed" ? "loss" : "secondary"}>{r.verdict}</Badge></ReportTd>
        </ReportTr>
      ))}</tbody>
    </ReportTable>
  ) : (
    <EmptyState variant="journal" title="No staged positions yet" />
  )}<p className="p-4 text-[0.6875rem] text-muted-foreground">Counterfactual: the first tranche held to the ladder’s weighted average exit, with proportional exit charges. It isolates the money added by scaling; it does not claim you could have executed that path unchanged.</p></CardContent></Card>
  <Card><CardHeader><CardTitle>Visual EOD replay</CardTitle></CardHeader><CardContent><TradeReplay trades={replays}/></CardContent></Card></ProGate></div></>;
}
