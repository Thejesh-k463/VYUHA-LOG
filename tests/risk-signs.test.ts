import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { formatSignedPair, signOf, signedPct, inrCompact } from "@/lib/format";

/**
 * R8 — the percentage sign FOLLOWS the rupee value.
 *
 * The Open P&L tile printed "-₹17 · +0.00%": one loss, two signs. The ₹ half
 * and the % half each chose their own (`inrCompact(e.unrealised)` beside
 * `e.openPnlPct >= 0 ? "+" : ""`), so a loss whose percentage of capital
 * rounded to nothing wore a gain's plus. The two are not independent facts —
 * they are one fact stated twice — so one formatter now signs both.
 *
 * Ruling: the percentage sign follows the RUPEE value; a rupee value of zero
 * prints unsigned; a negative rupee with a percentage that rounds to 0.00
 * prints "-0.00%" (a loss too small to show, never a gain).
 *
 * The sign glyph is ASCII "-", the one `inrCompact()` already emits — not
 * U+2212 — so the two halves cannot disagree typographically either.
 */
describe("signOf — the one sign both halves wear", () => {
  it("is the rupee value's sign, and zero is unsigned", () => {
    expect(signOf(-17)).toBe("-");
    expect(signOf(17)).toBe("+");
    expect(signOf(0)).toBe("");
    expect(signOf(-0.004)).toBe("-");
  });

  it("has no sign for a figure that does not exist", () => {
    expect(signOf(null)).toBe("");
    expect(signOf(undefined)).toBe("");
    expect(signOf(Number.NaN)).toBe("");
  });
});

describe("signedPct — a percentage borrows the rupee figure's sign", () => {
  it("prints -0.00% for a loss whose percentage rounds away", () => {
    expect(signedPct(-17, 0.001)).toBe("-0.00%");
  });

  it("never doubles a sign when the percentage carries its own", () => {
    expect(signedPct(-17, -0.4)).toBe("-0.40%");
    expect(signedPct(17, 0.4)).toBe("+0.40%");
  });

  it("is unsigned at zero rupees", () => {
    expect(signedPct(0, 0)).toBe("0.00%");
  });

  it("is an em dash when there is no percentage", () => {
    expect(signedPct(-17, null)).toBe("—");
  });
});

describe("formatSignedPair — the Open P&L tile's whole value", () => {
  it("(-17, 0.001) signs BOTH halves as a loss", () => {
    expect(formatSignedPair(-17, 0.001)).toBe("-₹17 · -0.00%");
  });

  it("(0, 0) prints unsigned on both halves", () => {
    expect(formatSignedPair(0, 0)).toBe("₹0 · 0.00%");
  });

  it("(17, 0.4) signs BOTH halves as a gain", () => {
    expect(formatSignedPair(17, 0.4)).toBe("+₹17 · +0.40%");
  });

  it("the two halves can never disagree, over the whole sign matrix", () => {
    for (const rupees of [-1_23_456, -17, -0.004, 0, 0.004, 17, 1_23_456]) {
      for (const p of [-9.5, -0.001, 0, 0.001, 9.5]) {
        const s = formatSignedPair(rupees, p);
        const [money, pctHalf] = s.split(" · ");
        const moneySign = money.startsWith("-") ? "-" : money.startsWith("+") ? "+" : "";
        const pctSign = pctHalf.startsWith("-") ? "-" : pctHalf.startsWith("+") ? "+" : "";
        expect(pctSign, `"${s}" states two signs for one fact`).toBe(moneySign);
        expect(moneySign).toBe(signOf(rupees));
      }
    }
  });

  it("keeps inrCompact's own magnitude and glyphs", () => {
    expect(formatSignedPair(-12_34_567, -1.5)).toBe(`-${inrCompact(12_34_567)} · -1.50%`);
  });
});

/**
 * Source-shape pin: the cockpit must not grow the independent sign back.
 * A formatter nobody calls fixes nothing — this is the half of the fix that
 * a revert of the call site would otherwise leave green.
 */
describe("risk-cockpit-client uses the shared formatter", () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "components", "risk", "risk-cockpit-client.tsx"),
    "utf8",
  );

  it("no longer chooses a percentage sign independently of the rupee value", () => {
    // Every remaining `>= 0 ? "+"` must be attached to a ₹ figure, never to a
    // `.toFixed(n)}%` percentage printed beside one.
    const independentPct = src.match(/>= 0 \? "\+" : ""\}\$\{[A-Za-z0-9_.]*[Pp]ct\.toFixed\(\d\)\}%/g) ?? [];
    expect(independentPct, `independent percentage signs still in the cockpit: ${independentPct.join(" | ")}`).toEqual([]);
  });

  it("never prints a signed rupee figure with its own >= 0 test (seam S-1: +₹0 beside ₹0)", () => {
    // A zero rupee value is unsigned everywhere (lib/format.ts signOf). The
    // per-position running-impact row used to print "+₹0" while the Open P&L
    // tile printed "₹0" for the same value; every rupee sign now comes from signOf().
    const ownRupeeSign = src.match(/[A-Za-z0-9_.]+ >= 0 \? "\+" : ""\}\{inrCompact\(/g) ?? [];
    expect(ownRupeeSign, `rupee figures signing themselves: ${ownRupeeSign.join(" | ")}`).toEqual([]);
    expect(src).toMatch(/\{signOf\(p\.unrealised\)\}\{inrCompact\(Math\.abs\(p\.unrealised\)\)\}/);
  });

  it("imports and calls the formatter", () => {
    expect(src).toMatch(/formatSignedPair/);
    expect(src).toMatch(/signedPct/);
    expect(src).toMatch(/from "@\/lib\/format"/);
  });

  it("the Open P&L tile's value is the pair formatter", () => {
    expect(src).toMatch(/formatSignedPair\(e\.unrealised, e\.openPnlPct\)/);
  });
});
