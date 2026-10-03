import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { hubForHref, hubTabHref } from "@/lib/domain/hubs";
import type { ClinicState } from "@/lib/analytics/edge-clinic-contract";
import { ClinicCopyBlock, GradeBadge } from "./clinic-copy";

const CLINIC_HREF = hubTabHref(hubForHref("/reports/edge-clinic")!, "clinic");

/**
 * v4.7.0 C2 (design D6) — Arjun's Eye's small Clinic card. It reads the CACHED
 * state only (fresh or stale report → the weekly note's first finding; missing
 * → a link to the Clinic, which computes). It never runs the engine, and it
 * renders the finding's own grade / verb / copy unchanged.
 */
export function ArjunClinicCard({ state }: { state: ClinicState }) {
  const first = state.note?.findings[0] ?? null;
  return (
    <Card data-arjun-clinic="">
      <CardContent className="space-y-2 p-4 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">Edge Clinic</span>
          {first ? <GradeBadge grade={first.grade} /> : null}
          {first ? <span className="text-muted-foreground">{first.label}</span> : null}
        </div>
        {first ? (
          <ClinicCopyBlock verb={first.verb} headline={first.headline} provenanceLine={first.provenanceLine} />
        ) : state.report ? (
          <p className="text-muted-foreground">No finding in your book is past the evidence bar this week.</p>
        ) : state.teaser ? (
          // Seam D3: a free copy's state carries the teaser but no report — the book HAS been read.
          <p className="text-muted-foreground">{state.teaser.headline}</p>
        ) : (
          <p className="text-muted-foreground">The Clinic has not read this book yet.</p>
        )}
        <Link href={CLINIC_HREF} className="text-accent underline-offset-2 hover:underline">
          Open the Clinic
        </Link>
      </CardContent>
    </Card>
  );
}
