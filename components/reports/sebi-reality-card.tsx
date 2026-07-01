import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { inr, inrCompact } from "@/lib/format";
import { Info } from "lucide-react";
import type { FnoReality } from "@/lib/analytics/sebi-reality";

function Mini({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card-hover/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold tabular-nums ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

export function SebiRealityCard({ reality }: { reality: FnoReality }) {
  const { facts } = reality;
  const pnlTone = reality.netPnl > 0 ? "text-profit" : reality.netPnl < 0 ? "text-loss" : "text-muted-foreground";

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Info className="size-4 text-muted-foreground" />
          <CardTitle>SEBI reality check — F&amp;O</CardTitle>
        </div>
        <Badge variant="secondary">{facts.period}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg border border-border bg-card-hover/30 px-4 py-3">
          <div className="text-2xl font-bold tabular-nums text-loss">{facts.lossMakingPct}%</div>
          <div className="text-sm text-foreground">of individual F&amp;O traders made a net loss in {facts.period}.</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            Average net loss ≈ {inr(facts.avgNetLoss, { decimals: 0 })} per loss-making trader. {facts.sourceNote}
          </div>
        </div>

        {reality.hasData ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <Mini label="Your F&O net" value={inrCompact(reality.netPnl)} tone={pnlTone} />
              <Mini label="Win rate" value={`${reality.winRatePct}%`} />
              <Mini label="Closed F&O" value={`${reality.closed}`} />
              <Mini label="Per trade" value={inrCompact(reality.avgPerTrade)} tone={reality.avgPerTrade >= 0 ? "text-profit" : "text-loss"} />
              <Mini label="Profit factor" value={reality.profitFactor == null ? "—" : reality.profitFactor.toFixed(2)} />
              <Mini label="Charge drag" value={`${reality.chargeDragPct}%`} tone={reality.chargeDragPct > 30 ? "text-loss" : undefined} />
            </div>
            <div
              className={`rounded-lg border-l-2 px-3 py-2 text-sm ${
                reality.profitable
                  ? "border-l-profit bg-profit/5 text-foreground"
                  : "border-l-loss bg-loss/5 text-foreground"
              }`}
            >
              {reality.verdict}
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{reality.verdict}</p>
        )}

        <p className="text-[11px] text-muted-foreground">
          Informational, not advice. Figures from SEBI&apos;s published study; your numbers are realised net P&amp;L on
          closed derivative trades in this journal.
        </p>
      </CardContent>
    </Card>
  );
}
