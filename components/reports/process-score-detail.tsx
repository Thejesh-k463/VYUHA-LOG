import { coverageText } from "@/lib/intelligence/insight";
import type { ProcessComponent, ProcessRefusal } from "@/lib/analytics/process-score";
import { cn } from "@/lib/utils";

/**
 * The arithmetic behind one week's Process Score, revealed on demand.
 *
 * A bare 0-100 score is exactly the kind of number nobody can argue with and
 * nobody can check. Each of the five components carries its own numerator,
 * denominator and coverage, so this renders them as "n of m · pct" with the
 * sentence that says what could actually be read ("12 of 40 trades had a
 * playbook"). A component with nothing to measure shows "—" and its coverage
 * explains why — it is not a zero, and it is not in the mean.
 *
 * The same `<details>` disclosure the margin panel uses, so it needs no client
 * JavaScript: this renders inside a server component and prints in whatever
 * state the reader left it.
 *
 * A week under the sample floor has no score at all; its refusal sentence is
 * the summary line, visible without opening anything. Copy here is DESCRIPTIVE
 * (owner decision #7) — it states what the record holds and instructs nothing.
 */
export function ProcessScoreDetail({
  components,
  refusal,
  className,
}: {
  components: ProcessComponent[];
  refusal: ProcessRefusal | null;
  className?: string;
}) {
  const measured = components.filter((c) => c.pct != null).length;
  return (
    <details className={cn("px-2.5 py-1.5", className)}>
      <summary className="cursor-pointer text-[0.6875rem] text-muted-foreground">
        {refusal ? refusal.reason : `Score arithmetic — ${measured} of ${components.length} components measured`}
      </summary>
      <ul className="mt-1.5 space-y-1 pl-4">
        {components.map((c) => (
          <li key={c.id} className="flex flex-wrap items-baseline gap-x-2.5 text-[0.6875rem]">
            <span className="min-w-[11rem] font-medium">{c.label}</span>
            <span className="tabular-nums">
              {c.pct == null ? "—" : `${c.numerator} of ${c.denominator} · ${c.pct}%`}
            </span>
            <span className="text-muted-foreground">{coverageText(c.coverage)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 pl-4 text-[0.6875rem] text-muted-foreground">
        The score is the mean of the components that had something to measure. A component showing
        &quot;—&quot; had no denominator in this week and sits out of the mean rather than counting as zero.
      </p>
    </details>
  );
}
