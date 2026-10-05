import { Badge } from "@/components/ui/badge";
import { LazyMount } from "@/components/ui/lazy-mount";
import { inr } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { EdgeDecay } from "@/lib/analytics/edge-clinic";
import type { RProvenanceCounts } from "@/lib/analytics/win-loss";
import { fmtR } from "./clinic-copy";
import { DecayChart } from "./decay-chart";
import { DECAY_CHART_HEIGHT } from "./decay-chart-height";

/**
 * v4.8.0 F1 — the decay card (owner-picked design "N1"): numbers first, then a
 * small chart. It sits in a cell's Detail directly under the engine's own decay
 * copy block and restates, as two figures, what that block says in a sentence.
 *
 * Every number is the engine's (`decay.usual`, `decay.recent`, `decay.trace` in
 * lib/analytics/edge-clinic.ts) and so is the claim: "alarmed" is
 * `decay.cusum.alarmIndex`, never a comparison made here. A quiet cell reads
 * "no drop detected" — what the CUSUM states — and nothing stronger.
 *
 * The rupee line is a restatement of R at ₹1,000 risked, so it exists only where
 * R is a multiple of a risk: every R in the cell from a stop or a typed risk. One
 * cap-unit row and the line is gone (invariant 6 — cap-unit R is P&L over a cap,
 * not over a risk; ₹1,000 "risked" would be a fabricated denominator).
 */

export interface DecayCardModel {
  alarmed: boolean;
  usualLabel: string;
  usualValue: string;
  recentLabel: string;
  recentValue: string;
  /** The recent figure takes the loss colour: alarmed AND below the usual figure. */
  recentIsLoss: boolean;
  chip: string;
  /** Null when any R in the cell is not a real risk — the line is then omitted entirely. */
  rupeeLine: string | null;
  note: string;
  ariaLabel: string;
}

/** ₹ for an R at ₹1,000 risked: whole rupees through the app's INR formatter, a negative as "−₹203". */
function rupeesPerThousand(r: number): string {
  const v = Math.round(r * 1000);
  return `${v < 0 ? "−" : ""}${inr(Math.abs(v), { decimals: 0 })}`;
}

/** Every R in the cell is a multiple of a real risk: none from the default cap, none unclassified. */
export function everyRIsARisk(p: RProvenanceCounts): boolean {
  return p.cap === 0 && p.unknown === 0 && p.plan + p.typed > 0;
}

/** Pure: the card's words and figures from the engine's decay block, the cell's R provenance and its R unit. */
export function decayCardModel(decay: EdgeDecay, provenance: RProvenanceCounts, rUnit: "R" | "cap"): DecayCardModel {
  const { usual, recent, window } = decay;
  const alarmed = decay.cusum.alarmIndex != null;
  // A cell whose every R is cap-unit is labelled the way the cells table labels it.
  const unit = rUnit === "cap" ? " cap" : "R";
  const usualValue = `${fmtR(usual.meanR)}${unit}`;
  const recentValue = `${fmtR(recent.meanR)}${unit}`;
  const diff = recent.meanR - usual.meanR;
  return {
    alarmed,
    usualLabel: `USUAL · first ${usual.n} trades`,
    usualValue,
    recentLabel: alarmed ? `RECENT · since trade ${recent.fromTrade}` : `RECENT · last ${recent.n} trades`,
    recentValue,
    recentIsLoss: alarmed && diff < 0,
    chip: alarmed ? `${fmtR(diff)}${unit} a trade` : "no drop detected",
    rupeeLine: everyRIsARisk(provenance)
      ? `For every ${inr(1000, { decimals: 0 })} risked: ${rupeesPerThousand(usual.meanR)} → ${rupeesPerThousand(recent.meanR)}`
      : null,
    note:
      rUnit === "cap"
        ? `Each point is the average of ${window} trades in a row. These figures are P&L in units of your per-trade cap, not of the risk you took.`
        : `Each point is the average of ${window} trades in a row. R = profit as a multiple of what you risked.`,
    ariaLabel: alarmed
      ? `Average of ${window} trades in a row, trade by trade. Usual ${usualValue} over the first ${usual.n} trades; recent ${recentValue} since trade ${recent.fromTrade}, where a possible drop was flagged.`
      : `Average of ${window} trades in a row, trade by trade. Usual ${usualValue} over the first ${usual.n} trades; recent ${recentValue} over the last ${recent.n} trades; no drop detected.`,
  };
}

function Figure({ label, value, loss, mark }: { label: string; value: string; loss?: boolean; mark: "usual" | "recent" }) {
  return (
    <div data-decay-figure={mark}>
      <p className="text-[0.625rem] tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("text-lg font-semibold tabular-nums", loss ? "text-loss" : "text-foreground")}>{value}</p>
    </div>
  );
}

export function DecayCard({ decay, provenance, rUnit }: { decay: EdgeDecay; provenance: RProvenanceCounts; rUnit: "R" | "cap" }) {
  const m = decayCardModel(decay, provenance, rUnit);
  return (
    <div data-clinic-decay-card="" data-alarmed={m.alarmed ? "true" : "false"} className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <Figure mark="usual" label={m.usualLabel} value={m.usualValue} />
        <span aria-hidden="true" className="pb-1 text-muted-foreground">
          →
        </span>
        <Figure mark="recent" label={m.recentLabel} value={m.recentValue} loss={m.recentIsLoss} />
        <Badge data-decay-chip="" variant={m.recentIsLoss ? "loss" : "secondary"} className="mb-1">
          {m.chip}
        </Badge>
      </div>
      {m.rupeeLine ? (
        <p data-decay-rupees="" className="text-xs tabular-nums text-foreground/90">
          {m.rupeeLine}
        </p>
      ) : null}
      {/* The figures above are real text; the chart is their picture, named for a screen reader.
          LazyMount: a closed Detail lays nothing out, so the chart is not built until it is opened. */}
      <div role="img" aria-label={m.ariaLabel} data-decay-chart="">
        <LazyMount minHeight={DECAY_CHART_HEIGHT}>
          <DecayChart trace={decay.trace} usualMean={decay.usual.meanR} splitAt={m.alarmed ? decay.recent.fromTrade : null} />
        </LazyMount>
      </div>
      <p className="text-[0.6875rem] text-muted-foreground">{m.note}</p>
    </div>
  );
}
