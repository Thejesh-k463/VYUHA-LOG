// IND-4 — Advance-tax planner (PURE, no DB/React).
//
// Indian advance-tax falls due in four instalments: 15 Jun / 15 Sep / 15 Dec / 15 Mar,
// at cumulative 15% / 45% / 75% / 100% of the year's tax. Shortfalls attract deferment
// interest at 3% / 3% / 3% / 1% of the shortfall.
//
// ── Statute, verified 2026-08-31 ──────────────────────────────────────────
//
// The Income-tax Act, 2025 came into force on 1 April 2026 and repealed the 1961
// Act. §211 → s.408 (instalments), §234A/B/C → s.423 / s.424 / s.425. The Finance
// Act, 2026 (No. 4 of 2026, assented 30 Mar 2026) amends s.425 only at
// sub-section (5)(f) — a tax-credit cross-reference — so everything relied on
// below is the section as enacted.
//
// RATE: s.425(1)'s Table states FLAT rates of 3%, 3%, 3% and 1% in column E. The
// old §234C wording was 1% per month for three months, which is the SAME NUMBER.
// `monthsForInterest` × 1% is therefore still correct arithmetic and is kept so
// the historical years this planner can be pointed at stay right. Do not "fix"
// it into a single 3% multiplier and then also multiply by months.
//
// SAFE HARBOUR — s.425(2): no interest at all if the advance tax paid on or
// before 15 June is ≥12%, or on or before 15 September ≥36%, of the tax due on
// the returned income. THE FIRST TWO INSTALMENTS ONLY. There is no tolerance for
// December or March. This was previously not implemented, so the planner charged
// interest the statute does not.
//
// RELIEF — s.425(4): no interest on a shortfall caused by underestimating
// capital gains, casual income, dividend, or business income "accruing or
// arising for the FIRST TIME" — but ONLY IF the tax on that income is then paid
// in full in a remaining instalment or by 31 March. The conditions are
// CONJUNCTIVE, and there is no statutory "could not reasonably have estimated"
// test, so the payment test is what gets built. Note the trap: an ESTABLISHED
// F&O or intraday trader gets no relief on a windfall quarter, because their
// business income is not arising for the first time. Whether it is "first time"
// needs history predating the journal, so the caller must assert it — this
// module will not assume it.
//
// (s.424, old §234B — 1%/month if <90% is paid — is only assessable after the
// year closes, so a forward planner surfaces it as a caveat rather than a
// number. s.425(4) relief never touches it; the only protection there is
// s.408(3), under which anything paid by 31 March counts as advance tax.)
//
// KNOWN SIMPLIFICATION: `taxPaidToDate` is a single cumulative figure applied to
// every instalment, so a payment made late in the year is treated as though it
// were available at every earlier due date. Modelling this properly needs a
// dated challan ledger, which the journal does not hold.
//
// This is a planning estimate, not filing advice.

import { statuteForFy, statuteNote } from "./statute";

export interface AdvanceTaxInput {
  estimatedAnnualTax: number; // total estimated tax for the FY
  taxPaidToDate: number; // advance tax already paid (cumulative)
  today: string; // ISO date
  fyStartMonth?: number; // 1-12, default 4 (April)
  /**
   * s.425(4): tax on income the shortfall is attributable to — capital gains,
   * dividend, casual income, or FIRST-TIME business income. Caller-supplied
   * because "first time" cannot be derived from trade data alone.
   */
  reliefEligibleTax?: number;
  /**
   * s.425(4)(b): whether the tax on that income was actually paid in full in a
   * remaining instalment or by 31 March. The relief is CONJUNCTIVE — without
   * this it does not arise, so it defaults to false and the relief is not applied.
   */
  reliefTaxPaidInFull?: boolean;
}

export interface Instalment {
  quarter: number; // 1..4
  label: string; // "15 Jun" etc.
  dueDate: string; // ISO
  cumPct: number; // 15 / 45 / 75 / 100
  cumRequired: number; // ₹ cumulative required by this date
  instalmentAmount: number; // ₹ due this quarter (marginal)
  isDue: boolean; // due date has passed
  shortfall: number; // ₹ short vs cumRequired (0 if not yet due or fully paid)
  monthsForInterest: number; // s.425 rate as months × 1% (3/3/3/1)
  interest234C: number; // ₹ estimated s.425 interest on this instalment
  /** s.425(2) threshold for this instalment: 12 / 36, or null where none exists. */
  safeHarbourPct: number | null;
  /** True when s.425(2) is satisfied, so no interest arises on this instalment. */
  safeHarbourMet: boolean;
}

export interface AdvanceTaxPlan {
  fyLabel: string; // "2026-27"
  estimatedAnnualTax: number;
  taxPaidToDate: number;
  instalments: Instalment[];
  nextDue: Instalment | null; // first not-yet-due instalment
  paidPct: number; // taxPaidToDate / estimatedAnnualTax
  totalShortfallNow: number; // cumRequired of latest due instalment − paid
  interest234C: number; // Σ instalment s.425 interest
  underpaid234B: boolean; // <90% paid — would attract s.424 after year-end
  totalWithInterest: number; // estimatedAnnualTax + s.425 interest
  /** ₹ of tax excluded from the interest base under s.425(4). 0 unless asserted. */
  reliefApplied: number;
  /** Statutory caveats that belong ON SCREEN, not in this file. */
  notes: string[];
}

const rupee = (n: number) => Math.round(n);
const r2 = (n: number) => Math.round(n * 100) / 100;

function iso(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function computeAdvanceTax(input: AdvanceTaxInput): AdvanceTaxPlan {
  const fyStartMonth = input.fyStartMonth ?? 4;
  const est = Math.max(0, input.estimatedAnnualTax);
  const paid = Math.max(0, input.taxPaidToDate);
  const today = input.today;
  const [ty, tm] = today.split("-").map(Number);

  // Financial year start year: if we're before the FY start month, the FY began last year.
  const fyStartYear = tm >= fyStartMonth ? ty : ty - 1;
  const fyEndYear = fyStartYear + 1;
  const fyLabel = `${fyStartYear}-${String(fyEndYear).slice(2)}`;

  // s.425(4): the relief is conjunctive — the income must be of a qualifying
  // kind AND its tax actually paid in full by 31 March. Absent that assertion we
  // apply nothing, because assuming it would understate a real liability.
  const reliefApplied = input.reliefTaxPaidInFull
    ? rupee(Math.max(0, Math.min(input.reliefEligibleTax ?? 0, est)))
    : 0;
  // Interest runs on the shortfall net of relieved tax; the PAYMENT obligation
  // under s.408 is still on the full figure, so `cumRequired` keeps using `est`.
  const interestBase = Math.max(0, est - reliefApplied);

  // Standard advance-tax due dates (assumes April-start FY).
  // s.425(2) safe-harbour thresholds attach to the first two instalments ONLY.
  const defs = [
    { quarter: 1, label: "15 Jun", date: iso(fyStartYear, 6, 15), cumPct: 15, months: 3, harbour: 12 },
    { quarter: 2, label: "15 Sep", date: iso(fyStartYear, 9, 15), cumPct: 45, months: 3, harbour: 36 },
    { quarter: 3, label: "15 Dec", date: iso(fyStartYear, 12, 15), cumPct: 75, months: 3, harbour: null },
    { quarter: 4, label: "15 Mar", date: iso(fyEndYear, 3, 15), cumPct: 100, months: 1, harbour: null },
  ];

  let prevCum = 0;
  const instalments: Instalment[] = defs.map((d) => {
    const cumRequired = rupee((est * d.cumPct) / 100);
    const instalmentAmount = cumRequired - prevCum;
    prevCum = cumRequired;
    const isDue = today >= d.date;
    const shortfall = isDue ? Math.max(0, cumRequired - paid) : 0;

    // s.425(2) is measured against the tax due on the RETURNED income — the full
    // figure — not against the relief-reduced interest base.
    const safeHarbourMet = d.harbour != null && est > 0 && paid >= (est * d.harbour) / 100;

    const interestShortfall = isDue
      ? Math.max(0, rupee((interestBase * d.cumPct) / 100) - paid)
      : 0;
    const interest234C = safeHarbourMet ? 0 : rupee(interestShortfall * 0.01 * d.months);

    return {
      quarter: d.quarter,
      label: d.label,
      dueDate: d.date,
      cumPct: d.cumPct,
      cumRequired,
      instalmentAmount,
      isDue,
      shortfall,
      monthsForInterest: d.months,
      interest234C,
      safeHarbourPct: d.harbour,
      safeHarbourMet,
    };
  });

  const dueOnes = instalments.filter((i) => i.isDue);
  const latestDue = dueOnes[dueOnes.length - 1] ?? null;
  const nextDue = instalments.find((i) => !i.isDue) ?? null;
  const interest234C = instalments.reduce((s, i) => s + i.interest234C, 0);

  // Citations follow the Act that governed THIS year, not today's.
  const st = statuteForFy(fyLabel);
  const deferment = st.sections.interestDeferment;
  const shortPay = st.sections.interestAdvanceTax;
  const instalmentsS = st.sections.advanceTaxInstalments;

  const notes: string[] = [statuteNote(fyLabel)];
  const harbourHit = instalments.filter((i) => i.safeHarbourMet && i.isDue);
  if (harbourHit.length > 0) {
    notes.push(
      `No deferment interest arises on ${harbourHit.map((i) => i.label).join(" or ")} — the ${deferment} safe harbour waives it where at least 12% is paid by 15 June, or 36% by 15 September, of the tax due on the returned income. There is NO equivalent tolerance for the December or March instalments.`,
    );
  }
  if (reliefApplied > 0) {
    notes.push(
      `₹${reliefApplied.toLocaleString("en-IN")} has been excluded from the interest base under the ${deferment} relief, on your assertion that the tax on that income was paid in full by 31 March. The payment condition is part of the relief, not a formality — if it was not met, the interest above is understated.`,
    );
  } else {
    notes.push(
      `The ${deferment} relief can waive interest on a shortfall caused by underestimating capital gains, dividend or casual income — but only if the tax on it is paid in full in a remaining instalment or by 31 March. It also covers business income only where it arises for the FIRST TIME, so an established F&O or intraday trader does not get it on a windfall quarter. Not applied here.`,
    );
  }
  notes.push(
    `${shortPay} is assessed after the year closes and is NOT reduced by the ${deferment} relief. Anything paid by 31 March still counts as advance tax (${instalmentsS}).`,
  );

  return {
    fyLabel,
    estimatedAnnualTax: rupee(est),
    taxPaidToDate: rupee(paid),
    instalments,
    nextDue,
    paidPct: est > 0 ? r2((paid / est) * 100) : 0,
    totalShortfallNow: latestDue ? Math.max(0, latestDue.cumRequired - paid) : 0,
    interest234C,
    underpaid234B: est > 0 && paid < 0.9 * est,
    totalWithInterest: rupee(est + interest234C),
    reliefApplied,
    notes,
  };
}
