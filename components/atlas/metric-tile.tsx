import { cn } from "@/lib/utils";
import { COVERAGE_FLOOR_PPM } from "@/lib/atlas/types";

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

/** Signed percentage for a RETURN: +2.10% / −0.35%; "—" for null. */
export function signedPct(ppm: number | null | undefined, digits = 2): string {
  if (ppm == null) return "—";
  const s = (Math.abs(ppm) / 10_000).toFixed(digits);
  return ppm > 0 ? `+${s}%` : ppm < 0 ? `−${s}%` : `${s}%`;
}

/** An integer with Indian grouping; "—" for null. */
export function fmtCount(x: number | null | undefined): string {
  return x == null ? "—" : x.toLocaleString("en-IN");
}

/** "12 Jul" from an ISO date — UTC-anchored so the server and the browser print the same day. */
export function fmtDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
}

/**
 * AQ44 — the collapsed-denominator sentence: "40 of 1,900 priced (2%)". The
 * universe is recovered from the metric's own `denominator` and `coverage_ppm`
 * (coverage = denominator / universe), so the tile needs no extra prop.
 */
export function coverageSentence(denominator: number, coveragePpm: number): string {
  const universe = coveragePpm > 0 ? Math.round((denominator * 1_000_000) / coveragePpm) : null;
  const whole = Math.round(coveragePpm / 10_000);
  const pct = whole === 0 && coveragePpm > 0 ? "<1%" : `${whole}%`;
  return universe === null
    ? `${denominator.toLocaleString("en-IN")} priced (${pct})`
    : `${denominator.toLocaleString("en-IN")} of ${universe.toLocaleString("en-IN")} priced (${pct})`;
}

/** True when the AQ44 rule applies: a real denominator whose coverage is under the floor. */
export function belowCoverageFloor(
  denominator: number | null | undefined,
  coveragePpm: number | null | undefined,
  floorPpm: number,
): boolean {
  return denominator != null && denominator > 0 && coveragePpm != null && coveragePpm < floorPpm;
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
  coverageFloorPpm = COVERAGE_FLOOR_PPM,
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
  /**
   * AQ44 (v4.6.0 W5): below this coverage the tile prints its COVERAGE
   * ("40 of 1,900 priced (2%)") INSTEAD of its value — a figure over a
   * collapsed denominator is not published, and it is never 0 or blank.
   * Above it the value prints with its coverage beneath. 30% is a proposal.
   */
  coverageFloorPpm?: number;
}) {
  const collapsed = !shortfall && belowCoverageFloor(denominator, coveragePpm, coverageFloorPpm);
  const missing = shortfall || collapsed || (valuePpm === undefined ? value == null : valuePpm == null);
  return (
    <div className={cn("rounded-md border border-border bg-card/40 p-3", className)} data-coverage={collapsed ? "below-floor" : undefined}>
      <div className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-xl font-semibold tabular-nums", missing && "text-muted-foreground")}>
        {shortfall || collapsed ? "—" : valuePpm !== undefined ? ppmToPct(valuePpm) : (value ?? "—")}
      </div>
      {shortfall ? (
        <div className="mt-1 text-[0.6875rem] text-muted-foreground">{shortfall}</div>
      ) : collapsed ? (
        <div className="mt-1 text-[0.6875rem] tabular-nums text-muted-foreground">
          {coverageSentence(denominator!, coveragePpm!)} · below the {ppmToPct(coverageFloorPpm, 0)} coverage floor, so the
          value is not shown
        </div>
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
