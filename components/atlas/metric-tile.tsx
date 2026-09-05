import { cn } from "@/lib/utils";

/**
 * The unit of the Atlas panel: a figure that CANNOT be rendered without its
 * denominator (04 §4.1, AGENTS.md invariant 6).
 *
 * "68%" is not publishable here — "68% · 1,204 of 1,771 · 93% coverage" is.
 * The shortfall line replaces the value entirely when the metric could not be
 * computed, so a metric that needs 200 sessions on a 43-session database reads
 * "needs 200 sessions, you have 43" rather than a confident blank.
 */

/** Integer ppm → a percentage string. 20_000 ppm = "2.0%". */
export function ppmToPct(ppm: number | null, digits = 1): string {
  return ppm === null ? "—" : `${(ppm / 10_000).toFixed(digits)}%`;
}

export function MetricTile({
  label,
  valuePpm,
  value,
  numerator,
  denominator,
  coveragePpm,
  shortfall,
  formula,
  children,
  className,
}: {
  label: string;
  /** A ratio, in integer ppm. */
  valuePpm?: number | null;
  /** A count. Mutually exclusive with `valuePpm` — a count is not a ratio. */
  value?: number | null;
  numerator?: number | null;
  denominator?: number | null;
  coveragePpm?: number | null;
  /** "needs 200 sessions, you have 43" — printed INSTEAD of the figure. */
  shortfall?: string | null;
  formula?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const missing = shortfall || (valuePpm === undefined ? value == null : valuePpm == null);
  return (
    <div className={cn("rounded-md border border-border bg-card/40 p-3", className)}>
      <div className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-xl font-semibold tabular-nums", missing && "text-muted-foreground")}>
        {shortfall ? "—" : valuePpm !== undefined ? ppmToPct(valuePpm) : (value ?? "—")}
      </div>
      {shortfall ? (
        <div className="mt-1 text-[0.6875rem] text-muted-foreground">{shortfall}</div>
      ) : (
        <div className="mt-1 text-[0.6875rem] tabular-nums text-muted-foreground">
          {denominator != null && denominator > 0 ? (
            <>
              {numerator != null ? `${numerator.toLocaleString("en-IN")} of ` : ""}
              {denominator.toLocaleString("en-IN")}
              {coveragePpm != null ? ` · ${ppmToPct(coveragePpm, 0)} coverage` : ""}
            </>
          ) : (
            "no denominator — nothing to divide by"
          )}
        </div>
      )}
      {formula ? <div className="mt-1 text-[0.625rem] leading-relaxed text-muted-foreground">{formula}</div> : null}
      {children}
    </div>
  );
}
