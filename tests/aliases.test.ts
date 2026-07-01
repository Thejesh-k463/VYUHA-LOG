import { describe, it, expect } from "vitest";
import { parseAliasList, buildAliasMap, resolveTicker } from "@/lib/analytics/aliases";

describe("parseAliasList", () => {
  it("parses name → ticker with mixed separators; skips comments/short lines", () => {
    const text = [
      "# NSE aliases",
      "ADANI TOTAL GAS LIMITED, ATGL",
      "ANGEL ONE LIMITED | ANGELONE | broker full name",
      "BHARAT COKING COAL LTD\tBCCL",
      "incomplete-line",
    ].join("\n");
    const rows = parseAliasList(text);
    expect(rows).toEqual([
      { alias: "ADANI TOTAL GAS LIMITED", ticker: "ATGL", note: null },
      { alias: "ANGEL ONE LIMITED", ticker: "ANGELONE", note: "broker full name" },
      { alias: "BHARAT COKING COAL LTD", ticker: "BCCL", note: null },
    ]);
  });
});

describe("buildAliasMap / resolveTicker", () => {
  const map = buildAliasMap([
    { alias: "ADANI TOTAL GAS LIMITED", ticker: "ATGL" },
    { alias: "tcs", ticker: "tcs" },
  ]);

  it("resolves a known alias to its ticker (case-insensitive)", () => {
    expect(resolveTicker("ADANI TOTAL GAS LIMITED", map)).toBe("ATGL");
    expect(resolveTicker("adani total gas limited", map)).toBe("ATGL");
  });

  it("falls back to the upper-cased symbol when unmapped", () => {
    expect(resolveTicker("RELIANCE", map)).toBe("RELIANCE");
    expect(resolveTicker("reliance", map)).toBe("RELIANCE");
  });
});
