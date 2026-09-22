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
  RATE_CUTOVER_DATE,
  type CarryForwardLot,
} from "./capital-gains";
import {
  bucketFor,
  resolveCgHead,
  type CgAssetClass,
  type CgBucketKey,
  type CgHead,
} from "./cg-heads";
import { itrCgCodes, assessmentYearFor, type ItrForm } from "./itr-cg-codes";
import { DELIVERY_SEGMENTS, FNO_SEGMENTS, turnoverContribution } from "./turnover";
// Citations are resolved BY TAX YEAR — a 2023-24 pack must keep its 1961 Act
// sections, not be retro-labelled with the 2025 Act's.
import { section, statuteNote } from "./statute";

export interface ItrScheduleTrade {
  segment: string;
  /** REQUIRED from v4.5.0 — see `CapitalGainsTrade.assetClass`. */
  assetClass: CgAssetClass;
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
  /** Financing costs. Excluded from the capital-gains deduction for the same
   *  reason STT is: no court has held either to be transfer expenditure
   *  (dossier §G2). They remain inside `chargesTotal` for the business heads. */
  mtfInterest?: number;
  pledgeCharges?: number;
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
export function transferExpenditure(t: {
  chargesTotal: number;
  sttCtt: number;
  mtfInterest?: number;
  pledgeCharges?: number;
}): number {
  return r2(
    Math.max(
      0,
      t.chargesTotal - t.sttCtt - Math.max(0, t.mtfInterest ?? 0) - Math.max(0, t.pledgeCharges ?? 0),
    ),
  );
}

interface CgBucket {
  trades: number;
  consideration: number;
  cost: number;
  expenditure: number;
  stt: number;
  /** MTF interest + pledge charges NOT deducted from this bucket. */
  notDeducted: number;
  /** Set when at least one lot used a 31-Jan-2018 FMV. */
  grandfatheredLots: number;
  /** One representative resolved head, for the citation and the rate. */
  head: CgHead | null;
  /** Every distinct §G1 cell that landed here — more than one means the bucket
   *  spans a rate change and the reader must be told. */
  cells: Set<string>;
  /** Reasons a figure in this bucket cannot be priced. */
  blank: Set<string>;
}

const emptyCg = (): CgBucket => ({
  trades: 0, consideration: 0, cost: 0, expenditure: 0, stt: 0, notDeducted: 0,
  grandfatheredLots: 0, head: null, cells: new Set<string>(), blank: new Set<string>(),
});

type CgBuckets = Record<CgBucketKey, CgBucket>;
const emptyCgBuckets = (): CgBuckets => ({
  stcg111A: emptyCg(), stcgOther: emptyCg(), ltcg112A: emptyCg(), ltcg112: emptyCg(), cgUndetermined: emptyCg(),
});

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
    { cg: CgBuckets; spec: BpBucket; fno: BpBucket; sellDates: string[] }
  >();

  for (const t of trades) {
    if (t.isOpen) continue;
    const fy = fyOf(t.sellDate ?? t.buyDate, fyStartMonth, fallbackFy);
    const b =
      map.get(fy) ?? { cg: emptyCgBuckets(), spec: emptyBp(), fno: emptyBp(), sellDates: [] };
    if (t.sellDate) b.sellDates.push(t.sellDate);

    if (DELIVERY.has(t.segment)) {
      // v4.5.0: the BOX follows the resolved head, not the segment. A gold ETF
      // used to be written into the 112A box on no authority at all.
      const head = resolveCgHead({ assetClass: t.assetClass, acquiredOn: t.buyDate, transferredOn: t.sellDate });
      const bucket = b.cg[bucketFor(head.head)];
      // Grandfathering raises the cost basis of a pre-2018 lot; it never lowers it.
      const eligible = head.grandfatherEligible;
      const cost = eligible ? grandfatheredCost(t.buyValue, t.fmv31Jan2018 ?? null, t.sellValue) : t.buyValue;
      if (eligible && cost !== t.buyValue) bucket.grandfatheredLots++;
      bucket.trades++;
      bucket.consideration = r2(bucket.consideration + t.sellValue);
      bucket.cost = r2(bucket.cost + cost);
      bucket.expenditure = r2(bucket.expenditure + transferExpenditure(t));
      bucket.stt = r2(bucket.stt + t.sttCtt);
      bucket.notDeducted = r2(bucket.notDeducted + Math.max(0, t.mtfInterest ?? 0) + Math.max(0, t.pledgeCharges ?? 0));
      bucket.head = bucket.head ?? head;
      bucket.cells.add(head.cell);
      if (head.ratePct == null) for (const r of head.reasons) bucket.blank.add(r);
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

/** One capital-gains block, in the ITR's own shape. `code` is BLANK when this
 *  release has not read the item numbers for this (form, AY) — invariant 6. */
function cgBlock(
  code: string | null,
  title: string,
  bucket: CgBucket,
  opts: { exemption?: number | null; exemptionLabel?: string; indexation?: boolean },
): ScheduleLine[] {
  const c = (suffix: string) => (code ? `${code}${suffix}` : "");
  const balance = r2(bucket.consideration - bucket.cost - bucket.expenditure);
  const lines: ScheduleLine[] = [
    { schedule: "Schedule CG", code: code ?? "", label: title, amount: null,
      note: code ? undefined : "The item code for this row on this form and assessment year was not read for this release — copy the figures into the box the form itself names." },
    { schedule: "Schedule CG", code: c("(a)"), label: "Full value of consideration", amount: bucket.consideration },
    {
      schedule: "Schedule CG",
      code: c("(b)(i)"),
      label: opts.indexation ? "Cost of acquisition — INDEXED" : "Cost of acquisition without indexation",
      amount: opts.indexation ? null : bucket.cost,
      note: opts.indexation
        ? `Actual cost is ₹${bucket.cost.toLocaleString("en-IN")}. The INDEXED cost is blank: no cost-inflation-index table is bundled with this release, so it cannot be derived. Missing input — the CBDT CII notification for the acquisition and transfer years.`
        : bucket.grandfatheredLots > 0
          ? `${bucket.grandfatheredLots} lot(s) use the 31-Jan-2018 grandfathered cost.`
          : undefined,
    },
    // Deliberately 0, not blank: a listed security cannot carry a cost of
    // improvement, so 0 is the derived answer (invariant 6 forbids inventing a
    // figure, not stating a known one). Both hand-written blocks this generic
    // one replaced carried the line; the 3b-i tests caught its loss.
    { schedule: "Schedule CG", code: c("(b)(ii)"), label: "Cost of improvement", amount: 0, note: "Not applicable to listed securities." },
    {
      schedule: "Schedule CG",
      code: c("(b)(iii)"),
      label: "Expenditure wholly and exclusively in connection with transfer",
      amount: bucket.expenditure,
      note:
        `Excludes STT of ₹${bucket.stt.toLocaleString("en-IN")} — not allowable against capital gains (proviso to S.48).` +
        (bucket.notDeducted > 0
          ? ` Also excludes ₹${bucket.notDeducted.toLocaleString("en-IN")} of MTF interest and pledge charges: neither is transfer expenditure, and the High Courts are split on whether interest forms part of the cost of acquisition.`
          : ""),
    },
    {
      schedule: "Schedule CG",
      code: c("(c)"),
      label: opts.exemption != null ? "Capital gain before exemption" : "Balance (a − b) — capital gain",
      amount: opts.indexation ? null : balance,
      note: opts.indexation ? "Blank because the indexed cost above is blank." : undefined,
    },
  ];
  if (opts.exemption != null) {
    const exemption = balance > 0 ? r2(Math.min(balance, opts.exemption)) : 0;
    lines.push(
      {
        schedule: "Schedule CG",
        code: c("(d)"),
        label: opts.exemptionLabel ?? `Deduction (exemption threshold ₹${opts.exemption.toLocaleString("en-IN")})`,
        amount: exemption,
        note: "FY-level exemption across ALL your 112A gains — if you hold equity outside this journal, the threshold is shared.",
      },
      { schedule: "Schedule CG", code: c("(e)"), label: "Net long-term capital gain (c − d)", amount: r2(balance - exemption) },
    );
  }
  return lines;
}

function buildFy(
  fy: string,
  b: { cg: CgBuckets; spec: BpBucket; fno: BpBucket; sellDates: string[] },
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

  // ── Which form? Decided BEFORE Schedule CG, because ITR-2 and ITR-3 number
  //    Schedule CG differently and the item codes are read off the form. ──────
  const hasBusiness = b.spec.trades > 0 || b.fno.trades > 0;
  const hasCg = (["stcg111A", "stcgOther", "ltcg112A", "ltcg112", "cgUndetermined"] as const)
    .some((k) => b.cg[k].trades > 0);
  const itrForm: ItrForm = hasBusiness ? "ITR-3" : "ITR-2";
  const codes = itrCgCodes(itrForm, fy);
  const ay = assessmentYearFor(fy);

  // ── Schedule CG · short-term u/s 111A ─────────────────────────────────────
  if (b.cg.stcg111A.trades > 0) {
    lines.push(
      ...cgBlock(codes.stcg111A, `STCG on equity shares/units where STT is paid (u/s ${section(fy, "stcgEquity")})`, b.cg.stcg111A, {}),
    );
  }

  // ── Schedule CG · slab-rate short-term (ordinary unit, or s.50AA-deemed) ──
  if (b.cg.stcgOther.trades > 0) {
    lines.push(
      ...cgBlock(null, `Short-term capital gain taxed at SLAB rates — a non-equity-oriented unit, or one deemed short-term by ${section(fy, "stcgDeemedSmf")}`, b.cg.stcgOther, {}),
      {
        schedule: "Schedule CG",
        code: "",
        label: "Tax on the row above",
        amount: null,
        note: "Blank on purpose: it is taxed at your personal slab rate, which this journal does not know. The AMOUNT is complete; only the tax is missing.",
      },
    );
  }

  // ── Schedule CG · long-term u/s 112A ──────────────────────────────────────
  if (b.cg.ltcg112A.trades > 0) {
    const head = b.cg.ltcg112A.head;
    const exemption = head?.exemption ?? rates.ltcgExemption;
    const exempt1038 = head?.head === "ltcgExempt1038";
    lines.push(
      ...cgBlock(
        exempt1038 ? null : codes.ltcg112A,
        exempt1038
          ? `Long-term capital gain EXEMPT under ${section(fy, "ltcgExempt1038")} (STT-paid equity, transfers up to 31-3-2018)`
          : `LTCG on equity shares/units where STT is paid (u/s ${section(fy, "ltcgEquity")})`,
        b.cg.ltcg112A,
        exempt1038
          ? {}
          : { exemption, exemptionLabel: `Deduction u/s ${section(fy, "ltcgEquity")} (exemption threshold ₹${exemption.toLocaleString("en-IN")})` },
      ),
    );
  }

  // ── Schedule CG · long-term u/s 112 — a non-equity-oriented unit ──────────
  if (b.cg.ltcg112.trades > 0) {
    const head = b.cg.ltcg112.head;
    lines.push(
      ...cgBlock(codes.ltcg112, `LTCG on a unit that is NOT equity-oriented (u/s ${section(fy, "ltcgOther")})`, b.cg.ltcg112, {
        indexation: !!head?.indexation,
      }),
    );
  }

  // ── Schedule CG · head undetermined — stated, never filed into a box ──────
  if (b.cg.cgUndetermined.trades > 0) {
    lines.push({
      schedule: "Schedule CG",
      code: "",
      label: `${b.cg.cgUndetermined.trades} realised trade(s) whose capital-gains head this journal cannot determine`,
      amount: null,
      note: `Consideration ₹${b.cg.cgUndetermined.consideration.toLocaleString("en-IN")}, cost ₹${b.cg.cgUndetermined.cost.toLocaleString("en-IN")}. These are NOT written into any box: ${[...b.cg.cgUndetermined.blank].join(" ")}`,
    });
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

  // ── Why that form ─────────────────────────────────────────────────────────
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
  if (b.cg.ltcg112A.trades > 0 && b.cg.ltcg112A.grandfatheredLots === 0) {
    cautions.push(
      "No lot claimed a 31-Jan-2018 grandfathered cost. If you hold equity bought before that date, enter its FMV on the Tax Summary page or the LTCG cost here is understated.",
    );
  }
  if (b.cg.ltcg112A.grandfatheredLots > 0) {
    cautions.push(
      "On a grandfathered 112A lot, buy-side brokerage, stamp duty and their GST are treated here as part of transfer expenditure. Whether they instead form part of the cost of acquisition — and therefore interact with the 31-Jan-2018 substituted cost — is NOT verified in this release; the treatment is stated so your CA can change it.",
    );
  }
  for (const key of ["stcg111A", "stcgOther", "ltcg112A", "ltcg112"] as const) {
    const bucket = b.cg[key];
    if (bucket.cells.size > 1) {
      cautions.push(
        `The ${key} block above spans more than one rate band (${[...bucket.cells].join(", ")}) — the rate changed inside FY ${fy}, so the block's own rate is an aggregate. Split it by sale date with your CA.`,
      );
    }
  }
  const notDeducted = (["stcg111A", "stcgOther", "ltcg112A", "ltcg112"] as const)
    .reduce((s, k) => s + b.cg[k].notDeducted, 0);
  if (notDeducted > 0) {
    cautions.push(
      `₹${r2(notDeducted).toLocaleString("en-IN")} of MTF interest and pledge/unpledge charges is NOT deducted anywhere in Schedule CG above. No court has held either to be expenditure incurred wholly and exclusively in connection with the transfer, and the High Courts are SPLIT on whether interest on borrowed money forms part of the cost of acquisition — there is no Supreme Court ruling. Your trade P&L elsewhere in Vyuha still nets them. The figure is a FLOOR: GST charged on those lines is not separable from the trade's single GST total.`,
    );
  }
  if (hasCg && codes.notes.length > 0) cautions.push(...codes.notes);
  if (hasCg && ay) {
    cautions.push(
      `Schedule CG item codes above are the ${itrForm} codes for AY ${ay}. They MOVE between years — on ITR-2, s.112A was B4 for AY 2025-26 and B3 for AY 2026-27 — so check them against the form you are actually filing.`,
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
