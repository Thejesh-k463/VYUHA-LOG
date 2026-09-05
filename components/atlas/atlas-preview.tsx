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
 *     own (AGENTS.md invariant 6), and a buyer who later saw different real
 *     numbers would be right to distrust both.
 *  2. NO DATABASE READ. It takes no props and calls nothing. The page decides
 *     Pro BEFORE loading, so a locked visitor never pays for a full-market
 *     recompute they cannot see.
 *
 * It is a server component: nothing here has state, and the sibling panel is
 * "use client" only because five tabs need a selected tab.
 */

const TABS: { label: string; what: string }[] = [
  {
    label: "Market",
    what:
      "Advancing, declining and unchanged with their denominators; % above the 20/50/200-day averages with a " +
      "90-session spark for each; new highs and lows over the 52-week window; median volume expansion and the " +
      "names furthest above their own 20-session baseline. A named regime sits on top of the first two, with " +
      "its thresholds and its arithmetic printed beside it.",
  },
  {
    label: "Sectors",
    what:
      "Every sector's equal-weighted move and its internal breadth over the same window, with how many of its " +
      "members were actually measurable — and the symbols that carry no sector counted nowhere rather than " +
      "swept into an “Other” bucket.",
  },
  {
    label: "Cap bands",
    what:
      "Large, mid, small and micro, bucketed by NSE's own index membership rather than by a market cap Vyuha " +
      "would have to guess at. Labelled as the current classification, not a point-in-time one.",
  },
  {
    label: "My names",
    what:
      "Each open equity position against the equal-weighted return of its own sector cohort over 1 week and 1 " +
      "month, and the difference between them — the first honest answer to “was that the pick, or the sector?”.",
  },
  {
    label: "Coverage",
    what:
      "The ledger: what was excluded and why, the denominator behind every metric, which symbols are stale, and " +
      "the one-time history backfill that fills the window the deeper metrics need.",
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
            every figure carries its denominator would be the wrong way to sell it.
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
