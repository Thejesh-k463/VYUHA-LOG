import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { SEGMENT_LABELS, type Segment } from "@/lib/domain/constants";
import { KELLY_MIN_N, type CellKind, type ClinicCell, type ClinicReport, type FnoCuts, type GapCheck, type SegmentBehaviour } from "@/lib/analytics/edge-clinic";
import { ClinicCopyBlock, GradeBadge, fmtR } from "./clinic-copy";
import { DecayCard } from "./decay-card";

/**
 * v4.7.0 C2 (design D6) — the full report, Pro only: the cells grid (book /
 * segment / setup / grade), the F&O cuts, the behaviour checks with the
 * engine's `behaviourNote`, the deflation line and the report's provenance
 * line. Every card renders the engine's `grade` / `verb` / `copy` as given —
 * nothing here grades, ranks or rewords a finding.
 */

const segLabel = (s: Segment | null) => (s ? SEGMENT_LABELS[s] ?? s : "");

const KIND_TITLE: Record<Exclude<CellKind, "fno">, string> = {
  book: "Whole book",
  segment: "By segment",
  setup: "By setup",
  grade: "By setup grade",
};

/** The cells' own sub-cards that carry copy — each rendered under its own verb. */
function CellDetail({ cell }: { cell: ClinicCell }) {
  const { decay } = cell;
  const extra = [cell.sizing, cell.ruleAdherence.check].filter(
    (x): x is NonNullable<typeof x> => x != null,
  );
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground">Detail</summary>
      <div className="mt-2 space-y-2">
        <ClinicCopyBlock verb="none" headline={cell.verdict} detail={cell.copy.detail} provenanceLine={cell.copy.provenanceLine} />
        {decay ? (
          <>
            <ClinicCopyBlock verb={decay.verb} headline={decay.copy.headline} detail={decay.copy.detail} provenanceLine={decay.copy.provenanceLine} />
            {/* v4.8.0 F1: the decay card — the engine's usual / recent figures and its trace, directly under its copy. */}
            <DecayCard decay={decay} provenance={cell.provenance} rUnit={cell.rUnit} />
          </>
        ) : null}
        {extra.map((x, i) => (
          <ClinicCopyBlock key={i} verb={x.verb} headline={x.copy.headline} detail={x.copy.detail} provenanceLine={x.copy.provenanceLine} />
        ))}
        {cell.sizing == null && cell.sizingSample ? (
          // C3 D8: why there is no sizing card — the sample, not an instruction.
          <p className="text-[0.6875rem] text-muted-foreground" data-clinic-sizing-sample="">
            Sizing: {cell.sizingSample.withRisk} of {cell.sizingSample.of} trades carry a real risk — {KELLY_MIN_N} needed.
          </p>
        ) : null}
      </div>
    </details>
  );
}

function CellRows({ cells }: { cells: readonly ClinicCell[] }) {
  return (
    <ReportTable>
      <ReportThead>
        <ReportTh>Cell</ReportTh>
        <ReportTh align="right">Trades</ReportTh>
        <ReportTh align="right">Mean</ReportTh>
        <ReportTh align="right">95 % CI</ReportTh>
        <ReportTh>Evidence</ReportTh>
        <ReportTh>Finding</ReportTh>
      </ReportThead>
      <tbody>
        {cells.map((c) => (
          <ReportTr key={c.key} data-cell-key={c.key}>
            <ReportTd className="font-medium">{c.label}</ReportTd>
            <ReportTd align="right">
              {c.n}
              <span className="text-muted-foreground"> · {c.nWithR} with R</span>
            </ReportTd>
            <ReportTd align="right">
              {fmtR(c.meanR)} {c.meanR != null ? (c.rUnit === "cap" ? "cap" : "R") : null}
            </ReportTd>
            <ReportTd align="right">{c.ci ? `${fmtR(c.ci.lo)} to ${fmtR(c.ci.hi)}` : "—"}</ReportTd>
            <ReportTd>
              <GradeBadge grade={c.grade} />
            </ReportTd>
            <ReportTd className="max-w-[28rem] whitespace-normal">
              <ClinicCopyBlock verb={c.verb} headline={c.copy.headline} />
              <CellDetail cell={c} />
            </ReportTd>
          </ReportTr>
        ))}
      </tbody>
    </ReportTable>
  );
}

export function CellsGrid({ report }: { report: ClinicReport }) {
  const kinds = ["book", "segment", "setup", "grade"] as const;
  return (
    <Card className="p-0" data-clinic-cells="">
      <CardHeader>
        <CardTitle>Cells</CardTitle>
        <p className="text-[0.6875rem] text-muted-foreground">
          {report.closedTrades} closed trades{report.openExcluded ? `, ${report.openExcluded} open left out` : ""}. {report.m} cells
          have at least {report.params.minN} trades with an R and are tested together, corrected for multiple comparisons (
          {report.multiplicity.method}, q = {report.multiplicity.q}).
        </p>
      </CardHeader>
      <CardContent className="space-y-4 p-0">
        {kinds.map((k) => {
          const cells = report.cells.filter((c) => c.kind === k);
          if (cells.length === 0) return null;
          return (
            <section key={k} className="space-y-1">
              <h3 className="px-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">{KIND_TITLE[k]}</h3>
              <CellRows cells={cells} />
            </section>
          );
        })}
      </CardContent>
    </Card>
  );
}

function FnoBlock({ f }: { f: FnoCuts }) {
  const groups: [string, readonly ClinicCell[] | null][] = [
    ["Days to expiry", f.dte],
    ["Buyer vs seller", f.side],
    ["Lots", f.lots],
    ["Expiry regime", f.expiryRegime],
  ];
  return (
    <section className="space-y-2">
      <h3 className="px-4 text-sm font-medium">{segLabel(f.segment)}</h3>
      {groups.map(([title, cells]) =>
        cells && cells.length ? (
          <div key={title} className="space-y-1">
            <h4 className="px-4 text-xs uppercase tracking-wide text-muted-foreground">{title}</h4>
            <CellRows cells={cells} />
          </div>
        ) : null,
      )}
      <p className="px-4 text-[0.6875rem] text-muted-foreground">
        {f.unknownDte ? `${f.unknownDte} trades with no readable expiry are left out of the expiry cuts. ` : ""}
        {f.unknownLots ? `${f.unknownLots} trades with no lot size are left out of the lot cut. ` : ""}
        {f.oneLotOverCap != null && f.oneLotOverCap > 0 ? `${f.oneLotOverCap} one-lot trades risked more than your per-trade cap.` : ""}
      </p>
    </section>
  );
}

export function FnoCutsCard({ fno }: { fno: readonly FnoCuts[] }) {
  if (fno.length === 0) return null;
  return (
    <Card className="p-0" data-clinic-fno="">
      <CardHeader>
        <CardTitle>F&amp;O cuts</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 p-0 pb-4">
        {fno.map((f) => (
          <FnoBlock key={f.segment} f={f} />
        ))}
      </CardContent>
    </Card>
  );
}

function GapRow({ g }: { g: GapCheck }) {
  return (
    <div className="space-y-1 border-b border-border pb-2 last:border-0">
      <div className="flex flex-wrap items-center gap-2 text-xs font-medium">
        {g.title} <GradeBadge grade={g.grade} />
        <span className="font-normal text-muted-foreground">
          {g.arms.map((a) => `${a.label}: ${a.n}`).join(" · ")}
          {g.coverage ? ` · ${g.coverage.withData} of ${g.coverage.of} rows readable` : ""}
        </span>
      </div>
      <ClinicCopyBlock verb={g.verb} headline={g.copy.headline} detail={g.copy.detail} provenanceLine={g.copy.provenanceLine} />
    </div>
  );
}

export function BehaviourCard({ behaviour, note }: { behaviour: readonly SegmentBehaviour[]; note: string }) {
  if (behaviour.length === 0) return null;
  return (
    <Card data-clinic-behaviour="">
      <CardHeader>
        <CardTitle>Behaviour checks</CardTitle>
        <p className="text-[0.6875rem] text-muted-foreground">{note}</p>
      </CardHeader>
      <CardContent className="space-y-5">
        {behaviour.map((b) => (
          <section key={b.segment} className="space-y-2">
            <h3 className="text-sm font-medium">{segLabel(b.segment)}</h3>
            {b.checks.map((g) => (
              <GapRow key={g.id} g={g} />
            ))}
            <ClinicCopyBlock verb={b.hold.verb} headline={b.hold.copy.headline} detail={b.hold.copy.detail} provenanceLine={b.hold.copy.provenanceLine} />
          </section>
        ))}
      </CardContent>
    </Card>
  );
}

/** The deflation line (the best cell against luck across m trials) and the report's provenance line. */
export function ReportFooter({ report }: { report: ClinicReport }) {
  return (
    <div className="space-y-2 text-xs text-muted-foreground" data-clinic-footer="">
      {report.deflation ? (
        <ClinicCopyBlock
          verb="none"
          headline={report.deflation.copy.headline}
          detail={report.deflation.copy.detail}
          provenanceLine={report.deflation.copy.provenanceLine}
        />
      ) : null}
      <p className="text-[0.6875rem]">{report.provenanceLine}</p>
    </div>
  );
}
