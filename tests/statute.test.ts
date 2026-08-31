import { describe, expect, it } from "vitest";
import {
  statuteForFy,
  statuteForDate,
  section,
  sectionOn,
  sectionWithLegacy,
  statuteNote,
  fyStartYear,
  STATUTE_CUTOVER_FY,
  STATUTE_CUTOVER_DATE,
  type SectionKey,
} from "@/lib/analytics/statute";

// The Income-tax Act, 2025 came into force on 1 April 2026 and repealed the 1961
// Act. A report for an EARLIER year must keep its own citations — retro-labelling
// it would make it cite law that never governed it.

describe("which Act governed a tax year", () => {
  it("2026-27 onward is the Income-tax Act, 2025", () => {
    expect(statuteForFy("2026-27").id).toBe("ita2025");
    expect(statuteForFy("2027-28").id).toBe("ita2025");
    expect(statuteForFy("2030-31").id).toBe("ita2025");
  });

  it("2025-26 and earlier remain the Income-tax Act, 1961", () => {
    expect(statuteForFy("2025-26").id).toBe("ita1961");
    expect(statuteForFy("2019-20").id).toBe("ita1961");
  });

  it("the cutover constant is the first year of the new Act", () => {
    expect(STATUTE_CUTOVER_FY).toBe("2026-27");
    expect(statuteForFy(STATUTE_CUTOVER_FY).id).toBe("ita2025");
  });

  it("the vocabulary changed too — 'tax year', not 'previous year'", () => {
    expect(statuteForFy("2026-27").periodNoun).toBe("tax year");
    expect(statuteForFy("2025-26").periodNoun).toBe("financial year");
  });

  it("an unparseable label falls back to the CURRENT Act, never the repealed one", () => {
    // A wrong-but-current citation misleads far less than confidently citing
    // law that no longer exists.
    expect(statuteForFy("").id).toBe("ita2025");
    expect(statuteForFy("garbage").id).toBe("ita2025");
    expect(statuteForFy("26-27").id).toBe("ita2025");
    expect(fyStartYear("garbage")).toBeNull();
    expect(fyStartYear("2026-27")).toBe(2026);
  });
});

describe("date-keyed resolution", () => {
  it("splits on 1 April 2026, the day the Act commenced", () => {
    expect(STATUTE_CUTOVER_DATE).toBe("2026-04-01");
    expect(statuteForDate("2026-03-31").id).toBe("ita1961");
    expect(statuteForDate("2026-04-01").id).toBe("ita2025");
  });

  it("a sale before the cutover is cited under the 1961 Act", () => {
    expect(sectionOn("2025-12-15", "stcgEquity")).toBe("S.111A");
    expect(sectionOn("2026-06-15", "stcgEquity")).toBe("s.196");
  });

  it("a missing date falls back to the current Act", () => {
    expect(statuteForDate(null).id).toBe("ita2025");
    expect(statuteForDate(undefined).id).toBe("ita2025");
    expect(statuteForDate("not-a-date").id).toBe("ita2025");
  });
});

describe("the section map itself", () => {
  it("maps the citations this app actually displays", () => {
    const cases: [SectionKey, string, string][] = [
      ["speculative", "S.43(5)", "s.66(31)"],
      ["derivativeCarveOut", "S.43(5) proviso (d)", "s.66(33)"],
      ["stcgEquity", "S.111A", "s.196"],
      ["ltcgEquity", "S.112A", "s.198"],
      ["grandfather", "S.55(2)(ac)", "s.90"],
      ["sttNotDeductibleCg", "proviso to S.48", "s.72(3)(b)"],
      ["sttBusinessExpense", "S.36(1)(xv)", "s.32(k)"],
      ["audit", "S.44AB", "s.63"],
      ["presumptive", "S.44AD", "s.58"],
      ["rebate", "S.87A", "s.156"],
      ["newRegime", "S.115BAC", "s.202"],
      ["interestDeferment", "S.234C", "s.425"],
      ["interestAdvanceTax", "S.234B", "s.424"],
      ["interestLateReturn", "S.234A", "s.423"],
      ["advanceTaxInstalments", "S.211", "s.408"],
    ];
    for (const [key, old, now] of cases) {
      expect(section("2024-25", key), `1961 label for ${key}`).toBe(old);
      expect(section("2026-27", key), `2025 label for ${key}`).toBe(now);
    }
  });

  it("both Acts define every key — a gap would render 'undefined' to a user", () => {
    const keys = Object.keys(statuteForFy("2026-27").sections) as SectionKey[];
    expect(keys.length).toBeGreaterThan(20);
    for (const k of keys) {
      expect(section("2024-25", k), `1961 missing ${k}`).toBeTruthy();
      expect(section("2026-27", k), `2025 missing ${k}`).toBeTruthy();
    }
    // The two Acts must agree on the key SET, or a call site silently loses one.
    expect(Object.keys(statuteForFy("2024-25").sections).sort()).toEqual(keys.slice().sort());
  });

  it("no citation is shared between the two Acts", () => {
    const keys = Object.keys(statuteForFy("2026-27").sections) as SectionKey[];
    for (const k of keys) {
      expect(section("2024-25", k), `${k} did not change`).not.toBe(section("2026-27", k));
    }
  });
});

describe("reader bridges", () => {
  it("annotates the new citation with the number readers already know", () => {
    expect(sectionWithLegacy("2026-27", "interestDeferment")).toBe("s.425 (formerly S.234C)");
    expect(sectionWithLegacy("2026-27", "audit")).toBe("s.63 (formerly S.44AB)");
  });

  it("does NOT annotate a pre-cutover year — there was nothing to bridge from", () => {
    expect(sectionWithLegacy("2024-25", "interestDeferment")).toBe("S.234C");
  });

  it("names the governing Act, and says the old one was repealed", () => {
    expect(statuteNote("2026-27")).toContain("Income-tax Act, 2025");
    expect(statuteNote("2026-27")).toContain("1 April 2026");
    expect(statuteNote("2024-25")).toContain("Income-tax Act, 1961");
    expect(statuteNote("2024-25")).toContain("repealed");
  });
});
