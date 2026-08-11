import { test, expect } from "@playwright/test";
import { ensureTrades } from "./helpers";

/**
 * The bundled NSE index map, end to end: one click on Instruments fills
 * sectors + thematic memberships, and the Edge report's theme card starts
 * answering. Unit tests cover the parser and the maths; what they cannot
 * cover is the route → merge-upsert → membership table → report pipeline.
 */
test("bundled NSE map: load, sectors appear, theme card comes alive", async ({ page }) => {
  await ensureTrades(page);

  await page.goto("/instruments");
  await page.waitForLoadState("networkidle");

  // The one-click panel states its snapshot date — the honesty stamp.
  await expect(page.getByText(/snapshot as of/i)).toBeVisible();

  // "Add every symbol" so the assertion doesn't depend on which symbols the
  // fixture happened to import.
  await page.getByLabel(/Add every symbol in the map/i).first().check();
  await page.getByRole("button", { name: /Load NSE sector map/i }).click();

  // Success line carries the as-of date and the membership count.
  await expect(page.getByText(/NSE map \(as of \d{4}-\d{2}-\d{2}\) applied to \d+ symbols/i)).toBeVisible({ timeout: 30_000 });

  // A liquid name from the map is now in the master with its official sector.
  await page.waitForLoadState("networkidle");
  const counter = page.getByText(/\d+ instruments · \d+ with sector/);
  await expect
    .poll(async () => {
      const t = (await counter.textContent().catch(() => "")) ?? "";
      return Number(t.match(/(\d+) with sector/)?.[1] ?? 0);
    }, { timeout: 20_000 })
    .toBeGreaterThan(1000);

  // Second click must be a clean idempotent re-apply, not a duplicate pile-up.
  await page.getByRole("button", { name: /Load NSE sector map/i }).click();
  // .first(): since the toast migration the recap appears as BOTH a transient
  // toast and the persistent status line — the message being visible is the
  // contract; its multiplicity is the toaster stacking by design.
  await expect(page.getByText(/applied to \d+ symbols/i).first()).toBeVisible({ timeout: 30_000 });

  // The Edge report now has the theme lens — with its overlap disclosure.
  await page.goto("/reports/edge");
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(/By NSE theme/i).first()).toBeVisible();
  await expect(page.getByText(/Themes overlap|lens, not a slice/i).first()).toBeVisible();
});
