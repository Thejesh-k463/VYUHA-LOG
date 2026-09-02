import { Card } from "@/components/ui/card";
import { inr, inrCompact } from "@/lib/format";
import type { GoalFacts, GoalProgress } from "@/lib/analytics/goal";

/**
 * Compact goal summary for the Target Tracker pages — the Meter's vocabulary
 * (label · used/limit · bar · remaining line) applied to the bucket's
 * expected-capital goal. Server component: display only, no interactivity.
 *
 * Renders only when a goal exists (the page guards); an unmeasurable goal
 * shows "—" plus the one Settings nudge, never 0% (invariant 6).
 */
export function GoalStrip({ goal, progress }: { goal: GoalFacts; progress: GoalProgress }) {
  const gp = progress;
  const title = goal.kind === "absolute" ? `Goal ${inrCompact(goal.targetAmount ?? 0)}` : `Goal +${goal.pctTarget}% profit`;

  if (!gp.measurable) {
    return (
      <Card className="p-3">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{title}{goal.targetDate ? ` · by ${goal.targetDate}` : ""}</span>
          <span className="font-medium">—</span>
        </div>
        <div className="mt-1 text-[10px] text-muted-foreground">
          Not measurable without a capital base — set this bucket&apos;s capital in Settings.
        </div>
      </Card>
    );
  }

  const pctUsed = gp.progressPct != null ? Math.max(0, Math.min(100, gp.progressPct)) : 0;
  const met = gp.gapAmount != null && gp.gapAmount <= 0;
  const color = met ? "var(--color-profit)" : "var(--color-primary)";

  return (
    <Card className="p-3">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{title}{goal.targetDate ? ` · by ${goal.targetDate}` : ""}</span>
        <span className="font-medium tabular-nums">
          {inrCompact(gp.achieved ?? 0)}/{inrCompact(gp.targetLevel ?? 0)}
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-card-hover">
        <div className="h-full rounded-full transition-all" style={{ width: `${pctUsed}%`, background: color }} />
      </div>
      <div className="mt-1 text-[10px] text-muted-foreground">
        {met
          ? "Goal met"
          : `${inr(gp.gapAmount ?? 0, { decimals: 0 })} remaining${
              gp.requiredPerWeek != null ? ` · works out to ${inr(gp.requiredPerWeek, { decimals: 0 })}/wk to the date` : ""
            }${gp.runRate30 != null ? ` · trailing 30d pace ${inr(gp.runRate30, { decimals: 0 })}/wk` : ""}`}
      </div>
    </Card>
  );
}
