import { test, expect } from "@playwright/test";

/**
 * v4.6.0 W3 (owner ruling T1) — the three analytics hubs.
 *
 * Each of the seven pre-hub URLs must LAND on its hub with `?tab=<id>` (a 307
 * from the old page.tsx, lib/domain/hubs.ts `legacyRedirect`), the hub must
 * render a real tab strip (`role="tablist"`, Radix) naming its tabs, and the
 * tab the URL names must be the one marked `aria-selected`. A bookmark to an
 * old screen that 404s, or lands on the hub's default tab instead of the one
 * it named, is the failure this spec exists to catch.
 *
 * Seeded settings leave workspace = "both" (schema default; see
 * z-sidebar-fold.spec.ts), so every tab is in every strip here.
 *
 * It seeds nothing — a hub and its strip render the same over an empty book
 * (each tab states its own empty state). The `z-` prefix still sorts it after
 * import-dashboard.spec.ts, so a later edit that adds seeding stays safe
 * (AGENTS.md).
 */

const CASES: { from: string; to: RegExp; heading: RegExp; tabs: string[]; active: string }[] = [
  { from: "/reports/edge", to: /\/reports\/edge-clinic\?tab=setups$/, heading: /Edge Clinic/, tabs: ["Setups", "Discipline", "Scaling & Replay"], active: "Setups" },
  { from: "/reports/discipline", to: /\/reports\/edge-clinic\?tab=discipline$/, heading: /Edge Clinic/, tabs: ["Setups", "Discipline", "Scaling & Replay"], active: "Discipline" },
  { from: "/reports/scaling", to: /\/reports\/edge-clinic\?tab=scaling$/, heading: /Edge Clinic/, tabs: ["Setups", "Discipline", "Scaling & Replay"], active: "Scaling & Replay" },
  { from: "/reports/rom", to: /\/reports\/capital\?tab=rom$/, heading: /Capital & Expiry/, tabs: ["Return on Margin", "Expiry"], active: "Return on Margin" },
  { from: "/reports/expiry", to: /\/reports\/capital\?tab=expiry$/, heading: /Capital & Expiry/, tabs: ["Return on Margin", "Expiry"], active: "Expiry" },
  { from: "/reports/charges", to: /\/reports\/costs\?tab=charges$/, heading: /Costs/, tabs: ["Charges & MTF Leak", "Broker Costs"], active: "Charges & MTF Leak" },
  { from: "/reports/broker-compare", to: /\/reports\/costs\?tab=broker-compare$/, heading: /Costs/, tabs: ["Charges & MTF Leak", "Broker Costs"], active: "Broker Costs" },
];

for (const c of CASES) {
  test(`${c.from} lands on its hub tab`, async ({ page }) => {
    // On the wire first: a REAL 307 from next.config.ts redirects(), not the
    // page stub's streamed NEXT_REDIRECT (a 200 only client JS can follow —
    // measured 2026-09-25). A bookmark, curl or the screenshot script sees this.
    const wire = await page.request.get(c.from, { maxRedirects: 0 });
    expect(wire.status(), "config-level redirect").toBe(307);
    expect(wire.headers()["location"]).toMatch(c.to);
    const res = await page.goto(c.from);
    expect(res?.status(), "the hub rendered, not an error").toBeLessThan(400);
    await expect(page).toHaveURL(c.to);
    await expect(page.getByRole("heading", { level: 1, name: c.heading })).toBeVisible();

    const strip = page.getByRole("tablist");
    await expect(strip).toHaveCount(1);
    await expect(strip.getByRole("tab")).toHaveText(c.tabs);
    await expect(strip.getByRole("tab", { name: c.active, exact: true })).toHaveAttribute("aria-selected", "true");
    for (const other of c.tabs.filter((t) => t !== c.active)) {
      await expect(strip.getByRole("tab", { name: other, exact: true })).toHaveAttribute("aria-selected", "false");
    }
  });
}

test("a tab link navigates: the strip is links, and the server renders the tab it names", async ({ page }) => {
  await page.goto("/reports/costs");
  await expect(page.getByRole("tab", { name: "Charges & MTF Leak", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Broker Costs", exact: true }).click();
  await expect(page).toHaveURL(/\/reports\/costs\?tab=broker-compare$/);
  await expect(page.getByRole("tab", { name: "Broker Costs", exact: true })).toHaveAttribute("aria-selected", "true");
});
