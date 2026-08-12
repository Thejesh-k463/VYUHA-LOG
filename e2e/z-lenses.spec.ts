import { test, expect } from "@playwright/test";
import { ensureTrades } from "./helpers";

/**
 * The Lenses screen: six cuts of the same book, and the drill-down.
 *
 * `z-` PREFIXED because it seeds via `ensureTrades`. Specs run alphabetically
 * and whichever seeds first is the one that gets to see "Imported 122 trades";
 * an unprefixed name here would steal that moment from
 * `import-dashboard.spec.ts` and fail it on a side effect (AGENTS.md).
 *
 * Deliberately READ-ONLY otherwise. Every group on this page carries a delete,
 * and exercising one would remove trades from the shared e2e database that
 * other specs count on. The delete path is covered where it can be covered
 * honestly — `tests/trash-roundtrip.test.ts` deletes AND restores against a
 * throwaway database of its own.
 */

const TABS = ["Month", "Broker", "Trade type", "Import file", "Setup", "Outcome"];

test.beforeEach(async ({ page }) => {
  await ensureTrades(page);
});

test("the tab strip offers every lens and switches without leaving the page", async ({ page }) => {
  await page.goto("/lenses");

  await expect(page.getByRole("tab")).toHaveCount(TABS.length);
  for (const label of TABS) {
    await expect(page.getByRole("tab", { name: label })).toBeVisible();
  }

  await page.getByRole("tab", { name: "Import file" }).click();
  await expect(page.getByRole("tab", { name: "Import file", selected: true })).toBeVisible();
  // Still the same URL — the strip is not navigation.
  expect(new URL(page.url()).pathname).toBe("/lenses");
});

test("the active tab survives a reload", async ({ page }) => {
  await page.goto("/lenses");
  await page.getByRole("tab", { name: "Broker" }).click();
  await expect(page.getByRole("tab", { name: "Broker", selected: true })).toBeVisible();

  await page.reload();
  // Restored by client code AFTER hydration — polled, never asserted once,
  // because a single check reads the default and looks exactly like broken
  // persistence (AGENTS.md).
  await expect
    .poll(async () => page.getByRole("tab", { name: "Broker" }).getAttribute("aria-selected"), { timeout: 15_000 })
    .toBe("true");
});

test("every lens is a partition — each one covers the same book exactly once", async ({ page }) => {
  await page.goto("/lenses");

  const countsPerTab: number[] = [];
  for (const label of TABS) {
    await page.getByRole("tab", { name: label }).click();
    await expect(page.getByRole("tab", { name: label, selected: true })).toBeVisible();

    const rows = page.locator("tbody tr");
    await expect(rows.first()).toBeVisible();

    // Column 2 is Trades. Every lens groups the whole book, so each tab's
    // group counts must sum to the same number.
    const cells = await rows.locator("td:nth-child(2)").allInnerTexts();
    countsPerTab.push(cells.reduce((s, c) => s + Number(c.trim().replace(/,/g, "")), 0));
  }

  expect(countsPerTab.every((n) => n > 0)).toBe(true);
  expect(new Set(countsPerTab).size, `each lens should cover the same book: ${countsPerTab.join(", ")}`).toBe(1);
});

test("a group drills down to its own trades and back again", async ({ page }) => {
  await page.goto("/lenses");
  await page.getByRole("tab", { name: "Import file" }).click();

  const firstGroup = page.locator("tbody tr").first();
  await expect(firstGroup).toBeVisible();
  const declared = Number((await firstGroup.locator("td:nth-child(2)").innerText()).trim().replace(/,/g, ""));
  expect(declared).toBeGreaterThan(0);

  await firstGroup.locator("td:first-child button").click();

  // The drill-down: an in-page back control, and a delete sized to exactly
  // what the group row declared.
  const back = page.getByRole("button", { name: "All groups" });
  await expect(back).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(`Delete these ${declared} trades?`) })).toBeVisible();

  await back.click();
  // Back on the group list — the header row is the tell.
  await expect(page.getByRole("columnheader", { name: "Profit factor" })).toBeVisible();
});

test("an app-level back control appears only once there is somewhere to go", async ({ page }) => {
  await page.goto("/lenses");
  // A full load starts a fresh in-app history, so nothing is offered yet.
  await expect(page.locator('[aria-label^="Back to"]')).toHaveCount(0);

  await page.getByRole("link", { name: "Trades", exact: true }).click();
  await expect(page).toHaveURL(/\/trades$/);

  const back = page.locator('[aria-label="Back to Lenses"]');
  await expect(back).toBeVisible();

  await back.click();
  await expect(page).toHaveURL(/\/lenses$/);
  // Stack popped rather than grown — there is nothing behind Lenses again.
  await expect(page.locator('[aria-label^="Back to"]')).toHaveCount(0);
});

test("Delete by… resolves a scope and refuses to arm until the count is typed", async ({ page }) => {
  await page.goto("/trades");
  await page.getByRole("button", { name: /Delete by/ }).click();

  const chooser = page.getByRole("dialog");
  await expect(chooser).toBeVisible();

  // "Everything this view is showing" resolves the visible rows — no dates to
  // type, so this works against either fixture.
  await chooser.getByLabel("Scope").selectOption("filter");
  const review = chooser.getByRole("button", { name: /^Review \d+ trade/ });
  await expect(review).toBeEnabled();
  const wanted = Number((await review.innerText()).match(/\d+/)?.[0] ?? 0);
  expect(wanted).toBeGreaterThan(0);

  await review.click();

  // The confirmation carries the SAME count, and stays disarmed: past ten
  // trades the count must be typed.
  const confirm = page.getByRole("dialog");
  await expect(confirm.getByRole("button", { name: `Delete ${wanted} trades` })).toBeDisabled();
  await expect(confirm.getByText(/snapshot is saved first/i)).toBeVisible();

  // Leave without deleting — the shared database must survive this spec.
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(new RegExp(`${wanted}\\s+of\\s+${wanted}`))).toBeVisible();
});
