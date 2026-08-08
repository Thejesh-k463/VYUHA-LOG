import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PRO_FEATURES } from "@/lib/license";

/**
 * PRO_FEATURES is the list the upsell card shows; <ProGate> is what actually
 * gates. Nothing in the type system ties them together, and they DID drift:
 * the registry advertised six screens while several substantive analytics
 * pages rendered free. These tests are the coupling — they read the real page
 * files, so a page listed as Pro but left ungated fails here.
 */

const ROOT = path.resolve(__dirname, "..");

/**
 * "/reports/edge" → app/reports/edge/page.tsx.
 *
 * A href carrying a QUERY STRING is an action on an otherwise-free page
 * (`/trades?add=open` opens a dialog on the ungated Trades screen), not a Pro
 * page — gating the page would gate the core journal. Those return null and
 * are covered by the open-trade test below.
 */
function pageFileFor(href: string): string | null {
  if (href.includes("?")) return null;
  const p = path.join(ROOT, "app", href === "/" ? "" : href, "page.tsx");
  return fs.existsSync(p) ? p : null;
}

const read = (p: string) => fs.readFileSync(p, "utf8");

describe("Pro gating — the registry and the real gates agree", () => {
  it("every advertised Pro page is actually wrapped in <ProGate>", () => {
    const ungated: string[] = [];
    for (const f of PRO_FEATURES) {
      const file = pageFileFor(f.href);
      // Entries without their own page (e.g. the open-trade action, gated in
      // the trades client) are covered by their own test below.
      if (!file) continue;
      const src = read(file);
      if (!src.includes("<ProGate>")) ungated.push(f.href);
    }
    expect(ungated, `advertised as Pro but rendering free: ${ungated.join(", ")}`).toEqual([]);
  });

  it("the open-trade entry point is entitlement-gated in the trades client", () => {
    const src = read(path.join(ROOT, "components/trades/trades-client.tsx"));
    // The button must be behind the `pro` flag, not merely styled differently.
    expect(src).toMatch(/\{!pro \?/);
    expect(src).toContain("Open trade");
  });

  it("the CORE JOURNAL stays free — recording trades is never held hostage", () => {
    // Invariant 7. These pages must NOT contain a gate.
    const free = [
      "app/page.tsx", // dashboard
      "app/trades/page.tsx",
      "app/import/page.tsx",
      "app/playbooks/page.tsx",
      "app/backup/page.tsx",
      "app/settings/page.tsx", // must stay reachable to enter a licence
      "app/cash/page.tsx",
      "app/help/page.tsx",
    ];
    const gated = free.filter((rel) => {
      const p = path.join(ROOT, rel);
      return fs.existsSync(p) && read(p).includes("<ProGate>");
    });
    expect(gated, `core-journal pages must never be gated: ${gated.join(", ")}`).toEqual([]);
  });

  it("no Pro page is advertised twice", () => {
    const hrefs = PRO_FEATURES.map((f) => f.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
