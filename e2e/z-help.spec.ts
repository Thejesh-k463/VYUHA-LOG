import { test, expect } from "@playwright/test";
import { ensureTrades, gotoHydrated } from "./helpers";

/**
 * The task-first Help Desk and the getting-started strip (v4.6.0 W4).
 *
 * Hero search, the category accordion, the topic dialog (open by click, by
 * `#topic-…` deep link, closed by Esc — which clears the fragment), the "?" in
 * a page header, the "?" shortcuts sheet, and the dashboard strip's Dismiss
 * surviving a reload. Client-restored state is asserted with `expect.poll`
 * (AGENTS: never once after networkidle). `z-` prefix: it seeds through
 * `ensureTrades`, so it must sort after import-dashboard.
 */

test.describe("Help Desk (W4)", () => {
  test("the hero search filters to a typed topic and a row opens its dialog", async ({ page }) => {
    await gotoHydrated(page, "/help");
    const search = page.getByRole("textbox", { name: "Search help" });
    await expect(search).toBeFocused();
    await search.fill("grandfathering");
    const row = page.locator("main").getByRole("button", { name: /^Tax Summary/ });
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByRole("dialog", { name: "Tax Summary" })).toBeVisible();
    await expect(page).toHaveURL(/#topic-reports-tax$/);
  });

  test("a group expands and a card opens the dialog; Esc closes it and clears the hash", async ({ page }) => {
    await gotoHydrated(page, "/help");
    const main = page.locator("main");
    await main.getByRole("button", { name: /^Journal/ }).click();
    await main.getByRole("button", { name: /^Trades\b/ }).click();
    const dialog = page.getByRole("dialog", { name: "Trades" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Steps")).toBeVisible();
    await expect(dialog.getByText("Watch out")).toBeVisible();
    await expect(page).toHaveURL(/#topic-trades$/);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");
  });

  // v4.6.0 audit UI-2 + UI-3: a topic WITH a glossary term (Tax Summary's steps
  // link "FMV"). Radix's default autofocus landed on that term's <button>, its
  // tooltip opened over the dialog and the first Esc only closed the tooltip;
  // and with no Trigger, focus fell to <body> on close.
  test("a topic with a glossary term opens with focus on its title, one Esc closes it, focus returns to the card", async ({ page }) => {
    await gotoHydrated(page, "/help");
    const main = page.locator("main");
    await main.getByRole("button", { name: /^Tax\s*\d+ topics?$/ }).click();
    const card = page.locator("#topic-reports-tax");
    // By keyboard, with the pointer parked in a corner, so nothing hovers a term open.
    await page.mouse.move(0, 0);
    await card.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Tax Summary" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("button.cursor-help").first()).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Tax Summary" })).toBeFocused();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? "")).toBe("topic-reports-tax");
  });

  test("#topic-dashboard deep link opens the dialog on load", async ({ page }) => {
    await gotoHydrated(page, "/help#topic-dashboard");
    await expect(page.getByRole("dialog", { name: "Dashboard" })).toBeVisible();
  });

  test("the '?' in the /trades header links to /help#topic-trades", async ({ page }) => {
    await gotoHydrated(page, "/trades");
    const link = page.getByRole("link", { name: "Help for this screen" });
    await expect(link).toHaveAttribute("href", "/help#topic-trades");
    await link.click();
    await expect(page.getByRole("dialog", { name: "Trades" })).toBeVisible();
  });

  test("a hub tab's '?' finds the tab's own topic", async ({ page }) => {
    await gotoHydrated(page, "/reports/capital?tab=expiry");
    await expect(page.getByRole("link", { name: "Help for this screen" })).toHaveAttribute(
      "href",
      "/help#topic-reports-capital-expiry",
    );
  });

  test("the shortcuts sheet opens on '?' and closes on Esc", async ({ page }) => {
    await gotoHydrated(page, "/trades");
    await page.locator("main").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("?");
    const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("Open or close the command palette")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });
});

test.describe("getting-started strip (W4, row 9.5)", () => {
  test("shows 'of 5'; Dismiss hides it and the dismissal survives a reload", async ({ page }) => {
    await ensureTrades(page);
    await gotoHydrated(page, "/");
    const strip = page.getByTestId("getting-started-strip");
    await expect(strip).toContainText("of 5");
    await strip.getByRole("button", { name: "Dismiss" }).click();
    await expect(strip).toBeHidden();
    await page.reload();
    await gotoHydrated(page, "/");
    await expect.poll(() => page.getByTestId("getting-started-strip").count()).toBe(0);
  });
});
