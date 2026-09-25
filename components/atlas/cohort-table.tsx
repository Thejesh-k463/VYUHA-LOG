"use client";

import type { CohortRow, CohortWindowKey } from "@/lib/atlas";
import type { EntryDayBreadthView, MyNamesView } from "@/lib/queries/atlas";
import { fmtCount, ppmToPct, signedPct } from "./metric-tile";
import { sparseHistoryLine } from "./rotation-table";

/**
 * "My names" — stock pick, or cohort ride? (Q51 #3–#7, AQ21, AQ26, AQ47.)
 *
 * One row per open equity position, over `MyNamesView.cohorts`: the LEVEL the
 * row used (industry, falling up to sector when the industry cohort is too
 * thin) and the count it was decided on; own / cohort MEDIAN / difference for
 * 1w and 1m; "14 of 17 priced"; rank in cohort with its percentile; the
 * corporate-action exclusion with its date; and a DESCRIPTIVE verdict
 * ("rose while its industry fell over 1m") — never a rating, never a verb
 * about the future. The forbidden vocabulary is scanned in tests/atlas-copy.
 *
 * The dark state (under 21 stored sessions) is the server's sentence,
 * rendered verbatim — tests pin "21" and "you have N" in it.
 */

const WINDOWS: CohortWindowKey[] = ["1w", "1m"];

function levelCell(r: CohortRow): string {
  if (!r.level) return "unclassified";
  const group = r.group ?? "—";
  const decided = r.decidedOn ? ` · decided on ${r.decidedOn.window}: ${fmtCount(r.decidedOn.priced)} of ${fmtCount(r.decidedOn.members)} priced` : "";
  const fell = r.fellUp ? " (industry too thin, fell up to sector)" : "";
  return `${r.level}: ${group}${fell}${decided}`;
}

function rankCell(r: CohortRow, w: CohortWindowKey): string {
  const cw = r.windows[w];
  if (!cw?.rank) return "—";
  const pct = cw.percentile === null ? "" : ` · above ${cw.percentile}% of them`;
  return `${cw.rank.position} of ${cw.rank.of}${pct}`;
}

export function CohortTable({ myNames }: { myNames: MyNamesView }) {
  if (!myNames.enabled || myNames.cohorts.length === 0) {
    return (
      <p className="text-muted-foreground" data-testid="atlas-cohort-reason">
        {myNames.reason}
      </p>
    );
  }
  const rows = myNames.cohorts;
  const floors = myNames.floors;
  const gapLines = WINDOWS.map((w) => myNames.spans[w]?.gapLine).filter((s): s is string => Boolean(s));
  const sparse = WINDOWS.map((w) => sparseHistoryLine(w, myNames.spans[w])).filter((s): s is string => s !== null);

  return (
    <div className="space-y-3" data-testid="atlas-cohorts">
      <p className="text-muted-foreground">
        Each open equity position against the <span className="text-foreground">median</span> return of its own
        cohort over the same window — its industry, falling up to its sector when the industry has fewer than{" "}
        {floors.minPriced} priced constituents or under {ppmToPct(floors.minCoveragePpm, 0)} of them priced. The
        difference is the part the cohort did not explain — not a claim about why, and not a verdict on the pick.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-left tabular-nums">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-medium">Symbol</th>
              <th className="py-1 pr-3 font-medium">Cohort (level used)</th>
              <th className="py-1 pr-3 font-medium">1w own</th>
              <th className="py-1 pr-3 font-medium">Cohort median</th>
              <th className="py-1 pr-3 font-medium">Diff</th>
              <th className="py-1 pr-3 font-medium">1m own</th>
              <th className="py-1 pr-3 font-medium">Cohort median</th>
              <th className="py-1 pr-3 font-medium">Diff</th>
              <th className="py-1 pr-3 font-medium">Rank in cohort (1m)</th>
              <th className="py-1 pr-3 font-medium">What the price did</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.symbol} className="border-t border-border/60" data-symbol={r.symbol} data-level={r.level ?? "none"}>
                <td className="py-1 pr-3 text-foreground">{r.symbol}</td>
                <td className="py-1 pr-3 text-muted-foreground">{levelCell(r)}</td>
                {WINDOWS.map((w) => {
                  const cw = r.windows[w];
                  const cohort = cw?.cohort ?? null;
                  return [
                    <td key={`${w}-own`} className="py-1 pr-3" title={cw?.ownExcluded ? `excluded: unreconciled price gap on ${cw.ownExcluded.date}` : undefined}>
                      {signedPct(cw?.own ?? null)}
                    </td>,
                    <td
                      key={`${w}-cohort`}
                      className="py-1 pr-3"
                      title={cohort ? `${fmtCount(cw.constituents)} of ${fmtCount(cw.members)} priced` : r.thinLine ?? undefined}
                    >
                      {signedPct(cohort?.value_ppm ?? null)}
                      {cohort ? <span className="text-muted-foreground"> ({fmtCount(cw.constituents)} of {fmtCount(cw.members)} priced)</span> : null}
                    </td>,
                    <td key={`${w}-diff`} className="py-1 pr-3">
                      {signedPct(cw?.diff ?? null)}
                    </td>,
                  ];
                })}
                <td className="py-1 pr-3 text-muted-foreground">{rankCell(r, "1m")}</td>
                <td className="py-1 pr-3 text-muted-foreground">{r.verdict}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {myNames.excludedSymbols.length > 0 ? (
        <p className="text-muted-foreground" data-testid="atlas-cohort-excluded">
          Held out for an unreconciled price gap inside a window: {myNames.excludedSymbols.join(", ")} — the same
          guard the rotation table applies, so both exclude the same set.
        </p>
      ) : null}
      {gapLines.length > 0 || sparse.length > 0 ? (
        <p className="tabular-nums text-muted-foreground">
          {[...gapLines, ...sparse].join(" · ")}. The store holds {fmtCount(myNames.sessions)} sessions in all.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The trades join (AQ52 Option B point 3, A7): breadth on the sessions these
 * positions were opened, from a stored same-spec market row or the payload's
 * price-only replay. The denominator is entry DAYS with a figure; a day outside
 * the replay is counted and named. Descriptive only.
 */
export function EntryDayBreadthCard({ view }: { view: EntryDayBreadthView }) {
  return (
    <div className="space-y-2" data-testid="atlas-entry-days">
      <div className="font-medium text-foreground">Breadth on the days you opened these positions</div>
      <ul className="space-y-1 text-muted-foreground">
        <li>
          <span className="text-foreground">Open positions:</span> {view.open.sentence}
        </li>
        <li>
          <span className="text-foreground">Closed winners:</span> {view.closedWinners.sentence}
        </li>
        <li>
          <span className="text-foreground">Closed losers:</span> {view.closedLosers.sentence}
        </li>
      </ul>
      <p className="text-muted-foreground">
        {view.source} Replay depth: {fmtCount(view.replaySessions)} sessions. A description of those days, not a
        rule for the next one.
      </p>
    </div>
  );
}
