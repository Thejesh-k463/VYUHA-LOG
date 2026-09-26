import { describe, expect, it } from "vitest";
import {
  itrScheduleByFy,
  transferExpenditure,
  scheduleExportRows,
  taxesPaidByFy,
  taxesPaidExportRows,
  type ItrScheduleTrade,
  type TaxPaymentInput,
} from "@/lib/analytics/itr-schedule";
import type { CarryForwardLot } from "@/lib/analytics/capital-gains";
import { section } from "@/lib/analytics/statute";

/**
 * C — the ITR schedule export.
 *
 * The value of this module is not the re-labelling; it is the two things a
 * naive export gets wrong:
 *
 *   1. STT is NOT deductible against capital gains (proviso to S.48), but IS an
 *      allowable business expense for the speculative and F&O heads. Every
 *      other figure in this app is net of STT, so a re-label would silently
 *      over-deduct on Schedule CG.
 *   2. Schedule CG asks for consideration and cost SEPARATELY. Reporting a net
 *      gain loses exactly the numbers the schedule wants.
 */

/**
 * v4.5.0 — two things changed about this fixture.
 *
 *  • `assetClass` is REQUIRED and never defaulted (a gold/debt ETF unit is not
 *    an equity share and must never be written into the 111A/112A boxes).
 *  • The default sale moved to FY 2025-26. Schedule CG item codes are read off
 *    a SPECIFIC form for a SPECIFIC assessment year, and this release has read
 *    ITR-2 for AY 2025-26 (A2/B4/B9) and AY 2026-27 (A2/B3/B8) only. FY 2025-26
 *    is AY 2026-27, so these fixtures exercise real codes; the old FY 2026-27
 *    default is AY 2027-28, whose codes are deliberately BLANK (invariant 6)
 *    and is pinned as such in "Schedule CG item codes" below.
 */
const trade = (over: Partial<ItrScheduleTrade> = {}): ItrScheduleTrade => {
  const r: Omit<ItrScheduleTrade, "fyDate"> = {
    segment: "eq_delivery",
    assetClass: "share",
    buyDate: "2025-05-01",
    sellDate: "2025-06-01",
    buyValue: 100000,
    sellValue: 110000,
    grossPnl: 10000,
    netPnl: 9800,
    chargesTotal: 200,
    sttCtt: 110,
    fmv31Jan2018: null,
    isOpen: false,
    ...over,
  };
  // v4.6.0 fix wave (SEAM-V46-2) — `fyDate` is REQUIRED; a fixture files by the
  // date it filed by before the fix (r.sellDate ?? r.buyDate) unless it states one.
  return { ...r, fyDate: "fyDate" in over ? (over.fyDate ?? null) : r.sellDate ?? r.buyDate };
};

const lineOf = (packs: ReturnType<typeof itrScheduleByFy>, code: string) =>
  packs.flatMap((p) => p.lines).find((l) => l.code === code);

describe("transfer expenditure", () => {
  it("allows every charge except STT", () => {
    expect(transferExpenditure({ chargesTotal: 200, sttCtt: 110 })).toBe(90);
  });

  it("never goes negative if STT somehow exceeds the recorded total", () => {
    expect(transferExpenditure({ chargesTotal: 50, sttCtt: 110 })).toBe(0);
  });

  /**
   * v4.5.0 — MTF interest and pledge/unpledge charges leave the deduction too.
   * Neither has been held to be expenditure incurred wholly and exclusively in
   * connection with the transfer, and the High Courts are SPLIT on whether
   * interest forms part of the cost of acquisition (dossier §G2). They stay
   * inside `chargesTotal` for the two BUSINESS heads, which is the asymmetry.
   */
  it("also excludes MTF interest and pledge charges — 200 − 110 STT − 30 − 10 = 50", () => {
    expect(transferExpenditure({ chargesTotal: 200, sttCtt: 110, mtfInterest: 30, pledgeCharges: 10 })).toBe(50);
    // Absent fields change nothing, and a negative one never INCREASES it.
    expect(transferExpenditure({ chargesTotal: 200, sttCtt: 110, mtfInterest: -30 })).toBe(90);
  });
});

describe("Schedule CG — A2 (STCG u/s 111A on ITR-2)", () => {
  it("reports consideration and cost separately, not netted", () => {
    const packs = itrScheduleByFy([trade()]);
    expect(lineOf(packs, "A2(a)")?.amount).toBe(110000);
    expect(lineOf(packs, "A2(b)(i)")?.amount).toBe(100000);
  });

  it("deducts brokerage but NOT STT", () => {
    const packs = itrScheduleByFy([trade({ chargesTotal: 200, sttCtt: 110 })]);
    expect(lineOf(packs, "A2(b)(iii)")?.amount).toBe(90);
    // The balance must therefore be HIGHER than the app's own netPnl, which is
    // net of STT too. That gap is the whole point of this module.
    expect(lineOf(packs, "A2(c)")?.amount).toBe(110000 - 100000 - 90);
    expect(lineOf(packs, "A2(c)")?.amount).toBeGreaterThan(9800);
  });

  it("states the excluded STT on the line itself", () => {
    const packs = itrScheduleByFy([trade({ sttCtt: 110 })]);
    expect(lineOf(packs, "A2(b)(iii)")?.note).toMatch(/S\.48/);
    expect(lineOf(packs, "A2(b)(iii)")?.note).toMatch(/110/);
  });

  /**
   * Wave 3b-i: the generic `cgBlock` that replaced the two hand-written blocks
   * at first DROPPED the "(b)(ii) Cost of improvement = 0" line both of them
   * carried. A listed security cannot have one, so 0 is the derived answer and
   * deliberately NOT a blank — pinned as an amount, not just a code, so a
   * future "blank everything we cannot derive" sweep cannot swallow it.
   */
  it("emits consideration, cost, improvement and expenditure as separate boxes", () => {
    const packs = itrScheduleByFy([trade()]);
    const codes = packs.flatMap((p) => p.lines).map((l) => l.code);
    expect(codes).toEqual(expect.arrayContaining(["A2", "A2(a)", "A2(b)(i)", "A2(b)(ii)", "A2(b)(iii)", "A2(c)"]));
    expect(lineOf(packs, "A2(b)(ii)")?.amount, "a listed security's cost of improvement is 0, not blank").toBe(0);
  });

  it("aggregates several short-term lots", () => {
    const packs = itrScheduleByFy([
      trade({ sellValue: 110000, buyValue: 100000, chargesTotal: 200, sttCtt: 110 }),
      trade({ sellValue: 50000, buyValue: 45000, chargesTotal: 100, sttCtt: 50 }),
    ]);
    expect(lineOf(packs, "A2(a)")?.amount).toBe(160000);
    expect(lineOf(packs, "A2(b)(i)")?.amount).toBe(145000);
    expect(lineOf(packs, "A2(b)(iii)")?.amount).toBe(140);
  });

  it("omits the block entirely when there were no short-term equity sales", () => {
    const packs = itrScheduleByFy([trade({ segment: "index_option" })]);
    expect(lineOf(packs, "A2(a)")).toBeUndefined();
    expect(lineOf(packs, "A3(a)")).toBeUndefined();
  });
});

describe("Schedule CG — B3 (LTCG u/s 112A on the AY 2026-27 ITR-2)", () => {
  const longTerm = (over: Partial<ItrScheduleTrade> = {}) =>
    trade({ buyDate: "2024-01-01", sellDate: "2025-06-01", ...over });

  it("classifies a holding over twelve months as long-term", () => {
    const packs = itrScheduleByFy([longTerm()]);
    expect(lineOf(packs, "B3(a)")?.amount).toBe(110000);
    expect(lineOf(packs, "A2(a)")).toBeUndefined();
  });

  it("applies the ₹1.25L exemption and nets it off", () => {
    const packs = itrScheduleByFy([longTerm({ buyValue: 100000, sellValue: 400000, chargesTotal: 400, sttCtt: 300 })]);
    const before = lineOf(packs, "B3(c)")!.amount!;
    expect(before).toBe(400000 - 100000 - 100);
    expect(lineOf(packs, "B3(d)")?.amount).toBe(125000);
    expect(lineOf(packs, "B3(e)")?.amount).toBe(before - 125000);
  });

  it("caps the exemption at the actual gain rather than manufacturing a loss", () => {
    const packs = itrScheduleByFy([longTerm({ buyValue: 100000, sellValue: 110000, chargesTotal: 200, sttCtt: 110 })]);
    const before = lineOf(packs, "B3(c)")!.amount!;
    expect(lineOf(packs, "B3(d)")?.amount).toBe(before);
    expect(lineOf(packs, "B3(e)")?.amount).toBe(0);
  });

  it("claims no exemption against a long-term loss", () => {
    const packs = itrScheduleByFy([longTerm({ buyValue: 200000, sellValue: 110000 })]);
    expect(lineOf(packs, "B3(c)")!.amount!).toBeLessThan(0);
    expect(lineOf(packs, "B3(d)")?.amount).toBe(0);
  });

  it("uses the grandfathered cost for a pre-2018 lot and says how many", () => {
    const packs = itrScheduleByFy([
      longTerm({ buyDate: "2015-06-01", buyValue: 50000, sellValue: 300000, fmv31Jan2018: 200000 }),
    ]);
    // Grandfathering raises cost to min(FMV, consideration) when that beats actual.
    expect(lineOf(packs, "B3(b)(i)")?.amount).toBe(200000);
    expect(lineOf(packs, "B3(b)(i)")?.note).toMatch(/grandfathered/i);
  });

  it("warns when a long-term book claimed no grandfathering at all", () => {
    const packs = itrScheduleByFy([longTerm()]);
    expect(packs[0].cautions.some((c) => /31-Jan-2018/.test(c))).toBe(true);
  });
});

/**
 * T2 (v4.5.0) — Schedule CG item codes are a pointer into a SPECIFIC PDF of a
 * SPECIFIC assessment year, and this module used to emit one set for all of
 * them: A3 for s.111A and B4 for s.112A. On ITR-2, s.111A is item **A2** (A3 is
 * a different row), and the codes MOVE between years — s.112A is B4 on the
 * AY 2025-26 ITR-2 and B3 on AY 2026-27, with the s.112 row moving B9 → B8.
 * A wrong box number is transcribed straight into the utility and is invisible
 * until the return is rejected, so an (form, AY) pair this release has not read
 * a schema for prints BLANK (invariant 6).
 */
describe("Schedule CG item codes — per form, per assessment year", () => {
  const codesOf = (packs: ReturnType<typeof itrScheduleByFy>) =>
    packs.flatMap((p) => p.lines).filter((l) => l.schedule === "Schedule CG" && l.amount === null && !l.code.includes("(")).map((l) => l.code);

  it("ITR-2, AY 2025-26 (FY 2024-25): A2 short-term, B4 s.112A, B9 s.112", () => {
    // incometaxgov-ITR-2_2025_Main_V1.2-schema-AY2025-26.json
    const st = itrScheduleByFy([trade({ buyDate: "2024-08-01", sellDate: "2024-09-01" })]);
    expect(st[0].fy).toBe("2024-25");
    expect(st[0].itrForm).toBe("ITR-2");
    expect(lineOf(st, "A2(a)")?.amount).toBe(110000);
    expect(lineOf(st, "A3(a)")).toBeUndefined(); // A3 is a DIFFERENT row on ITR-2

    const lt = itrScheduleByFy([trade({ buyDate: "2022-08-01", sellDate: "2024-09-01" })]);
    expect(lineOf(lt, "B4(a)")?.amount).toBe(110000);

    const unit = itrScheduleByFy([trade({ assetClass: "otherUnit", buyDate: "2019-08-01", sellDate: "2024-09-01" })]);
    expect(lineOf(unit, "B9(a)")?.amount).toBe(110000);
  });

  it("ITR-2, AY 2026-27 (FY 2025-26): the s.112A row is B3 and the s.112 row B8", () => {
    // incometaxgov ITR-2 schema AY2026-27 + incometaxgov-notification-46-2026-….pdf
    expect(lineOf(itrScheduleByFy([trade()]), "A2(a)")?.amount).toBe(110000);
    expect(lineOf(itrScheduleByFy([trade({ buyDate: "2023-01-01" })]), "B3(a)")?.amount).toBe(110000);
    expect(lineOf(itrScheduleByFy([trade({ assetClass: "otherUnit", buyDate: "2020-01-01" })]), "B8(a)")?.amount).toBe(110000);
    // …and the codes that belong to the OTHER assessment year are not emitted.
    expect(lineOf(itrScheduleByFy([trade({ buyDate: "2023-01-01" })]), "B4(a)")).toBeUndefined();
  });

  it("ITR-3 numbers Schedule CG differently: s.111A really IS A3 there", () => {
    // Any business head forces ITR-3, and §F.1 verified only its A3 = 111A row.
    const packs = itrScheduleByFy([trade(), trade({ segment: "eq_intraday", netPnl: 100 })]);
    expect(packs[0].itrForm).toBe("ITR-3");
    expect(lineOf(packs, "A3(a)")?.amount).toBe(110000);
    expect(lineOf(packs, "A2(a)")).toBeUndefined();
  });

  it("ITR-3's long-term rows are BLANK, not borrowed from ITR-2", () => {
    const packs = itrScheduleByFy([trade({ buyDate: "2023-01-01" }), trade({ segment: "eq_intraday", netPnl: 100 })]);
    expect(lineOf(packs, "B3(a)")).toBeUndefined();
    expect(lineOf(packs, "B4(a)")).toBeUndefined();
    // The block is still printed — with no code and a line saying why.
    const blank = packs[0].lines.find((l) => l.label.includes("112A"));
    expect(blank?.code).toBe("");
    expect(blank?.note).toMatch(/was not read for this release/);
    expect(packs[0].cautions.some((c) => /long-term item codes were not read/i.test(c))).toBe(true);
  });

  it("an assessment year this release has not read prints NO code at all", () => {
    // FY 2026-27 is AY 2027-28: no schema read, so a nearby year's codes would
    // be wrong, not approximate.
    const packs = itrScheduleByFy([trade({ buyDate: "2026-05-01", sellDate: "2026-06-01" })]);
    expect(packs[0].fy).toBe("2026-27");
    expect(codesOf(packs).every((c) => c === "")).toBe(true);
    expect(lineOf(packs, "A2(a)")).toBeUndefined();
    expect(lineOf(packs, "A3(a)")).toBeUndefined();
    expect(packs[0].cautions.some((c) => /AY 2027-28/.test(c))).toBe(true);
  });

  it("names the assessment year and warns that the codes move between years", () => {
    const packs = itrScheduleByFy([trade()]);
    expect(packs[0].cautions.some((c) => /ITR-2 codes for AY 2026-27/.test(c))).toBe(true);
    expect(packs[0].cautions.some((c) => /B4 for AY 2025-26 and B3 for AY 2026-27/.test(c))).toBe(true);
  });
});

/**
 * A NON-equity-oriented unit (gold, silver, international, debt). It never
 * reaches s.111A/s.112A: no STT is charged on it, so the concessional rate
 * cannot apply. Before v4.5.0 the box followed the SEGMENT and a gold ETF was
 * written straight into the 112A box.
 */
describe("Schedule CG — the s.112 block for a unit that is not equity-oriented", () => {
  it("routes a long-held gold unit to s.112, never to the 112A box", () => {
    const packs = itrScheduleByFy([trade({ assetClass: "otherUnit", buyDate: "2020-01-01" })]);
    expect(lineOf(packs, "B8(a)")?.amount).toBe(110000);
    expect(lineOf(packs, "B3(a)")).toBeUndefined();
    // …and it gets NO ₹1.25 L exemption: that threshold belongs to s.112A only.
    expect(lineOf(packs, "B8(d)")).toBeUndefined();
  });

  it("blanks the INDEXED cost and the gain for a pre-23-Jul-2024 s.112 cell — no CII is bundled", () => {
    // Transferred 1-Sep-2023: S.112 on an INDEXED cost. The actual cost is
    // stated in the note, but the indexed cost, and therefore the gain, are
    // BLANK — the CBDT cost-inflation-index notification is not in this
    // release's primary-source set (invariant 6, owner answer T2).
    const packs = itrScheduleByFy([trade({ assetClass: "otherUnit", buyDate: "2018-01-01", sellDate: "2023-09-01" })]);
    const cost = packs[0].lines.find((l) => l.label.includes("INDEXED"));
    expect(cost).toBeDefined();
    expect(cost!.amount).toBeNull();
    expect(cost!.note).toMatch(/cost-inflation-index/i);
    expect(cost!.note).toMatch(/1,00,000/); // the ACTUAL cost is still stated
    const balance = packs[0].lines.find((l) => l.label.startsWith("Balance"));
    expect(balance?.amount).toBeNull();
  });

  it("a slab-rate short-term unit states its AMOUNT and blanks only its TAX", () => {
    const packs = itrScheduleByFy([trade({ assetClass: "debtUnit", buyDate: "2025-05-01" })]);
    const tax = packs[0].lines.find((l) => l.label === "Tax on the row above");
    expect(tax?.amount).toBeNull();
    expect(tax?.note).toMatch(/slab rate, which this journal does not know/);
    // The consideration and cost are complete — only the tax is missing.
    const block = packs[0].lines.find((l) => l.label.includes("SLAB rates"));
    expect(block).toBeDefined();
    expect(block!.code).toBe(""); // no ITR box was read for this row
  });
});

/** Second-pass ruling (b) — the "not deducted" figure and its caution. */
describe("Schedule CG — MTF interest and pledge charges", () => {
  it("excludes them from transfer expenditure and says so on the line and in a caution", () => {
    const packs = itrScheduleByFy([trade({ chargesTotal: 200, sttCtt: 110, mtfInterest: 30, pledgeCharges: 10 })]);
    // 200 − 110 STT − 40 financing = 50.
    expect(lineOf(packs, "A2(b)(iii)")?.amount).toBe(50);
    expect(lineOf(packs, "A2(b)(iii)")?.note).toMatch(/MTF interest and pledge charges/);
    const caution = packs[0].cautions.find((c) => /MTF interest and pledge/.test(c));
    expect(caution).toMatch(/₹40/);
    // The FLOOR sentence must travel with it: the GST on those lines is not
    // separable from the trade's single GST total, so it is still netted.
    expect(caution).toMatch(/FLOOR/);
    expect(caution).toMatch(/no Supreme Court ruling/);
  });

  it("carries no such caution when there is nothing to report", () => {
    const packs = itrScheduleByFy([trade({ chargesTotal: 200, sttCtt: 110 })]);
    expect(packs[0].cautions.some((c) => /MTF interest and pledge/.test(c))).toBe(false);
  });
});

describe("Schedule BP — business heads", () => {
  it("files intraday as speculative and F&O as non-speculative", () => {
    const packs = itrScheduleByFy([
      trade({ segment: "eq_intraday", netPnl: -5000, chargesTotal: 300 }),
      trade({ segment: "index_option", netPnl: 8000, chargesTotal: 400 }),
    ]);
    expect(lineOf(packs, "BP-SPEC")?.amount).toBe(-5000);
    expect(lineOf(packs, "BP-NONSPEC")?.amount).toBe(8000);
  });

  it("keeps STT inside business expenses — the opposite of the CG treatment", () => {
    const packs = itrScheduleByFy([trade({ segment: "eq_intraday", netPnl: 1000, chargesTotal: 300, sttCtt: 150 })]);
    expect(lineOf(packs, "BP-SPEC-EXP")?.amount).toBe(300);
  });

  // Was: "the absolute sum of per-trade P&L", asserting |netPnl|. That was wrong
  // twice over — net is after charges, and it omitted option premium entirely.
  // ICAI GN 11th ed. (2026) para 5.11(b)(i)+(ii). See lib/analytics/turnover.ts.
  it("computes turnover from GROSS differences plus option premium, never net", () => {
    const packs = itrScheduleByFy([
      trade({ segment: "index_option", grossPnl: 8500, netPnl: 8000, sellValue: 120000 }),
      trade({ segment: "index_option", grossPnl: -2700, netPnl: -3000, sellValue: 60000 }),
    ]);
    // The head's income is still NET of charges — only turnover uses gross.
    expect(lineOf(packs, "BP-NONSPEC")?.amount).toBe(5000);
    // differences 8500 + 2700 = 11200; premium 120000 + 60000 = 180000
    expect(lineOf(packs, "BP-NONSPEC-TO")?.amount).toBe(191200);
  });

  it("matches the turnover /reports/tax shows for the same F&O book", async () => {
    const { taxByFy } = await import("@/lib/analytics/tax");
    const packs = itrScheduleByFy([
      trade({ segment: "index_option", grossPnl: 8500, netPnl: 8000, sellValue: 120000 }),
    ]);
    const rows = taxByFy([
      {
        segment: "index_option", assetClass: "share", instrumentType: "option",
        buyDate: "2025-05-01", sellDate: "2025-06-01", fyDate: "2025-06-01",
        grossPnl: 8500, netPnl: 8000, buyValue: 100000, sellValue: 120000,
        chargesTotal: 200, isOpen: false,
      },
    ]);
    expect(lineOf(packs, "BP-NONSPEC-TO")?.amount).toBe(rows[0].fnoTurnover);
  });

  it("treats every F&O segment as non-speculative", () => {
    for (const segment of ["index_option", "stock_option", "future", "commodity_future", "commodity_option"]) {
      const packs = itrScheduleByFy([trade({ segment, netPnl: 100 })]);
      expect(lineOf(packs, "BP-NONSPEC")?.amount).toBe(100);
    }
  });
});

describe("which ITR form", () => {
  it("indicates ITR-2 for a capital-gains-only year", () => {
    const packs = itrScheduleByFy([trade()]);
    expect(packs[0].itrForm).toBe("ITR-2");
    expect(packs[0].formReason).toMatch(/no business head/i);
  });

  it("indicates ITR-3 as soon as there is any business head", () => {
    expect(itrScheduleByFy([trade({ segment: "eq_intraday" })])[0].itrForm).toBe("ITR-3");
    expect(itrScheduleByFy([trade({ segment: "index_option" })])[0].itrForm).toBe("ITR-3");
  });

  it("still says ITR-3 when capital gains and business income coexist", () => {
    const packs = itrScheduleByFy([trade(), trade({ segment: "index_option", netPnl: 100 })]);
    expect(packs[0].itrForm).toBe("ITR-3");
    expect(packs[0].formReason).toMatch(/capital-gains schedule/);
  });
});

describe("Schedule CFL — carry forward", () => {
  it("reports supplied lots with their lapse year", () => {
    const cf = new Map<string, CarryForwardLot[]>([
      ["2026-27", [{ bucket: "nonSpeculative", fyIncurred: "2026-27", amount: 112997 }]],
    ]);
    const packs = itrScheduleByFy([trade({ segment: "index_option", netPnl: -112997, buyDate: "2026-05-01", sellDate: "2026-06-01" })], 4, "2026-27", cf);
    const line = lineOf(packs, "CFL-nonSpeculative");
    expect(line?.amount).toBe(112997);
    expect(line?.note).toMatch(/8 years/);
    expect(line?.note).toMatch(/2034-35/);
  });

  it("gives speculative losses the shorter four-year window", () => {
    const cf = new Map<string, CarryForwardLot[]>([
      ["2026-27", [{ bucket: "speculative", fyIncurred: "2026-27", amount: 82088 }]],
    ]);
    const packs = itrScheduleByFy([trade({ segment: "eq_intraday", netPnl: -82088, buyDate: "2026-05-01", sellDate: "2026-06-01" })], 4, "2026-27", cf);
    expect(lineOf(packs, "CFL-speculative")?.note).toMatch(/4 years/);
    expect(lineOf(packs, "CFL-speculative")?.note).toMatch(/2030-31/);
  });

  it("distinguishes 'no losses' from 'not supplied'", () => {
    const supplied = itrScheduleByFy([trade()], 4, "2025-26", new Map());
    expect(lineOf(supplied, "CFL")?.amount).toBe(0);

    const notSupplied = itrScheduleByFy([trade()]);
    expect(lineOf(notSupplied, "CFL")?.amount).toBeNull();
    expect(lineOf(notSupplied, "CFL")?.note).toMatch(/not supplied/i);
  });
});

describe("scoping and cautions", () => {
  it("ignores open positions — nothing is realised yet", () => {
    expect(itrScheduleByFy([trade({ isOpen: true })])).toEqual([]);
  });

  it("splits across financial years, oldest first", () => {
    const packs = itrScheduleByFy([
      trade({ sellDate: "2025-06-01", buyDate: "2025-05-01" }),
      trade({ sellDate: "2026-06-01", buyDate: "2026-05-01" }),
    ]);
    expect(packs.map((p) => p.fy)).toEqual(["2025-26", "2026-27"]);
  });

  it("flags an FY that straddles the 23-Jul-2024 rate cutover", () => {
    const packs = itrScheduleByFy([
      trade({ buyDate: "2024-05-01", sellDate: "2024-06-01" }),
      trade({ buyDate: "2024-09-01", sellDate: "2024-10-01" }),
    ]);
    expect(packs[0].fy).toBe("2024-25");
    expect(packs[0].cautions.some((c) => /straddles/i.test(c))).toBe(true);
  });

  it("always carries the preparation-not-advice caution and the STT asymmetry", () => {
    const packs = itrScheduleByFy([trade()]);
    expect(packs[0].cautions.some((c) => /not a filed return/i.test(c))).toBe(true);
    // The fixture sells in FY 2025-26, so the STT caution cites the 1961 Act.
    expect(packs[0].cautions.some((c) => c.includes(section("2025-26", "sttNotDeductibleCg")))).toBe(true);
  });

  it("cites the Act that governed the YEAR, not today's, and names it", () => {
    // A 2024-25 pack must keep its 1961 Act citations; retro-labelling it would
    // make it cite law that never governed it.
    const old = itrScheduleByFy([trade({ buyDate: "2024-05-01", sellDate: "2024-09-01" })]);
    expect(old[0].fy).toBe("2024-25");
    expect(old[0].cautions.some((c) => c.includes("proviso to S.48"))).toBe(true);
    expect(old[0].cautions.some((c) => c.includes("Income-tax Act, 1961"))).toBe(true);
    expect(old[0].cautions.some((c) => c.includes("repealed"))).toBe(true);

    const now = itrScheduleByFy([trade({ buyDate: "2026-05-01", sellDate: "2026-06-01" })]);
    expect(now[0].fy).toBe("2026-27");
    expect(now[0].cautions.some((c) => c.includes("Income-tax Act, 2025"))).toBe(true);
    // …and the BP labels move with it.
    const spec = itrScheduleByFy([trade({ segment: "eq_intraday", netPnl: 100, buyDate: "2026-05-01", sellDate: "2026-06-01" })]);
    expect(lineOf(spec, "BP-SPEC")?.label).toContain("s.66(31)");
    const specOld = itrScheduleByFy([
      trade({ segment: "eq_intraday", netPnl: 100, buyDate: "2024-05-01", sellDate: "2024-09-01" }),
    ]);
    expect(lineOf(specOld, "BP-SPEC")?.label).toContain("S.43(5)");
  });

  it("never states an amount it cannot derive as zero", () => {
    const packs = itrScheduleByFy([trade()]);
    const heading = packs[0].lines.find((l) => l.code === "A2");
    expect(heading?.amount).toBeNull(); // a section heading, not a figure
  });
});

describe("export rows", () => {
  it("flattens every line with its FY, form and schedule", () => {
    const rows = scheduleExportRows(itrScheduleByFy([trade()]));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.fy).toBe("2025-26");
      expect(r.form).toBe("ITR-2");
      expect(r.schedule.startsWith("Schedule")).toBe(true);
    }
  });

  it("renders a null amount as blank rather than 0", () => {
    // A blank cell reads as "not applicable"; a 0 reads as a figure.
    const rows = scheduleExportRows(itrScheduleByFy([trade()]));
    expect(rows.find((r) => r.code === "A2")?.amount).toBe("");
  });
});

/**
 * Schedule IT — taxes paid (advance tax), v3.7 WS4.
 *
 * The blank-vs-rows case is the whole point of the surface: a journal with no
 * challan recorded has not observed a nil payment, it has observed NOTHING, and
 * Schedule IT is the one schedule where the difference is money — a fabricated
 * 0 invites an interest computation on a balance the user actually paid
 * (AGENTS.md invariant 6).
 */
const challan = (over: Partial<TaxPaymentInput> = {}): TaxPaymentInput => ({
  fy: "2026-27",
  paidOn: "2026-06-14",
  amount: 25000,
  bsrCode: "0510308",
  challanSerial: "02451",
  note: null,
  ...over,
});

describe("taxes paid — blank vs rows", () => {
  it("an FY with no challan states BLANK, never 0", () => {
    const [b] = taxesPaidByFy([], ["2026-27"]);
    expect(b.fy).toBe("2026-27");
    expect(b.count).toBe(0);
    // The two assertions that matter: null, and specifically NOT zero.
    expect(b.total).toBeNull();
    expect(b.total).not.toBe(0);
    expect(b.lines).toHaveLength(1);
    expect(b.lines[0].amount).toBeNull();
    expect(b.lines[0].amount).not.toBe(0);
    expect(b.lines[0].paidOn).toBeNull();
    // …and it says so, rather than leaving the reader to infer it.
    expect(b.cautions.join(" ")).toMatch(/BLANK IS NOT A NIL PAYMENT/i);
  });

  it("an FY with challans emits one row per challan, oldest first, totalled", () => {
    const [b] = taxesPaidByFy(
      [challan({ paidOn: "2026-09-15", amount: 20000 }), challan({ paidOn: "2026-06-14", amount: 25000 })],
      ["2026-27"],
    );
    expect(b.count).toBe(2);
    expect(b.total).toBe(45000);
    expect(b.lines.map((l) => l.paidOn)).toEqual(["2026-06-14", "2026-09-15"]);
    expect(b.lines[0].bsrCode).toBe("0510308");
    expect(b.lines[0].challanSerial).toBe("02451");
  });

  it("keeps an omitted BSR code or serial BLANK instead of inventing a placeholder", () => {
    // A self-assessment receipt often carries neither. Refusing the payment, or
    // filling "—"/"0" into the box, would both be worse than an honest blank.
    const [b] = taxesPaidByFy([challan({ bsrCode: null, challanSerial: "   " })], ["2026-27"]);
    expect(b.lines[0].bsrCode).toBeNull();
    expect(b.lines[0].challanSerial).toBeNull();
    // The amount is still real, so the row is not discarded over a blank field.
    expect(b.lines[0].amount).toBe(25000);
    expect(b.cautions.join(" ")).toMatch(/missing a BSR code or serial/i);
  });

  it("an FY the pack does not cover still appears when the ledger holds one", () => {
    const blocks = taxesPaidByFy([challan({ fy: "2025-26", paidOn: "2025-06-14" })], ["2026-27"]);
    expect(blocks.map((b) => b.fy)).toEqual(["2025-26", "2026-27"]);
    expect(blocks[0].count).toBe(1);
    expect(blocks[1].count).toBe(0);
  });

  it("cites the Act that governed THAT year, never a hard-coded 234C", () => {
    const older = taxesPaidByFy([], ["2024-25"])[0].cautions.join(" ");
    expect(older).toContain(section("2024-25", "interestAdvanceTax")); // S.234B
    expect(older).not.toContain("s.424");

    const current = taxesPaidByFy([challan()], ["2026-27"])[0].cautions.join(" ");
    expect(current).toContain(section("2026-27", "advanceTaxInstalments")); // s.408
    expect(current).toContain(section("2026-27", "interestDeferment")); // s.425
    expect(current).not.toContain("234C");
    expect(current).not.toContain("S.211");
  });
});

describe("taxes paid export rows", () => {
  it("emits challan rows ONLY where rows exist, and blank — not 0 — where they do not", () => {
    const rows = taxesPaidExportRows(
      taxesPaidByFy([challan({ fy: "2026-27" })], ["2025-26", "2026-27"]),
    );
    const empty = rows.find((r) => r.fy === "2025-26");
    const real = rows.find((r) => r.fy === "2026-27");

    // The FY with nothing recorded: every derived cell blank. `toBe("")` and
    // NOT 0 — a 0 in an amount column is a figure someone will file.
    expect(empty?.amount).toBe("");
    expect(empty?.amount).not.toBe(0);
    expect(empty?.bsrCode).toBe("");
    expect(empty?.paidOn).toBe("");
    expect(empty?.challanSerial).toBe("");

    // The FY with a challan: the four Schedule IT columns, as transcribed.
    expect(real?.amount).toBe(25000);
    expect(real?.bsrCode).toBe("0510308");
    expect(real?.paidOn).toBe("2026-06-14");
    expect(real?.challanSerial).toBe("02451");
  });

  it("blanks an omitted BSR / serial in the export too", () => {
    const rows = taxesPaidExportRows(taxesPaidByFy([challan({ bsrCode: null, challanSerial: null })], []));
    expect(rows[0].bsrCode).toBe("");
    expect(rows[0].challanSerial).toBe("");
    expect(rows[0].amount).toBe(25000);
  });
});
