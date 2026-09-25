"use client";

import type { AtlasPayload, ClassificationCoverage, GroupTableRow, SessionSpan, Statistic } from "@/lib/atlas";
import { GROUP_MIN_COMPUTE } from "@/lib/atlas/types";
import type { RankDeltaView } from "@/lib/queries/atlas";
import { cn } from "@/lib/utils";
import { fmtCount, fmtDay, ppmToPct, signedPct } from "./metric-tile";

/**
 * ONE rotation table (owner ruling AQ6), with a LEVEL toggle (sector 22 /
 * industry 59 — the exchanges' own classification, AQ21: sector by default,
 * industry one click away) and a STATISTIC toggle (median shipped, mean
 * labelled — AQ18). Both statistics are READ from the persisted payload
 * (`returns[w].median` / `.mean`), never recomputed here: a click is a read.
 *
 * Columns (AQ6/AQ9): group · n of m priced · 1w · 1m · 3m · YTD · RS · rank Δ
 * 1m · %>SMA50 · NH−NL · at 52w high · turnover share. Every cell that is
 * "—" has a reason a title attribute states; nothing here is a 0 in disguise.
 *
 * Leaders / laggards come only from groups with ≥ `minRank` priced members
 * (AQ26) and the hidden count is stated. "Turnover share" is Σ close × volume
 * of the group over the universe's — never the word money (AQ9).
 */

export type RotationLevel = "sector" | "industry";
export const ROTATION_LEVELS: { key: RotationLevel; label: string; count: string }[] = [
  { key: "sector", label: "Sector", count: "22 groups" },
  { key: "industry", label: "Industry", count: "59 groups" },
];
export const STATISTICS: { key: Statistic; label: string }[] = [
  { key: "median", label: "Median" },
  { key: "mean", label: "Mean (equal-weighted)" },
];

const WINDOWS = ["1w", "1m", "3m"] as const;

type Span = (SessionSpan & { gapLine: string | null }) | null;

export function Toggle<T extends string>({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  value: T;
  options: { key: T; label: string; count?: string }[];
  onChange: (v: T) => void;
  testId: string;
}) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label={label} data-testid={testId}>
      <span className="mr-1 text-muted-foreground">{label}</span>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          aria-pressed={o.key === value}
          data-value={o.key}
          onClick={() => onChange(o.key)}
          title={o.count}
          className={cn(
            "rounded-md border px-2 py-0.5 text-xs transition-colors",
            o.key === value
              ? "border-border bg-card text-primary"
              : "border-transparent text-muted-foreground hover:bg-card-hover hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** "1m = 21 stored sessions, 12 Jul → 15 Sep (3 missing)" — printed only when the calendar disagrees with the store. */
export function sparseHistoryLine(key: string, span: Span): string | null {
  if (!span || span.missing === 0) return null;
  return `${key} = ${span.stored} stored sessions, ${fmtDay(span.from)} → ${fmtDay(span.to)} (${span.missing} missing)`;
}

function cellTitle(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  return reason.replace(/_/g, " ");
}

export function RotationTable({
  rows,
  level,
  onLevel,
  statistic,
  onStatistic,
  rankDelta,
  filtered,
  classification,
  unclassified,
  spans,
  minRank,
  rs,
  caveat,
}: {
  rows: GroupTableRow[];
  level: RotationLevel;
  onLevel: (l: RotationLevel) => void;
  statistic: Statistic;
  onStatistic: (s: Statistic) => void;
  /** Same-spec stored snapshots (A1). `null` under an index filter — the stored ranks are the whole market's. */
  rankDelta: RankDeltaView | null;
  filtered: boolean;
  classification: ClassificationCoverage;
  /** Symbols with no label at THIS level — stated, never bucketed. */
  unclassified: number;
  spans: Record<(typeof WINDOWS)[number], Span>;
  minRank: number;
  /** The payload's RS block: eligible / priced counts, windows, weights and floors — printed, never retyped. */
  rs: AtlasPayload["relative_strength"] | null;
  caveat: string;
}) {
  const rsWindows = rs ? rs.windows.join("/") : "";
  const rsWeights = rs ? rs.weights.join("/") : "";
  const rsFloors = rs
    ? `turnover ≥ ₹${(rs.floors.minTurnoverRupees / 10_000_000).toLocaleString("en-IN")} crore, close ≥ ₹${rs.floors.minPrice.toLocaleString("en-IN")}`
    : "the turnover and price floors";
  const statLabel = statistic === "mean" ? "mean" : "median";
  const value = (r: GroupTableRow, w: (typeof WINDOWS)[number]) => r.returns[w]?.[statistic] ?? null;
  const sorted = [...rows].sort((a, b) => {
    const av = value(a, "1m")?.value_ppm ?? null;
    const bv = value(b, "1m")?.value_ppm ?? null;
    if (av === null && bv === null) return a.group < b.group ? -1 : 1;
    if (av === null) return 1;
    if (bv === null) return -1;
    return bv - av || (a.group < b.group ? -1 : 1);
  });

  const rankable = rows.filter((r) => r.rankable && r.rs.value_ppm !== null).sort((a, b) => b.rs.value_ppm! - a.rs.value_ppm!);
  const hidden = rows.length - rankable.length;
  const leaders = rankable.slice(0, 3);
  const laggards = rankable.length > 3 ? rankable.slice(-3).reverse() : [];

  const delta1m = rankDelta?.windows.find((w) => w.key === "1m") ?? null;
  const sparse = WINDOWS.map((w) => sparseHistoryLine(w, spans[w])).filter((s): s is string => s !== null);

  return (
    <div className="space-y-3 text-xs" data-testid="atlas-rotation" data-level={level} data-statistic={statistic}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Toggle label="Level" value={level} options={ROTATION_LEVELS} onChange={onLevel} testId="atlas-level-toggle" />
        <Toggle label="Statistic" value={statistic} options={STATISTICS} onChange={onStatistic} testId="atlas-statistic-toggle" />
      </div>

      {/* Q49, verbatim: one clock on the classification, so a row is today's
          grouping applied to today's move and is never backdated. */}
      <p className="rounded-md border border-accent/30 bg-accent/5 p-2 text-muted-foreground">
        {caveat} The classification carries a single as-of date and no per-row effective date, so these groupings
        are today&rsquo;s and are not backdated.
      </p>

      {rows.length === 0 ? (
        <p className="text-muted-foreground">
          No {level} groups: none of the priced symbols carries a {level} label in the bundled classification, so
          there is nothing to group by.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left tabular-nums">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-medium">{level === "sector" ? "Sector" : "Industry"}</th>
                <th className="py-1 pr-3 font-medium">Priced</th>
                <th className="py-1 pr-3 font-medium">1w</th>
                <th className="py-1 pr-3 font-medium">1m</th>
                <th className="py-1 pr-3 font-medium">3m</th>
                <th className="py-1 pr-3 font-medium">YTD</th>
                <th className="py-1 pr-3 font-medium">RS</th>
                <th className="py-1 pr-3 font-medium">Rank Δ 1m</th>
                <th className="py-1 pr-3 font-medium">%&gt;SMA50</th>
                <th className="py-1 pr-3 font-medium">NH−NL</th>
                <th className="py-1 pr-3 font-medium">At 52w high</th>
                <th className="py-1 pr-3 font-medium">Turnover share</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const held = r.returns["1m"]?.corporateActionExcluded.length ?? 0;
                const d = filtered ? undefined : delta1m?.delta[r.group];
                return (
                  <tr key={r.group} className="border-t border-border/60" data-group={r.group}>
                    <td className="py-1 pr-3 text-foreground">
                      {r.group}
                      {!r.computable ? <span className="text-muted-foreground"> · under {GROUP_MIN_COMPUTE} members</span> : null}
                    </td>
                    <td className="py-1 pr-3 text-muted-foreground">
                      {fmtCount(r.priced)} of {fmtCount(r.members)}
                      {held > 0 ? ` · ${held} held out (price gap)` : ""}
                    </td>
                    {WINDOWS.map((w) => {
                      const m = value(r, w);
                      return (
                        <td key={w} className="py-1 pr-3" title={cellTitle(m?.reason)}>
                          {signedPct(m?.value_ppm ?? null)}
                        </td>
                      );
                    })}
                    <td className="py-1 pr-3" title={cellTitle(r.ytd?.[statistic]?.reason)}>
                      {signedPct(r.ytd?.[statistic]?.value_ppm ?? null)}
                    </td>
                    <td className="py-1 pr-3" title={r.rs.reason ? cellTitle(r.rs.reason) : `median of ${r.rsEligible} eligible members' RS`}>
                      {signedPct(r.rs.value_ppm)}
                    </td>
                    <td className="py-1 pr-3" title={filtered ? "not shown under an index filter" : delta1m?.shortfall ?? undefined}>
                      {filtered || !delta1m || delta1m.shortfall ? "—" : d == null ? "not ranked then" : d > 0 ? `+${d}` : String(d)}
                    </td>
                    <td className="py-1 pr-3" title={cellTitle(r.aboveSma[50]?.reason)}>{ppmToPct(r.aboveSma[50]?.value_ppm ?? null, 0)}</td>
                    <td className="py-1 pr-3" title={cellTitle(r.netHighLow.reason)}>
                      {r.netHighLow.value === null ? "—" : `${r.netHighLow.value > 0 ? "+" : ""}${r.netHighLow.value}`}
                    </td>
                    <td className="py-1 pr-3" title={cellTitle(r.atHighShare.reason)}>
                      {r.atHighShare.denominator > 0 ? `${fmtCount(r.atHighShare.numerator)} of ${fmtCount(r.atHighShare.denominator)}` : "—"}
                    </td>
                    <td className="py-1 pr-3" title={cellTitle(r.turnoverShare.reason)}>{ppmToPct(r.turnoverShare.value_ppm, 1)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Leaders and laggards by RS, ≥ minRank priced members only (AQ26); the hidden count is stated. */}
      {rows.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2" data-testid="atlas-leaders">
          <div>
            <div className="mb-1 font-medium text-foreground">RS leaders</div>
            {leaders.length === 0 ? (
              <p className="text-muted-foreground">No group has {minRank} priced members yet, so none is ranked.</p>
            ) : (
              <ul className="space-y-0.5 tabular-nums text-muted-foreground">
                {leaders.map((r) => (
                  <li key={r.group}>
                    <span className="text-foreground">{r.group}</span> {signedPct(r.rs.value_ppm)} · {fmtCount(r.rsEligible)} eligible
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="mb-1 font-medium text-foreground">RS laggards</div>
            {laggards.length === 0 ? (
              <p className="text-muted-foreground">Fewer than four ranked groups — leaders and laggards would be the same list.</p>
            ) : (
              <ul className="space-y-0.5 tabular-nums text-muted-foreground">
                {laggards.map((r) => (
                  <li key={r.group}>
                    <span className="text-foreground">{r.group}</span> {signedPct(r.rs.value_ppm)} · {fmtCount(r.rsEligible)} eligible
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="text-muted-foreground sm:col-span-2">
            {hidden > 0
              ? `${hidden} group${hidden === 1 ? "" : "s"} hidden (fewer than ${minRank} priced members). `
              : ""}
            {rs ? `RS over ${fmtCount(rs.eligible)} eligible of ${fmtCount(rs.priced)} priced. ` : ""}
            {filtered
              ? "Rank Δ is read from the whole market's stored snapshots and is not shown under an index filter."
              : delta1m?.shortfall
                ? `Rank Δ: ${delta1m.shortfall}.`
                : delta1m
                  ? `Rank Δ 1m against the snapshot of ${delta1m.pastAsOf}; positive = climbed.`
                  : ""}
          </p>
        </div>
      ) : null}

      {sparse.length > 0 ? (
        <p className="tabular-nums text-muted-foreground" data-testid="atlas-sparse-history">
          Sparse history: {sparse.join(" · ")}. The calendar counts the trading days the store does not hold.
        </p>
      ) : null}

      {/* Q-5: the columns are figures, so their plain public definitions sit
          beside them. Everything here comes out of lib/atlas/groups and none
          of it is weighted by anything — no market cap, no free float. */}
      <p className="text-muted-foreground">
        <span className="text-foreground">1w / 1m / 3m / YTD</span> are the median of each measurable member&rsquo;s
        own return over the window (close ÷ close N sessions ago − 1; YTD from the prior year&rsquo;s last close);
        every member counts once, whatever its size, and the mean is the labelled alternative to the shipped
        median{statLabel === "mean" ? " — the table is showing the mean now" : ""}.{" "}
        <span className="text-foreground">RS</span> is the median of members&rsquo; relative strength — {rsWindows}-session
        returns weighted {rsWeights} against the market median of the eligible universe ({rsFloors}).{" "}
        <span className="text-foreground">%&gt;SMA50</span> is the share of measurable members whose close is
        strictly above the mean of their last 50 closes. <span className="text-foreground">NH−NL</span> is new
        52-week highs minus new lows, a count. <span className="text-foreground">At 52w high</span> is the members at a new
        high over the members with a window. <span className="text-foreground">Turnover share</span> is the group&rsquo;s Σ
        close × volume over the universe&rsquo;s, on the anchor session. A name with too little history — or held out
        for an unreconciled price gap — is counted in none of them, which is what the Priced column states.
      </p>
      <p className="text-muted-foreground">
        {fmtCount(classification.groups)} sector groups · classification coverage{" "}
        {ppmToPct(classification.classified.value_ppm, 1)} ({fmtCount(classification.classified.numerator)} of{" "}
        {fmtCount(classification.classified.denominator)}) · {fmtCount(unclassified)} symbols carry no {level} label and are
        counted nowhere rather than dropped into &ldquo;Other&rdquo;.
      </p>
    </div>
  );
}
