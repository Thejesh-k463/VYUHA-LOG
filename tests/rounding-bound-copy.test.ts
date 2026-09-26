import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

/**
 * RC-1 + DA-7 (v4.6.0 fix wave) — the W7 owner answer Q2 (LEDGER D-14): the
 * ~₹1 per-day gap between the engine and a contract note is ACCEPTED and its
 * bound is STATED, in three places. Nothing pinned the sentence, so deleting all
 * three stayed green. ONE test reads the three sources.
 *
 *   - app/reports/costs/_tabs/broker-compare.tsx — the "vs recorded" footnote;
 *   - app/reports/tax/page.tsx — the tax footnote;
 *   - lib/domain/help-topics.ts — the broker-compare help card (read only here).
 *
 * DA-7: the broker columns re-price the PARENT row once (lib/analytics/
 * broker-compare.ts), so "(per fill on a staged ladder)" is true on the tax page
 * only and must not appear on the broker-compare footnote.
 */
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\s+/g, " ");

describe("the ₹0.50 × N rounding bound is stated where it applies", () => {
  it("broker-compare, the tax footnotes and the help card each state it: per row, once per contract note, ₹0.50 per head", () => {
    for (const rel of ["app/reports/costs/_tabs/broker-compare.tsx", "app/reports/tax/page.tsx", "lib/domain/help-topics.ts"]) {
      const src = read(rel);
      expect(src, `${rel} states the per-row rounding`).toMatch(/per trade row/);
      expect(src, `${rel} names the contract note`).toMatch(/contract note/);
      expect(src, `${rel} states the bound`).toMatch(/₹0\.50 (?:× N )?per (?:row per )?head/);
    }
    expect(read("app/reports/costs/_tabs/broker-compare.tsx")).toContain("differ from your bill by up to ₹0.50 × N per head");
    expect(read("app/reports/tax/page.tsx")).toContain("differ from your bill by up to ₹0.50 × N per head");
  });

  it("DA-7: broker-compare re-prices the parent once, so it does not claim a per-fill rounding; the tax page (realised rows per fill) does", () => {
    expect(read("app/reports/costs/_tabs/broker-compare.tsx")).not.toContain("per fill on a staged ladder");
    expect(read("app/reports/tax/page.tsx")).toContain("(per fill on a staged ladder)");
  });
});
