import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pins what the agent-facing docs say about a broker's evidence, so a banner
 * cannot outlive the fixtures it describes. Moved here from
 * tests/uninstall-claims.test.ts (where the v3.8 fix wave parked it for want
 * of a file) in the second-audit fix pass, 2026-09-04.
 *
 * AGENTS.md and docs/BROKER_FORMATS.md called Upstox "schema-only — its three
 * real exports carried zero data rows" for a fortnight after
 * tests/golden-books.test.ts started pinning two POPULATED Upstox exports. The
 * banner is the thing a future agent reads before deciding whether it may trust
 * an Upstox number, so it must not outlive the fixtures.
 */

const root = process.cwd();

describe("the Upstox schema-only caveat is retired everywhere it was stated", () => {
  const golden = readFileSync(path.join(root, "tests/golden-books.test.ts"), "utf8");

  it("golden-books really does pin populated Upstox exports", () => {
    expect(golden, "the realised-P&L reference Upstox itself states").toContain(
      "reference: { gross: -1.05, net: -4.28, charges: 3.23",
    );
    // −271.90 → −271.92 on 2026-09-11: the 4.3.0 exchange-charge epochs (C-8) price the trade
    // report at NSE's 1-Mar-2026 transaction rate; the docs quote the same figure.
    // −271.92 → −355.66 on 2026-09-18 (v4.4.0): the Upstox F&O grammar is VERIFIED, so the report's three
    // option contracts price as options (4 → 5 positions; charges 136.47 → 220.21).
    // −355.66 → −443.14 on 2026-09-22 (v4.5.0 wave U): findings D2 (Upstox delivery brokerage is
    // min(₹20, 2.5%), not 0.1%) and D3 (DP ₹20, not ₹18.50) reprice the two equity round trips;
    // gross is unchanged at −135.45 and the option half at 156.76. Charges 220.21 → 307.69.
    expect(golden, "the trade report's committed net").toContain("commit: { net: -443.14,");
  });

  for (const file of ["AGENTS.md", "docs/BROKER_FORMATS.md"]) {
    it(`${file} no longer says Upstox exports carry zero rows`, () => {
      const text = readFileSync(path.join(root, file), "utf8");
      // Line-based would miss a claim wrapped across two lines, which is how
      // the docs/BROKER_FORMATS.md copy of it survived the first pass.
      const flat = text.replace(/\s+/g, " ");
      const bad = [
        /Upstox is (?!no longer)[^.]*schema-only/i,
        /still schema-only/i,
        /still INFERRED for Upstox/i,
        /value behaviour is INFERRED/i,
      ]
        .map((re) => flat.match(re)?.[0])
        .filter(Boolean);
      expect(bad, `${file} still states the retired Upstox caveat`).toEqual([]);
    });

    it(`${file} states what actually pins Upstox now`, () => {
      const text = readFileSync(path.join(root, file), "utf8");
      expect(text).toMatch(/golden-books\.test\.ts/);
      expect(text).toMatch(/−4\.28|-4\.28/);
      // Follows the golden commit pinned above (−271.90 → −271.92, C-8, 2026-09-11;
      // → −355.66, the F&O grammar, 2026-09-18; → −443.14, D2/D3, 2026-09-22).
      expect(text).toMatch(/−443\.14|-443\.14/);
    });
  }
});
