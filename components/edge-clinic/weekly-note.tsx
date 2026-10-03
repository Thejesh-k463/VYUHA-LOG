import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { fmtDate, plural } from "@/lib/format";
import type { ClinicExperiment, WeeklyNote } from "@/lib/analytics/edge-clinic-contract";
import { ClinicCopyBlock, GradeBadge, fmtR } from "./clinic-copy";
import { AbandonExperimentButton, StartExperimentButton } from "./experiment-actions";

/**
 * v4.7.0 C2 (design D5) — the weekly note: at most three findings, each the
 * engine's own card, with the ONE experiment it proposes. The note is derived
 * on every read from the cached report (`weeklyNote`); nothing about it is
 * stored, and nothing here ranks or filters it again.
 */
export function WeeklyNoteCard({ note, canStartExperiment }: { note: WeeklyNote; canStartExperiment: boolean }) {
  return (
    <Card data-clinic-note="">
      <CardHeader>
        <CardTitle>Week of {fmtDate(note.weekOf)}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {note.findings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing in your book is past the evidence bar this week — no finding is graded likely or established yet.
          </p>
        ) : (
          note.findings.map((f) => (
            <div key={f.key} className="space-y-2 border-b border-border pb-3 last:border-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-foreground">
                {f.label} <GradeBadge grade={f.grade} />
              </div>
              <ClinicCopyBlock verb={f.verb} headline={f.headline} detail={f.detail} provenanceLine={f.provenanceLine} />
              {f.experiment ? (
                <StartExperimentButton cellKey={f.key} hypothesis={f.experiment.hypothesis} canStart={canStartExperiment} />
              ) : null}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

const STATUS_VARIANT = { open: "accent", checked: "default", abandoned: "secondary" } as const;

/** The experiments list: progress n / targetN, the baseline and the result, each with its provenance line. */
export function ExperimentsList({ experiments, canStartExperiment }: { experiments: ClinicExperiment[]; canStartExperiment: boolean }) {
  if (experiments.length === 0) return null;
  return (
    <Card data-clinic-experiments="">
      <CardHeader>
        <CardTitle>Experiments</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {experiments.map((e) => (
          <div key={e.id} className="space-y-1.5 border-b border-border pb-3 text-xs last:border-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{e.cellLabel}</span>
              <Badge variant={STATUS_VARIANT[e.status]}>{e.status}</Badge>
              <span className="text-muted-foreground">
                {e.progressN} / {e.targetN} trades · started {fmtDate(e.startedAt)}
                {e.checkedAt ? ` · checked ${fmtDate(e.checkedAt)}` : null}
              </span>
              {e.status === "open" ? <AbandonExperimentButton id={e.id} disabled={!canStartExperiment} /> : null}
            </div>
            <p className="text-muted-foreground">{e.hypothesis}</p>
            {e.baseline ? (
              <p className="text-muted-foreground">
                <span className="text-foreground">Before:</span> {plural(e.baseline.n, "trade", "trades")}, mean {fmtR(e.baseline.meanR)} R — {e.baseline.provenanceLine}
              </p>
            ) : null}
            {e.result ? (
              <p className="text-muted-foreground">
                <span className="text-foreground">Experiment:</span> {plural(e.result.n, "trade", "trades")}, mean {fmtR(e.result.meanR)} R
                {e.result.lo != null && e.result.hi != null ? ` (95 % CI ${fmtR(e.result.lo)} to ${fmtR(e.result.hi)})` : null} — {e.result.provenanceLine}
              </p>
            ) : null}
            {e.copy ? <ClinicCopyBlock verb={e.verb} headline={e.copy.headline} detail={e.copy.detail} /> : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
