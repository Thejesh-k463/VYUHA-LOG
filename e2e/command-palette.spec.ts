import { test, expect } from "@playwright/test";

/**
 * Command palette on Radix Dialog (v2.99.70). The palette used to be a bare
 * fixed div with ARIA attributes; the rebuild must keep the keyboard contract
 * (Ctrl+K toggle, arrows, Enter) while gaining what Radix supplies: focus
 * trapped in the dialog, Escape closing only the palette, outside click
 * dismissing. No seeding — safe at any position in the run.
 */

test.describe("command palette", () => {
  test("Ctrl+K opens, Enter navigates, palette closes", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Control+k");

    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible();

    // Focus lands in the search input (Radix onOpenAutoFocus + autoFocus).
    const input = dialog.getByPlaceholder(/Jump to a screen/);
    await expect(input).toBeFocused();

    await input.fill("settings");
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await page.waitForURL(/\/settings/);
  });

  test("Escape closes without navigating; Ctrl+K toggles", async ({ page }) => {
    await page.goto("/trades");
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(new URL(page.url()).pathname).toBe("/trades");

    // Toggle: open then close with the same chord.
    await page.keyboard.press("Control+k");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Control+k");
    await expect(dialog).toBeHidden();
  });

  test("focus stays trapped inside the palette", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible();

    // Tab a handful of times — focus must remain inside the dialog (the old
    // div implementation let Tab walk into the page behind).
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]');
        return !!d && d.contains(document.activeElement);
      });
      expect(inside).toBe(true);
    }
  });
});
