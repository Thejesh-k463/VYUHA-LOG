import { test, expect, type Page } from "@playwright/test";
import { gotoHydrated } from "./helpers";

/**
 * Expected-capital goals (v3.6): the Settings editor lifecycle — empty state,
 * create an absolute ₹ goal, see it on /reports/performance, edit it, delete
 * it — plus the % kind gate.
 *
 * Account scoping: the seed creates ONE account (lib/db/seed-core.ts,
 * "Primary"), so getSelectedAccountId resolves to it and the card is
 * EDITABLE. v297-surfaces may add a second account earlier in the run, but it
 * explicitly switches the selection back — the guard assertion below turns
 * any drift into a clear failure instead of a mysterious read-only card.
 *
 * Capital gate: Playwright's webServer runs prepare-db.ts WITHOUT
 * VYUHA_SEED_CLEAN, so the DEFAULT seed profile applies — equity capital
 * ₹13,00,000 and active ₹4,00,000 (lib/db/seed-core.ts). Every bucket's
 * capital is therefore KNOWN, so this spec asserts the ENABLED branch of the
 * "% profit" kind toggle (and the absence of its capital warning). If the e2e
 * seed ever moves to the clean profile, flip these assertions to the
 * disabled-with-explanation branch.
 *
 * Selector strategy: the goal card exposes per-bucket aria-labels
 * ("Equity ₹ target", "Equity goal kind", "Remove the Equity goal"), so
 * everything anchors on those; the ambiguous buttons ("Set goal", "Save",
 * "Edit") are scoped to the Equity tile via the nearest bordered ancestor of
 * a labelled element — never by grid position.
 *
 * z- prefixed for ordering safety (seeds no trades; costs nothing). Tests run
 * in file order (workers=1); each later test recreates what it needs, and the
 * cleanup helper makes a retried test immune to a half-finished predecessor.
 */

/** ₹20,00,000 / ₹25,00,000 as the card displays them (lib/format inrCompact). */
const CREATE_AMOUNT = "2000000";
const CREATE_SHOWN = "₹20.00L";
const EDIT_AMOUNT = "2500000";
const EDIT_SHOWN = "₹25.00L";

/** The Equity tile in its EDITOR/EMPTY state (the kind toggle only renders then). */
function editorTile(page: Page) {
  return page
    .getByRole("group", { name: "Equity goal kind" })
    .locator("xpath=ancestor::div[contains(@class,'border')][1]");
}

/** The Equity tile in its DISPLAY state (the remove button only renders then). */
function displayTile(page: Page) {
  return page
    .getByRole("button", { name: "Remove the Equity goal" })
    .locator("xpath=ancestor::div[contains(@class,'border')][1]");
}

/**
 * Land on Settings with the goals card rendered and NO equity goal — makes a
 * retried test independent of what a half-finished earlier run left behind.
 * The card is server-rendered (force-dynamic page), so a count() taken after
 * the title is visible is safe — no StagedPanel-style loading race.
 */
/**
 * Specs share one DB and must not assume the ambient account selection (an
 * earlier spec legitimately leaves the All-accounts view selected — asserting
 * it away failed 4/4 on the first full run). Select the editable
 * single-account view ourselves, the v297-surfaces way.
 */
async function ensureSingleAccountView(page: Page): Promise<void> {
  const switcher = page.getByLabel("Portfolio account");
  if ((await switcher.inputValue()) === "0") {
    await switcher.selectOption({ label: "Primary" });
    // Switching is a POST + refresh — poll the aggregate banner away, never
    // assert once after networkidle (repo e2e rule).
    await expect(page.getByText(/All-accounts view/)).toHaveCount(0, { timeout: 15_000 });
  }
}

async function gotoSettingsWithoutEquityGoal(page: Page): Promise<void> {
  await gotoHydrated(page, "/settings");
  await expect(page.getByText("Expected capital goals")).toBeVisible();
  await ensureSingleAccountView(page);
  const remove = page.getByRole("button", { name: "Remove the Equity goal" });
  if (await remove.count()) {
    await remove.click();
    await expect(remove).toHaveCount(0, { timeout: 15_000 });
  }
}

test("with no goal, the equity bucket offers the editor and the % kind is enabled", async ({ page }) => {
  await gotoSettingsWithoutEquityGoal(page);

  const tile = editorTile(page);
  await expect(tile.getByRole("button", { name: "₹ target" })).toBeVisible();
  await expect(page.getByLabel("Equity ₹ target")).toBeVisible();
  await expect(tile.getByRole("button", { name: "Set goal" })).toBeVisible();

  // Capital is configured in the e2e seed (see header), so the % kind must be
  // ENABLED — for every bucket — and the capital warning must not render.
  const pctButtons = page.getByRole("button", { name: "% profit" });
  await expect(pctButtons).toHaveCount(3);
  for (const b of await pctButtons.all()) await expect(b).toBeEnabled();
  await expect(page.getByText(/goals need this bucket/)).toHaveCount(0);
});

test("creating an absolute ₹ goal shows it on Settings AND on the Performance report", async ({ page }) => {
  await gotoSettingsWithoutEquityGoal(page);

  await page.getByLabel("Equity ₹ target").fill(CREATE_AMOUNT);
  await editorTile(page).getByRole("button", { name: "Set goal" }).click();

  // The save is fetch + router.refresh() (recorded convention), so the
  // display state lands asynchronously — web-first assertions poll for it.
  // Scoped to the goal tile: the target also renders on the capital chart's
  // reference line and the goal strip, so a page-wide getByText is ambiguous
  // (strict-mode violation seen live on the first run — 3 matches).
  await expect(displayTile(page).getByText(CREATE_SHOWN).first()).toBeVisible({ timeout: 15_000 });
  await expect(displayTile(page).getByRole("button", { name: "Edit", exact: true })).toBeVisible();

  // The performance report renders a goal card only when a goal exists; with
  // capital known the baseline froze at creation, so the goal is measurable
  // and the progress/gap tiles render (app/reports/performance/page.tsx).
  await gotoHydrated(page, "/reports/performance");
  await expect(page.getByText("Expected capital — Equity")).toBeVisible();
  await expect(page.getByText("Goal progress").first()).toBeVisible();
  await expect(page.getByText("Goal gap").first()).toBeVisible();
});

test("editing the target updates the displayed value", async ({ page }) => {
  // Depends on the goal created above; recreate it if a retry lost it.
  await gotoHydrated(page, "/settings");
  await expect(page.getByText("Expected capital goals")).toBeVisible();
  await ensureSingleAccountView(page);
  if ((await page.getByRole("button", { name: "Remove the Equity goal" }).count()) === 0) {
    await page.getByLabel("Equity ₹ target").fill(CREATE_AMOUNT);
    await editorTile(page).getByRole("button", { name: "Set goal" }).click();
    await expect(displayTile(page).getByText(CREATE_SHOWN).first()).toBeVisible({ timeout: 15_000 });
  }

  await displayTile(page).getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Equity ₹ target").fill(EDIT_AMOUNT);
  await editorTile(page).getByRole("button", { name: "Save", exact: true }).click();
  // Tile-scoped for the same strict-mode reason as the create test.
  await expect(displayTile(page).getByText(EDIT_SHOWN).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(CREATE_SHOWN)).toHaveCount(0);
});

test("deleting the goal restores the empty state and clears the Performance card", async ({ page }) => {
  // Ensure a goal exists to delete (retry safety), then delete it.
  await gotoHydrated(page, "/settings");
  await expect(page.getByText("Expected capital goals")).toBeVisible();
  await ensureSingleAccountView(page);
  const remove = page.getByRole("button", { name: "Remove the Equity goal" });
  if ((await remove.count()) === 0) {
    await page.getByLabel("Equity ₹ target").fill(EDIT_AMOUNT);
    await editorTile(page).getByRole("button", { name: "Set goal" }).click();
    await expect(remove).toBeVisible({ timeout: 15_000 });
  }
  await remove.click();

  // Empty state returns: the editor form with its kind toggle and Set goal.
  await expect(remove).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole("group", { name: "Equity goal kind" })).toBeVisible();
  await expect(editorTile(page).getByRole("button", { name: "Set goal" })).toBeVisible();

  // No goal -> the performance report renders no goal card at all (the
  // empty-state rule). Assert the page itself rendered before asserting the
  // absence, so a blank page cannot fake a pass.
  await gotoHydrated(page, "/reports/performance");
  await expect(page.getByRole("heading", { level: 1, name: "Performance" })).toBeVisible();
  await expect(page.getByText("Expected capital — Equity")).toHaveCount(0);
});
