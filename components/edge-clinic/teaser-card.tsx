import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { plural } from "@/lib/format";
import type { ClinicTeaser } from "@/lib/analytics/edge-clinic-contract";
import { GradeBadge } from "./clinic-copy";

/**
 * v4.7.0 C2 — the ONE free card (owner ruling 2026-10-03 (d)): the whole-book
 * evidence grade and how many trades it still needs. Rendered for EVERY copy,
 * free and Pro, from `ClinicTeaser` alone — the only Clinic value a free copy's
 * payload carries (`clinicStateFor`). The headline is the engine's own copy of
 * the book cell, unchanged.
 */
export function ClinicTeaserCard({ teaser }: { teaser: ClinicTeaser | null }) {
  return (
    <Card data-clinic-teaser="">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Whole-book evidence {teaser ? <GradeBadge grade={teaser.grade} /> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {teaser ? (
          <>
            <p className="text-sm text-foreground/90">{teaser.headline}</p>
            <p className="text-xs text-muted-foreground">
              Read over {plural(teaser.closedTrades, "closed trade", "closed trades")}.
              {teaser.tradesStillNeeded != null
                ? ` About ${plural(teaser.tradesStillNeeded, "more trade", "more trades")} with an R before this grade can firm up.`
                : null}
            </p>
            <p className="text-[0.6875rem] text-muted-foreground">{teaser.provenanceLine}</p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">The Clinic has not read this book yet.</p>
        )}
        <p className="text-[0.6875rem] text-muted-foreground">
          A grade says how strong the evidence in your own record is — not what to trade.
        </p>
      </CardContent>
    </Card>
  );
}
