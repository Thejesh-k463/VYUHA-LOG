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
    expect(golden, "the trade report's committed net").toContain("commit: { net: -271.9,");
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
      expect(text).toMatch(/−271\.90|-271\.90/);
    });
  }
});
