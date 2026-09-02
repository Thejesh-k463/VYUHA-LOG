// ITR SCHEDULE-FORMAT EXPORT (PURE, no DB/React).
//
// `lib/analytics/itr.ts` answers "how does my book split across tax heads?".
// This module answers the next question, which is the one that actually costs a
// trader time every July: "what goes in which BOX of the return?"
//
// It emits line items shaped like the ITR's own schedules — Schedule CG (A3 for
// STCG u/s 111A, B4 for LTCG u/s 112A), Schedule BP for the two business heads,
// and Schedule CFL for carry-forward — using the ITR's own wording and item
// codes, so a CA can read across from this to the utility without translating.
//
// ── Two rules that make this more than a re-labelling ────────────────────────
//
// 1. STT IS NOT DEDUCTIBLE AGAINST CAPITAL GAINS. The proviso to S.48 excludes
//    securities transaction tax from the cost/expenditure allowed against a
//    capital gain, while brokerage, exchange fees, GST, stamp duty and DP
//    charges remain allowable as "expenditure wholly and exclusively in
//    connection with the transfer". Vyuha stores the charge breakdown per
//    trade, so the split is a fact here rather than an estimate — and it is a
//    rule a naive export WOULD get wrong, because everywhere else in this app
//    `netPnl` is correctly net of every charge including STT.
//
//    NOTE the asymmetry: STT *is* an allowable business expense for the
//    speculative and F&O heads. Same rupees, different treatment, decided by
//    which head the trade falls under.
//
// 2. CONSIDERATION AND COST ARE REPORTED GROSS. Schedule CG wants full value of
//    consideration and cost of acquisition as separate figures, not a net gain.
//    Anything that reports only the net loses the two numbers the schedule
//    actually asks for.
//
// Everything here remains a PREPARATION AID. The cautions are part of the
// output on purpose; they are not decoration to be stripped by a caller.

import {
  capitalGainsRatesFor,
  grandfatheredCost,
  isGrandfatherEligible,
  classifyTerm,
  RATE_CUTOVER_DATE,
  type CarryForwardLot,
} from "./capital-gains";
import { DELIVERY_SEGMENTS, FNO_SEGMENTS, turnoverContribution } from "./turnover";
// Citations are resolved BY TAX YEAR — a 2023-24 pack must keep its 1961 Act
// sections, not be retro-labelled with the 2025 Act's.
import { section, statuteNote } from "./statute";

export interface ItrScheduleTrade {
  segment: string;
  buyDate: string | null;
  sellDate: string | null;
  /** Actual cost, pre-charge. */
  buyValue: number;
  /** Full value of consideration, pre-charge. */
  sellValue: number;
  /** Pre-charge trade difference. Turnover is built from gross, never net. */
  grossPnl: number;
  netPnl: number;
  chargesTotal: number;
  /** Excluded from capital-gains deductions — S.48 proviso, now s.72(3)(b). */
  sttCtt: number;
  fmv31Jan2018?: number | null;
  isOpen: boolean;
}

export interface ScheduleLine {
  /** "Schedule CG" | "Schedule BP" | "Schedule CFL" | "Audit" */
  schedule: string;
  /** The ITR's own item code, e.g. "A3(a)" or "B4(b)(i)". Blank for headings. */
  code: string;
  /** The ITR's own wording for that item. */
  label: string;
  /** null where the app genuinely cannot supply the figure — never a guessed 0. */
  amount: number | null;
  note?: string;
}

export interface ItrScheduleFy {
  fy: string;
  /** Which return the book implies: any business head forces ITR-3. */
  itrForm: "ITR-2" | "ITR-3";
  formReason: string;
  lines: ScheduleLine[];
  cautions: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const FNO = FNO_SEGMENTS;
const DELIVERY = DELIVERY_SEGMENTS;

function fyOf(dateStr: string | null, fyStartMonth: number, fallback: string): string {
  if (!dateStr) return fallback;
  const d = new Date(dateStr + "T00:00:00");
  const start = d.getMonth() + 1 >= fyStartMonth ? d.getFullYear() : d.getFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/**
 * Deductible transfer expenditure: every charge EXCEPT STT.
 * S.48 proviso under the 1961 Act; s.72(3)(b) under the 2025 Act — the rule is
 * unchanged, and note both name only STT, never CTT.
 */
export function transferExpenditure(t: { chargesTotal: number; sttCtt: number }): number {
  return r2(Math.max(0, t.chargesTotal - t.sttCtt));
}

interface CgBucket {
  trades: number;
  consideration: number;
  cost: number;
  expenditure: number;
  stt: number;
  /** Set when at least one lot used a 31-Jan-2018 FMV. */
  grandfatheredLots: number;
}

const emptyCg = (): CgBucket => ({ trades: 0, consideration: 0, cost: 0, expenditure: 0, stt: 0, grandfatheredLots: 0 });

interface BpBucket {
  trades: number;
  turnover: number;
  net: number;
  expenses: number;
}

const emptyBp = (): BpBucket => ({ trades: 0, turnover: 0, net: 0, expenses: 0 });

/**
 * Build ITR schedule line items per financial year, oldest first.
 *
 * @param carryForwardByFy carry-forward lots produced by
 *   `computeTaxTimeline`, keyed by the FY whose return should REPORT them.
 *   Omitted entirely, Schedule CFL is emitted with nulls and a caution rather
 *   than zeros — "no losses" and "not supplied" are different answers.
 */
export function itrScheduleByFy(
  trades: ItrScheduleTrade[],
  fyStartMonth = 4,
  fallbackFy = "2026-27",
  carryForwardByFy?: Map<string, CarryForwardLot[]>,
): ItrScheduleFy[] {
  const map = new Map<
    string,
    { st: CgBucket; lt: CgBucket; spec: BpBucket; fno: BpBucket; sellDates: string[] }
  >();

  for (const t of trades) {
    if (t.isOpen) continue;
    const fy = fyOf(t.sellDate ?? t.buyDate, fyStartMonth, fallbackFy);
    const b =
      map.get(fy) ?? { st: emptyCg(), lt: emptyCg(), spec: emptyBp(), fno: emptyBp(), sellDates: [] };
    if (t.sellDate) b.sellDates.push(t.sellDate);

    if (DELIVERY.has(t.segment)) {
      const term = classifyTerm(t.buyDate, t.sellDate);
      const bucket = term === "LT" ? b.lt : b.st;
      // Grandfathering raises the cost basis of a pre-2018 lot; it never lowers it.
      const eligible = term === "LT" && isGrandfatherEligible(t.buyDate);
      const cost = eligible ? grandfatheredCost(t.buyValue, t.fmv31Jan2018 ?? null, t.sellValue) : t.buyValue;
      if (eligible && cost !== t.buyValue) bucket.grandfatheredLots++;
      bucket.trades++;
      bucket.consideration = r2(bucket.consideration + t.sellValue);
      bucket.cost = r2(bucket.cost + cost);
      bucket.expenditure = r2(bucket.expenditure + transferExpenditure(t));
      bucket.stt = r2(bucket.stt + t.sttCtt);
    } else if (t.segment === "eq_intraday" || FNO.has(t.segment)) {
      const bucket = t.segment === "eq_intraday" ? b.spec : b.fno;
      bucket.trades++;
      bucket.net = r2(bucket.net + t.netPnl);
      // Shared method — see lib/analytics/turnover.ts. This used |NET P&L|, which
      // is after charges and therefore wrong under every edition of the Guidance
      // Note; and it omitted option premium. Corrected 2026-08-31.
      bucket.turnover = r2(bucket.turnover + turnoverContribution(t));
      // STT is an allowable business expense for these heads, unlike capital gains.
      bucket.expenses = r2(bucket.expenses + t.chargesTotal);
    }
    map.set(fy, b);
  }

  return [...map.entries()]
    .map(([fy, b]) => buildFy(fy, b, carryForwardByFy))
    .sort((a, b) => a.fy.localeCompare(b.fy));
}

function buildFy(
  fy: string,
  b: { st: CgBucket; lt: CgBucket; spec: BpBucket; fno: BpBucket; sellDates: string[] },
  carryForwardByFy?: Map<string, CarryForwardLot[]>,
): ItrScheduleFy {
  const lines: ScheduleLine[] = [];
  const cautions: string[] = [];

  // The 112A exemption belongs to the FY. Where an FY straddles the 23-Jul-2024
  // rate cutover, the regime is taken from the LAST sale in the year and the
  // approximation is stated rather than hidden.
  const sorted = [...b.sellDates].sort();
  const lastSale = sorted[sorted.length - 1] ?? `${fy.slice(0, 4)}-03-31`;
  const rates = capitalGainsRatesFor(lastSale);
  const straddles = sorted.length > 0 && sorted[0] < RATE_CUTOVER_DATE && lastSale >= RATE_CUTOVER_DATE;

  // ── Schedule CG · A3 — STCG u/s 111A ──────────────────────────────────────
  if (b.st.trades > 0) {
    const balance = r2(b.st.consideration - b.st.cost - b.st.expenditure);
    lines.push(
      { schedule: "Schedule CG", code: "A3", label: "STCG on equity shares/units where STT is paid (u/s 111A)", amount: null },
      { schedule: "Schedule CG", code: "A3(a)", label: "Full value of consideration", amount: b.st.consideration },
      { schedule: "Schedule CG", code: "A3(b)(i)", label: "Cost of acquisition without indexation", amount: b.st.cost },
      { schedule: "Schedule CG", code: "A3(b)(ii)", label: "Cost of improvement", amount: 0, note: "Not applicable to listed securities." },
      {
        schedule: "Schedule CG",
        code: "A3(b)(iii)",
        label: "Expenditure wholly and exclusively in connection with transfer",
        amount: b.st.expenditure,
        note: `Excludes STT of ₹${b.st.stt.toLocaleString("en-IN")} — not allowable against capital gains (proviso to S.48).`,
      },
      { schedule: "Schedule CG", code: "A3(c)", label: "Balance (a − b) — short-term capital gain", amount: balance },
    );
  }

  // ── Schedule CG · B4 — LTCG u/s 112A ──────────────────────────────────────
  if (b.lt.trades > 0) {
    const before = r2(b.lt.consideration - b.lt.cost - b.lt.expenditure);
    const exemption = before > 0 ? r2(Math.min(before, rates.ltcgExemption)) : 0;
    lines.push(
      { schedule: "Schedule CG", code: "B4", label: "LTCG on equity shares/units where STT is paid (u/s 112A)", amount: null },
      { schedule: "Schedule CG", code: "B4(a)", label: "Full value of consideration", amount: b.lt.consideration },
      {
        schedule: "Schedule CG",
        code: "B4(b)(i)",
        label: "Cost of acquisition without indexation",
        amount: b.lt.cost,
        note: b.lt.grandfatheredLots > 0
          ? `${b.lt.grandfatheredLots} lot(s) use the 31-Jan-2018 grandfathered cost.`
          : undefined,
      },
      {
        schedule: "Schedule CG",
        code: "B4(b)(iii)",
        label: "Expenditure wholly and exclusively in connection with transfer",
        amount: b.lt.expenditure,
        note: `Excludes STT of ₹${b.lt.stt.toLocaleString("en-IN")} — not allowable against capital gains (proviso to S.48).`,
      },
      { schedule: "Schedule CG", code: "B4(c)", label: "Long-term capital gain before exemption", amount: before },
      {
        schedule: "Schedule CG",
        code: "B4(d)",
        label: `Deduction u/s ${section(fy, "ltcgEquity")} (exemption threshold ₹${rates.ltcgExemption.toLocaleString("en-IN")})`,
        amount: exemption,
        note: "FY-level exemption across ALL your 112A gains — if you hold equity outside this journal, the threshold is shared.",
      },
      { schedule: "Schedule CG", code: "B4(e)", label: "Net long-term capital gain (c − d)", amount: r2(before - exemption) },
    );
  }

  // ── Schedule BP — business heads ──────────────────────────────────────────
  if (b.spec.trades > 0) {
    lines.push(
      { schedule: "Schedule BP", code: "BP-SPEC", label: `Speculative business income — intraday equity (${section(fy, "speculative")})`, amount: b.spec.net },
      { schedule: "Schedule BP", code: "BP-SPEC-TO", label: "Speculative turnover (ICAI Guidance Note, 11th ed.)", amount: b.spec.turnover },
      {
        schedule: "Schedule BP",
        code: "BP-SPEC-EXP",
        label: "Expenses debited — brokerage, statutory charges and GST",
        amount: b.spec.expenses,
        note: "Already netted into the income figure above; shown separately for the P&L account.",
      },
    );
  }
  if (b.fno.trades > 0) {
    lines.push(
      { schedule: "Schedule BP", code: "BP-NONSPEC", label: `Non-speculative business income — F&O (${section(fy, "derivativeCarveOut")})`, amount: b.fno.net },
      { schedule: "Schedule BP", code: "BP-NONSPEC-TO", label: "Non-speculative turnover (ICAI Guidance Note, 11th ed.)", amount: b.fno.turnover },
      {
        schedule: "Schedule BP",
        code: "BP-NONSPEC-EXP",
        label: "Expenses debited — brokerage, statutory charges and GST",
        amount: b.fno.expenses,
        note: "Already netted into the income figure above; shown separately for the P&L account.",
      },
    );
  }

  // ── Schedule CFL — carry forward of losses ────────────────────────────────
  if (carryForwardByFy) {
    const lots = carryForwardByFy.get(fy) ?? [];
    if (lots.length === 0) {
      lines.push({ schedule: "Schedule CFL", code: "CFL", label: "No losses to carry forward from this year", amount: 0 });
    } else {
      for (const lot of lots) {
        const window = lot.bucket === "speculative" ? 4 : 8;
        const expires = `${Number(lot.fyIncurred.slice(0, 4)) + window}-${String((Number(lot.fyIncurred.slice(0, 4)) + window + 1) % 100).padStart(2, "0")}`;
        lines.push({
          schedule: "Schedule CFL",
          code: `CFL-${lot.bucket}`,
          label: `${CFL_LABEL[lot.bucket]} incurred in FY ${lot.fyIncurred}`,
          amount: r2(lot.amount),
          note: `Carry-forward window ${window} years — lapses after FY ${expires}. Requires the return to be filed by the due date.`,
        });
      }
    }
  } else {
    lines.push({
      schedule: "Schedule CFL",
      code: "CFL",
      label: "Carry-forward of losses",
      amount: null,
      note: "Not supplied to this export — run the set-off engine on the Tax Summary page for carry-forward figures.",
    });
  }

  // ── Which form? ───────────────────────────────────────────────────────────
  const hasBusiness = b.spec.trades > 0 || b.fno.trades > 0;
  const hasCg = b.st.trades > 0 || b.lt.trades > 0;
  const itrForm = hasBusiness ? "ITR-3" : "ITR-2";
  const formReason = hasBusiness
    ? `Intraday and/or F&O produce business income, which ITR-2 cannot carry — ITR-3 (or ITR-4 if you elect presumptive taxation) is indicated${hasCg ? ", and it also carries the capital-gains schedule" : ""}.`
    : "Only capital gains this year, with no business head — ITR-2 is indicated.";

  // ── Cautions ──────────────────────────────────────────────────────────────
  cautions.push(
    "These are preparation figures in the ITR's own item codes, not a filed return. Your broker's contract notes and your CA remain the source of record.",
  );
  cautions.push(
    `STT is excluded from capital-gains deductions (${section(fy, "sttNotDeductibleCg")}) but IS included as a business expense for the speculative and F&O heads (${section(fy, "sttBusinessExpense")}). The same rupees are treated differently by head — this is deliberate.`,
  );
  // Which Act governed this year. A pack spanning the changeover needs this more
  // than any single citation does.
  cautions.push(statuteNote(fy));
  if (straddles) {
    cautions.push(
      `FY ${fy} straddles the 23-Jul-2024 rate cutover. The 112A exemption above uses the regime in force at the LAST sale of the year; gains realised on either side of the cutover carry different rates, so verify the split with your CA.`,
    );
  }
  if (b.lt.trades > 0 && b.lt.grandfatheredLots === 0) {
    cautions.push(
      "No lot claimed a 31-Jan-2018 grandfathered cost. If you hold equity bought before that date, enter its FMV on the Tax Summary page or the LTCG cost here is understated.",
    );
  }
  if (hasCg) {
    cautions.push(
      "Capital-gains figures cover only trades recorded in this journal. Equity held in another demat, and any buyback, bonus-stripping or off-market transfer, will not appear.",
    );
  }

  return { fy, itrForm, formReason, lines, cautions };
}

const CFL_LABEL: Record<CarryForwardLot["bucket"], string> = {
  speculative: "Speculative business loss",
  nonSpeculative: "Non-speculative business loss",
  stcl: "Short-term capital loss",
  ltcl: "Long-term capital loss",
};

/** Flatten every FY into export rows for CSV/XLSX. */
export function scheduleExportRows(packs: ItrScheduleFy[]) {
  return packs.flatMap((p) =>
    p.lines.map((l) => ({
      fy: p.fy,
      form: p.itrForm,
      schedule: l.schedule,
      code: l.code,
      label: l.label,
      amount: l.amount ?? "",
      note: l.note ?? "",
    })),
  );
}

// ── Taxes paid — the advance-tax challan schedule (v3.7, WS4) ────────────────
//
// WHY IT LIVES HERE. The return's own "Schedule IT — Details of Advance Tax and
// Self-Assessment Tax Payments" asks for exactly four columns per challan: BSR
// code, date of deposit, serial number, amount. That is the same question this
// module already answers for CG/BP/CFL — "what goes in which BOX?" — and, more
// importantly, it is governed by the same rule this module exists to enforce:
// `amount: number | null`, where null EXPORTS BLANK and never 0 (invariant 6).
// A journal with no challan recorded has not observed a nil payment; it has
// observed nothing, and Schedule IT is the one schedule where the difference is
// money — a fabricated 0 invites a s.424 interest computation on a balance the
// user actually paid. Keeping it beside `scheduleExportRows` keeps ONE
// blank-vs-zero contract instead of two that can drift.
//
// PURE, like the rest of the file: the ledger rows arrive as plain data from
// `lib/queries/challans.ts` (rupees at runtime, invariant 1 — no conversion
// here), and every citation resolves through `section(fy, …)` so a 2024-25 pack
// keeps S.211/S.234B/S.234C while a 2026-27 pack says s.408/s.424/s.425.

/** One transcribed challan, in the units and shape `lib/queries/challans.ts` returns. */
export interface TaxPaymentInput {
  fy: string;
  /** ISO date of deposit. */
  paidOn: string;
  /** ₹ paid — RUPEES. */
  amount: number;
  bsrCode?: string | null;
  challanSerial?: string | null;
  note?: string | null;
}

/** One Schedule IT row. Every field is nullable because a receipt may omit it. */
export interface TaxesPaidLine {
  /** BSR code of the receiving bank branch; null where the receipt omitted it. */
  bsrCode: string | null;
  /** Date of deposit; null only on the "nothing recorded" placeholder line. */
  paidOn: string | null;
  challanSerial: string | null;
  /** null ⇒ the journal has no challan to state here. NEVER a fabricated 0. */
  amount: number | null;
  note: string;
}

export interface TaxesPaidFy {
  fy: string;
  /** How many challans the journal holds for this FY. 0 ⇒ the placeholder line. */
  count: number;
  /** ₹ across the FY, or null when nothing is recorded — not 0 (invariant 6). */
  total: number | null;
  lines: TaxesPaidLine[];
  cautions: string[];
}

/**
 * Group the challan ledger into per-FY Schedule IT blocks, oldest FY first.
 *
 * @param payments the account's challans (any FY, any order).
 * @param fys FYs the surrounding pack covers. Each gets a block even with no
 *   challan, because "this year shows nothing" is the answer that has to be
 *   READ — an FY silently omitted looks like an FY with no tax due.
 */
export function taxesPaidByFy(payments: TaxPaymentInput[], fys: readonly string[] = []): TaxesPaidFy[] {
  const map = new Map<string, TaxPaymentInput[]>();
  for (const fy of fys) if (!map.has(fy)) map.set(fy, []);
  for (const p of payments) {
    const bucket = map.get(p.fy);
    if (bucket) bucket.push(p);
    else map.set(p.fy, [p]);
  }

  return [...map.entries()]
    .map(([fy, rows]) => buildTaxesPaidFy(fy, rows))
    .sort((a, b) => a.fy.localeCompare(b.fy));
}

function buildTaxesPaidFy(fy: string, rows: TaxPaymentInput[]): TaxesPaidFy {
  const instalments = section(fy, "advanceTaxInstalments");
  const shortPay = section(fy, "interestAdvanceTax");
  const deferment = section(fy, "interestDeferment");
  const cautions: string[] = [];

  if (rows.length === 0) {
    // The whole point of the module: blank, not zero. A 0 here would read as
    // "nil advance tax paid" and is a figure this journal has not observed.
    cautions.push(
      `Nothing is stated for FY ${fy} — this journal holds no challan for that year. A BLANK IS NOT A NIL PAYMENT: if you did pay, the amount is missing from this pack, and ${shortPay} interest would be computed on a balance you had already cleared. Check Form 26AS / AIS, or record the challans on the Advance tax planner.`,
    );
    return {
      fy,
      count: 0,
      total: null,
      lines: [
        {
          bsrCode: null,
          paidOn: null,
          challanSerial: null,
          amount: null,
          note: `No advance-tax challan recorded for FY ${fy}.`,
        },
      ],
      cautions,
    };
  }

  const sorted = [...rows].sort((a, b) => (a.paidOn === b.paidOn ? 0 : a.paidOn < b.paidOn ? -1 : 1));
  const lines: TaxesPaidLine[] = sorted.map((r) => ({
    bsrCode: r.bsrCode?.trim() ? r.bsrCode.trim() : null,
    paidOn: r.paidOn,
    challanSerial: r.challanSerial?.trim() ? r.challanSerial.trim() : null,
    amount: r2(r.amount),
    note: r.note?.trim() ? r.note.trim() : "",
  }));
  const total = r2(lines.reduce((s, l) => s + (l.amount ?? 0), 0));

  cautions.push(
    `Transcribed from your own receipts — verify each against Form 26AS / AIS before filing; a BSR code or serial mistyped here is mistyped on the return.`,
  );
  cautions.push(
    `${instalments} counts money paid by 31 March as advance tax for FY ${fy}; anything after that date is self-assessment tax and belongs in its own row, not this one.`,
  );
  cautions.push(
    `The DATES matter as much as the amounts: ${deferment} deferment interest is computed instalment by instalment from what stood paid on each due date, so a wrong date changes the interest even when the total is right.`,
  );
  const missingRefs = lines.filter((l) => l.bsrCode === null || l.challanSerial === null).length;
  if (missingRefs > 0) {
    cautions.push(
      `${missingRefs} of ${lines.length} challan${lines.length === 1 ? "" : "s"} here ${missingRefs === 1 ? "is" : "are"} missing a BSR code or serial number. Those columns are left BLANK rather than filled with a placeholder — the return needs the real ones from the receipt.`,
    );
  }

  return { fy, count: lines.length, total, lines, cautions };
}

/**
 * Flatten the Schedule IT blocks for CSV/XLSX.
 *
 * A null amount, BSR or serial exports as "" — the same blank-not-zero rule
 * `scheduleExportRows` applies, and the reason this function is not a caller's
 * inline `.map`.
 */
export function taxesPaidExportRows(packs: TaxesPaidFy[]) {
  return packs.flatMap((p) =>
    p.lines.map((l) => ({
      fy: p.fy,
      bsrCode: l.bsrCode ?? "",
      paidOn: l.paidOn ?? "",
      challanSerial: l.challanSerial ?? "",
      amount: l.amount ?? "",
      note: l.note,
    })),
  );
}
