import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KpiCard, type KpiDetail } from "@/components/kpi-card";
import { num } from "@/lib/format";
import type { WeekComparison } from "./week-gap";

/**
 * PANEL 1 — the open week's Process Score, with its arithmetic beside it.
 *
 * The transparency IS the feature. Every component states its own numerator,
 * denominator and percentage, plus the coverage sentence saying what it could
 * actually read — a bare 74 tells a trader nothing about which of five things
 * moved, and a component that refused to measure looks identical to one that
 * scored badly unless the row says so.
 *
 * Two refusals are rendered as refusals, never as zeroes:
 *   - the WEEK under the sample floor shows its reason instead of a score;
 *   - a COMPONENT with nothing honest to measure shows "—" with the coverage
 *     line explaining what was missing.
 *
 * The week-over-week line follows lib/analytics/monthly.ts's `momNet` rule:
 * blank across a gap, never a trend invented from two non-adjacent weeks.
 */

export interface ProcessRowView {
  id: string;
  label: string;
  numerator: number;
  denominator: number;
  /** 0..100, or null where the component had nothing honest to measure. */
  pct: number | null;
  /** "12 of 40 trades had a playbook" — from the component's own coverage. */
  coverage: string;
  /** The registry's one-line explainer for this component. */
  note: string;
}

function scoreTone(score: number): string {
  return score >= 80 ? "text-profit" : score >= 60 ? "text-warning" : "text-loss";
}

/** The comparison sentence, or the reason there is none. */
function comparisonLine(c: WeekComparison): string {
  if (c.kind === "delta") {
    const sign = c.delta > 0 ? "+" : "";
    return `${sign}${num(c.delta, 0)} vs the week of ${c.previousWeekStart} (${num(c.previousScore, 0)})`;
  }
  if (c.reason === "no-current") return `— vs the week of ${c.previousWeekStart}: this week has no score yet`;
  if (c.reason === "no-week") return `— vs the week of ${c.previousWeekStart}: nothing closed in it`;
  return `— vs the week of ${c.previousWeekStart}: that week did not score either`;
}

function ComponentRow({ row }: { row: ProcessRowView }) {
  return (
    <div className="grid grid-cols-1 gap-x-3 gap-y-0.5 border-t border-rule py-2 text-xs first:border-t-0 sm:grid-cols-[minmax(0,1fr)_auto]">
      <span className="font-medium text-foreground">{row.label}</span>
      <span className="tabular-nums">
        {row.numerator} of {row.denominator}
        {" · "}
        {row.pct == null ? <span className="text-muted-foreground">—</span> : <span>{num(row.pct, 1)}%</span>}
      </span>
      <span className="text-muted-foreground sm:col-span-2">{row.coverage}</span>
    </div>
  );
}

export function ProcessScorePanel({
  weekLabel,
  weekStart,
  weekEnd,
  score,
  refusal,
  closedTrades,
  rows,
  comparison,
  detail,
}: {
  weekLabel: string;
  weekStart: string;
  weekEnd: string;
  score: number | null;
  /** The stated reason there is no score. Null whenever `score` is a number. */
  refusal: string | null;
  closedTrades: number;
  rows: ProcessRowView[];
  comparison: WeekComparison;
  detail: KpiDetail;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>This week — {weekLabel}</CardTitle>
        <p className="text-xs text-muted-foreground">
          {weekStart} to {weekEnd} · {closedTrades} closed trade{closedTrades === 1 ? "" : "s"} so far
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
          <KpiCard
            label="Process Score"
            value={score == null ? "—" : String(score)}
            valueClassName={score == null ? "text-muted-foreground" : scoreTone(score)}
            sub={refusal ?? comparisonLine(comparison)}
            detail={detail}
          />
          <div className="rounded-md border border-border bg-card-hover/30 px-3 py-1.5">
            {rows.map((r) => (
              <ComponentRow key={r.id} row={r} />
            ))}
          </div>
        </div>

        {refusal && (
          <p className="text-xs text-muted-foreground">
            The five rows above still hold: the arithmetic is visible even while the summary figure is
            withheld. {refusal}.
          </p>
        )}

        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">How each component is counted</summary>
          <dl className="mt-2 space-y-2">
            {rows.map((r) => (
              <div key={r.id}>
                <dt className="font-medium text-foreground">{r.label}</dt>
                <dd className="text-muted-foreground">{r.note}</dd>
              </div>
            ))}
          </dl>
        </details>
      </CardContent>
    </Card>
  );
}
