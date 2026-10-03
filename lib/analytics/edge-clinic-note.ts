/**
 * EDGE CLINIC — the weekly note, the free teaser and the experiment check
 * (PURE: no DB, no React, no server-only). v4.7.0 wave C2, design D5 + the
 * review's change 4.
 *
 * Everything here is DERIVED from a ClinicReport (or, for an experiment, from the
 * same ClinicTrade[] the report was computed over) on every read — nothing is
 * stored but an experiment's `startedAt`. The UI renders `verb` and `copy` as
 * given and never re-grades.
 *
 * Copy rules (invariant 6 and owner ruling C2): no counterfactual rupee figure
 * and no counterfactual phrasing anywhere — gaps between arms of the user's own
 * book, in R; an experiment is ONE pre-registered comparison, so its verb is
 * never "imperative".
 */
import {
  cellTrades,
  dayOf,
  type ClinicCell,
  type ClinicReport,
  type ClinicTrade,
  type GapCheck,
} from "@/lib/analytics/edge-clinic";
import { meanInterval } from "@/lib/analytics/inference";
import { provenanceRowOf, rProvenanceCounts, rProvenanceLine } from "@/lib/analytics/win-loss";
import { exitDateOf } from "@/lib/domain/side";
import {
  EXPERIMENT_TARGET_N,
  type ClinicExperiment,
  type ClinicTeaser,
  type ExperimentStatus,
  type WeeklyFinding,
  type WeeklyNote,
} from "@/lib/analytics/edge-clinic-contract";

/** At most this many findings in one weekly note. */
export const WEEKLY_NOTE_CAP = 3;

const fmtR = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}`;
const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);

/** ISO Monday of the week holding `iso` (UTC calendar arithmetic on a date, no clock). */
export function isoMonday(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  if (!Number.isFinite(t)) return iso.slice(0, 10);
  const dow = new Date(t).getUTCDay(); // 0 = Sunday
  const back = (dow + 6) % 7;
  return new Date(t - back * 86_400_000).toISOString().slice(0, 10);
}

/** Every cell the report shows — the grid and the F&O cuts — in report order. */
export function allCells(report: ClinicReport): ClinicCell[] {
  const out = [...report.cells];
  for (const f of report.fno) out.push(...f.dte, ...(f.side ?? []), ...f.lots, ...f.expiryRegime);
  return out;
}

/** The cell with this key anywhere in the report, else null. */
export function findCell(report: ClinicReport, key: string): ClinicCell | null {
  return allCells(report).find((c) => c.key === key) ?? null;
}

/**
 * The ONE experiment a cell proposes: its next EXPERIMENT_TARGET_N R-bearing trades,
 * read against the cell's own record before the start. Null when the cell has no
 * graded mean to state a direction from.
 */
export function proposalFor(cell: ClinicCell): { hypothesis: string; targetN: number } | null {
  if (cell.grade === "insufficient" || !fin(cell.meanR)) return null;
  const dir = cell.meanR >= 0 ? "above" : "below";
  return {
    hypothesis: `${cell.label}: the next ${EXPERIMENT_TARGET_N} trades closed from tomorrow average ${dir} 0 R, as the ${cell.nWithR} before them did (${fmtR(cell.meanR)} R).`,
    targetN: EXPERIMENT_TARGET_N,
  };
}

// ── The weekly note ─────────────────────────────────────────────────────────

interface Candidate {
  finding: WeeklyFinding;
  rank: number; // 1 = established, 0 = likely
  weight: number; // |meanR or gap| × √n
}

function gapCandidate(key: string, label: string, g: GapCheck): Candidate | null {
  if (g.grade !== "likely" || !fin(g.gap)) return null;
  const n = g.arms[0].n + g.arms[g.arms.length - 1].n;
  return {
    finding: {
      key,
      label,
      grade: g.grade,
      verb: g.verb,
      headline: g.copy.headline,
      detail: g.copy.detail,
      provenanceLine: g.copy.provenanceLine,
      // A gap is a behaviour, not a cell: there is no cell to run an experiment on
      // (review change 4) — the gap card's own copy states its test.
      experiment: null,
    },
    rank: 0,
    weight: Math.abs(g.gap) * Math.sqrt(n),
  };
}

/**
 * Up to three findings: cells graded likely / established and gap checks graded
 * likely (gap checks are never established — they are not corrected). Established
 * first, then |mean R or gap| × √n, descending; ties by key. A finding whose key has
 * an OPEN experiment still shows, with `experiment: null`.
 */
export function weeklyNote(report: ClinicReport, openExperimentKeys: ReadonlySet<string> | readonly string[]): WeeklyNote {
  const open = new Set(openExperimentKeys);
  const cands: Candidate[] = [];
  for (const c of allCells(report)) {
    if (c.grade !== "likely" && c.grade !== "established") continue;
    if (!fin(c.meanR)) continue;
    cands.push({
      finding: {
        key: c.key,
        label: c.label,
        grade: c.grade,
        verb: c.verb,
        headline: c.copy.headline,
        detail: c.copy.detail,
        provenanceLine: c.copy.provenanceLine,
        experiment: open.has(c.key) ? null : proposalFor(c),
      },
      rank: c.grade === "established" ? 1 : 0,
      weight: Math.abs(c.meanR) * Math.sqrt(c.nWithR),
    });
  }
  for (const b of report.behaviour) {
    for (const g of b.checks) {
      const cand = gapCandidate(`gap:${b.segment}|${g.id}`, g.title, g);
      if (cand) cands.push(cand);
    }
  }
  // Rule adherence lives on cells; the book's and each segment's are findings
  // (a setup's would repeat its segment's), keyed `gap:all|…` / `gap:<seg>|…`.
  for (const c of report.cells) {
    if (c.kind !== "book" && c.kind !== "segment") continue;
    const g = c.ruleAdherence.check;
    if (!g) continue;
    const cand = gapCandidate(`gap:${c.segment ?? "all"}|${g.id}`, `${g.title} · ${c.label}`, g);
    if (cand) cands.push(cand);
  }
  cands.sort((a, b) => b.rank - a.rank || b.weight - a.weight || a.finding.key.localeCompare(b.finding.key));
  return { weekOf: isoMonday(report.asOf), findings: cands.slice(0, WEEKLY_NOTE_CAP).map((c) => c.finding) };
}

// ── The free teaser ─────────────────────────────────────────────────────────

/**
 * The ONE free card (owner ruling 2026-10-03 (d)): the whole-book grade and how many
 * trades it still needs. `tradesStillNeeded`: below the minimum sample, the count to
 * reach it; past it, the MinTRL shortfall when one exists and is positive; else null.
 */
export function teaser(report: ClinicReport): ClinicTeaser | null {
  const book = report.cells.find((c) => c.key === "all|all");
  if (!book) return null;
  const minN = report.params.minN;
  const still =
    book.nWithR < minN ? minN - book.nWithR : book.tradesStillNeeded != null && book.tradesStillNeeded > 0 ? book.tradesStillNeeded : null;
  return {
    grade: book.grade,
    headline: book.copy.headline,
    tradesStillNeeded: still,
    closedTrades: report.closedTrades,
    provenanceLine: book.copy.provenanceLine,
  };
}

// ── Experiments ─────────────────────────────────────────────────────────────

/** The stored row an experiment check reads (`clinic_experiments`). */
export interface StoredExperiment {
  id: number;
  accountId: number;
  cellKey: string;
  cellLabel: string;
  hypothesis: string;
  startedAt: string;
  targetN: number;
  status: ExperimentStatus;
  checkedAt: string | null;
}

/** The ISO day a closed trade CLOSED on (a short closes on its buy-back), else null. */
function exitDay(t: ClinicTrade): string | null {
  return dayOf(exitDateOf(t));
}

const provLineOf = (ts: ClinicTrade[]) => rProvenanceLine(rProvenanceCounts(ts.map(provenanceRowOf)));

/**
 * Baseline and result of one experiment, from ONE ClinicTrade[] (review change 4):
 *   baseline = the cell's R-bearing trades exiting ON OR BEFORE startedAt (the
 *              start day is already seen — seam D2: an experiment started at
 *              15:00 must not count the trade that closed at 10:00 that day);
 *   result   = the first targetN R-bearing trades exiting AFTER it, in the
 *              engine's chronological order — so a risk-cap reprice moves both.
 * `trades` must be the experiment's OWN account's book (review change 3), never the
 * view's. Status: an `abandoned` row stays abandoned; an `open` one whose progress
 * reached targetN reads `checked` (checkedAt = the stored one, else `today`).
 */
export function checkExperiment(trades: readonly ClinicTrade[], exp: StoredExperiment, today: string): ClinicExperiment {
  const inCell = cellTrades(trades, exp.cellKey).filter((t) => fin(t.rMultiple));
  const before: ClinicTrade[] = [];
  const after: ClinicTrade[] = [];
  for (const t of inCell) {
    const d = exitDay(t);
    if (d == null) continue;
    (d <= exp.startedAt ? before : after).push(t);
  }
  const progressN = after.length;
  const reached = progressN >= exp.targetN;
  const status: ExperimentStatus = exp.status === "abandoned" ? "abandoned" : exp.status === "checked" || reached ? "checked" : "open";
  const checkedAt = status === "checked" ? (exp.checkedAt ?? today) : exp.checkedAt;

  const baselineRs = before.map((t) => t.rMultiple as number);
  const baseline = {
    n: before.length,
    meanR: baselineRs.length ? baselineRs.reduce((s, x) => s + x, 0) / baselineRs.length : null,
    provenanceLine: provLineOf(before),
  };

  let result: ClinicExperiment["result"] = null;
  if (status === "checked" && progressN > 0) {
    const ran = after.slice(0, exp.targetN);
    const ci = meanInterval(ran.map((t) => t.rMultiple as number));
    result = {
      n: ran.length,
      meanR: fin(ci.point) ? ci.point : null,
      lo: fin(ci.lo) ? ci.lo : null,
      hi: fin(ci.hi) ? ci.hi : null,
      provenanceLine: provLineOf(ran),
    };
  }

  const baseLine =
    baseline.meanR != null
      ? `Before ${exp.startedAt}: ${fmtR(baseline.meanR)} R per trade over ${baseline.n} (${baseline.provenanceLine || "no R provenance"}).`
      : `Before ${exp.startedAt}: no R-bearing trades in this cell.`;
  let verb: ClinicExperiment["verb"];
  let copy: ClinicExperiment["copy"];
  if (status === "abandoned") {
    verb = "none";
    copy = { headline: `${exp.cellLabel}: experiment set aside after ${progressN} of ${exp.targetN} trades`, detail: `${exp.hypothesis} ${baseLine}` };
  } else if (status === "open") {
    verb = "test";
    copy = {
      headline: `${exp.cellLabel}: ${progressN} of ${exp.targetN} trades since ${exp.startedAt}`,
      detail: `${exp.hypothesis} ${baseLine}`,
    };
  } else {
    verb = "test";
    const r = result;
    const holds =
      r && r.lo != null && r.hi != null
        ? r.lo > 0
          ? "its 95 % interval sits above 0 R"
          : r.hi < 0
            ? "its 95 % interval sits below 0 R"
            : "its 95 % interval spans 0 R"
        : "too few trades for an interval";
    const line =
      r && r.meanR != null
        ? `${fmtR(r.meanR)} R per trade over the first ${r.n} trades from ${exp.startedAt}${r.lo != null && r.hi != null ? ` (95 % CI ${fmtR(r.lo)} to ${fmtR(r.hi)})` : ""} (${r.provenanceLine || "no R provenance"}).`
        : "";
    copy = {
      headline: `${exp.cellLabel}: experiment checked — ${holds}`,
      detail: `${line} ${baseLine} One pre-registered comparison: not corrected for the Clinic's other cells.`.trim(),
    };
  }

  return {
    id: exp.id,
    accountId: exp.accountId,
    cellKey: exp.cellKey,
    cellLabel: exp.cellLabel,
    hypothesis: exp.hypothesis,
    startedAt: exp.startedAt,
    targetN: exp.targetN,
    status,
    progressN,
    baseline,
    result,
    checkedAt,
    verb,
    copy,
  };
}

