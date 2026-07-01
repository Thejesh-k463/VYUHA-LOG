// IND-4 — Advance-tax planner (PURE, no DB/React).
//
// Indian advance-tax falls due in four instalments: 15 Jun / 15 Sep / 15 Dec / 15 Mar,
// at cumulative 15% / 45% / 75% / 100% of the year's tax. Shortfalls attract §234C
// interest (1%/month: 3 months on the first three instalments, 1 month on the last).
// (§234B — 1%/month from 1 Apr of the assessment year if <90% is paid by year-end —
// is only assessable after the FY closes, so a forward planner surfaces it as a caveat
// rather than a number.) This is a planning estimate, not filing advice.

export interface AdvanceTaxInput {
  estimatedAnnualTax: number; // total estimated tax for the FY
  taxPaidToDate: number; // advance tax already paid (cumulative)
  today: string; // ISO date
  fyStartMonth?: number; // 1-12, default 4 (April)
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
  monthsForInterest: number; // 234C months (3/3/3/1)
  interest234C: number; // ₹ estimated 234C interest on this instalment
}

export interface AdvanceTaxPlan {
  fyLabel: string; // "2026-27"
  estimatedAnnualTax: number;
  taxPaidToDate: number;
  instalments: Instalment[];
  nextDue: Instalment | null; // first not-yet-due instalment
  paidPct: number; // taxPaidToDate / estimatedAnnualTax
  totalShortfallNow: number; // cumRequired of latest due instalment − paid
  interest234C: number; // Σ instalment 234C
  underpaid234B: boolean; // <90% paid — would attract §234B after year-end
  totalWithInterest: number; // estimatedAnnualTax + 234C
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

  // Standard advance-tax due dates (assumes April-start FY).
  const defs = [
    { quarter: 1, label: "15 Jun", date: iso(fyStartYear, 6, 15), cumPct: 15, months: 3 },
    { quarter: 2, label: "15 Sep", date: iso(fyStartYear, 9, 15), cumPct: 45, months: 3 },
    { quarter: 3, label: "15 Dec", date: iso(fyStartYear, 12, 15), cumPct: 75, months: 3 },
    { quarter: 4, label: "15 Mar", date: iso(fyEndYear, 3, 15), cumPct: 100, months: 1 },
  ];

  let prevCum = 0;
  const instalments: Instalment[] = defs.map((d) => {
    const cumRequired = rupee((est * d.cumPct) / 100);
    const instalmentAmount = cumRequired - prevCum;
    prevCum = cumRequired;
    const isDue = today >= d.date;
    const shortfall = isDue ? Math.max(0, cumRequired - paid) : 0;
    const interest234C = rupee(shortfall * 0.01 * d.months);
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
    };
  });

  const dueOnes = instalments.filter((i) => i.isDue);
  const latestDue = dueOnes[dueOnes.length - 1] ?? null;
  const nextDue = instalments.find((i) => !i.isDue) ?? null;
  const interest234C = instalments.reduce((s, i) => s + i.interest234C, 0);

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
  };
}
