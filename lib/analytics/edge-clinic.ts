/**
 * EDGE CLINIC — the report builder (PURE: no DB, no React, no server-only).
 *
 * v4.7.0 wave C1. `edgeClinic(trades, opts)` turns a book of closed trades into
 * graded evidence: per cell (whole book, each segment, each setup within a
 * segment, and the F&O cuts) the mean R with its interval, the per-trade
 * Sharpe with PSR / MinTRL, the cost drag, the win-rate × payoff split, edge
 * decay, a sizing ceiling, and the behaviour checks per segment.
 *
 * Formulas: lib/analytics/edge-clinic-stats.ts, pinned against
 * VYUHA/LIVE-DESK-RESEARCH/22-V460-BUILD/research/R1F-BAILEY-LDP-FORMULAS-2026-10-01.md.
 *
 * The rules this module encodes:
 *  - EVIDENCE GRADES, exactly one per card: insufficient (n < minN) · unclear
 *    (CI spans 0) · likely (CI excludes 0 but fails multiplicity) · established
 *    (CI excludes 0 AND survives Benjamini–Yekutieli over ALL m tested cells).
 *    BY, not BH: the cells overlap (the book and a segment share every row of
 *    that segment), which is exactly the arbitrary dependence BY is valid under.
 *  - Only `established` carries an imperative (owner ruling C2, "graded by
 *    evidence"); likely/unclear get a bounded experiment; insufficient gets "—".
 *  - Prescriptions state GAPS between arms of the user's own book, in R — never
 *    a counterfactual rupee figure (invariant 6: anything underivable is null).
 *  - Closed trades only. Money arrives in rupees (invariant 1) and is never
 *    converted here.
 *  - The sizing ceiling (Kelly) reads ONE sample, `kellySample()`: closed rows
 *    with a finite R whose denominator is a REAL risk (a stop or a typed risk —
 *    never `risk_source = 'cap'`, which is P&L in cap units, not a risk), and a
 *    known cost basis. Floor: `KELLY_MIN_N` = 30 trades in that sample (owner
 *    ruling Q-7, applied to the Clinic by C3 K2 — it was 50 in C1). The Sizing
 *    Lab's journal Kelly (lib/analytics/journal-kelly.ts) calls the same
 *    `kellyCeiling` over the same sample: one Kelly, one sample.
 */
import { benjaminiYekutieli, meanInterval, tQuantile95, wilsonInterval, type Interval } from "@/lib/analytics/inference";
import {
  EMPTY_R_PROVENANCE,
  provenanceRowOf,
  rProvenance,
  rProvenanceCounts,
  rProvenanceLine,
  type RProvenanceCounts,
} from "@/lib/analytics/win-loss";
import { PLAYBOOK_RULE_PREFIX } from "@/lib/analytics/behavior";
import { DTE_BANDS } from "@/lib/analytics/options-seller-depth";
import { isFnoSegment } from "@/lib/analytics/sebi-reality";
import { sideOf } from "@/lib/domain/side";
import { SEGMENT_LABELS, type Segment } from "@/lib/domain/constants";
import * as S from "@/lib/analytics/edge-clinic-stats";
import { SETUP_GRADES, type SetupGrade } from "@/lib/analytics/edge-clinic-contract";

/**
 * The engine's version, folded into every cache digest (lib/queries/edge-clinic.ts):
 * a cached report computed by another version is never served as fresh. BUMP IT on any
 * change to what `edgeClinic` returns for the same input — tests/edge-clinic-db.test.ts
 * pins a golden-report hash beside this string, so an output change without a bump fails.
 *   c1   v4.7.0 wave C1 (no cache existed)
 *   c2.1 v4.7.0 wave C2 — grade cells (`all|grade:<g>`), setup keys `${seg}|setup:${tag}`
 *   c2.2 v4.7.0 wave C2 seam D1 — a playbook-journaled row with NULL ruleViolations is rule data ("kept every rule")
 *   c3.0 v4.7.0 wave C3 — sizing over `kellySample()` (no cap-unit R, no basis-less sale), floor 50 → 30,
 *        `sizingSample` on every cell, `n` on the sizing card, the sizing provenance line names the sample
 *   c3.1 v4.7.0 audit fix wave (owner Q3, review R4, CG-1) — the sizing ceiling is PER 1R
 *        (½ Kelly at the lower bounds / L̄ at its upper bound, capped at ½ empirical Kelly), `lossHi`
 *        on the sizing card, an off-grid empirical Kelly / fc is null, the refusal names its reason
 */
export const ENGINE_VERSION = "c3.1";

/** Finance (No. 2) Act 2024 STT step for F&O — must equal `STT_EPOCH_2024` in lib/db/seed-data.ts (a test pins it). */
export const FNO_STT_EPOCH = "2024-10-01";
/** SEBI's one-weekly-expiry-per-exchange date: the F&O regime cut. */
export const FNO_WEEKLY_EXPIRY_CUT = "2024-11-20";

/** Moments (g3, g4, PSR, MinTRL) need at least this many R values (paper p.11, CLT "in excess of 30"). */
export const MOMENTS_MIN_N = 30;
/** A MinTRL above this is shown capped — it says "far away", not a count to plan around. */
export const MIN_TRL_DISPLAY_CAP = 1000;
/** The streak horizon of the sizing card. */
export const STREAK_HORIZON = 200;
/** The bounded experiment's length. */
export const EXPERIMENT_TRADES = 20;
/**
 * The Kelly floor: trades in `kellySample()` a sizing figure needs. Owner ruling
 * Q-7 ("journal-derived Kelly at >= 30 closed trades"), applied to the Clinic's
 * sizing card AND the Sizing Lab by C3 K2 — C1's session value of 50 lost to it.
 * It is an anti-embarrassment floor ("so no one Kellys off six trades"), not a
 * power calculation; the lower 95 % bounds carry the uncertainty above it.
 */
export const KELLY_MIN_N = 30;
/** The engine's default bootstrap seed — the Lab's journal Kelly uses it too, so the two agree to the bit. */
export const CLINIC_SEED = 20261001;

// ── Input ───────────────────────────────────────────────────────────────────

/**
 * The slice of a `trades` row the clinic reads — every field maps 1:1 from
 * lib/db/schema.ts (money already in rupees). `side` is never read directly:
 * direction goes through `sideOf`.
 */
export interface ClinicTrade {
  id: number;
  segment: Segment;
  buyQty: number;
  sellQty: number;
  side?: string | null;
  buyDate: string | null;
  sellDate: string | null;
  entryTime: string | null;
  exitTime: string | null;
  isOpen: boolean;
  grossPnl: number;
  chargesTotal: number;
  netPnl: number;
  rMultiple: number | null;
  riskAmount: number | null;
  /** 'cap' | 'set' | 'frozen' | null */
  riskSource: string | null;
  rPlan?: boolean;
  slPlanned: number | null;
  trailingSl: number | null;
  avgBuyPrice: number;
  avgSellPrice: number;
  setupTag: string | null;
  /** v4.7.0 C2: the trader's own A+ / A / B grade; absent or null = ungraded (never a grade cell). */
  setupGrade?: SetupGrade | null;
  ruleViolations: string[] | null;
  /**
   * v4.7.0 C2 (seam D1): the playbook a journal save assigned. Its ONLY writer is
   * app/api/trades/journal/route.ts, which stores NULL ruleViolations when every
   * rule was kept — so a row with a playbookId is rule data even when
   * ruleViolations is null. Absent = treated as null.
   */
  playbookId?: number | null;
  entryDte: number | null;
  lotSize: number | null;
  importNotes?: string | null;
}

export interface ClinicOptions {
  /** ISO date the report is computed on. */
  today: string;
  minN?: number;
  minArm?: number;
  minKelly?: number;
  window?: number;
  q?: number;
  seed?: number;
  /** The per-trade risk cap in rupees, for `oneLotOverCap`. */
  riskCapRupees?: number | null;
  /** Current risk per trade in PERCENT of capital (1 = 1 %), for `growthAtCurrent`. */
  currentRiskPct?: number | null;
}

// ── Output ──────────────────────────────────────────────────────────────────

export type EvidenceGrade = "insufficient" | "unclear" | "likely" | "established";
export const EVIDENCE_GRADES: readonly EvidenceGrade[] = ["insufficient", "unclear", "likely", "established"];
export type CopyVerb = "imperative" | "test" | "none";

export interface ClinicCopy {
  headline: string;
  detail: string;
  provenanceLine: string;
}

export interface CostDrag {
  grossMean: number | null;
  netMean: number | null;
  costPerTrade: number | null;
  /** Σ charges / Σ gross of the gross-winning trades; null when nothing won gross. */
  costShareOfGrossWins: number | null;
  /** mean(charges / riskAmount) over rows with a known risk, when ≥ minN carry one. */
  costInR: number | null;
  /** Rows the costInR mean is over. */
  costInRN: number;
}

export interface HalfStats {
  n: number;
  p: number;
  meanWin: number;
  meanLoss: number;
  expectancy: number;
}

export interface ExpectancyShift {
  prev: HalfStats;
  curr: HalfStats;
  /** curr.expectancy − prev.expectancy, computed directly. */
  total: number;
  /** Δp·(W̄m + L̄m) */
  fromWinRate: number;
  /** p̄·ΔW̄ */
  fromWinners: number;
  /** −(1 − p̄)·ΔL̄ */
  fromLosers: number;
}

export interface WinRatePayoff {
  /** Win rate (R > 0) with its Wilson interval. */
  p: Interval;
  meanWin: number | null;
  /** Positive magnitude of the mean non-winning R (R ≤ 0). */
  meanLoss: number | null;
  b: number | null;
  breakevenP: number | null;
  /** The win rate's UPPER bound sits below breakeven at this payoff. */
  winRateProblem: boolean | null;
  deltaE: ExpectancyShift | null;
}

export interface GapArm {
  label: string;
  n: number;
  mean: number | null;
}

export interface GapCheck {
  id: "after-loss" | "kth-trade" | "size-creep" | "re-entry" | "rule-adherence";
  title: string;
  unit: "R" | "rupees";
  /** arms[0] is the baseline; the gap is the LAST arm minus the first. */
  arms: GapArm[];
  gap: number | null;
  ci: Interval | null;
  grade: EvidenceGrade;
  /** Rows that could be read / rows in scope — null when the check reads every row. */
  coverage: { withData: number; of: number } | null;
  verb: CopyVerb;
  copy: ClinicCopy;
}

export interface RuleAdherence {
  /** null when no row in the cell carries `ruleViolations` at all. */
  coverage: { withData: number; of: number } | null;
  /** null below minN rows with data. */
  check: GapCheck | null;
}

export interface EdgeDecay {
  cusum: S.CusumResult;
  band: S.RollingPoint[];
  window: number;
  verb: CopyVerb;
  copy: ClinicCopy;
}

/**
 * The numeric core of every Kelly figure in the app (C3 D1) — `kellyCeiling()`
 * over a `kellySample()`. The CEILING (`halfKellyLowerBound`) is a fraction of
 * capital risked PER 1R (owner Q3, v4.7.0 audit) — the unit `sizeKelly`'s fUsed
 * is in, since the Lab's risk budget is 1R. `kellyPoint` / `kellyAtLowerBounds`
 * stay Thorp's classic f = p − (1 − p)/b: the fraction LOST on an average loss of
 * L̄ R, which is f/L̄ per 1R. `empiricalKelly` is per 1R already (ln(1 + f·R)).
 */
export interface KellyCeiling {
  /** R values in the sample. */
  n: number;
  /** Win rate (R > 0 — a scratch at exactly 0 is not a win). */
  p: number;
  /** Wilson lower 95 % bound of p. */
  pLo: number;
  /** Payoff W̄/L̄ (a loss is every non-winning R): 0 with no winner, +∞ with no loser. */
  b: number;
  /** Percentile-bootstrap lower 95 % bound of b; null when not finite. */
  bLo: number | null;
  /**
   * L̄ = the mean non-winning R as a positive magnitude, at its percentile-bootstrap
   * UPPER 95 % bound (same seed and resamples as `bLo`), so dividing by it stays
   * conservative; null when not a positive finite number (no loss, or every loss a scratch).
   */
  lossHi: number | null;
  /** Classic f at the point estimates — a fraction lost on an average loss, NOT per 1R. */
  kellyPoint: number | null;
  /** Classic f at the lower 95 % bounds of p and b — NOT per 1R. */
  kellyAtLowerBounds: number | null;
  /**
   * THE ceiling, a fraction of capital risked PER 1R: ½ × `kellyAtLowerBounds` / `lossHi`,
   * capped at ½ × `empiricalKelly`. Null = not supported: Kelly at the lower bounds not
   * positive, no `lossHi`, no `empiricalKelly` (off grid — CG-1), or a result that is not
   * finite or exceeds 1.
   */
  halfKellyLowerBound: number | null;
  supportsSizingUp: boolean;
  /** Argmax of mean ln(1 + f·R) on the 0.001 grid below 0.99 — per 1R; null off grid. */
  empiricalKelly: number | null;
  zeroGrowthFraction: number | null;
}

export interface SizingCeiling extends KellyCeiling {
  growthAtCurrent: number | null;
  lossRate: number;
  longestLosingRun: S.LongestRun | null;
  verb: CopyVerb;
  copy: ClinicCopy;
}

export type CellKind = "book" | "segment" | "setup" | "grade" | "fno";
export type FnoDimension = "dte" | "side" | "lots" | "expiryRegime";

export interface ClinicCell {
  key: string;
  kind: CellKind;
  segment: Segment | null;
  /** The setup tag ("untagged" for null); null on book / segment / grade / fno cells. */
  setup: string | null;
  /** v4.7.0 C2: the setup grade on a `grade` cell; null on every other kind. */
  setupGrade: SetupGrade | null;
  cut: { dimension: FnoDimension; label: string } | null;
  label: string;
  /** Closed trades in the cell. */
  n: number;
  /** Closed trades carrying an R — the sample every R statistic and the grade use. */
  nWithR: number;
  provenance: RProvenanceCounts;
  rUnit: "R" | "cap";
  meanR: number | null;
  ci: Interval | null;
  bootstrapCi: Interval | null;
  early: boolean;
  sr: number | null;
  g3: number | null;
  g4: number | null;
  psr: number | null;
  minTrl: number | null;
  minTrlCapped: boolean;
  tradesStillNeeded: number | null;
  pOneSided: number | null;
  pTwoSided: number | null;
  /** Counts toward m (nWithR ≥ minN). */
  tested: boolean;
  grade: EvidenceGrade;
  verdict: string;
  verb: CopyVerb;
  copy: ClinicCopy;
  cost: CostDrag;
  payoff: WinRatePayoff | null;
  ruleAdherence: RuleAdherence;
  decay: EdgeDecay | null;
  sizing: SizingCeiling | null;
  /**
   * C3 D8: the sizing sample against the cell's R sample — `withRisk` rows in
   * `kellySample()` of `of` = nWithR. Lets a surface say why `sizing` is null
   * ("X of Y trades carry a real risk — 30 needed").
   */
  sizingSample: { withRisk: number; of: number };
}

export interface HoldMeasure {
  unit: "days" | "minutes";
  winners: { n: number; median: number | null };
  losers: { n: number; median: number | null };
  holdRatio: number | null;
  ratioCi: Interval | null;
  disposition: boolean | null;
  grade: EvidenceGrade;
}

export interface HoldClock {
  days: HoldMeasure;
  minutes: HoldMeasure;
  verb: CopyVerb;
  copy: ClinicCopy;
}

export interface SegmentBehaviour {
  segment: Segment;
  checks: GapCheck[];
  hold: HoldClock;
}

export interface FnoCuts {
  segment: Segment;
  dte: ClinicCell[];
  /** Buyer vs seller — option segments only. */
  side: ClinicCell[] | null;
  lots: ClinicCell[];
  expiryRegime: ClinicCell[];
  unknownDte: number;
  unknownLots: number;
  /** Closed one-lot trades whose riskAmount exceeds the cap; null without a cap. */
  oneLotOverCap: number | null;
}

export interface Deflation {
  bestCellKey: string;
  bestSr: number;
  /** N = m: the tested cells on the screen — an UPPER bound on independent trials (the cells overlap). */
  nTrials: number;
  varOfTrialSRs: number;
  expectedMaxSr: number;
  psr: number | null;
  deflatedSr: number | null;
  withinLuck: boolean | null;
  copy: ClinicCopy;
}

export interface ClinicReport {
  asOf: string;
  params: { minN: number; minArm: number; minKelly: number; window: number; q: number; seed: number };
  closedTrades: number;
  openExcluded: number;
  /** Cells with nWithR ≥ minN across EVERYTHING the report can show (cells + F&O cuts). */
  m: number;
  multiplicity: { method: "BY"; q: number; m: number };
  cells: ClinicCell[];
  fno: FnoCuts[];
  behaviour: SegmentBehaviour[];
  deflation: Deflation | null;
  provenance: RProvenanceCounts;
  provenanceLine: string;
  /** Behaviour checks are graded one at a time — say so wherever they are shown. */
  behaviourNote: string;
}

// ── Small helpers ───────────────────────────────────────────────────────────

const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);
const rOf = (t: ClinicTrade): number | null => (fin(t.rMultiple) ? t.rMultiple : null);
const fmtR = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}`;
const fmtPct = (x: number) => `${(x * 100).toFixed(1)} %`;
const fmtRupees = (x: number) => `₹${Math.round(Math.abs(x))}`;
const fmtCi = (ci: Interval) => `95 % CI ${fmtR(ci.lo)} to ${fmtR(ci.hi)}`;

/** The ISO day a stored date states (ISO, or the 4.2.x DD-MM-YYYY / DD/MM/YYYY), else null. */
export function dayOf(s: string | null | undefined): string | null {
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(s.trim());
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

/** Whole days since the epoch for an ISO day, validated (no `new Date` on a raw field). */
function dayNumber(iso: string | null): number | null {
  if (!iso) return null;
  const [y, mo, d] = iso.split("-").map(Number);
  if (!(mo >= 1 && mo <= 12) || !(d >= 1)) return null;
  const DAY_MS = 86_400_000;
  const monthStart = Date.UTC(y, mo - 1, 1);
  const daysInMonth = Math.round((Date.UTC(y, mo, 1) - monthStart) / DAY_MS);
  if (!Number.isFinite(monthStart) || d > daysInMonth) return null; // 2026-02-31 and friends
  return Math.round(monthStart / DAY_MS) + d - 1;
}

/** Minutes after midnight for "HH:MM" / "HH:MM:SS", else null. */
function minuteOf(s: string | null): number | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi + (m[3] ? Number(m[3]) / 60 : 0);
}

/** Chronological = sellDate then exitTime (as `tiltBehaviour` sorts), ties by id. */
function chronological(trades: ClinicTrade[]): ClinicTrade[] {
  const key = (t: ClinicTrade) => `${dayOf(t.sellDate ?? t.buyDate) ?? ""}${t.exitTime ?? ""}`;
  return [...trades].sort((a, b) => key(a).localeCompare(key(b)) || a.id - b.id);
}

const isOptionSegment = (s: Segment) => s === "index_option" || s === "stock_option" || s === "commodity_option";

function lotsOf(t: ClinicTrade): number | null {
  if (!fin(t.lotSize) || t.lotSize <= 0) return null;
  const qty = Math.max(t.buyQty, t.sellQty);
  if (!(qty > 0)) return null;
  return Math.max(1, Math.round(qty / t.lotSize));
}

// ── Win-rate × payoff ───────────────────────────────────────────────────────

function halfStats(rs: readonly number[]): HalfStats | null {
  const wins = rs.filter((r) => r > 0);
  const non = rs.filter((r) => r <= 0);
  if (wins.length === 0 || non.length === 0) return null;
  const p = wins.length / rs.length;
  const meanWin = S.mean(wins);
  const meanLoss = -S.mean(non);
  return { n: rs.length, p, meanWin, meanLoss, expectancy: p * meanWin - (1 - p) * meanLoss };
}

/**
 * ΔE between two halves by the MIDPOINT decomposition
 * ΔE = Δp·(W̄m + L̄m) + p̄·ΔW̄ − (1 − p̄)·ΔL̄, exact for E = p·W̄ − (1 − p)·L̄ (a
 * "loss" is every non-winning R, so E is the mean R exactly). Null when either
 * half lacks a win or a non-win (W̄ or L̄ undefined).
 */
export function expectancyShift(prev: readonly number[], curr: readonly number[]): ExpectancyShift | null {
  const a = halfStats(prev);
  const b = halfStats(curr);
  if (!a || !b) return null;
  const dp = b.p - a.p;
  const pm = (a.p + b.p) / 2;
  const wm = (a.meanWin + b.meanWin) / 2;
  const lm = (a.meanLoss + b.meanLoss) / 2;
  return {
    prev: a,
    curr: b,
    total: b.expectancy - a.expectancy,
    fromWinRate: dp * (wm + lm),
    fromWinners: pm * (b.meanWin - a.meanWin),
    fromLosers: -(1 - pm) * (b.meanLoss - a.meanLoss),
  };
}

function winRatePayoff(rs: number[], minN: number): WinRatePayoff | null {
  if (rs.length === 0) return null;
  const wins = rs.filter((r) => r > 0);
  const non = rs.filter((r) => r <= 0);
  const p = wilsonInterval(wins.length, rs.length);
  const meanWin = wins.length ? S.mean(wins) : null;
  const meanLoss = non.length ? -S.mean(non) : null;
  const b = meanWin != null && meanLoss != null && meanLoss > 0 ? meanWin / meanLoss : null;
  const breakevenP = meanWin != null && meanLoss != null && meanWin + meanLoss > 0 ? meanLoss / (meanWin + meanLoss) : null;
  const half = Math.floor(rs.length / 2);
  return {
    p,
    meanWin,
    meanLoss,
    b,
    breakevenP,
    winRateProblem: breakevenP != null ? p.hi < breakevenP : null,
    deltaE: rs.length >= minN ? expectancyShift(rs.slice(0, half), rs.slice(half)) : null,
  };
}

// ── Cost drag ───────────────────────────────────────────────────────────────

function costDrag(ts: ClinicTrade[], minN: number): CostDrag {
  const n = ts.length;
  if (n === 0) return { grossMean: null, netMean: null, costPerTrade: null, costShareOfGrossWins: null, costInR: null, costInRN: 0 };
  const charges = ts.reduce((s, t) => s + t.chargesTotal, 0);
  const grossWins = ts.filter((t) => t.grossPnl > 0).reduce((s, t) => s + t.grossPnl, 0);
  const withRisk = ts.filter((t) => fin(t.riskAmount) && t.riskAmount > 0);
  return {
    grossMean: S.mean(ts.map((t) => t.grossPnl)),
    netMean: S.mean(ts.map((t) => t.netPnl)),
    costPerTrade: charges / n,
    costShareOfGrossWins: grossWins > 0 ? charges / grossWins : null,
    costInR: withRisk.length >= minN ? S.mean(withRisk.map((t) => t.chargesTotal / (t.riskAmount as number))) : null,
    costInRN: withRisk.length,
  };
}

// ── Gap checks ──────────────────────────────────────────────────────────────

interface Ctx {
  minN: number;
  minArm: number;
  minKelly: number;
  window: number;
  q: number;
  seed: number;
  riskCapRupees: number | null;
  currentRiskPct: number | null;
}

const NOT_CORRECTED = "Graded on its own — not corrected for the other behaviour checks.";

interface GapSpec {
  id: GapCheck["id"];
  title: string;
  unit: GapCheck["unit"];
  where: string;
  arms: { label: string; values: number[] }[];
  coverage: GapCheck["coverage"];
  provenanceLine: string;
}

function gapCheck(spec: GapSpec, ctx: Ctx): GapCheck {
  const base = spec.arms[0].values;
  const cmp = spec.arms[spec.arms.length - 1].values;
  const arms: GapArm[] = spec.arms.map((a) => ({ label: a.label, n: a.values.length, mean: a.values.length ? S.mean(a.values) : null }));
  const gap = base.length && cmp.length ? S.mean(cmp) - S.mean(base) : null;
  const short = base.length < ctx.minArm || cmp.length < ctx.minArm;
  const ci = short ? null : S.bootstrapGap(base, cmp, { seed: ctx.seed });
  const excludes = ci != null && fin(ci.lo) && fin(ci.hi) && (ci.lo > 0 || ci.hi < 0);
  // No multiplicity across behaviour checks, so (owner ruling C2: "stop / size
  // up only past the FULL corrected bar") a gap check can never be
  // `established`: a CI that excludes 0 is capped at `likely`, verb `test`, and
  // the copy says it was not corrected.
  const grade: EvidenceGrade = short ? "insufficient" : excludes ? "likely" : "unclear";
  const u = (x: number) => (spec.unit === "R" ? `${fmtR(x)} R` : `${x >= 0 ? "+" : "−"}${fmtRupees(x)}`);
  const armLine = arms.map((a) => `${a.label} n = ${a.n}`).join(" · ");
  let verb: CopyVerb;
  let headline: string;
  let detail: string;
  if (grade === "insufficient") {
    verb = "none";
    headline = "—";
    detail = `${armLine}, need ≥ ${ctx.minArm} in each.`;
  } else {
    const gapLine = `${spec.arms[spec.arms.length - 1].label} vs ${spec.arms[0].label}: ${u(gap as number)} per trade (bootstrap ${ci!.conf * 100} % CI ${u(ci!.lo)} to ${u(ci!.hi)}; ${armLine}).`;
    verb = "test";
    headline =
      grade === "likely"
        ? `${spec.title} ${spec.where}: a likely gap of ${u(gap as number)} per trade, not yet established`
        : `${spec.title} ${spec.where}: not yet distinguishable from no gap`;
    detail = `Test: log the next ${EXPERIMENT_TRADES} trades ${spec.where} and re-read this card. ${gapLine} ${NOT_CORRECTED}`;
  }
  return {
    id: spec.id,
    title: spec.title,
    unit: spec.unit,
    arms,
    gap,
    ci,
    grade,
    coverage: spec.coverage,
    verb,
    copy: { headline, detail, provenanceLine: spec.provenanceLine },
  };
}

function behaviourChecks(seg: Segment, ts: ClinicTrade[], ctx: Ctx, provLine: string): GapCheck[] {
  const where = `in ${SEGMENT_LABELS[seg]}`;
  const afterWin: number[] = [];
  const afterLoss: number[] = [];
  const sizeAfterWin: number[] = [];
  const sizeAfterLoss: number[] = [];
  let sizeScope = 0;
  const reentry: number[] = [];
  const rest: number[] = [];
  const ord: [number[], number[], number[]] = [[], [], []];
  let lastDay: string | null = null;
  let ordinal = 0;

  for (let i = 0; i < ts.length; i++) {
    const cur = ts[i];
    const r = rOf(cur);
    const day = dayOf(cur.sellDate ?? cur.buyDate);
    ordinal = day != null && day === lastDay ? ordinal + 1 : 1;
    lastDay = day;
    if (r != null && day != null) ord[Math.min(ordinal, 3) - 1].push(r);

    const prev = i > 0 ? ts[i - 1] : null;
    if (prev && prev.netPnl !== 0) {
      const won = prev.netPnl > 0;
      if (r != null) (won ? afterWin : afterLoss).push(r);
      sizeScope++;
      if (fin(cur.riskAmount) && cur.riskAmount > 0 && cur.riskSource !== "cap") {
        (won ? sizeAfterWin : sizeAfterLoss).push(cur.riskAmount);
      }
    }
    if (r != null && prev) {
      const prevDay = dayOf(prev.sellDate ?? prev.buyDate);
      if (prev.netPnl < 0 && day != null && prevDay === day) reentry.push(r);
      else rest.push(r);
    }
  }

  return [
    gapCheck(
      {
        id: "after-loss",
        title: "Trading straight after a loss",
        unit: "R",
        where,
        arms: [
          { label: "after a win", values: afterWin },
          { label: "after a loss", values: afterLoss },
        ],
        coverage: null,
        provenanceLine: provLine,
      },
      ctx,
    ),
    gapCheck(
      {
        id: "kth-trade",
        title: "Later trades of the day",
        unit: "R",
        where,
        arms: [
          { label: "1st of the day", values: ord[0] },
          { label: "2nd of the day", values: ord[1] },
          { label: "3rd+ of the day", values: ord[2] },
        ],
        coverage: null,
        provenanceLine: provLine,
      },
      ctx,
    ),
    gapCheck(
      {
        id: "size-creep",
        title: "Size after a win",
        unit: "rupees",
        where,
        arms: [
          { label: "risk after a loss", values: sizeAfterLoss },
          { label: "risk after a win", values: sizeAfterWin },
        ],
        // Size = riskAmount the user SET (a 'cap' row's risk is the cap, not a size).
        coverage: { withData: sizeAfterWin.length + sizeAfterLoss.length, of: sizeScope },
        provenanceLine: provLine,
      },
      ctx,
    ),
    gapCheck(
      {
        id: "re-entry",
        title: "Same-day re-entry after a loss",
        unit: "R",
        where,
        arms: [
          { label: "other trades", values: rest },
          { label: "same-day re-entries after a loss", values: reentry },
        ],
        coverage: null,
        provenanceLine: provLine,
      },
      ctx,
    ),
  ];
}

// ── Hold clock ──────────────────────────────────────────────────────────────

function holdMeasure(unit: HoldMeasure["unit"], winners: number[], losers: number[], ctx: Ctx): HoldMeasure {
  const wMed = winners.length ? S.median(winners) : null;
  const lMed = losers.length ? S.median(losers) : null;
  const holdRatio = wMed != null && lMed != null && wMed > 0 ? lMed / wMed : null;
  const enough = winners.length >= ctx.minArm && losers.length >= ctx.minArm && holdRatio != null;
  const ratioCi = enough
    ? S.bootstrapTwoSample(winners, losers, (w, l) => {
        const d = S.median(w);
        return d > 0 ? S.median(l) / d : Number.POSITIVE_INFINITY;
      }, { seed: ctx.seed })
    : null;
  const disposition = ratioCi != null && fin(ratioCi.lo) ? ratioCi.lo > 1 : null;
  const grade: EvidenceGrade = !enough ? "insufficient" : disposition ? "established" : "unclear";
  return {
    unit,
    winners: { n: winners.length, median: wMed },
    losers: { n: losers.length, median: lMed },
    holdRatio,
    ratioCi,
    disposition,
    grade,
  };
}

function holdClock(seg: Segment, ts: ClinicTrade[], ctx: Ctx, provLine: string): HoldClock {
  const dW: number[] = [];
  const dL: number[] = [];
  const mW: number[] = [];
  const mL: number[] = [];
  for (const t of ts) {
    if (t.netPnl === 0) continue;
    const a = dayNumber(dayOf(t.buyDate));
    const b = dayNumber(dayOf(t.sellDate));
    if (a == null || b == null) continue;
    const days = Math.abs(b - a);
    (t.netPnl > 0 ? dW : dL).push(days);
    if (days === 0) {
      const e = minuteOf(t.entryTime);
      const x = minuteOf(t.exitTime);
      if (e != null && x != null) (t.netPnl > 0 ? mW : mL).push(Math.abs(x - e));
    }
  }
  const days = holdMeasure("days", dW, dL, ctx);
  const minutes = holdMeasure("minutes", mW, mL, ctx);
  const where = `in ${SEGMENT_LABELS[seg]}`;
  const shown = days.grade !== "insufficient" ? days : minutes;
  // A hold pattern is a TIME gap, not an R gap — prescriptions here are tests, never imperatives.
  let verb: CopyVerb = "none";
  let headline = "—";
  let detail = `winners n = ${shown.winners.n} · losers n = ${shown.losers.n}, need ≥ ${ctx.minArm} in each (with a non-zero winner median).`;
  if (shown.grade !== "insufficient") {
    verb = "test";
    const line = `Median hold: losers ${shown.losers.median!.toFixed(1)} ${shown.unit} vs winners ${shown.winners.median!.toFixed(1)} ${shown.unit} (ratio ${shown.holdRatio!.toFixed(2)}, bootstrap 95 % CI ${shown.ratioCi!.lo.toFixed(2)} to ${shown.ratioCi!.hi.toFixed(2)}).`;
    headline = shown.disposition
      ? `You hold losers longer than winners ${where}`
      : `No clear hold-time gap between winners and losers ${where}`;
    detail = shown.disposition
      ? `${line} Test: for the next ${EXPERIMENT_TRADES} trades, exit a loser no later than your median winner's hold, then re-read this card.`
      : line;
  }
  return { days, minutes, verb, copy: { headline, detail, provenanceLine: provLine } };
}

// ── Cells ───────────────────────────────────────────────────────────────────

interface CellSpec {
  key: string;
  kind: CellKind;
  segment: Segment | null;
  setup: string | null;
  setupGrade?: SetupGrade | null;
  cut: ClinicCell["cut"];
  label: string;
  trades: ClinicTrade[]; // closed, chronological
}

function rUnitOf(ts: ClinicTrade[]): "R" | "cap" {
  const withR = ts.filter((t) => rOf(t) != null);
  return withR.length > 0 && withR.every((t) => t.riskSource === "cap") ? "cap" : "R";
}

const ciExcludesZero = (ci: Interval | null) => ci != null && fin(ci.lo) && fin(ci.hi) && (ci.lo > 0 || ci.hi < 0);

const EQUITY_SEGMENTS: ReadonlySet<Segment> = new Set<Segment>(["eq_delivery", "eq_mtf", "eq_intraday"]);

/**
 * An equity row whose buy leg carries quantity but no price: a sale with no cost
 * basis (an acquisition-flagged holding whose issue price is still blank —
 * `edgeMeasurable` false). Its R is a basis-less "win" (research risk 4), and the
 * Clinic's projection carries no acquisition column, so the buy price is the
 * fingerprint. Equity only: an option or a future CAN close at 0 (a short that
 * expires worthless is a real, priced win).
 */
export function basisUnknown(t: Pick<ClinicTrade, "segment" | "buyQty" | "avgBuyPrice">): boolean {
  return EQUITY_SEGMENTS.has(t.segment) && t.buyQty > 0 && !(t.avgBuyPrice > 0);
}

/**
 * THE Kelly sample (C3 D2, owner K1), in the input's order: closed rows with a
 * finite rMultiple whose R denominator is a real risk — provenance through
 * `rProvenance()` (lib/analytics/win-loss.ts, the ONE place), so a `cap` row is
 * out and a null riskSource with an R counts as typed, as everywhere else — and
 * a known cost basis (`basisUnknown`). The Clinic's sizing card and the Sizing
 * Lab's journal Kelly both read this; nothing else defines it.
 */
export function kellySample<T extends ClinicTrade>(trades: readonly T[]): T[] {
  return trades.filter((t) => !t.isOpen && fin(t.rMultiple) && rProvenance(provenanceRowOf(t)) !== "cap" && !basisUnknown(t));
}

/**
 * THE Kelly numbers over an R sample (C3 D1 — extracted from C1's sizing card).
 * No floor here: callers apply `KELLY_MIN_N`. The bootstrap of b is seeded, so
 * the same sample in the same order gives the same bounds everywhere.
 */
export function kellyCeiling(rs: readonly number[], opts: { seed?: number } = {}): KellyCeiling {
  const seed = opts.seed ?? CLINIC_SEED;
  const sample = [...rs];
  const wins = sample.filter((r) => r > 0).length;
  const p = wins / sample.length;
  const pLo = wilsonInterval(wins, sample.length).lo;
  // b = W̄/L̄ (a loss is every non-winning R). Allocation-free: it runs inside
  // every bootstrap resample. No win → 0; no loss → +∞ (sorts to the top, so
  // it can only raise the upper bound, never invent a lower one).
  const ratio = (xs: number[]) => {
    let ws = 0;
    let wn = 0;
    let ls = 0;
    let ln = 0;
    for (const r of xs) {
      if (r > 0) {
        ws += r;
        wn++;
      } else {
        ls -= r;
        ln++;
      }
    }
    if (wn === 0) return 0;
    const lm = ln ? ls / ln : 0;
    return lm > 0 ? ws / wn / lm : Number.POSITIVE_INFINITY;
  };
  const b = ratio(sample);
  const bCi = S.bootstrapInterval(sample, ratio, { seed });
  const bLo = fin(bCi.lo) ? bCi.lo : null;
  // L̄ (Q3 / R4): the mean non-winning R as a magnitude, at its UPPER bound — the same
  // seed, so the same resamples as bLo. A resample with no loss has no L̄ (NaN, dropped).
  const meanLoss = (xs: number[]) => {
    let ls = 0;
    let ln = 0;
    for (const r of xs) {
      if (!(r > 0)) {
        ls -= r;
        ln++;
      }
    }
    return ln ? ls / ln : Number.NaN;
  };
  const lCi = S.bootstrapInterval(sample, meanLoss, { seed });
  const lossHi = fin(lCi.hi) && lCi.hi > 0 ? lCi.hi : null;
  const kellyPoint = fin(b) ? S.kellyApprox(p, b) : null;
  const kellyAtLowerBounds = bLo != null ? S.kellyApprox(pLo, bLo) : null;
  const empiricalKelly = S.kellyEmpirical(sample);
  // Per 1R: classic f is the fraction lost on an AVERAGE loss of L̄ R, so f/L̄ is the
  // fraction per 1R. A scratch-heavy book has a tiny L̄ and f/L̄ explodes ("600 %"), so
  // the result is capped at ½ × the empirical Kelly, which is per 1R and ruin-bounded.
  const perR = kellyAtLowerBounds != null && kellyAtLowerBounds > 0 && lossHi != null && empiricalKelly != null
    ? Math.min(kellyAtLowerBounds / 2 / lossHi, empiricalKelly / 2)
    : null;
  const halfKellyLowerBound = perR != null && fin(perR) && perR > 0 && perR <= 1 ? perR : null;
  return {
    n: sample.length,
    p,
    pLo,
    b,
    bLo,
    lossHi,
    kellyPoint,
    kellyAtLowerBounds,
    halfKellyLowerBound,
    supportsSizingUp: halfKellyLowerBound != null,
    empiricalKelly,
    zeroGrowthFraction: S.zeroGrowthFractionEmpirical(sample),
  };
}

/**
 * The Clinic's sizing card: `kellyCeiling` over the cell's `kellySample()` R
 * values (`rs`, of `of` = the cell's nWithR), plus copy, verb, streak and growth.
 * Null below `ctx.minKelly` (KELLY_MIN_N unless a caller overrides it).
 */
function sizingCeiling(rs: number[], of: number, grade: EvidenceGrade, meanR: number | null, label: string, ctx: Ctx, provLine: string): SizingCeiling | null {
  if (rs.length < ctx.minKelly) return null;
  const k = kellyCeiling(rs, { seed: ctx.seed });
  const { p, halfKellyLowerBound, supportsSizingUp } = k;
  const growthAtCurrent = fin(ctx.currentRiskPct) ? S.empiricalGrowth(ctx.currentRiskPct / 100, rs) : null;
  const lossRate = 1 - p;
  const longestLosingRun = S.expectedLongestLoss(STREAK_HORIZON, lossRate);

  const atRisk = fin(ctx.currentRiskPct) ? `at ${ctx.currentRiskPct} % risk and ` : "at ";
  const streak = longestLosingRun
    ? `${atRisk}a ${fmtPct(lossRate)} loss rate, a run of ${Math.max(0, Math.round(longestLosingRun.mean))} straight losses in the next ${STREAK_HORIZON} trades is normal (asymptotic approximation, sd ${longestLosingRun.sd.toFixed(1)}).`
    : "";
  let verb: CopyVerb;
  let headline: string;
  if (!supportsSizingUp) {
    verb = "none";
    headline = `${label}: the data does not support sizing up`;
  } else if (grade === "established" && meanR != null && meanR > 0) {
    verb = "imperative";
    headline = `Keep sizing ${label} at or under ${fmtPct(halfKellyLowerBound!)} of capital at risk per trade`;
  } else {
    verb = "test";
    headline = `${label}: ceiling ${fmtPct(halfKellyLowerBound!)} of capital at risk per trade, edge not yet established`;
  }
  // Q3 / R4: the ceiling is per 1R; the refusal names the reason that actually held.
  const method = supportsSizingUp
    ? `Half-Kelly at the lower 95 % bounds of the win rate and the payoff, per 1R: divided by the average loss at its upper 95 % bound (${k.lossHi!.toFixed(2)} R) and no higher than half the empirical Kelly.`
    : !(k.kellyAtLowerBounds != null && k.kellyAtLowerBounds > 0)
      ? "Kelly at the lower 95 % bounds of the win rate and the payoff is not positive."
      : k.empiricalKelly == null
        ? "The empirical Kelly has no maximum below 99 % of capital per 1R — the losses measured are too small to size against — so no ceiling is stated."
        : "Kelly at the lower 95 % bounds is positive, but the losses measured give no per-1R ceiling.";
  const detail = [method, streak].filter(Boolean).join(" ");
  // D8: the card names its own sample — cap-unit R is P&L over a cap, not a risk.
  const sampleLine = `Sizing reads ${k.n} of ${of} trades with an R: the trades with a stop or a typed risk — cap-unit rows are not a risk.`;
  return {
    ...k,
    growthAtCurrent,
    lossRate,
    longestLosingRun,
    verb,
    copy: { headline, detail, provenanceLine: provLine ? `${provLine}. ${sampleLine}` : sampleLine },
  };
}

/** Pass 1 — everything but the grade (the grade needs BY across all tested cells). */
function buildCell(spec: CellSpec, ctx: Ctx): ClinicCell {
  const ts = spec.trades;
  const rs = ts.map(rOf).filter(fin);
  const nWithR = rs.length;
  const provenance = rProvenanceCounts(ts.map(provenanceRowOf));
  const provLine = rProvenanceLine(provenance);
  const ci = nWithR > 0 ? meanInterval(rs) : null;
  const early = nWithR > 0 && nWithR < MOMENTS_MIN_N;
  const bootstrapCi = early && nWithR >= 2 ? S.bootstrapInterval(rs, S.mean, { seed: ctx.seed }) : null;
  const mo = S.populationMoments(rs);
  const sr = mo ? mo.mean / mo.sd : null;
  const momentsOk = mo != null && nWithR >= MOMENTS_MIN_N;
  const g3 = momentsOk ? mo!.g3 : null;
  const g4 = momentsOk ? mo!.g4 : null;
  const psr = momentsOk && sr != null ? S.psr(sr, 0, nWithR, g3!, g4!) : null;
  const minTrl = momentsOk && sr != null ? S.minTrl(sr, 0, g3!, g4!) : null;
  const tt = S.tTest(rs);
  const meanR = nWithR > 0 ? S.mean(rs) : null;

  let decay: EdgeDecay | null = null;
  if (nWithR >= 2 * ctx.window) {
    const cusum = S.cusumDown(rs, { minBurnIn: ctx.window });
    if (cusum) {
      const alarmed = cusum.alarmIndex != null;
      decay = {
        cusum,
        band: S.rollingMeanBand(rs, ctx.window),
        window: ctx.window,
        verb: alarmed ? "test" : "none",
        copy: {
          headline: alarmed
            ? `${spec.label}: a possible drop in R from trade ${cusum.alarmIndex! + 1}`
            : `${spec.label}: no downward shift detected`,
          detail: alarmed
            ? `CUSUM against the first ${cusum.burnIn} trades (mean ${fmtR(cusum.mu0)} R) crossed its limit. Test: the next ${EXPERIMENT_TRADES} trades at no more than your current size, then re-read this card.`
            : `CUSUM against the first ${cusum.burnIn} trades (mean ${fmtR(cusum.mu0)} R) has not crossed its limit.`,
          provenanceLine: provLine,
        },
      };
    }
  }

  const withData = ts.filter((t) => rOf(t) != null && (t.ruleViolations != null || t.playbookId != null));
  const broke = (t: ClinicTrade) => (t.ruleViolations ?? []).some((v) => v.startsWith(PLAYBOOK_RULE_PREFIX));
  const ruleAdherence: RuleAdherence = {
    coverage: withData.length > 0 ? { withData: withData.length, of: nWithR } : null,
    check:
      withData.length >= ctx.minN
        ? gapCheck(
            {
              id: "rule-adherence",
              title: "Keeping to your playbook rules",
              unit: "R",
              where: `in ${spec.label}`,
              arms: [
                { label: "broke a playbook rule", values: withData.filter(broke).map((t) => rOf(t) as number) },
                { label: "kept every rule", values: withData.filter((t) => !broke(t)).map((t) => rOf(t) as number) },
              ],
              coverage: { withData: withData.length, of: nWithR },
              provenanceLine: provLine,
            },
            ctx,
          )
        : null,
  };

  return {
    key: spec.key,
    kind: spec.kind,
    segment: spec.segment,
    setup: spec.setup,
    setupGrade: spec.setupGrade ?? null,
    cut: spec.cut,
    label: spec.label,
    n: ts.length,
    nWithR,
    provenance,
    rUnit: rUnitOf(ts),
    meanR,
    ci,
    bootstrapCi,
    early,
    sr,
    g3,
    g4,
    psr,
    minTrl,
    minTrlCapped: minTrl != null && minTrl > MIN_TRL_DISPLAY_CAP,
    tradesStillNeeded: minTrl != null ? Math.max(0, Math.ceil(minTrl) - nWithR) : null,
    pOneSided: tt ? tt.pOneSided : null,
    pTwoSided: tt ? tt.pTwoSided : null,
    tested: nWithR >= ctx.minN,
    grade: "insufficient",
    verdict: "",
    verb: "none",
    copy: { headline: "—", detail: "", provenanceLine: provLine },
    cost: costDrag(ts, ctx.minN),
    payoff: winRatePayoff(rs, ctx.minN),
    ruleAdherence,
    decay,
    sizing: null, // pass 2, once the grade is known
    sizingSample: { withRisk: kellySample(ts).length, of: nWithR },
  };
}

/** Pass 2 — grade, verdict, copy and the sizing card (over `kellyRs`, the cell's `kellySample()` R), given the BY outcome. */
function finishCell(c: ClinicCell, survivesBy: boolean, m: number, ctx: Ctx, rs: number[], kellyRs: number[]): void {
  const capNote = c.rUnit === "cap" ? " P&L in units of your per-trade cap, not of the risk you took." : "";
  const excl = ciExcludesZero(c.ci) && (!c.early || (ciExcludesZero(c.bootstrapCi) && Math.sign(c.bootstrapCi!.lo) === Math.sign(c.ci!.lo)));
  c.grade = !c.tested ? "insufficient" : !excl ? "unclear" : survivesBy ? "established" : "likely";

  if (c.grade === "insufficient") {
    const without = c.n - c.nWithR;
    c.verdict = `n = ${c.nWithR}, need ≥ ${ctx.minN}`;
    c.verb = "none";
    c.copy = {
      headline: "—",
      detail: `n = ${c.nWithR}, need ≥ ${ctx.minN}${without > 0 ? ` (${without} closed without an R)` : ""}.${capNote}`,
      provenanceLine: c.copy.provenanceLine,
    };
  } else {
    const ci = c.ci!;
    const line = `${fmtR(c.meanR!)} R per trade (${fmtCi(ci)}, n = ${c.nWithR}${c.early ? ", early: fewer than 30" : ""})`;
    if (c.grade === "established") {
      c.verdict = `${line} — survives the correction for ${m} tested cells`;
      c.verb = "imperative";
      c.copy = {
        headline: c.meanR! > 0 ? `Keep sizing ${c.label} as you do` : `Stop taking ${c.label}`,
        detail: `${c.verdict}.${capNote}`,
        provenanceLine: c.copy.provenanceLine,
      };
    } else {
      // The bounded experiment: what 20 fresh trades must average to read as an
      // edge ON THEIR OWN (one-sample t at this cell's dispersion).
      const sd = Math.sqrt(S.populationVariance(rs) * (rs.length / (rs.length - 1)));
      const need = (tQuantile95(EXPERIMENT_TRADES - 1) * sd) / Math.sqrt(EXPERIMENT_TRADES);
      c.verdict =
        c.grade === "likely"
          ? `${line} — not yet beyond chance across the ${m} tested cells`
          : `${line} — the interval spans zero`;
      c.verb = "test";
      c.copy = {
        headline:
          c.grade === "likely"
            ? `${c.label}: a likely ${c.meanR! > 0 ? "positive" : "negative"} edge, not yet established`
            : `${c.label}: no edge you can lean on yet`,
        detail: `Test: next ${EXPERIMENT_TRADES} trades in ${c.label} at no more than your current size; on their own they read as an edge only at an average of ${fmtR(need)} R or better. ${c.verdict}.${capNote}`,
        provenanceLine: c.copy.provenanceLine,
      };
    }
  }
  c.sizing = sizingCeiling(kellyRs, c.nWithR, c.grade, c.meanR, c.label, ctx, c.copy.provenanceLine);
}

// ── The engine ──────────────────────────────────────────────────────────────

export function edgeClinic(trades: readonly ClinicTrade[], opts: ClinicOptions): ClinicReport {
  const ctx: Ctx = {
    minN: opts.minN ?? 20,
    minArm: opts.minArm ?? 15,
    minKelly: opts.minKelly ?? KELLY_MIN_N,
    window: opts.window ?? 30,
    q: opts.q ?? 0.05,
    seed: opts.seed ?? CLINIC_SEED,
    riskCapRupees: opts.riskCapRupees ?? null,
    currentRiskPct: opts.currentRiskPct ?? null,
  };
  const closed = closedChronological(trades);
  const openExcluded = trades.filter((t) => t.isOpen).length;
  const { segments, specs, fnoSpecs } = cellSpecs(closed, ctx.riskCapRupees);

  // Pass 1 over EVERYTHING that can be shown, so m is computed once.
  const allSpecs: CellSpec[] = [...specs];
  for (const f of fnoSpecs) for (const d of Object.values(f.dims)) if (d) allSpecs.push(...d);
  const built = allSpecs.map((s) => ({
    spec: s,
    cell: buildCell(s, ctx),
    rs: s.trades.map(rOf).filter(fin),
    kellyRs: kellySample(s.trades).map((t) => t.rMultiple as number),
  }));
  const testedCells = built.filter((b) => b.cell.tested);
  const m = testedCells.length;
  const by = benjaminiYekutieli(testedCells.map((b) => ({ item: b.cell.key, p: b.cell.pTwoSided ?? 1 })), ctx.q);
  const survives = new Set(by.filter((r) => r.significant).map((r) => r.item));
  for (const b of built) finishCell(b.cell, survives.has(b.cell.key), m, ctx, b.rs, b.kellyRs);

  const byKey = new Map(built.map((b) => [b.cell.key, b.cell]));
  const cells = specs.map((s) => byKey.get(s.key)!);
  const fno: FnoCuts[] = fnoSpecs.map((f) => ({
    segment: f.segment,
    dte: f.dims.dte!.map((s) => byKey.get(s.key)!),
    side: f.dims.side ? f.dims.side.map((s) => byKey.get(s.key)!) : null,
    lots: f.dims.lots!.map((s) => byKey.get(s.key)!),
    expiryRegime: f.dims.expiryRegime!.map((s) => byKey.get(s.key)!),
    unknownDte: f.unknownDte,
    unknownLots: f.unknownLots,
    oneLotOverCap: f.oneLotOverCap,
  }));

  const behaviour: SegmentBehaviour[] = segments.map((seg) => {
    const segTs = closed.filter((t) => t.segment === seg);
    const provLine = byKey.get(`${seg}|all`)!.copy.provenanceLine;
    return { segment: seg, checks: behaviourChecks(seg, segTs, ctx, provLine), hold: holdClock(seg, segTs, ctx, provLine) };
  });

  const provenance = closed.length ? rProvenanceCounts(closed.map(provenanceRowOf)) : { ...EMPTY_R_PROVENANCE };
  return {
    asOf: opts.today,
    params: { minN: ctx.minN, minArm: ctx.minArm, minKelly: ctx.minKelly, window: ctx.window, q: ctx.q, seed: ctx.seed },
    closedTrades: closed.length,
    openExcluded,
    m,
    multiplicity: { method: "BY", q: ctx.q, m },
    cells,
    fno,
    behaviour,
    deflation: deflation(built.map((b) => b.cell).filter((c) => c.tested), m, rProvenanceLine(provenance)),
    provenance,
    provenanceLine: rProvenanceLine(provenance),
    behaviourNote: NOT_CORRECTED,
  };
}

/** The engine's sample: closed rows with a finite net, in its chronological order. */
function closedChronological(trades: readonly ClinicTrade[]): ClinicTrade[] {
  return chronological(trades.filter((t) => !t.isOpen && Number.isFinite(t.netPnl)));
}

/**
 * The closed trades of ONE cell, in the engine's chronological order — exactly the
 * rows `edgeClinic` puts in the cell with that key (the same spec builder runs), so
 * an experiment's baseline and result (lib/analytics/edge-clinic-note.ts) read the
 * cell the report graded. Unknown key → []. Covers every kind, F&O cuts included.
 */
export function cellTrades(trades: readonly ClinicTrade[], key: string): ClinicTrade[] {
  const { specs, fnoSpecs } = cellSpecs(closedChronological(trades), null);
  const hit = specs.find((s) => s.key === key);
  if (hit) return hit.trades;
  for (const f of fnoSpecs) for (const d of Object.values(f.dims)) for (const s of d ?? []) if (s.key === key) return s.trades;
  return [];
}

interface FnoSpec {
  segment: Segment;
  dims: Record<FnoDimension, CellSpec[] | null>;
  unknownDte: number;
  unknownLots: number;
  oneLotOverCap: number | null;
}

/**
 * Every cell the report can show, over `closed` (already closed + chronological).
 *
 * Keys (v4.7.0 C2, a recorded format change): `all|all` the book · `${seg}|all` a
 * segment · `${seg}|setup:${tag}` a setup (prefixed so a tag literally named "all"
 * cannot collide with the segment cell) · `all|grade:${g}` a setup grade, ONLY for
 * grades present on a closed row · `${seg}|fno:${dim}:${label}` an F&O cut.
 */
function cellSpecs(closed: ClinicTrade[], cap: number | null): { segments: Segment[]; specs: CellSpec[]; fnoSpecs: FnoSpec[] } {
  // Segments and setups in a stable order.
  const segments = [...new Set(closed.map((t) => t.segment))].sort();
  const specs: CellSpec[] = [
    { key: "all|all", kind: "book", segment: null, setup: null, cut: null, label: "Whole book", trades: closed },
  ];
  const fnoSpecs: FnoSpec[] = [];

  for (const seg of segments) {
    const segTs = closed.filter((t) => t.segment === seg);
    const segLabel = SEGMENT_LABELS[seg];
    specs.push({ key: `${seg}|all`, kind: "segment", segment: seg, setup: null, cut: null, label: `${segLabel} · all setups`, trades: segTs });
    const setups = [...new Set(segTs.map((t) => t.setupTag ?? "untagged"))].sort();
    for (const setup of setups) {
      specs.push({
        key: `${seg}|setup:${setup}`,
        kind: "setup",
        segment: seg,
        setup,
        cut: null,
        label: `${segLabel} · ${setup}`,
        trades: segTs.filter((t) => (t.setupTag ?? "untagged") === setup),
      });
    }

    if (isFnoSegment(seg)) {
      const mk = (dimension: FnoDimension, label: string, ts: ClinicTrade[]): CellSpec => ({
        key: `${seg}|fno:${dimension}:${label}`,
        kind: "fno",
        segment: seg,
        setup: null,
        cut: { dimension, label },
        label: `${segLabel} · ${label}`,
        trades: ts,
      });
      const withDte = segTs.filter((t) => fin(t.entryDte) && t.entryDte >= 0);
      const dte = DTE_BANDS.map((b) => mk("dte", `DTE ${b.label}`, withDte.filter((t) => t.entryDte! >= b.minDte && t.entryDte! <= b.maxDte)));
      const side = isOptionSegment(seg)
        ? [
            mk("side", "buyer", segTs.filter((t) => sideOf(t) === "long")),
            mk("side", "seller", segTs.filter((t) => sideOf(t) === "short")),
          ]
        : null;
      const lotted = segTs.map((t) => ({ t, lots: lotsOf(t) }));
      const lots = [
        mk("lots", "1 lot", lotted.filter((x) => x.lots === 1).map((x) => x.t)),
        mk("lots", "2–3 lots", lotted.filter((x) => x.lots != null && x.lots >= 2 && x.lots <= 3).map((x) => x.t)),
        mk("lots", "4+ lots", lotted.filter((x) => x.lots != null && x.lots >= 4).map((x) => x.t)),
      ];
      const dated = segTs.map((t) => ({ t, d: dayOf(t.sellDate) })).filter((x) => x.d != null);
      const expiryRegime = [
        mk("expiryRegime", `before ${FNO_WEEKLY_EXPIRY_CUT}`, dated.filter((x) => x.d! < FNO_WEEKLY_EXPIRY_CUT).map((x) => x.t)),
        mk("expiryRegime", `from ${FNO_WEEKLY_EXPIRY_CUT}`, dated.filter((x) => x.d! >= FNO_WEEKLY_EXPIRY_CUT).map((x) => x.t)),
      ];
      fnoSpecs.push({
        segment: seg,
        dims: { dte, side, lots, expiryRegime },
        unknownDte: segTs.length - withDte.length,
        unknownLots: lotted.filter((x) => x.lots == null).length,
        oneLotOverCap: fin(cap)
          ? lotted.filter((x) => x.lots === 1 && fin(x.t.riskAmount) && x.t.riskAmount > cap).length
          : null,
      });
    }
  }

  // Setup grades (v4.7.0 C2): whole-book cells, ONLY for grades present — an
  // ungraded book's cells, m and BY family are exactly C1's. They are ordinary
  // cells: tested at nWithR ≥ minN, counted in m, corrected with the rest, and
  // eligible for deflation — so grading RAISES m and can demote a borderline
  // established cell elsewhere (recorded in DECISIONS, C2).
  for (const g of SETUP_GRADES) {
    const ts = closed.filter((t) => t.setupGrade === g);
    if (ts.length === 0) continue;
    specs.push({ key: `all|grade:${g}`, kind: "grade", segment: null, setup: null, setupGrade: g, cut: null, label: `Grade ${g} setups`, trades: ts });
  }
  return { segments, specs, fnoSpecs };
}

/**
 * Deflate the best tested cell's Sharpe for having picked it out of m.
 * N = m is an UPPER bound on the independent trials — the cells overlap (the
 * book contains every segment), so the effective count is smaller and the
 * deflation is conservative.
 */
function deflation(tested: ClinicCell[], m: number, provLine: string): Deflation | null {
  const withSr = tested.filter((c) => c.sr != null);
  if (m < 2 || withSr.length < 2) return null;
  const srs = withSr.map((c) => c.sr as number);
  const best = withSr.reduce((a, c) => ((c.sr as number) > (a.sr as number) ? c : a));
  const varOfTrialSRs = S.populationVariance(srs);
  const eMax = S.expectedMaxSr(varOfTrialSRs, m);
  if (eMax == null) return null;
  const dsr = best.g3 != null && best.g4 != null ? S.psr(best.sr as number, eMax, best.nWithR, best.g3, best.g4) : null;
  const withinLuck = dsr != null ? dsr < 0.95 : null;
  const headline =
    withinLuck == null
      ? `${best.label}: too few trades to deflate its Sharpe`
      : withinLuck
        ? `${best.label}: its edge is within what ${m} tries produce by luck`
        : `${best.label}: its edge holds after deflating for ${m} tries`;
  return {
    bestCellKey: best.key,
    bestSr: best.sr as number,
    nTrials: m,
    varOfTrialSRs,
    expectedMaxSr: eMax,
    psr: best.psr,
    deflatedSr: dsr,
    withinLuck,
    copy: {
      headline,
      detail: `Best per-trade Sharpe ${(best.sr as number).toFixed(2)} against an expected best-of-${m} of ${eMax.toFixed(2)} under no edge${dsr != null ? `; deflated Sharpe ${dsr.toFixed(3)}` : ""}. The ${m} cells overlap, so ${m} is an upper bound on independent tries.`,
      provenanceLine: provLine,
    },
  };
}
