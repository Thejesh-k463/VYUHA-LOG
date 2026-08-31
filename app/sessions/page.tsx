import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SessionPlanner } from "@/components/behavior/session-planner";
import { SessionReviewControls } from "@/components/behavior/session-review-controls";
import { getSessionPlanPage, type PlannedSymbolInfo } from "@/lib/queries/session-plan";
import { getPlaybooks } from "@/lib/queries/playbooks";
import { inr } from "@/lib/format";
import { EmptyState } from "@/components/ui/empty-state";

export const dynamic = "force-dynamic";

/**
 * Per-symbol history block: the account's OWN record with each planned symbol,
 * computed at render and never persisted. Every rate states its n; anything
 * without a denominator renders "—" rather than an invented 0 (invariant 6).
 */
function PlannedSymbolRow({ info }: { info: PlannedSymbolInfo }) {
  const s = info.stats;
  return <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-t border-rule py-1.5 text-xs first:border-t-0">
    <span className="w-24 shrink-0 font-medium">{info.symbol}</span>
    {s ? <>
      <span className="text-muted-foreground">{s.tradeCount} trade{s.tradeCount === 1 ? "" : "s"}</span>
      <span className={s.netPnl >= 0 ? "text-profit" : "text-loss"}>{inr(s.netPnl)}</span>
      <span className="text-muted-foreground">win {s.winRate ? `${s.winRate.pct}% (n=${s.winRate.n})` : "—"}</span>
      <span className="text-muted-foreground">avg R {s.avgR ? `${s.avgR.value} (n=${s.avgR.n})` : "—"}</span>
      <span className="text-muted-foreground">last {s.lastTraded ?? "—"}</span>
    </> : <span className="text-muted-foreground">no history in this account</span>}
    <span className="text-muted-foreground">{info.sector ?? "—"}</span>
    <span className="text-muted-foreground">lot {info.lotSize ?? "—"}</span>
    {s?.expiryWithinDays != null && <span className="text-warning">your book has an expiry within {s.expiryWithinDays} day{s.expiryWithinDays === 1 ? "" : "s"}</span>}
  </div>;
}

export default function SessionsPage() {
  const sessions = getSessionPlanPage(); const playbooks = getPlaybooks().filter((p) => !p.archived);
  return <><PageHeader title="Session Plan & Review" description="Commit the measurable plan before the market, then compare it with what the journal recorded." />
  <div className="space-y-5 p-6"><Card><CardHeader><CardTitle>Pre-market plan</CardTitle></CardHeader><CardContent><SessionPlanner playbooks={playbooks.map((p) => ({ id: p.id, name: p.name }))} /></CardContent></Card>
  <div className="space-y-3">{sessions.map((s) => <Card key={s.id}>
    <CardHeader className="flex-row items-center justify-between">
      <div><CardTitle>{s.sessionDate} · {s.market}</CardTitle><p className="text-xs text-muted-foreground">{s.plannedSymbols.join(", ") || "Open watchlist"}</p></div>
      <div className="flex items-center gap-2">
        {s.status === "reviewed" && <Badge variant="secondary">Reviewed</Badge>}
        <Badge variant={s.review.adherencePct === 100 ? "profit" : s.review.adherencePct >= 60 ? "warning" : "loss"}>{s.review.adherencePct}% adherence</Badge>
      </div>
    </CardHeader>
    <CardContent className="space-y-3">
      <div className="grid grid-cols-3 gap-3 text-xs"><div><span className="text-muted-foreground">Trades</span><p className="text-base font-medium tabular-nums">{s.review.tradeCount}{s.maxTrades ? ` / ${s.maxTrades}` : ""}</p></div><div><span className="text-muted-foreground">Net</span><p className={s.review.netPnl >= 0 ? "text-profit" : "text-loss"}>{inr(s.review.netPnl)}</p></div><div><span className="text-muted-foreground">Cutoff</span><p>{s.cutoffTime ?? "—"}</p></div></div>
      {s.plannedSymbolInfo.length > 0 && <div>{s.plannedSymbolInfo.map((info) => <PlannedSymbolRow key={info.symbol} info={info} />)}</div>}
      <ul className="space-y-1 text-xs">{s.review.findings.map((f) => <li key={f}>▸ {f}</li>)}</ul>
      {s.thesis && <p className="border-t border-rule pt-2 text-xs text-muted-foreground">Plan: {s.thesis}</p>}
      {s.status === "reviewed"
        ? (s.reviewNotes && <p className="border-t border-rule pt-2 text-xs text-muted-foreground">Review: {s.reviewNotes}</p>)
        : <SessionReviewControls sessionId={s.id} />}
    </CardContent>
  </Card>)}{sessions.length === 0 && <EmptyState variant="playbook" title="No session plans yet" hint="Commit a pre-market plan above and it will show up here with its review." />}</div></div></>;
}
