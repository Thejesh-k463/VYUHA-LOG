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
// PRESUMPTIVE — s.408 read with s.58 (old S.211(1)(b) with S.44AD/44ADA): an
// assessee who has elected the presumptive scheme pays the WHOLE advance tax in
// one instalment by 15 March, and s.425 charges one month at 1% on a shortfall
// after that date. Opt-in via `presumptive` — the election cannot be derived
// from trade data, so the caller asserts it.
//
// PAYMENT DATING — the simplification above is now CONDITIONAL (v3.7 WS4).
// `taxPaidToDate` is a single cumulative figure applied to every instalment, so
// a payment made late in the year is treated as though it were available at
// every earlier due date. That holds ONLY when `payments` is absent — or empty,
// which means the same thing: a ledger with no rows in it has said nothing, so
// it cannot overrule the figure the caller typed. That is still the whole of
// the localStorage calculator path.
//
// Supply `payments` — the dated challan ledger (`lib/queries/challans.ts`) —
// and each rung is measured against what was actually paid ON OR BEFORE ITS OWN
// DUE DATE: a March payment no longer clears a June shortfall, the s.425(2)
// safe harbours test 12%/36% against what stood on 15 June / 15 September, and
// `taxPaidToDate` becomes the FY total of the ledger. s.408(3) draws the outer
// line: anything paid by 31 March counts as advance tax, so a payment dated
// after it is excluded from every rung and named in `notes` as self-assessment
// tax. Nothing else in the arithmetic changes — the scalar path is byte-for-
// byte what it was.
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
  /**
   * Presumptive-scheme election (s.58 of the 2025 Act; old S.44AD/44ADA).
   * s.408 gives such an assessee a SINGLE instalment — 100% of the advance tax
   * by 15 March — and s.425 then charges one month's interest (1%) on any
   * shortfall after that date; the Jun/Sep/Dec ladder and its s.425(2) safe
   * harbours do not apply. Caller-asserted: the election is a filing choice
   * the journal cannot derive from trade data.
   */
  presumptive?: boolean;
  /**
   * The DATED challan ledger for this FY, amounts in RUPEES. When supplied it
   * replaces `taxPaidToDate` entirely: each instalment is measured against the
   * payments made on or before its own due date, and the FY total (everything
   * dated on or before 31 March, s.408(3)) becomes the plan's `taxPaidToDate`.
   * Absent — or EMPTY, which is a ledger saying nothing rather than a ledger
   * saying zero — every existing code path is unchanged and `taxPaidToDate`
   * stands.
   */
  payments?: { date: string; amount: number }[];
}

export interface Instalment {
  quarter: number; // 1..4
  label: string; // "15 Jun" etc.
  dueDate: string; // ISO
  cumPct: number; // 15 / 45 / 75 / 100
  cumRequired: number; // ₹ cumulative required by this date
  instalmentAmount: number; // ₹ due this quarter (marginal)
  isDue: boolean; // due date has passed
  /**
   * ₹ treated as paid AT THIS DUE DATE. With `payments` it is the dated total
   * on or before `dueDate`; without them it is the single `taxPaidToDate`
   * scalar repeated on every rung — the simplification, stated as data.
   */
  paidAsOfDue: number;
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
  const today = input.today;
  const [ty, tm] = today.split("-").map(Number);

  // Financial year start year: if we're before the FY start month, the FY began last year.
  const fyStartYear = tm >= fyStartMonth ? ty : ty - 1;
  const fyEndYear = fyStartYear + 1;
  const fyLabel = `${fyStartYear}-${String(fyEndYear).slice(2)}`;

  // s.408(3): only what is paid by 31 March of the FY is advance tax at all.
  // Anything after that date is self-assessment tax — excluded from every rung
  // and named in the notes rather than quietly dropped.
  const fyEnd = iso(fyEndYear, 3, 31);
  // An EMPTY ledger is not a statement that nothing was paid — it is the ledger
  // saying nothing (invariant 6), which is exactly what challanTotalsByFy
  // returns for an FY with no challans transcribed yet. Treating `[]` as "₹0,
  // dated" discarded the caller's own `taxPaidToDate` and charged interest on
  // money the user had told us about: {taxPaidToDate: 900000, payments: []}
  // reported ₹0 paid and ₹50,500 of s.425 interest instead of ₹0. The guard
  // belongs HERE, at the boundary, not at one call site that remembers it.
  const dated = input.payments && input.payments.length > 0 ? input.payments : null;
  const advancePayments = dated?.filter((p) => p.date <= fyEnd) ?? null;
  const latePayments = dated?.filter((p) => p.date > fyEnd) ?? [];
  const sumOf = (ps: { amount: number }[]) => Math.max(0, ps.reduce((s, p) => s + p.amount, 0));

  const paid = advancePayments ? sumOf(advancePayments) : Math.max(0, input.taxPaidToDate);
  /** ₹ paid on or before `d`. Without a ledger every rung sees the same scalar. */
  const paidAsOf = (d: string) =>
    advancePayments ? sumOf(advancePayments.filter((p) => p.date <= d)) : paid;

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
  // Under the presumptive election the ladder collapses to the statutory single
  // instalment: 100% by 15 March, one month's interest on a shortfall after it.
  const defs = input.presumptive
    ? [{ quarter: 1, label: "15 Mar", date: iso(fyEndYear, 3, 15), cumPct: 100, months: 1, harbour: null as number | null }]
    : [
        { quarter: 1, label: "15 Jun", date: iso(fyStartYear, 6, 15), cumPct: 15, months: 3, harbour: 12 as number | null },
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
    // The rung's own clock: what stood paid on or before ITS due date.
    const paidByDue = paidAsOf(d.date);
    const shortfall = isDue ? Math.max(0, cumRequired - paidByDue) : 0;

    // s.425(2) is measured against the tax due on the RETURNED income — the full
    // figure — not against the relief-reduced interest base.
    const safeHarbourMet = d.harbour != null && est > 0 && paidByDue >= (est * d.harbour) / 100;

    const interestShortfall = isDue
      ? Math.max(0, rupee((interestBase * d.cumPct) / 100) - paidByDue)
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
      paidAsOfDue: rupee(paidByDue),
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
  if (advancePayments) {
    notes.push(
      `Each instalment above is measured against your DATED payments — only what was paid on or before that rung's own due date counts towards it (${instalmentsS}), and the ${deferment} safe harbours test 12% against 15 June and 36% against 15 September on the same basis. ₹${rupee(paid).toLocaleString("en-IN")} across ${advancePayments.length} payment${advancePayments.length === 1 ? "" : "s"} is the FY total.`,
    );
  }
  if (latePayments.length > 0) {
    const lateTotal = rupee(sumOf(latePayments));
    const when = [...latePayments].map((p) => p.date).sort().join(", ");
    notes.push(
      `₹${lateTotal.toLocaleString("en-IN")} dated after 31 March ${fyEndYear} (${when}) is NOT advance tax for ${fyLabel}: ${instalmentsS} counts only what is paid by 31 March. It is excluded from every instalment above and from the paid total — on the return it is self-assessment tax.`,
    );
  }
  if (input.presumptive) {
    notes.push(
      `Presumptive scheme (${st.sections.presumptive}) asserted: the whole advance tax falls due in ONE instalment — 100% by 15 March (${instalmentsS}). ${deferment} then charges a single month's interest (1%) on any shortfall after that date; the June/September/December instalments and their safe harbours do not apply. The election itself is yours to make and to sustain — this planner takes it as asserted.`,
    );
  }
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
    // "Now" is today, not the rung's due date: a payment made since 15 June has
    // closed part of the June gap even though it did not stop the interest.
    totalShortfallNow: latestDue ? Math.max(0, latestDue.cumRequired - paidAsOf(today)) : 0,
    interest234C,
    underpaid234B: est > 0 && paid < 0.9 * est,
    totalWithInterest: rupee(est + interest234C),
    reliefApplied,
    notes,
  };
}
