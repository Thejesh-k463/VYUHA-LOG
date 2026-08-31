import { CheckCircle2, Info, TriangleAlert } from "lucide-react";
import { coverageText, type Insight, type InsightTone } from "@/lib/intelligence/insight";

/**
 * The shared "Vyuha Intelligence" rendering — generalised from Arjun's Eye's
 * FindingCard so every surface (lens popups, Trade Craft tabs, session plan)
 * speaks one visual language. Purely presentational, no hooks: renders in
 * server components AND inside client dialogs.
 *
 * Coverage renders WITH the claim (insight contract rule 3) — a number
 * computed on a subset never appears without its denominator.
 */

const TONE: Record<InsightTone, { icon: typeof Info; cls: string }> = {
  good: { icon: CheckCircle2, cls: "border-profit/40 text-profit" },
  warn: { icon: TriangleAlert, cls: "border-warning/45 text-warning" },
  info: { icon: Info, cls: "border-accent/40 text-accent" },
};

export function InsightCard({ insight }: { insight: Insight }) {
  const t = TONE[insight.tone];
  const Icon = t.icon;
  return (
    <div className={`flex items-start gap-3 rounded-lg border-l-2 bg-background/30 p-3 ${t.cls}`}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{insight.headline}</div>
        {insight.detail && <div className="mt-0.5 text-xs text-muted-foreground">{insight.detail}</div>}
        {insight.evidence.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
            {insight.evidence.map((e) => (
              <span key={e.label} className="text-xs text-muted-foreground">
                {e.label}{" "}
                <span
                  className={`font-mono tabular-nums ${
                    e.tone === "good" ? "text-profit" : e.tone === "warn" ? "text-warning" : "text-foreground"
                  }`}
                >
                  {e.value}
                </span>
              </span>
            ))}
          </div>
        )}
        {insight.suggestion && <div className="mt-1 text-xs text-muted-foreground">{insight.suggestion}</div>}
        {insight.coverage && (
          <div className="mt-1 text-[0.6875rem] text-muted-foreground/80">
            Based on {coverageText(insight.coverage)}.
          </div>
        )}
      </div>
    </div>
  );
}

export function InsightList({ insights, emptyText }: { insights: Insight[]; emptyText?: string }) {
  if (insights.length === 0) {
    return emptyText ? <p className="p-1 text-xs text-muted-foreground">{emptyText}</p> : null;
  }
  return (
    <div className="space-y-2">
      {insights.map((i) => (
        <InsightCard key={i.id} insight={i} />
      ))}
    </div>
  );
}
