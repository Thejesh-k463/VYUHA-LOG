import { Lock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NO_CHARTINK_LINE, NOT_ADVICE_LINE } from "@/lib/queries/atlas";

/**
 * The STATIC preview an unlicensed copy sees instead of the Atlas panel
 * (research answers Q55/Q57: the tab is locked, never hidden).
 *
 * Two rules decide everything about this file:
 *
 *  1. NO NUMBERS. Not one figure here is computed, and not one is invented
 *     either — the tiles show em-dashes and say why. A "sample" screen with
 *     plausible-looking breadth percentages would be a fabricated denominator
 *     on the one screen whose entire pitch is that every figure carries its
 *     own (AGENTS.md invariant 6), and a user who later saw different real
 *     numbers would be right to distrust both.
 *  2. NO DATABASE READ. It takes no props and calls nothing. The page decides
 *     Pro BEFORE loading, so a locked visitor never pays for a full-market
 *     recompute they cannot see.
 *
 * It is a server component: nothing here has state, and the sibling panel is
 * "use client" only because five tabs need a selected tab.
 *
 * v4.6.0 W5 (Atlas v3): the five entries below match the panel's TABS, in
 * order, and describe the v3 figures — the median as the group statistic, the
 * industry cohort, relative strength against the market median, and the list
 * of what Atlas does not compute.
 */

const TABS: { label: string; what: string }[] = [
  {
    label: "Market",
    what:
      "A named regime first, with its two voting inputs, its thresholds (editable in Settings) and the advancing " +
      "share beside them as a non-voting third tile; then your own names in one line, the sector relative-strength " +
      "leaders, the cap-band ladder in brief, and the breadth tiles — advancing / declining / unchanged with their " +
      "denominators, % above the 20/50/200-day averages with a 90-session spark each, new 52-week highs and lows, " +
      "RSI-14 extremes as counts, the advancing share of volume, and median volume expansion.",
  },
  {
    label: "Sectors",
    what:
      "One rotation table with a level toggle — the exchanges' 22 sectors by default, their 59 industries one click " +
      "away — and a statistic toggle: the median of each measurable member's own return ships, the equal-weighted " +
      "mean is the labelled alternative. Columns for 1 week, 1 month, 3 months and year-to-date, relative strength " +
      "against the market median, the change in rank, % above the 50-day average, new highs minus new lows, members " +
      "at a 52-week high and turnover share; leaders and laggards only from groups wide enough to rank, with the " +
      "hidden count stated. Labelled as the current classification, not a point-in-time one.",
  },
  {
    label: "Cap bands",
    what:
      "Large, mid and small by AMFI's half-yearly list (SEBI's ranking) rather than by a market cap Vyuha would " +
      "have to guess at — a ladder of breadth, RSI-14, rotation, % above the averages and new highs and lows per " +
      "band, NSE Emerge named as not ranked by AMFI, and Nifty size-index membership as a separate lens. Labelled as " +
      "the current classification, not a point-in-time one.",
  },
  {
    label: "My names",
    what:
      "Each open equity position against the median return of its own cohort — its industry, falling up to its " +
      "sector when the industry is too thin, the row saying which it used and on how many priced names — over 1 " +
      "week and 1 month, with its rank in that cohort, and a plain description of what the price did against the " +
      "group. Beside it: what market breadth read on the days you opened those positions, with the day count as " +
      "the denominator.",
  },
  {
    label: "Coverage",
    what:
      "The ledger: what was excluded and why, the denominator behind every metric, which symbols are stale, how " +
      "many sessions your 252-day window is missing, the history backfill that fills it — and the list of what Atlas " +
      "does not compute and the input each family waits behind.",
  },
];

export function AtlasPreview() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Lock className="size-4 text-accent" />
            Market Atlas — locked preview
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground">
          <p>
            This is what the screen shows with a Pro licence. Nothing below is computed on this copy and nothing
            below is a sample figure either — inventing numbers on the one screen whose whole promise is that
            every figure carries its denominator would be the wrong way to present it.
          </p>
          <p>
            Atlas reads only the end-of-day bhavcopy bars already stored on this machine. Switching it on adds no
            new server, no account and no upload.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {["Advancing", "Above SMA50", "New 52-week highs", "Median volume expansion"].map((label) => (
          <div key={label} className="rounded-md border border-dashed border-border bg-card/30 p-3">
            <div className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">{label}</div>
            <div className="mt-1 text-xl font-semibold tabular-nums text-muted-foreground">&mdash;</div>
            <div className="mt-1 text-[0.6875rem] text-muted-foreground">
              computed with a Pro licence, from your own stored bars
            </div>
          </div>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">The five tabs</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          {TABS.map((t) => (
            <div key={t.label}>
              <span className="font-medium text-foreground">{t.label}</span>{" "}
              <span className="text-muted-foreground">{t.what}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <p className="px-1 pb-2 text-[0.6875rem] leading-relaxed text-muted-foreground">
        {NO_CHARTINK_LINE} {NOT_ADVICE_LINE}
      </p>
    </div>
  );
}
