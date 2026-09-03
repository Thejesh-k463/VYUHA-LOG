import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { gotoImportReady } from "./helpers";

/**
 * v3.8 W3 — remove one broker's rows, then re-import the same file clean.
 *
 * `z-` prefix: this spec imports, and must sort after import-dashboard.spec.ts
 * (AGENTS.md). It also cannot assume the Dhan fixture is NOT already in the
 * shared database, so the first import tolerates "0 new trades".
 */

const DHAN = path.join(process.cwd(), "tests", "fixtures", "dhan-pnl.csv");

/** Drop the fixture; commit when there is anything new to commit. */
async function importDhan(page: Page): Promise<void> {
  await gotoImportReady(page);
  await page.locator('input[type="file"]').setInputFiles(DHAN);
  await expect(page.getByText(/Detected:\s*Dhan/i)).toBeVisible({ timeout: 25_000 });
  const commit = page.getByRole("button", { name: /Commit\s+\d+\s+new trade/i });
  await expect(commit).toBeVisible();
  if (await commit.isEnabled()) {
    await commit.click();
    await expect(page.getByText(/Imported\s+\d+\s+trade/i)).toBeVisible({ timeout: 25_000 });
  }
}

async function openPanel(page: Page) {
  await gotoImportReady(page);
  await page.getByTestId("remove-broker-toggle").click();
  await expect(page.getByTestId("remove-broker-panel")).toContainText(/Counting…|trade|nothing to remove/i);
}

test("remove Dhan's rows, see them gone from /trades, re-import them", async ({ page }) => {
  await importDhan(page);

  // The panel lists Dhan with its count. Wait for the panel's OWN fetch —
  // it mounts counting (AGENTS.md).
  await openPanel(page);
  const row = page.getByTestId("remove-broker-row-dhan");
  await expect(row).toBeVisible({ timeout: 20_000 });
  const before = Number((await row.innerText()).match(/(\d[\d,]*)\s+trades?/)![1].replace(/,/g, ""));
  expect(before).toBeGreaterThan(0);
  // The Dhan P&L carries no dates: the span reads "—", never an invented date.
  await expect(row).toContainText("—");

  // Confirm dialog carries the owner's sentence, naming count and account.
  await row.getByRole("button", { name: "Remove and re-import" }).click();
  const copy = page.getByTestId("remove-broker-confirm-copy");
  await expect(copy).toContainText(`Remove all ${before.toLocaleString("en-IN")} Dhan trades from “Primary”?`);
  await expect(copy).toContainText("restore from Backup & Restore → Deleted items");
  await page.getByTestId("remove-broker-confirm").click();

  // Success line is the server's message; the row is gone from the list.
  await expect(page.getByTestId("remove-broker-done")).toContainText(/Removed\s+\d+\s+dhan\s+trades?/, { timeout: 25_000 });
  await expect(row).toHaveCount(0);

  // "Now re-import the file" brings the dropzone into focus.
  await page.getByRole("button", { name: /Now re-import the file/ }).click();
  await expect(page.getByTestId("import-dropzone")).toBeFocused();

  // /trades filtered to Dhan shows zero rows. Polled: the filter is client
  // state applied after hydration (AGENTS.md).
  await page.goto("/trades");
  await page.waitForLoadState("networkidle");
  await page.locator("select").filter({ hasText: "All brokers" }).selectOption("dhan");
  await expect
    .poll(async () => (await page.getByText(/^\d+ of \d+$/).first().textContent()) ?? "", { timeout: 20_000 })
    .toMatch(/^0 of /);

  // Re-import: every row is new again, and the panel counts them back.
  await gotoImportReady(page);
  await page.locator('input[type="file"]').setInputFiles(DHAN);
  const commit = page.getByRole("button", { name: /Commit\s+\d+\s+new trade/i });
  await expect(commit).toBeEnabled({ timeout: 25_000 });
  await commit.click();
  await expect(page.getByText(/Imported\s+\d+\s+trade/i)).toBeVisible({ timeout: 25_000 });

  await openPanel(page);
  const again = page.getByTestId("remove-broker-row-dhan");
  await expect(again).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => Number((await again.innerText()).match(/(\d[\d,]*)\s+trades?/)?.[1].replace(/,/g, "") ?? 0))
    .toBe(before);
});
