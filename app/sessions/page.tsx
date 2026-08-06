import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SessionPlanner } from "@/components/behavior/session-planner";
import { getSessionsWithReview } from "@/lib/queries/sessions";
import { getPlaybooks } from "@/lib/queries/playbooks";
import { inr } from "@/lib/format";

export const dynamic = "force-dynamic";
export default function SessionsPage() {
  const sessions = getSessionsWithReview(); const playbooks = getPlaybooks().filter((p) => !p.archived);
  return <><PageHeader title="Session Plan & Review" description="Commit the measurable plan before the market, then compare it with what the journal recorded." />
  <div className="space-y-5 p-6"><Card><CardHeader><CardTitle>Pre-market plan</CardTitle></CardHeader><CardContent><SessionPlanner playbooks={playbooks.map((p) => ({ id: p.id, name: p.name }))} /></CardContent></Card>
  <div className="space-y-3">{sessions.map((s) => <Card key={s.id}><CardHeader className="flex-row items-center justify-between"><div><CardTitle>{s.sessionDate} · {s.market}</CardTitle><p className="text-xs text-muted-foreground">{s.plannedSymbols.join(", ") || "Open watchlist"}</p></div><Badge variant={s.review.adherencePct === 100 ? "profit" : s.review.adherencePct >= 60 ? "warning" : "loss"}>{s.review.adherencePct}% adherence</Badge></CardHeader><CardContent className="space-y-3"><div className="grid grid-cols-3 gap-3 text-xs"><div><span className="text-muted-foreground">Trades</span><p className="text-base font-medium tabular-nums">{s.review.tradeCount}{s.maxTrades ? ` / ${s.maxTrades}` : ""}</p></div><div><span className="text-muted-foreground">Net</span><p className={s.review.netPnl >= 0 ? "text-profit" : "text-loss"}>{inr(s.review.netPnl)}</p></div><div><span className="text-muted-foreground">Cutoff</span><p>{s.cutoffTime ?? "—"}</p></div></div><ul className="space-y-1 text-xs">{s.review.findings.map((f) => <li key={f}>▸ {f}</li>)}</ul>{s.thesis && <p className="border-t border-rule pt-2 text-xs text-muted-foreground">Plan: {s.thesis}</p>}</CardContent></Card>)}{sessions.length === 0 && <p className="text-sm text-muted-foreground">No session plans yet.</p>}</div></div></>;
}
