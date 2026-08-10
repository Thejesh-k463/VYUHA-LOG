import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { ensureTrades } from "./helpers";

/**
 * Surveillance NSE file upload (lib/import/nse-surveillance.ts + the
 * per-category replace in lib/queries/restrictions.ts).
 *
 * `z-` prefixed: seeds via `ensureTrades` (held-position matching needs a
 * book), so it must not take the import specs' first slot.
 *
 * The property under test is COEXISTENCE: a pasted GSM row must survive a
 * ban-file upload, because the ban file speaks only for the fno_ban category.
 * Whole-table replace here was the bug the feature exists to avoid.
 */

const BAN_FIXTURE = path.join(process.cwd(), "tests", "fixtures", "fo_secban.csv");
const REG_FIXTURE = path.join(process.cwd(), "tests", "fixtures", "REG_IND070826.csv");

async function clearList(page: Page): Promise<void> {
  // Reset via the API — a prior spec run (shared DB) may have left rows.
  await page.request.post("/api/restrictions", { data: { action: "clear" } });
  await page.goto("/surveillance");
  await page.waitForLoadState("networkidle");
}

test("surveillance: NSE uploads land in their own categories and coexist with pasted rows", async ({ page }) => {
  await ensureTrades(page);
  await clearList(page);

  // Paste one GSM row through the manual path first.
  await page.locator("textarea").fill("IDEA, GSM, Stage 4");
  await page.getByRole("button", { name: /Load list/ }).click();
  await expect(page.getByText(/Loaded 1 restricted securities/)).toBeVisible();

  // Upload the REAL ban fixture (3 symbols, dated 10-AUG-2026 in its header).
  await page.getByTestId("surveillance-file").setInputFiles(BAN_FIXTURE);
  const recap = page.getByText(/Imported 3 F&O ban rows/);
  await expect(recap).toBeVisible({ timeout: 15_000 });
  // The date came from the FILE's header line, not the form.
  await expect(page.getByText(/as of 2026-08-10/)).toBeVisible();

  // Coexistence: the pasted GSM row survived the ban upload. (The fixture is
  // the REAL file captured 2026-08-10; its banned symbols are BANDHANBNK,
  // KAYNES and LICI.)
  await expect(page.getByRole("cell", { name: "IDEA" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "BANDHANBNK" })).toBeVisible();

  // Now the surveillance indicator file: GSM/ASM/ESM rows replace the pasted
  // GSM row (same category — that IS the replace scope) but ban rows survive.
  await page.getByTestId("surveillance-file").setInputFiles(REG_FIXTURE);
  await expect(page.getByText(/Imported 10 GSM\/ASM\/ESM rows/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("cell", { name: "BANDHANBNK" })).toBeVisible(); // ban row still there
  await expect(page.getByRole("cell", { name: "BLUECHIP" })).toBeVisible(); // GSM from the file
  await expect(page.getByRole("cell", { name: "IDEA" })).not.toBeVisible(); // pasted GSM replaced

  // The stat tiles reflect all coexisting categories, ESM included — scoped
  // to the tile strip, since "F&O ban" also appears in table badge cells.
  const tiles = page.locator("section").first();
  await expect(tiles.getByText("F&O ban", { exact: true })).toBeVisible();
  await expect(tiles.getByText("ESM", { exact: true })).toBeVisible();

  // A file that fingerprints as neither is REFUSED with the reason.
  await page.getByTestId("surveillance-file").setInputFiles(
    path.join(process.cwd(), "tests", "fixtures", "zerodha-tradebook.csv"),
  );
  await expect(page.getByText(/Not a recognised NSE surveillance file/)).toBeVisible({ timeout: 15_000 });

  // Clear still empties everything.
  await page.getByRole("button", { name: /Clear/ }).click();
  await expect(page.getByText(/Restriction list cleared/)).toBeVisible();
});
