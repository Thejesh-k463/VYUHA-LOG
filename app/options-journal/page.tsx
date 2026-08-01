import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KpiCard } from "@/components/kpi-card";
import { OptionsJournalEditor } from "@/components/behavior/options-journal-editor";
import { optionsSellerReport } from "@/lib/analytics/options-seller";
import { inr } from "@/lib/format";
import { getTrades } from "@/lib/queries/trades";

export const dynamic = "force-dynamic";

export default function OptionsJournalPage() {
  const options = getTrades().filter((t) => t.instrumentType === "option");
  const seller = optionsSellerReport(options);
  return <>
    <PageHeader title="Options Seller Journal" description="Premium capture, IV change, hedge state, DTE, adjustments and expiry outcomes." />
    <div className="space-y-5 p-6">
      <div className="grid gap-3 sm:grid-cols-4">
        <KpiCard label="Seller trades" value={String(seller.count)} />
        <KpiCard label="Net P&L" value={inr(seller.netPnl)} />
        <KpiCard label="Premium captured" value={seller.capturePct == null ? "—" : `${seller.capturePct}%`} />
        <KpiCard label="Fully hedged" value={seller.hedgedPct == null ? "—" : `${seller.hedgedPct}%`} />
      </div>
      <Card><CardHeader><CardTitle>Outcome mix</CardTitle></CardHeader><CardContent className="flex flex-wrap gap-2">
        {Object.entries(seller.outcomes).map(([k, v]) => <div key={k} className="rounded-md border border-border px-3 py-2 text-xs"><span className="text-muted-foreground">{k.replaceAll("_", " ")}</span><p className="text-lg font-semibold tabular-nums">{v}</p></div>)}
      </CardContent></Card>
      <Card className="p-0"><CardHeader><CardTitle>Contract journal</CardTitle></CardHeader><CardContent className="p-0">
        <OptionsJournalEditor trades={options.map((t) => ({ id: t.id, symbol: t.symbol, tradingsymbol: t.tradingsymbol, entryIv: t.entryIv, exitIv: t.exitIv, entryDte: t.entryDte, hedgeStatus: t.hedgeStatus, expiryOutcome: t.expiryOutcome, adjustmentGroup: t.adjustmentGroup, isOpen: t.isOpen }))} />
        {!options.length && <p className="p-4 text-sm text-muted-foreground">No option trades yet.</p>}
      </CardContent></Card>
      <p className="text-[11px] text-muted-foreground">Premium capture is descriptive. Return-on-risk uses the recorded risk amount when present; it is not a broker SPAN statement. IV fields are user/broker observations, never silently inferred.</p>
    </div>
  </>;
}
