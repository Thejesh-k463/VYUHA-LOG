import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PENDING_BASIS_NOTE } from "@/components/trades/acquisition-panel";

/**
 * What the "sales with no purchase on record" panel says about Net P&L.
 *
 * Invariant 6: an unpriced sale books NO gain — its Net P&L is minus its
 * charges and nothing else. The panel used to say "The sale and its charges
 * are already counted in your cash and Net P&L", which sent people to
 * reconcile ₹2.75 Cr of proceeds that were never in the number. Pinned
 * verbatim, like the broker-connect consent copy: a change here is a
 * deliberate edit of this test in the same commit.
 */
describe("pending-basis copy", () => {
  it("is pinned verbatim", () => {
    expect(PENDING_BASIS_NOTE).toBe(
      "Only the charges on these sales are in your Net P&L so far — the proceeds are not, because with no cost there is no gain to book. Set the cost below (the IPO issue price, or what you actually paid) and each sale's gain lands in Net P&L.",
    );
  });

  it("says what IS counted, what is NOT, and what to do", () => {
    expect(PENDING_BASIS_NOTE).toMatch(/Only the charges .* are in your Net P&L/);
    expect(PENDING_BASIS_NOTE).toMatch(/the proceeds are not/);
    expect(PENDING_BASIS_NOTE).toMatch(/Set the cost/);
    // The false claim must not creep back, in either of its forms.
    expect(PENDING_BASIS_NOTE).not.toMatch(/already counted/);
    expect(PENDING_BASIS_NOTE).not.toMatch(/in your cash/);
  });

  it("is what the component renders — not a constant nobody uses", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "components", "trades", "acquisition-panel.tsx"), "utf8");
    expect(src).toMatch(/\{PENDING_BASIS_NOTE\}/);
    expect(src).not.toMatch(/already counted in your cash/);
  });
});
