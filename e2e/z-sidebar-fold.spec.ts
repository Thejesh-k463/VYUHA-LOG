import { test, expect, type Page } from "@playwright/test";
import { gotoHydrated } from "./helpers";

/**
 * Sidebar fold mechanics (v3.6): the default visible-when-folded sets, the
 * "N more…" / "Show less" toggle, persistence of the expand state, the
 * current-route force-expand, and the per-group customizer dialog.
 *
 * Constants below are HARDCODED copies of the owner-approved sets in
 * components/layout/nav-config.ts (NAV_ITEMS + NAV_DEFAULT_VISIBLE) — no
 * existing spec imports app modules (only ./helpers and @playwright/test),
 * so this file follows suit rather than being the first to pull React
 * component code through Playwright's transform. If a fold expectation here
 * reddens, check nav-config.ts first: the owner may have moved the fold.
 *
 * Positions group: 4 screens, folded shows only /risk  -> "3 more…".
 * System group:    6 screens, folded shows /settings + /backup -> /audit and
 *                  /data-quality sit below the fold.
 *
 * Seeded settings leave workspace = "both" (schema default), so no screen is
 * workspace-hidden and the counts above are exact.
 *
 * z- prefixed for ordering safety (seeds nothing; costs nothing). Fold state
 * lives in localStorage (`vyuha-nav-order`, v1 envelope) and each test gets a
 * fresh browser context, so tests start from the default fold without
 * clearing anything.
 */

const EQUITY = 'aside nav a[href="/equity"]';
const RISK = 'aside nav a[href="/risk"]';

/** Post-reload hydration gate — same clock signal gotoHydrated waits on. */
async function awaitHydrated(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await expect(page.locator("aside").getByText(/\d{2}:\d{2} IST/)).toBeVisible({ timeout: 20_000 });
}

test("a folded group shows its default screens and hides the rest behind 'N more…'", async ({ page }) => {
  await gotoHydrated(page, "/");

  // Default fold: Portfolio Risk survives, the other three render NO link at
  // all — the fold removes rows, it does not just style them.
  await expect(page.locator(RISK)).toBeVisible();
  await expect(page.locator(EQUITY)).toHaveCount(0);
  await expect(page.locator('aside nav a[href="/strategies"]')).toHaveCount(0);
  await expect(page.locator('aside nav a[href="/active"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show 3 more Positions screens" })).toBeVisible();
});

test("'N more…' expands the group and 'Show less' folds it again", async ({ page }) => {
  await gotoHydrated(page, "/");

  await page.getByRole("button", { name: "Show 3 more Positions screens" }).click();
  await expect(page.locator(EQUITY)).toBeVisible();
  await expect(page.locator('aside nav a[href="/active"]')).toBeVisible();

  const showLess = page.getByRole("button", { name: "Show fewer Positions screens" });
  await expect(showLess).toBeVisible();
  await showLess.click();
  await expect(page.locator(EQUITY)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show 3 more Positions screens" })).toBeVisible();
});

test("an expanded group STAYS expanded across a reload", async ({ page }) => {
  await gotoHydrated(page, "/");
  await page.getByRole("button", { name: "Show 3 more Positions screens" }).click();
  await expect(page.locator(EQUITY)).toBeVisible();

  // The expand state is client-restored from localStorage after hydration
  // (useStoredValue), so poll — a single assert after networkidle reads the
  // default fold and looks exactly like broken persistence (AGENTS.md).
  await page.reload();
  await awaitHydrated(page);
  await expect
    .poll(() => page.locator(EQUITY).count(), { timeout: 20_000 })
    .toBe(1);
  // And it is the STORED kind of expansion, so the fold control is offered.
  await expect(page.getByRole("button", { name: "Show fewer Positions screens" })).toBeVisible();
});

test("navigating directly to a below-fold route force-expands its group", async ({ page }) => {
  // /audit sits below System's fold (defaults show /settings + /backup).
  // Never hide where the user is: the group must render expanded, with the
  // current link present — and with NEITHER fold toggle, because a group that
  // cannot fold while you are on that screen must not pretend it can.
  await gotoHydrated(page, "/audit");

  await expect(page.locator('aside nav a[href="/audit"]')).toBeVisible();
  // A sibling below-fold screen is visible too — the whole group expanded,
  // not just the current row kept.
  await expect(page.locator('aside nav a[href="/data-quality"]')).toBeVisible();
  await expect(page.getByRole("button", { name: /more System screens/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show fewer System screens" })).toHaveCount(0);
});

test("the customize dialog demotes a default-visible screen; Reset restores the defaults", async ({ page }) => {
  await gotoHydrated(page, "/");

  // The customize control reveals on group-header hover.
  await page.locator("aside").getByText("Positions", { exact: true }).hover();
  await page.getByRole("button", { name: "Customize Positions group" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // Unticking persists IMMEDIATELY (there is no save button in this dialog);
  // closing just dismisses it.
  await dialog.getByRole("checkbox", { name: "Portfolio Risk" }).setChecked(false);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Positions' fold-visible set is now EMPTY. The audit fix (groupFoldState:
  // primary === 0 with items present pins the group OPEN — a bare header over
  // zero rows helps nobody) means the group renders EXPANDED: every screen
  // visible, neither fold toggle offered.
  await expect(page.locator(RISK)).toBeVisible();
  await expect(page.locator('aside nav a[href="/equity"]')).toBeVisible();
  await expect(page.getByRole("button", { name: /more Positions screens/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show fewer Positions screens" })).toHaveCount(0);

  // Reset (footer control, shown only while an order is stored) restores the
  // owner defaults.
  await page.locator("aside").getByRole("button", { name: "Reset" }).click();
  await expect(page.locator(RISK)).toBeVisible();
  await expect(page.getByRole("button", { name: "Show 3 more Positions screens" })).toBeVisible();
});
