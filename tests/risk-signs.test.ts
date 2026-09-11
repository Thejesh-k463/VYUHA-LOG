import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { formatSignedPair, signOf, signedNumber, signedPct, inrCompact } from "@/lib/format";

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

// ===========================================================================
// v4.3.0 wave 2 — the eight INDEPENDENT-sign sites B5 listed but did not own.
//
// Wave 1 applied R8 at five cockpit sites. Every other surface still carried a
// private `pct` / `sign` / `signed` helper of the shape `v >= 0 ? "+" : ""`,
// which is the exact construct that printed "-₹17 · +0.00%": a sign chosen
// from the percentage rather than from the rupee fact underneath it, and a
// zero that claims to be a gain. All eight now go through @/lib/format.
// ===========================================================================

describe("signedNumber — one sign, zero unsigned, the caller's own rounding", () => {
  it("signs itself when no rupee figure is named", () => {
    expect(signedNumber(12.5)).toBe("+12.5");
    expect(signedNumber(-12.5)).toBe("-12.5");
  });

  it("leaves zero UNSIGNED — the whole behaviour change at these sites", () => {
    expect(signedNumber(0)).toBe("0");
    expect(signedNumber(-0)).toBe("0");
    expect(signedNumber(0, { decimals: 2 })).toBe("0.00");
  });

  it("keeps the caller's rounding when decimals are omitted", () => {
    // p.totalReturnPct is already r2()'d upstream and printed raw: "12.5%",
    // never "12.50%". Signing it must not re-round it.
    expect(signedNumber(12.5)).toBe("+12.5");
    expect(signedNumber(12.5, { decimals: 2 })).toBe("+12.50");
    expect(signedNumber(-1.239, { decimals: 1 })).toBe("-1.2");
  });

  it("BORROWS the rupee figure's sign when one is named (R8)", () => {
    // The ledger card's "Difference" ₹ and "vs estimate" % are one fact.
    expect(signedNumber(0.001, { from: -17 })).toBe("-0.001");
    expect(signedNumber(0, { from: -17 })).toBe("-0");
    expect(signedNumber(4, { from: 17 })).toBe("+4");
    expect(signedNumber(4, { from: 0 })).toBe("4");
    expect(signedNumber(4, { from: null })).toBe("4");
  });

  it("is an em dash for a figure that does not exist", () => {
    expect(signedNumber(null)).toBe("—");
    expect(signedNumber(undefined)).toBe("—");
    expect(signedNumber(Number.NaN)).toBe("—");
  });

  it("agrees with signOf over the whole sign matrix", () => {
    for (const v of [-1234.5, -0.004, 0, 0.004, 1234.5]) {
      const s = signedNumber(v);
      const seen = s.startsWith("-") ? "-" : s.startsWith("+") ? "+" : "";
      expect(seen, `signedNumber(${v}) = "${s}"`).toBe(signOf(v));
    }
  });
});

/**
 * Source-shape pins. A formatter nobody calls fixes nothing, and a local
 * helper left in place grows the independent sign straight back.
 */
const SIGN_SITES: { rel: string; imports: RegExp }[] = [
  { rel: "app/reports/rom/page.tsx", imports: /signedPct/ },
  { rel: "app/reports/monthly/page.tsx", imports: /signedNumber/ },
  { rel: "app/reports/performance/page.tsx", imports: /signedNumber/ },
  { rel: "components/cash/ledger-import.tsx", imports: /signedNumber/ },
  { rel: "components/risk/greeks-panel.tsx", imports: /signOf/ },
  { rel: "components/risk/var-panel.tsx", imports: /signOf/ },
  { rel: "components/risk/mtf-drift-card.tsx", imports: /signedNumber/ },
  // v4.3.0 fix wave 1 (R28) — five more hand-rolled `>= 0 ? "+"` sites the
  // wave-2 list above did not reach. Each printed "+₹0" / "+0R" for a zero.
  { rel: "components/settings/capital-card.tsx", imports: /signOf/ },
  { rel: "app/reports/expiry/page.tsx", imports: /signOf/ },
  { rel: "components/cash/ledger-table.tsx", imports: /signOf/ },
  { rel: "components/trades/staged-panel.tsx", imports: /signedNumber/ },
  { rel: "lib/queries/capital.ts", imports: /signOf/ },
];

const srcOf = (rel: string) => fs.readFileSync(path.join(process.cwd(), ...rel.split("/")), "utf8");

describe.each(SIGN_SITES)("$rel signs through @/lib/format", ({ rel, imports }) => {
  const src = srcOf(rel);

  it("has no `? \"+\" :` of its own left", () => {
    // `\r?\n` nowhere needed: every one of these sat on a single line.
    const own = src.match(/\?\s*"\+"\s*:/g) ?? [];
    expect(own, `independent sign choices still in ${rel}: ${own.join(" | ")}`).toEqual([]);
  });

  it("declares no local pct/sign/signed helper", () => {
    const local = src.match(/const (pct|sign|signed) = \(/g) ?? [];
    expect(local, `local sign helpers still in ${rel}: ${local.join(" | ")}`).toEqual([]);
  });

  it("imports the shared helper it needs", () => {
    const imp = /import \{([^}]*)\} from "@\/lib\/format";/.exec(src);
    expect(imp, `${rel} imports nothing from lib/format`).not.toBeNull();
    expect(imp![1]).toMatch(imports);
  });
});

describe("the drawdown keeps a HARD minus, and says why at the site", () => {
  // performance.ts returns maxDrawdownPct = r2(Math.abs(maxDdFrac) * 100) — a
  // positive MAGNITUDE by construction, so signOf() would print "+".
  it("both drawdown sites carry the by-construction comment", () => {
    for (const rel of ["app/reports/monthly/page.tsx", "app/reports/performance/page.tsx"]) {
      const src = srcOf(rel);
      expect(src, `${rel} lost the hard-minus justification`).toMatch(/positive magnitude by construction/);
    }
  });
});

/**
 * R28 — the live position panel's Open R. It chose its own sign
 * (`openR >= 0 ? "+" : "−"`), so a flat position read "+0.00R". The live desk
 * already has the formatter for an R figure — desk-format's `rMultiple`, which
 * takes ppm, keeps the real minus (U+2212) the desk uses, and leaves zero
 * unsigned — so the panel goes through it rather than a new ternary. Its
 * `signedInr` had the same zero defect on the Unrealised stat ("+₹0").
 */
describe("the live position panel signs through desk-format (R28)", () => {
  const src = srcOf("components/live/position-chart-panel.tsx");

  it("has no hand-rolled `>= 0 ? \"+\"` of its own", () => {
    const own = src.match(/>= 0 \? "\+"/g) ?? [];
    expect(own, `independent sign choices still in the panel: ${own.join(" | ")}`).toEqual([]);
  });

  it("renders Open R through rMultiple, fed ppm", () => {
    expect(src).toMatch(/import \{[^}]*\brMultiple\b[^}]*\} from "\.\/desk-format";/);
    expect(src).toMatch(/rMultiple\(Math\.round\(openR \* PPM\)\)/);
  });

  it("signedInr leaves a zero unsigned — no `: \"+\"` fall-through for p === 0", () => {
    expect(src).not.toMatch(/p < 0 \? "−" : "\+";/);
  });

  it("rMultiple: zero unsigned, a real minus, two decimals", async () => {
    const { rMultiple } = await import("@/components/live/desk-format");
    expect(rMultiple(0)).toBe("0.00R");
    expect(rMultiple(-1_500_000)).toBe("−1.50R");
    expect(rMultiple(250_000)).toBe("+0.25R");
  });
});
