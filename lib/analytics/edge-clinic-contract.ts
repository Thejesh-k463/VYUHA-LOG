// The C2 seam (PURE: types, three constants and two reducers, no DB/React): what the server half
// (lib/queries/edge-clinic.ts, app/api/edge-clinic/*) hands the UI half
// (app/reports/edge-clinic/_tabs/clinic.tsx, components/edge-clinic/*, Arjun's
// Eye, the journal dialog). Both halves import from here; neither redefines a
// shape. Owner rulings 2026-10-03 (DECISIONS): setup grade A+/A/B optional;
// intra-trade high/low typed; the report cached per scope + input digest and
// computed OFF the page render; ONE free teaser card (the whole-book grade).

import type { ClinicReport, CopyVerb, EvidenceGrade } from "./edge-clinic";

/** The only setup grades a trade may carry (null = ungraded). */
export const SETUP_GRADES = ["A+", "A", "B"] as const;
export type SetupGrade = (typeof SETUP_GRADES)[number];

/** Trades an experiment runs for before it is checked (DECISIONS D-17). */
export const EXPERIMENT_TARGET_N = 20;

/** The free teaser — the whole-book cell ("all|all") reduced to what a free copy may see. */
export interface ClinicTeaser {
  grade: EvidenceGrade;
  /** The book cell's copy.headline, unchanged. */
  headline: string;
  /** null when the book cell is already past the minimum track record. */
  tradesStillNeeded: number | null;
  closedTrades: number;
  provenanceLine: string;
}

/** One line of the weekly note: a finding plus the ONE experiment it proposes. */
export interface WeeklyFinding {
  /** ClinicCell.key or `gap:<segment>|<GapCheck.id>`. */
  key: string;
  label: string;
  grade: EvidenceGrade;
  /** Rendered as given — the engine graded it; the UI never re-grades. */
  verb: CopyVerb;
  headline: string;
  detail: string;
  provenanceLine: string;
  /** The experiment this finding proposes, or null when one is already open on `key`. */
  experiment: { hypothesis: string; targetN: number } | null;
}

export interface WeeklyNote {
  /** ISO Monday of the report's asOf week. */
  weekOf: string;
  /** At most 3. */
  findings: WeeklyFinding[];
}

export type ExperimentStatus = "open" | "checked" | "abandoned";

export interface ClinicExperiment {
  id: number;
  accountId: number;
  cellKey: string;
  cellLabel: string;
  hypothesis: string;
  /** ISO date — the ONLY value stored at start. Baseline = the cell's R-bearing trades exiting ON OR BEFORE it
   *  (the start day is already seen); the experiment = the first targetN R-bearing trades exiting AFTER it. */
  startedAt: string;
  targetN: number;
  status: ExperimentStatus;
  /** R-bearing cell trades exiting after startedAt, counted so far (open) or at the check (checked). */
  progressN: number;
  /** Computed at read/check time from the SAME ClinicTrade[] as the result (one unit — a risk-cap reprice moves both). */
  baseline: { n: number; meanR: number | null; provenanceLine: string } | null;
  /** Filled when checked: mean R over the experiment's trades, its 95 % t-interval and its provenance line. */
  result: { n: number; meanR: number | null; lo: number | null; hi: number | null; provenanceLine: string } | null;
  checkedAt: string | null;
  /** Never "imperative" — one pre-registered comparison, not past the corrected bar. */
  verb: Exclude<CopyVerb, "imperative">;
  copy: { headline: string; detail: string } | null;
}

/**
 * What a page reads. NEVER computes: `missing` / `stale` tell the client runner
 * to POST /api/edge-clinic/compute and refresh. `report` on `stale` is the last
 * good report for this scope (shown with its computedAt), null on `missing`.
 */
export interface ClinicState {
  status: "fresh" | "stale" | "missing";
  /** `acct:<id>` (0 = the All-accounts VIEW — readable, never written to). */
  scopeKey: string;
  digest: string;
  computedAt: string | null;
  report: ClinicReport | null;
  teaser: ClinicTeaser | null;
  note: WeeklyNote | null;
  experiments: ClinicExperiment[];
  /** False in the All-accounts view: experiments are started per account only. */
  canStartExperiment: boolean;
}

/**
 * What a FREE copy may receive: the teaser and the status, nothing else — the full report, the note and the
 * experiments never enter its RSC payload (design review change 5). Pure; the page calls it with
 * `getEntitlement().pro` before handing state to any component.
 */
export function clinicStateFor(state: ClinicState, pro: boolean): ClinicState {
  if (pro) return state;
  return { ...state, report: null, note: null, experiments: [], canStartExperiment: false };
}

// ── Arjun's Eye's card (v4.8.0 P2) ──────────────────────────────────────────

/** The five fields of the weekly note's FIRST finding that the Arjun's Eye card prints — the engine's words, unchanged. */
export interface ClinicCardFinding {
  label: string;
  grade: EvidenceGrade;
  verb: CopyVerb;
  headline: string;
  provenanceLine: string;
}

/**
 * `clinic_cache.summary_json` (migration 0081): what the Arjun's Eye card needs of a cached report, written by the
 * compute NEXT TO that report and derived from it with the same `weeklyNote` / `teaser` the page read uses
 * (`clinicCardSummary` in edge-clinic-note.ts). A few hundred bytes, so the card never parses the report. It carries
 * its sibling's `computedAt` and the engine version, so a summary that is not this report's is never believed.
 * Nothing about experiments is in it: a finding's `experiment` depends on rows that change without a compute.
 */
export interface ClinicCardSummary {
  v: 1;
  engineVersion: string;
  computedAt: string;
  hasReport: true;
  finding: ClinicCardFinding | null;
  teaser: ClinicTeaser | null;
}

/** What the Arjun's Eye card reads. `hasReport` false + `teaser` null = the Clinic has not read this scope. */
export interface ClinicCard {
  hasReport: boolean;
  computedAt: string | null;
  finding: ClinicCardFinding | null;
  teaser: ClinicTeaser | null;
}

/** No cached report from this engine version for the scope. */
export const CLINIC_CARD_MISSING: ClinicCard = { hasReport: false, computedAt: null, finding: null, teaser: null };

/**
 * What a FREE copy's card may receive — the SAME cut `clinicStateFor` makes: the note's finding and the report's
 * presence are withheld (`note: null`, `report: null` there), the teaser and `computedAt` survive. Pure; the page
 * calls it with `getEntitlement().pro` before handing the card to the component.
 */
export function clinicCardFor(card: ClinicCard, pro: boolean): ClinicCard {
  if (pro) return card;
  return { ...card, hasReport: false, finding: null };
}

/** GET /api/edge-clinic/cell?tradeId= — the journal dialog's one line (Pro only, trade inside the selected scope; null otherwise). */
export interface TradeCellLine {
  key: string;
  label: string;
  grade: EvidenceGrade;
  nWithR: number;
  headline: string;
  computedAt: string;
}
