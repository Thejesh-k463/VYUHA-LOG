import { test, expect } from "@playwright/test";
import { ensureTrades } from "./helpers";

/**
 * The staged-position flow end to end: enable, add a tranche, book a partial
 * exit.
 *
 * Unit tests cover the ladder maths exhaustively. What they cannot cover is
 * that the server action, the repricing rebuild and the panel all agree — which
 * is exactly where a 100x paise-conversion bug lived during development, and it
 * passed typecheck, lint and 551 unit tests while doing so.
 */
test("staged position: enable → add tranche → partial exit", async ({ page }) => {
  await ensureTrades(page);

  await page.goto("/trades");
  await expect(page.locator("tbody tr").first()).toBeVisible();

  // Pick an OPEN position. "Add entry" is deliberately disabled once a trade is
  // fully closed — you cannot add to something that no longer exists — so a
  // closed row would fail on a correct product behaviour.
  const openRow = page.locator("tbody tr").filter({ has: page.locator('button[title="Close position"]') }).first();
  await expect(openRow, "fixture has no open trade to stage").toBeVisible();
  await openRow.locator('button[title*="tranches"], button[title*="Staged position"]').click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Staged position" });
  await expect(dialog).toBeVisible();

  // Enable staged mode — the existing quantity becomes the first entry. This is
  // lossless by design, so nothing about the trade's money should change.
  const enable = dialog.getByRole("button", { name: /Enable staged mode/i });
  if (await enable.count()) {
    await enable.click();
  }
  await expect(dialog.getByText(/Open qty/i)).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByText(/single entry/i)).toBeVisible();

  // Add a second entry with its own stop.
  await dialog.getByRole("button", { name: /Add entry/i }).click();
  await page.locator("#se-qty").fill("10");
  await page.locator("#se-price").fill("100");
  await page.locator("#se-sl").fill("95");
  await page.getByRole("button", { name: /^Add entry$/ }).last().click();

  // The average is now explicitly blended across two entries.
  await expect(dialog.getByText(/blended over 2 entries/i)).toBeVisible({ timeout: 20_000 });

  // Book a partial exit using the 50% shortcut.
  await dialog.getByRole("button", { name: /Book exit/i }).click();
  await page.getByRole("button", { name: "50%" }).click();

  const qty = Number(await page.locator("#sx-qty").inputValue());
  // Percentage shortcuts must never produce an unfillable fractional quantity —
  // you cannot sell 762.5 shares.
  expect(Number.isInteger(qty), `50% shortcut produced ${qty}`).toBe(true);
  expect(qty).toBeGreaterThan(0);

  await page.locator("#sx-price").fill("120");
  await page.getByRole("button", { name: /^Book exit$/ }).last().click();

  // A realised exit leg now exists.
  await expect(dialog.getByText(/1 exit/i)).toBeVisible({ timeout: 20_000 });
});
