import { describe, it, expect } from "vitest";
import { toPaise, toRupees, parsePaise, addP, mulP, pctP, roundRupee, sumP } from "@/lib/money";

describe("money — conversions", () => {
  it("rupees ↔ paise round-trips exactly", () => {
    expect(toPaise(1380.55)).toBe(138055);
    expect(toRupees(138055)).toBe(1380.55);
    expect(toPaise(0)).toBe(0);
    expect(toPaise(-200)).toBe(-20000);
  });

  it("parses messy money strings", () => {
    expect(parsePaise("1,380.55")).toBe(138055);
    expect(parsePaise("₹ 724.35")).toBe(72435);
    expect(parsePaise(-200)).toBe(-20000);
    expect(parsePaise("")).toBe(0);
    expect(parsePaise(null)).toBe(0);
  });
});

describe("money — integer arithmetic avoids float drift", () => {
  it("0.1 + 0.2 in paise is exact", () => {
    expect(addP(toPaise(0.1), toPaise(0.2))).toBe(30); // not 0.30000000000004
    expect(toRupees(addP(toPaise(0.1), toPaise(0.2)))).toBe(0.3);
  });

  it("sumP adds a list of paise", () => {
    expect(sumP([10000, 25050, -5000])).toBe(30050);
  });

  it("mulP rounds to whole paise", () => {
    expect(mulP(33333, 3)).toBe(99999);
    expect(mulP(100, 1.5)).toBe(150);
  });

  it("pctP applies a fractional rate", () => {
    expect(pctP(toPaise(10000), 0.001)).toBe(toPaise(10)); // 0.1% of ₹10,000 = ₹10
    expect(pctP(toPaise(100000), 0.0002)).toBe(toPaise(20)); // 0.02% of ₹1,00,000 = ₹20
  });
});

describe("money — statutory rounding", () => {
  it("rounds to the nearest rupee, expressed in paise", () => {
    expect(roundRupee(toPaise(138.55))).toBe(toPaise(139));
    expect(roundRupee(toPaise(138.49))).toBe(toPaise(138));
    expect(roundRupee(toPaise(0.5))).toBe(toPaise(1)); // round-half-up
  });
});
