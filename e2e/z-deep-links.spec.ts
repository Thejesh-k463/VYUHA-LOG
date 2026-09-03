import { test, expect, type Page } from "@playwright/test";
import { ensureDatedTrades, gotoHydrated } from "./helpers";

/**
 * WS7 — the `/trades?…` deep-link contract, end to end.
 *
 * The property under test is not "the filter applies" (a unit test covers the
 * parser) but that the URL is KEPT: a filtered view can be reloaded and
 * re-entered, a filter change is mirrored back into the address bar, Back from
 * a drill-down returns to the page the user came from, and the two links that
 * used to be dead (`basis=unknown`, `view=open`) now land somewhere.
 *
 * `z-` prefix: seeds via ensureDatedTrades, so it must sort after
 * import-dashboard.spec.ts (AGENTS.md).
 */

const searchBox = (page: Page) => page.getByPlaceholder(/Search symbol/i);
const viewSelect = (page: Page) => page.locator("select").filter({ hasText: "All trades" });
const shownCount = async (page: Page) => {
  const counter = await page.getByText(/\d+\s+of\s+\d+/).first().textContent();
  return Number(counter?.match(/^(\d+)/)?.[1] ?? -1);
};

test("deep link: symbol + view are honoured, the query survives, and a filter change updates it", async ({ page }) => {
  await ensureDatedTrades(page);
  await page.goto("/trades?symbol=RELIANCE&view=open");

  // Client-restored state: poll, never a single read after networkidle.
  await expect(searchBox(page)).toHaveValue("RELIANCE");
  await expect(viewSelect(page)).toHaveValue("open");
  // The query is STILL in the address bar — the old client wiped it on mount.
  await expect.poll(() => page.url()).toContain("symbol=RELIANCE");
  await expect.poll(() => page.url()).toContain("view=open");

  // Changing a filter mirrors into the URL (replaceState — no history entry).
  await viewSelect(page).selectOption("closed");
  await expect.poll(() => page.url()).toContain("view=closed");
  expect(page.url()).not.toContain("view=open");
  expect(page.url()).toContain("symbol=RELIANCE");

  // …so a reload restores exactly this view.
  await page.reload();
  await expect(viewSelect(page)).toHaveValue("closed");
  await expect(searchBox(page)).toHaveValue("RELIANCE");
});

test("deep link: add= is a one-shot — stripped after the dialog opens, every other key kept", async ({ page }) => {
  await ensureDatedTrades(page);
  await page.goto("/trades?add=manual&symbol=INFY");

  await expect(page.getByRole("dialog").filter({ hasText: /^Add trade/ }).first()).toBeVisible();
  await expect.poll(() => page.url()).not.toContain("add=");
  expect(page.url()).toContain("symbol=INFY");
  await expect(searchBox(page)).toHaveValue("INFY");
});

test("Back from a dashboard drill-down lands on the dashboard, not the page before it", async ({ page }) => {
  await ensureDatedTrades(page);
  await gotoHydrated(page, "/");

  await page.locator('[role="button"]', { hasText: "Net P&L" }).first().click();
  const dialog = page.getByRole("dialog").filter({ hasText: /where it came from/i });
  await expect(dialog).toBeVisible();
  const link = dialog.locator('a[href*="/trades?from="]').last();
  await expect(link).toBeVisible();
  await link.click();

  // Canonical serializer output, and it is still there once the filters land.
  await expect(page).toHaveURL(/\/trades\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}&realised=1$/);
  await expect(page.getByRole("button", { name: /Realised only/ })).toBeVisible();
  await expect.poll(() => page.url()).toMatch(/realised=1/);

  await page.goBack();
  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/$/);
});

test("/trades?basis=unknown shows exactly the sales the acquisition panel lists", async ({ page }) => {
  await ensureDatedTrades(page);
  await page.goto("/trades?basis=unknown");

  await expect(page.getByRole("button", { name: /Unknown basis only/ })).toBeVisible();
  await expect.poll(() => page.url()).toContain("basis=unknown");

  // The AcquisitionPanel renders one form per unpriced sale (and nothing at
  // all when there are none). The table under the same filter must show that
  // many rows — the two surfaces share one `hasKnownBasis` verdict. When the
  // seeded book has none, the honest outcome is an EMPTY table, asserted as
  // such rather than skipped.
  const pending = await page.locator('form:has(input[name="acquisitionPrice"])').count();
  await expect.poll(() => shownCount(page), { timeout: 15_000 }).toBe(pending);
  if (pending === 0) {
    await expect(page.getByText(/No trades yet/i)).toBeVisible();
  }
});
