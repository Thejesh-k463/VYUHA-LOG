import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { CopyVerb, EvidenceGrade } from "@/lib/analytics/edge-clinic";

/**
 * v4.7.0 C2 — the Clinic's two rendering primitives. The engine
 * (lib/analytics/edge-clinic.ts) GRADES every card and writes its copy; these
 * only render what it handed over. Nothing here compares a number to a bar or
 * picks a grade — a UI that re-graded would be a second, untested engine.
 *
 * Styling rule (design D6): the imperative treatment (accent rule, strong
 * headline) appears ONLY where the card's own `verb === "imperative"`; a "test"
 * or "none" card reads as plain information, however large its number.
 */

const GRADE_LABEL: Record<EvidenceGrade, string> = {
  insufficient: "Insufficient evidence",
  unclear: "Unclear",
  likely: "Likely",
  established: "Established",
};

// Neutral colours on purpose: a grade is the STRENGTH of evidence, not good or
// bad news — a loss-making cell can be "established". Profit/loss colours stay
// on money.
const GRADE_VARIANT: Record<EvidenceGrade, "secondary" | "outline" | "accent" | "default"> = {
  insufficient: "secondary",
  unclear: "outline",
  likely: "accent",
  established: "default",
};

export function GradeBadge({ grade }: { grade: EvidenceGrade }) {
  return (
    <Badge variant={GRADE_VARIANT[grade]} data-grade={grade}>
      {GRADE_LABEL[grade]}
    </Badge>
  );
}

/** One engine card's copy, rendered as given. */
export function ClinicCopyBlock({
  verb,
  headline,
  detail,
  provenanceLine,
  className,
}: {
  verb: CopyVerb;
  headline: string;
  detail?: string | null;
  provenanceLine?: string | null;
  className?: string;
}) {
  const imperative = verb === "imperative";
  return (
    <div data-verb={verb} className={cn("space-y-1", imperative && "border-l-2 border-accent pl-3", className)}>
      <p className={cn("text-sm", imperative ? "font-semibold text-foreground" : "text-foreground/90")}>{headline}</p>
      {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
      {provenanceLine ? <p className="text-[0.6875rem] text-muted-foreground">{provenanceLine}</p> : null}
    </div>
  );
}

/** "+0.42" / "−0.18" — an R figure with its sign; "—" when there is none (invariant 6). */
export function fmtR(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}`;
}

/**
 * How old a cached report is, in words ("12 min", "3 h", "2 days"). Pure: the
 * caller passes `now` (the server tab does, at request time) so a client render
 * never computes a clock-dependent string that hydration would disagree with.
 */
export function ageLabel(computedAt: string | null, now: number): string | null {
  if (!computedAt) return null;
  const t = Date.parse(computedAt);
  if (!Number.isFinite(t)) return null;
  const min = Math.max(0, Math.round((now - t) / 60_000));
  if (min < 1) return "under a minute";
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}
