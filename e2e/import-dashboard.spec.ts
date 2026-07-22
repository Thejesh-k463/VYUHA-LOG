import { test, expect } from "@playwright/test";
import path from "node:path";
import { gotoImportReady } from "./helpers";

const DHAN = path.join(process.cwd(), "tests", "fixtures", "dhan-pnl.csv");

test("import Dhan CSV → dashboard reflects the imported P&L", async ({ page }) => {
  // Import. gotoImportReady waits for hydration — handing a file to a
  // not-yet-interactive page silently drops it and looks like a parser bug.
  await gotoImportReady(page);
  await page.locator('input[type="file"]').setInputFiles(DHAN);

  // Auto-detected preview
  await expect(page.getByText(/Detected:\s*Dhan/i)).toBeVisible();

  // Commit
  await page.getByRole("button", { name: /Commit\s+\d+\s+new trade/i }).click();
  await expect(page.getByText(/Imported\s+122\s+trade/i)).toBeVisible();

  // Dashboard reflects the import
  await page.goto("/");
  await expect(page.getByText("122 trades")).toBeVisible();
  await expect(page.getByText("Net P&L", { exact: true })).toBeVisible();
  // Dhan realised gross is deterministic (≈ −₹1.0L of closed trades), shown under the card
  await expect(page.getByText(/Gross\s*-₹1\.0\dL/)).toBeVisible();
});
