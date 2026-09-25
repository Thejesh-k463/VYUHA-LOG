import { describe, expect, it } from "vitest";
import {
  sttSplit,
  ltcgRunway,
  setOffAsymmetry,
  hasLeverContent,
  LTCG_THRESHOLD_CAVEAT,
  LIABILITY_CAVEAT,
  NO_WASH_SALE_CAVEAT,
  type LeverTrade,
  type OpenLot,
} from "@/lib/analytics/tax-levers";
// A11 (v4.5.0 fix list): the OTHER side of the 12-month line — the rule a
// realised sale is classified by. The countdown must agree with it to the day.
import { heldMoreThanMonths } from "@/lib/analytics/cg-heads";
import { realisedRows, type LadderInput } from "@/lib/analytics/realised-rows";
import { parentAggregate, summarise, type Leg } from "@/lib/domain/staged";

const t = (over: Partial<LeverTrade> = {}): LeverTrade => ({
  segment: "eq_delivery",
  buyDate: "2026-04-01",
  sellDate: "2026-06-01",
  netPnl: 0,
  chargesTotal: 0,
  sttCtt: 0,
  isOpen: false,
  ...over,
});

describe("sttSplit — the same rupee, two treatments", () => {
  it("separates deductible business STT from forfeited capital-gains STT", () => {
    const s = sttSplit(
      [
        t({ segment: "index_option", sttCtt: 500 }),
        t({ segment: "eq_intraday", sttCtt: 120 }),
        t({ segment: "eq_delivery", sttCtt: 300 }),
        t({ segment: "eq_mtf", sttCtt: 200 }),
      ],
      "2026-27",
    );
    expect(s.deductible).toBe(620); // F&O + intraday
    expect(s.forfeited).toBe(500); // delivery + MTF
    expect(s.total).toBe(1120);
    expect(s.deductibleTrades).toBe(2);
    expect(s.forfeitedTrades).toBe(2);
  });

  it("cites the Act in force for that year, on both halves", () => {
    const now = sttSplit([t({ segment: "index_option", sttCtt: 1 })], "2026-27");
    expect(now.deductibleSection).toBe("s.32(k)");
    expect(now.forfeitedSection).toBe("s.72(3)(b)");

    const old = sttSplit([t({ segment: "index_option", sttCtt: 1 })], "2024-25");
    expect(old.deductibleSection).toBe("S.36(1)(xv)");
    expect(old.forfeitedSection).toBe("proviso to S.48");
  });

  it("ignores open positions — nothing is deductible until realised", () => {
    const s = sttSplit([t({ segment: "index_option", sttCtt: 999, isOpen: true })], "2026-27");
    expect(s.total).toBe(0);
  });

  // v4.6.0 W7 (D2) — owner answer Q1: ONE count per ladder per FY, the fills
  // listed beneath each half. A staged ladder reaches sttSplit as one realised
  // row per (fill × FIFO tranche), all carrying the parent id.
  it("a ladder of three realised rows counts ONCE and lists its fills grouped by exit leg", () => {
    const s = sttSplit(
      [
        // Exit leg 11 consumed two tranches → two rows, ONE fill.
        t({ id: 5, symbol: "NIFTY24JUN", segment: "index_option", fillLegId: 11, sellDate: "2026-05-02", realisedQty: 25, sttCtt: 3.25 }),
        t({ id: 5, symbol: "NIFTY24JUN", segment: "index_option", fillLegId: 11, sellDate: "2026-05-02", realisedQty: 50, sttCtt: 6.5 }),
        t({ id: 5, symbol: "NIFTY24JUN", segment: "index_option", fillLegId: 12, sellDate: "2026-06-09", realisedQty: 25, sttCtt: 4.1 }),
      ],
      "2026-27",
    );
    expect(s.deductibleTrades, "one ladder is one trade").toBe(1);
    expect(s.deductible, "the rupees are the three rows' sum, unchanged").toBe(13.85);
    expect(s.deductibleLadders).toEqual([
      {
        id: 5,
        symbol: "NIFTY24JUN",
        sttCtt: 13.85,
        fills: [
          { fillLegId: 11, sellDate: "2026-05-02", qty: 75, sttCtt: 9.75 },
          { fillLegId: 12, sellDate: "2026-06-09", qty: 25, sttCtt: 4.1 },
        ],
      },
    ]);
    expect(s.forfeitedLadders).toEqual([]);
  });

  it("two ladders and one flat trade count THREE; the flat trade is not listed as a ladder", () => {
    const s = sttSplit(
      [
        t({ id: 1, symbol: "INFY", fillLegId: 3, realisedQty: 10, sttCtt: 2 }),
        t({ id: 1, symbol: "INFY", fillLegId: 4, realisedQty: 10, sttCtt: 2 }),
        t({ id: 2, symbol: "TCS", fillLegId: 7, realisedQty: 5, sttCtt: 3 }),
        t({ id: 2, symbol: "TCS", fillLegId: 7, realisedQty: 5, sttCtt: 3 }),
        t({ id: 3, symbol: "HDFC", fillLegId: null, realisedQty: 8, sttCtt: 5 }),
      ],
      "2026-27",
    );
    expect(s.forfeitedTrades).toBe(3);
    expect(s.forfeited).toBe(15);
    expect(s.forfeitedLadders.map((l) => [l.symbol, l.fills.length, l.sttCtt])).toEqual([
      ["INFY", 2, 4],
      ["TCS", 1, 6],
    ]);
  });

  it("a SHORT ladder's one cover lists one fill line per ENTRY date its rows carry (fillLegId × sellDate)", () => {
    // On a short the realised rows of one cover carry the ENTRY tranches' dates
    // as sellDate (realised-rows.ts: a short sells at entry). Grouping by
    // fillLegId alone showed one "05-01 · 10" line — a date the other 5 were
    // not sold on. Rows come from the product's own splitter, not hand-typed.
    const legs: Leg[] = [
      { id: 1, seq: 1, kind: "entry", qty: 5, price: 100, tradeDate: "2026-05-01", chargesTotal: 0 },
      { id: 2, seq: 2, kind: "entry", qty: 5, price: 102, tradeDate: "2026-05-05", chargesTotal: 0 },
      { id: 3, seq: 3, kind: "exit", qty: 10, price: 90, tradeDate: "2026-05-10", chargesTotal: 0 },
    ];
    const agg = parentAggregate(legs, "short");
    const parent = { ...t({ segment: "index_option", sttCtt: 10 }), ...agg, id: 9, symbol: "NIFTYSHORT", staged: true, netPnl: 0, chargesTotal: 0 };
    const ladders = new Map<number, LadderInput>([[9, { legs, position: summarise(legs, "short") }]]);
    const rows = realisedRows([parent], ladders);
    expect(rows.map((r) => [r.fillLegId, r.sellDate, r.realisedQty]), "the splitter's rows").toEqual([
      [3, "2026-05-01", 5],
      [3, "2026-05-05", 5],
    ]);
    const s = sttSplit(rows, "2026-27");
    expect(s.deductibleTrades, "one ladder is one trade").toBe(1);
    expect(s.deductibleLadders).toEqual([
      {
        id: 9,
        symbol: "NIFTYSHORT",
        sttCtt: 10,
        fills: [
          { fillLegId: 3, sellDate: "2026-05-01", qty: 5, sttCtt: 5 },
          { fillLegId: 3, sellDate: "2026-05-05", qty: 5, sttCtt: 5 },
        ],
      },
    ]);
  });

  it("rows WITHOUT an id still count one trade per row", () => {
    const s = sttSplit([t({ sttCtt: 1 }), t({ sttCtt: 2 })], "2026-27");
    expect(s.forfeitedTrades).toBe(2);
    expect(s.forfeitedLadders).toEqual([]);
  });
});

describe("ltcgRunway — a fact about dates, not a suggestion to hold", () => {
  it("counts days held and days remaining to the 12-month line", () => {
    const lots: OpenLot[] = [
      { id: 1, symbol: "INFY", segment: "eq_delivery", buyDate: "2026-01-01", unrealised: 5000 },
    ];
    const r = ltcgRunway(lots, "2026-12-27");
    expect(r.rows[0].daysHeld).toBe(360);
    /**
     * A11 (v4.5.0 fix list) — 6, NOT 5: THE LINE IS A CALENDAR DATE.
     *
     * The Act says "months", and the General Clauses Act 1897 s.3(35) makes
     * that a calendar month reckoned from a date — which is what
     * `heldMoreThanMonths` (lib/analytics/cg-heads.ts) classifies a realised
     * sale by. This countdown used `365 − daysHeld` and so disagreed with the
     * head rule by up to two days at the boundary: the screen said "long-term
     * tomorrow" for a lot the ITR export would still file as short.
     *
     * THE ARITHMETIC. Bought 2026-01-01, so the last day a sale is still SHORT
     * is 2026-01-01 + 12 months = 2027-01-01 (a transfer must fall AFTER it);
     * the first LONG-term day is therefore 2027-01-02. From 2026-12-27 that is
     * 6 days away — 28, 29, 30, 31, 01, 02. The old 365-day rule answered
     * 365 − 360 = 5, i.e. 2027-01-01, a day on which the sale is still short.
     */
    expect(r.rows[0].daysToLongTerm).toBe(6);
    expect(r.rows[0].alreadyLongTerm).toBe(false);
    expect(r.crossingSoon).toBe(1);
  });

  it("A11 · 29 FEBRUARY: the countdown clamps to 28 Feb exactly as the head rule clamps it", () => {
    /**
     * A lot bought on a leap day has no anniversary, and `addMonthsIso` clamps
     * it to 2025-02-28 — so that is the last SHORT day and 2025-03-01 is the
     * first LONG one. 365 days from 2024-02-29 is 2025-02-28, which the old
     * rule then counted as already long-term: one day early, on the one date
     * in the calendar where the two rules are guaranteed to disagree.
     */
    const lot = (buyDate: string): OpenLot => ({ id: 1, symbol: "LEAP", segment: "eq_delivery", buyDate, unrealised: 1 });

    // From 2025-02-20: 2025-03-01 is 9 days away (21…28 is 8, then 01).
    const before = ltcgRunway([lot("2024-02-29")], "2025-02-20");
    expect(before.rows[0].daysToLongTerm).toBe(9);
    expect(before.rows[0].alreadyLongTerm).toBe(false);

    // On the last short day itself: one day left, and still not long-term.
    const onTheLine = ltcgRunway([lot("2024-02-29")], "2025-02-28");
    expect(onTheLine.rows[0].daysToLongTerm).toBe(1);
    expect(onTheLine.rows[0].alreadyLongTerm).toBe(false);
    // …and the head rule agrees, from the other side: a sale ON 2025-02-28 is
    // short, a sale on 2025-03-01 is long. Two modules, one boundary.
    expect(heldMoreThanMonths("2024-02-29", "2025-02-28", 12)).toBe(false);
    expect(heldMoreThanMonths("2024-02-29", "2025-03-01", 12)).toBe(true);

    // The day after: long-term, and the countdown is spent.
    const after = ltcgRunway([lot("2024-02-29")], "2025-03-01");
    expect(after.rows[0].alreadyLongTerm).toBe(true);
    expect(after.rows[0].daysToLongTerm).toBe(0);
  });

  it("A11 · the countdown and the head rule agree on EVERY buy date of a year, never by ±1 day", () => {
    // The class, not the case: for each date, the day `daysToLongTerm` points
    // at must be the FIRST day `heldMoreThanMonths` calls long-term, and the
    // day before it must still be short.
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const TODAY = "2026-06-15";
    for (let i = 0; i < 366; i++) {
      const buy = iso(new Date(Date.UTC(2025, 5, 15) + i * 86400000));
      const [row] = ltcgRunway([{ id: 1, symbol: "X", segment: "eq_delivery", buyDate: buy, unrealised: 1 }], TODAY).rows;
      if (row.alreadyLongTerm) {
        expect(heldMoreThanMonths(buy, TODAY, 12), `${buy} claims already long-term`).toBe(true);
        expect(row.daysToLongTerm, `${buy}`).toBe(0);
        continue;
      }
      const crosses = iso(new Date(Date.parse(`${TODAY}T00:00:00Z`) + row.daysToLongTerm * 86400000));
      const dayBefore = iso(new Date(Date.parse(`${crosses}T00:00:00Z`) - 86400000));
      expect(heldMoreThanMonths(buy, crosses, 12), `${buy} → ${crosses} must be LONG`).toBe(true);
      expect(heldMoreThanMonths(buy, dayBefore, 12), `${buy} → ${dayBefore} must still be SHORT`).toBe(false);
    }
  });

  it("clamps to zero once already long-term", () => {
    const r = ltcgRunway(
      [{ id: 1, symbol: "TCS", segment: "eq_delivery", buyDate: "2024-01-01", unrealised: 1 }],
      "2026-06-01",
    );
    expect(r.rows[0].alreadyLongTerm).toBe(true);
    expect(r.rows[0].daysToLongTerm).toBe(0);
    expect(r.crossingSoon).toBe(0);
  });

  it("only ages capital assets — F&O and intraday never become long-term", () => {
    const r = ltcgRunway(
      [
        { id: 1, symbol: "NIFTY", segment: "index_option", buyDate: "2025-01-01", unrealised: 1 },
        { id: 2, symbol: "X", segment: "eq_intraday", buyDate: "2025-01-01", unrealised: 1 },
      ],
      "2026-06-01",
    );
    expect(r.rows).toHaveLength(0);
  });

  it("reports undated lots rather than dropping them", () => {
    const r = ltcgRunway(
      [{ id: 1, symbol: "X", segment: "eq_delivery", buyDate: null, unrealised: 1 }],
      "2026-06-01",
    );
    expect(r.rows).toHaveLength(0);
    expect(r.undated).toBe(1);
  });

  it("orders by soonest to cross", () => {
    const r = ltcgRunway(
      [
        { id: 1, symbol: "A", segment: "eq_delivery", buyDate: "2026-06-01", unrealised: 1 },
        { id: 2, symbol: "B", segment: "eq_delivery", buyDate: "2026-01-01", unrealised: 1 },
      ],
      "2026-12-01",
    );
    expect(r.rows.map((x) => x.symbol)).toEqual(["B", "A"]);
  });
});

describe("setOffAsymmetry — the lever every competitor misses", () => {
  it("states the rule whether or not the book triggers it", () => {
    const f = setOffAsymmetry({ fnoBusiness: 0, speculative: 0, capitalGains: 0 }, "2026-27");
    expect(f.rule).toContain("s.109");
    expect(f.rule).toContain("s.112");
    expect(f.rule).toContain("NEVER against salary");
    expect(f.finding).toBeNull();
  });

  it("quantifies what an F&O loss can absorb THIS year", () => {
    const f = setOffAsymmetry({ fnoBusiness: -50000, speculative: 0, capitalGains: 30000 }, "2026-27");
    expect(f.absorbableNow).toBe(30000); // capped by the gains available
    expect(f.finding).toContain("30,000");
    expect(f.finding).toContain("THIS year");
  });

  it("caps absorption at the loss, not the gain", () => {
    const f = setOffAsymmetry({ fnoBusiness: -20000, speculative: 0, capitalGains: 90000 }, "2026-27");
    expect(f.absorbableNow).toBe(20000);
  });

  it("says plainly when a loss has nothing to meet, and what that costs", () => {
    const f = setOffAsymmetry({ fnoBusiness: -40000, speculative: 0, capitalGains: 0 }, "2026-27");
    expect(f.finding).toContain("no capital gains to meet");
    expect(f.finding).toContain("filed by the due date");
    expect(f.absorbableNow).toBe(0);
  });

  it("explains that an intraday loss is quarantined", () => {
    const f = setOffAsymmetry({ fnoBusiness: 0, speculative: -15000, capitalGains: 50000 }, "2026-27");
    expect(f.finding).toContain("quarantined");
    expect(f.finding).toContain("four years");
  });

  it("cites the Act in force for the year", () => {
    expect(setOffAsymmetry({ fnoBusiness: 0, speculative: 0, capitalGains: 0 }, "2024-25").rule).toContain("S.71");
  });
});

describe("the caveats are the product", () => {
  it("says the exemption threshold is per PERSON, not per account", () => {
    expect(LTCG_THRESHOLD_CAVEAT).toContain("per PERSON");
    expect(LTCG_THRESHOLD_CAVEAT).toContain("upper bound");
  });

  it("refuses to claim it computes a liability", () => {
    expect(LIABILITY_CAVEAT).toContain("does not compute what you owe");
  });

  it("states there is NO wash-sale rule instead of inventing a waiting period", () => {
    expect(NO_WASH_SALE_CAVEAT).toContain("no wash-sale rule");
    expect(NO_WASH_SALE_CAVEAT).toContain("inventing a rule");
  });

  it("exports nothing that recommends a transaction", async () => {
    // (C) is enforced by ABSENCE. If someone adds a "sell these" helper, this
    // fails and they have to argue with the reason rather than the code.
    const mod = await import("@/lib/analytics/tax-levers");
    const names = Object.keys(mod);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      expect(n, `${n} reads like a recommendation`).not.toMatch(
        /recommend|suggest|advice|advise|shouldSell|opportunit|pick|bestTo/i,
      );
    }
  });

  it("no caveat text tells the user to sell, or invents a waiting period", () => {
    for (const text of [LTCG_THRESHOLD_CAVEAT, LIABILITY_CAVEAT, NO_WASH_SALE_CAVEAT]) {
      expect(text.toLowerCase()).not.toMatch(/you should sell|wait \d+ days|before buying back you/);
    }
  });
});

describe("hasLeverContent", () => {
  it("is false for an empty book, so the screen can render nothing", () => {
    const s = sttSplit([], "2026-27");
    const r = ltcgRunway([], "2026-06-01");
    const f = setOffAsymmetry({ fnoBusiness: 0, speculative: 0, capitalGains: 0 }, "2026-27");
    expect(hasLeverContent(s, r, f)).toBe(false);
  });

  it("is true as soon as any one lever has something to say", () => {
    const s = sttSplit([t({ segment: "eq_delivery", sttCtt: 10 })], "2026-27");
    const r = ltcgRunway([], "2026-06-01");
    const f = setOffAsymmetry({ fnoBusiness: 0, speculative: 0, capitalGains: 0 }, "2026-27");
    expect(hasLeverContent(s, r, f)).toBe(true);
  });
});
