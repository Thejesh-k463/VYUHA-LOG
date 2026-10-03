import { ProGate } from "@/components/system/pro-gate";
import { ClinicRunner } from "@/components/edge-clinic/clinic-runner";
import { ClinicTeaserCard } from "@/components/edge-clinic/teaser-card";
import { ExperimentsList, WeeklyNoteCard } from "@/components/edge-clinic/weekly-note";
import { BehaviourCard, CellsGrid, FnoCutsCard, ReportFooter } from "@/components/edge-clinic/clinic-report";
import { ageLabel } from "@/components/edge-clinic/clinic-copy";
import type { ClinicState } from "@/lib/analytics/edge-clinic-contract";

/**
 * v4.7.0 C2 (design D6) — the Clinic tab, the Edge Clinic's default.
 *
 * It receives `state` ONLY from the hub page, already cut by `clinicStateFor`
 * with the entitlement's `pro` flag (the page does that): for a free copy the
 * report, the weekly note and the experiments are null/empty before they get
 * here, so they never enter its RSC payload. This file never reads the cache
 * and never runs the engine — the client runner asks the compute route when
 * the cache is stale or missing.
 *
 * Partial gating: the teaser card renders for everyone (it is the free part);
 * the rest sits inside the Pro gate, which shows the existing upsell to a free copy.
 */
export function ClinicTab({ state, now }: { state: ClinicState; /** Request time (ms), read by the page — a render stays pure. */ now: number }) {
  const staleAge = state.status === "stale" ? ageLabel(state.computedAt, now) : null;
  const { report, note } = state;
  return (
    <>
      <ClinicRunner status={state.status} digest={state.digest} staleAge={staleAge} />
      <ClinicTeaserCard teaser={state.teaser} />
      <ProGate>
        {note ? <WeeklyNoteCard note={note} canStartExperiment={state.canStartExperiment} /> : null}
        <ExperimentsList experiments={state.experiments} canStartExperiment={state.canStartExperiment} />
        {report ? (
          <>
            <CellsGrid report={report} />
            <FnoCutsCard fno={report.fno} />
            <BehaviourCard behaviour={report.behaviour} note={report.behaviourNote} />
            <ReportFooter report={report} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">The full report appears here once the Clinic has read your book.</p>
        )}
      </ProGate>
    </>
  );
}
