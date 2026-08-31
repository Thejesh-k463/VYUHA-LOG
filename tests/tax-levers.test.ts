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
});

describe("ltcgRunway — a fact about dates, not a suggestion to hold", () => {
  it("counts days held and days remaining to the 12-month line", () => {
    const lots: OpenLot[] = [
      { id: 1, symbol: "INFY", segment: "eq_delivery", buyDate: "2026-01-01", unrealised: 5000 },
    ];
    const r = ltcgRunway(lots, "2026-12-27");
    expect(r.rows[0].daysHeld).toBe(360);
    expect(r.rows[0].daysToLongTerm).toBe(5);
    expect(r.rows[0].alreadyLongTerm).toBe(false);
    expect(r.crossingSoon).toBe(1);
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
