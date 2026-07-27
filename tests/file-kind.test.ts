import { describe, it, expect } from "vitest";
import {
  classifyFileKind,
  capabilityOf,
  guessProduct,
  guessReason,
  PRODUCT_CHOICES,
} from "@/lib/import/file-kind";

describe("classifyFileKind", () => {
  it("treats tradebook and console exports as transaction files", () => {
    expect(classifyFileKind("tradebook")).toBe("transactions");
    expect(classifyFileKind("console")).toBe("transactions");
    expect(classifyFileKind("TRADEBOOK")).toBe("transactions");
  });

  it("treats aggregated exports as P&L files", () => {
    expect(classifyFileKind("pnl")).toBe("pnl");
    expect(classifyFileKind("pnl-report")).toBe("pnl");
    expect(classifyFileKind("xlsx")).toBe("pnl");
    expect(classifyFileKind("pdf")).toBe("pnl");
  });

  it("defaults an unknown format to P&L — the conservative reading", () => {
    // "pnl" triggers the confirmation step; assuming "transactions" would
    // claim detail the file may not actually have.
    expect(classifyFileKind("something-new")).toBe("pnl");
    expect(classifyFileKind("")).toBe("pnl");
  });
});

describe("capabilityOf", () => {
  it("says a transaction file knows product, time and fills", () => {
    const c = capabilityOf("transactions");
    expect(c.knowsProduct).toBe(true);
    expect(c.knowsTime).toBe(true);
    expect(c.knowsFills).toBe(true);
  });

  it("says a P&L file knows none of them", () => {
    const c = capabilityOf("pnl");
    expect(c.knowsProduct).toBe(false);
    expect(c.knowsTime).toBe(false);
    expect(c.knowsFills).toBe(false);
  });
});

describe("guessProduct", () => {
  it("infers intraday from a same-day round trip", () => {
    expect(guessProduct("2026-06-01", "2026-06-01")).toBe("intraday");
  });

  it("defaults to delivery when the position was held overnight", () => {
    expect(guessProduct("2026-06-01", "2026-06-05")).toBe("delivery");
  });

  it("NEVER guesses MTF — it is not inferable from a P&L file", () => {
    // An MTF position looks identical to a delivery position here. Guessing
    // MTF would invent interest charges that were never incurred.
    const guesses = [
      guessProduct("2026-06-01", "2026-06-05"),
      guessProduct("2026-06-01", "2026-06-01"),
      guessProduct(null, null),
      guessProduct("2026-06-01", null),
    ];
    expect(guesses).not.toContain("mtf");
  });

  it("falls back to delivery — the safest wrong answer — with no dates", () => {
    // Delivery neither invents MTF interest nor applies intraday leverage.
    expect(guessProduct(null, null)).toBe("delivery");
    expect(guessProduct("2026-06-01", null)).toBe("delivery");
  });
});

describe("guessReason", () => {
  it("explains a same-day inference as evidence, not assumption", () => {
    expect(guessReason("intraday", "2026-06-01", "2026-06-01")).toMatch(/same day/i);
  });

  it("admits the delivery default is an assumption", () => {
    expect(guessReason("delivery", "2026-06-01", "2026-06-05")).toMatch(/assumed/i);
  });
});

describe("PRODUCT_CHOICES", () => {
  it("offers exactly the three equity products a P&L file cannot distinguish", () => {
    expect(PRODUCT_CHOICES.map((c) => c.value)).toEqual(["delivery", "mtf", "intraday"]);
  });

  it("gives each choice a plain-language hint", () => {
    for (const c of PRODUCT_CHOICES) {
      expect(c.hint.length).toBeGreaterThan(0);
      expect(c.label.length).toBeGreaterThan(0);
    }
  });
});
