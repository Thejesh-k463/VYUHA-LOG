import { describe, it, expect } from "vitest";
import {
  computeRestrictions,
  parseRestrictedList,
  normalizeCategory,
  type HeldSymbol,
  type RestrictedRow,
} from "@/lib/analytics/restrictions";

describe("normalizeCategory", () => {
  it("maps free-text tokens to canonical categories", () => {
    expect(normalizeCategory("F&O Ban")).toBe("fno_ban");
    expect(normalizeCategory("fno")).toBe("fno_ban");
    expect(normalizeCategory("MWPL")).toBe("fno_ban");
    expect(normalizeCategory("ASM Stage II")).toBe("asm");
    expect(normalizeCategory("GSM")).toBe("gsm");
    expect(normalizeCategory("price band")).toBe("circuit");
    expect(normalizeCategory("whatever")).toBe("other");
  });
});

describe("parseRestrictedList", () => {
  it("parses symbol, category and note from mixed separators; skips comments", () => {
    const text = [
      "# NSE F&O ban list 24-Jun",
      "RBLBANK, ban",
      "GNFC | F&O Ban | OI 96%",
      "ZEEL\tASM\tStage II",
      "",
      "IDEA, gsm, Stage 4",
    ].join("\n");
    const rows = parseRestrictedList(text, "2026-06-24", "NSE");
    expect(rows.length).toBe(4);
    expect(rows[0]).toMatchObject({ symbol: "RBLBANK", category: "fno_ban", asOfDate: "2026-06-24", source: "NSE" });
    expect(rows[1]).toMatchObject({ symbol: "GNFC", category: "fno_ban", stage: "OI 96%" });
    expect(rows[2]).toMatchObject({ symbol: "ZEEL", category: "asm", stage: "Stage II" });
    expect(rows[3]).toMatchObject({ symbol: "IDEA", category: "gsm", stage: "Stage 4" });
  });
});

describe("computeRestrictions", () => {
  const list: RestrictedRow[] = [
    { symbol: "RBLBANK", category: "fno_ban", asOfDate: "2026-06-24" },
    { symbol: "GNFC", category: "fno_ban", asOfDate: "2026-06-24" },
    { symbol: "ZEEL", category: "asm", stage: "Stage II", asOfDate: "2026-06-24" },
    { symbol: "SUZLON", category: "gsm", asOfDate: "2026-06-24" },
    { symbol: "TATAMOTORS", category: "circuit", asOfDate: "2026-06-23" }, // older
  ];

  const held: HeldSymbol[] = [
    { symbol: "RBLBANK", isOpen: true, isFno: true, qty: 1300, segments: ["stock_option"] }, // F&O ban + holds F&O → high
    { symbol: "GNFC", isOpen: true, isFno: false, qty: 200, segments: ["eq_delivery"] }, // F&O ban but equity only → info
    { symbol: "ZEEL", isOpen: true, isFno: false, qty: 500, segments: ["eq_delivery"] }, // ASM → medium
    { symbol: "INFY", isOpen: true, isFno: false, qty: 100, segments: ["eq_delivery"] }, // not restricted
  ];

  const r = computeRestrictions(held, list);

  it("summarizes the list with latest as-of date and per-category counts", () => {
    expect(r.totalRestricted).toBe(5);
    expect(r.asOfDate).toBe("2026-06-24");
    expect(r.byCategory.fno_ban).toBe(2);
    expect(r.byCategory.asm).toBe(1);
    expect(r.byCategory.gsm).toBe(1);
    expect(r.byCategory.circuit).toBe(1);
  });

  it("raises alerts only for held restricted symbols", () => {
    expect(r.heldRestricted).toBe(3); // RBLBANK, GNFC, ZEEL (not INFY, not SUZLON)
    expect(r.alerts.map((a) => a.symbol)).not.toContain("INFY");
    expect(r.alerts.map((a) => a.symbol)).not.toContain("SUZLON");
  });

  it("F&O ban is high severity for an F&O holder", () => {
    const a = r.alerts.find((x) => x.symbol === "RBLBANK")!;
    expect(a.severity).toBe("high");
    expect(a.categories).toContain("fno_ban");
    expect(a.guidance).toMatch(/only position reduction/i);
  });

  it("F&O ban downgrades to info when only equity is held", () => {
    const a = r.alerts.find((x) => x.symbol === "GNFC")!;
    expect(a.severity).toBe("info");
    expect(a.headline).toMatch(/equity only/i);
  });

  it("orders alerts by severity (high first)", () => {
    expect(r.alerts[0].symbol).toBe("RBLBANK"); // high
    expect(r.alerts[r.alerts.length - 1].severity).toBe("info");
  });

  it("empty list → no alerts", () => {
    const e = computeRestrictions(held, []);
    expect(e.totalRestricted).toBe(0);
    expect(e.heldRestricted).toBe(0);
    expect(e.asOfDate).toBeNull();
  });
});
