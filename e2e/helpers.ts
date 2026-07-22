import { expect, type Page } from "@playwright/test";
import path from "node:path";

const DHAN = path.join(process.cwd(), "tests", "fixtures", "dhan-pnl.csv");
const ZERODHA = path.join(process.cwd(), "tests", "fixtures", "zerodha-tradebook.csv");

/**
 * Wait for the import page to be INTERACTIVE before handing it a file.
 *
 * `setInputFiles` on a not-yet-hydrated page silently does nothing: the file
 * lands on the input, React's change handler is not attached yet, and no
 * preview ever renders. The failure then looks like "broker not detected",
 * which sends you hunting in the parser instead of the test.
 */
export async function gotoImportReady(page: Page): Promise<void> {
  await page.goto("/import");
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(/Drop a broker file/i)).toBeVisible();
  await expect(page.locator('input[type="file"]')).toBeAttached();
}


/**
 * Make sure the e2e database has trades, without assuming which spec ran first.
 *
 * The suite shares one database across the whole run, and imports are
 * de-duplicated — so blindly re-importing the fixture leaves the Commit button
 * DISABLED ("0 new trades") and any test that waits for it hangs. Checking
 * first makes each spec independent of file ordering.
 */
export async function ensureTrades(page: Page): Promise<void> {
  await page.goto("/trades");
  await page.waitForLoadState("networkidle");

  // Read the "N of M" counter rather than counting <tr>. An EMPTY table still
  // renders a placeholder row, so a naive row count reports "already seeded",
  // silently skips the import, and every downstream assertion then runs against
  // an empty database — which looks like a product bug rather than a test bug.
  const counter = await page.getByText(/\d+\s+of\s+\d+/).first().textContent().catch(() => null);
  const total = Number(counter?.match(/of\s+(\d+)/)?.[1] ?? 0);
  if (total > 0) return;

  await gotoImportReady(page);
  await page.locator('input[type="file"]').setInputFiles(DHAN);
  const commit = page.getByRole("button", { name: /Commit\s+\d+\s+new trade/i });
  await expect(commit).toBeEnabled({ timeout: 20_000 });
  await commit.click();
  await expect(page.getByText(/Imported\s+\d+\s+trade/i)).toBeVisible();
}

/**
 * Import the dated Zerodha tradebook fixture.
 *
 * The Dhan fixture is an aggregated P&L report with NO per-trade dates, so it
 * produces no daily P&L at all — nothing for a "worst day" drill-down to point
 * at. Anything that needs a dated book uses this instead, which also puts a
 * second importer under end-to-end coverage.
 *
 * Idempotent: imports are de-duplicated, so a second call finds nothing new and
 * the Commit button stays disabled.
 */
export async function ensureDatedTrades(page: Page): Promise<void> {
  await page.goto("/trades");
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder(/Search symbol/i).fill("E2E");
  await page.waitForTimeout(300);
  const counter = await page.getByText(/\d+\s+of\s+\d+/).first().textContent().catch(() => null);
  if (Number(counter?.match(/^(\d+)/)?.[1] ?? 0) > 0) return;

  await gotoImportReady(page);
  await page.locator('input[type="file"]').setInputFiles(ZERODHA);
  const commit = page.getByRole("button", { name: /Commit\s+\d+\s+new trade/i });
  await expect(commit).toBeEnabled({ timeout: 20_000 });
  await commit.click();
  await expect(page.getByText(/Imported\s+\d+\s+trade/i)).toBeVisible();
}
