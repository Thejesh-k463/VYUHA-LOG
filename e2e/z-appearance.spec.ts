import { test, expect, type Page } from "@playwright/test";
import { gotoHydrated } from "./helpers";

/**
 * Appearance settings: skin + tint intensity, panel style, custom theme.
 *
 * What is under test is the ROUND TRIP: the form previews on <html> at once,
 * "Save settings" persists through /api/settings, and a fresh server render
 * (app/layout.tsx → appearanceVars / appearanceClasses) puts the same thing
 * back on <html> as an inline style and classes. Live-preview correctness on
 * its own is a client concern the unit tests cover (lib/domain/appearance.ts);
 * what only a browser can prove is that the persisted row re-renders.
 *
 * `z-` prefixed and serial: it MUTATES the shared settings row, and it restores
 * Luxe / Balanced / luxe panels at the end so later specs see the default look.
 * Every assertion about restored state uses expect.poll — the layout's <html>
 * attributes are server-rendered, but the pill state and any toast are client
 * work after hydration (AGENTS.md).
 */
test.describe.configure({ mode: "serial" });

const html = (page: Page) => page.locator("html");
const htmlStyle = async (page: Page) => (await html(page).getAttribute("style")) ?? "";
const htmlClass = async (page: Page) => (await html(page).getAttribute("class")) ?? "";

async function save(page: Page) {
  const btn = page.getByRole("button", { name: /^Save settings$/ });
  await btn.click();
  // The button flips to "Saving…" and back; the toast is transient. Waiting on
  // the button label being back is the deterministic signal that the POST
  // resolved (either way), and the reload below reads server truth.
  await expect(btn).toHaveText(/^Save settings$/, { timeout: 15_000 });
}

async function pickSkin(page: Page, label: string) {
  const pill = page.getByRole("button", { name: label, exact: true });
  await pill.click();
  await expect(pill).toHaveAttribute("aria-pressed", "true");
}

test("rose + vivid persists as an inline tint on <html>", async ({ page }) => {
  await gotoHydrated(page, "/settings");
  await pickSkin(page, "Rose");
  // Preview lands before save: the pill click applies chrome at the current
  // intensity, so the tint var is inline immediately.
  await expect.poll(() => htmlStyle(page)).toContain("--color-border");
  await expect.poll(() => htmlClass(page)).toContain("skin-rose");

  await page.getByRole("button", { name: "Vivid", exact: true }).click();
  await expect(page.getByRole("button", { name: "Vivid", exact: true })).toHaveAttribute("aria-pressed", "true");
  await save(page);

  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect.poll(() => htmlStyle(page)).toContain("--color-border");
  const cls = await htmlClass(page);
  expect(cls).toContain("skin-rose");
  // A tint is a STYLE, never a class: the class list carries only the skin.
  expect(cls).not.toMatch(/tint-|intensity/);
  await expect
    .poll(async () => page.getByRole("button", { name: "Vivid", exact: true }).getAttribute("aria-pressed"), {
      timeout: 15_000,
    })
    .toBe("true");
});

test("panel style flat persists as html.panel-flat", async ({ page }) => {
  await gotoHydrated(page, "/settings");
  await page.getByRole("radio", { name: "Flat", exact: true }).click();
  // Live preview toggles the class before save.
  await expect.poll(() => htmlClass(page)).toContain("panel-flat");
  await save(page);

  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect.poll(() => htmlClass(page)).toContain("panel-flat");
});

test("custom skin persists with the user's own --color-primary inline", async ({ page }) => {
  await gotoHydrated(page, "/settings");
  await pickSkin(page, "Custom");
  await expect(page.getByTestId("custom-theme-builder")).toBeVisible();

  // Change the dark accent so the stored theme is provably the user's, not
  // DEFAULT_CUSTOM_THEME. The hex box commits on a full #rrggbb.
  const accent = page.getByLabel("Accent hex (dark)");
  await accent.fill("#ff8800");
  await expect.poll(() => htmlStyle(page)).toMatch(/--color-primary:\s*#ff8800/);
  await save(page);

  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect.poll(() => htmlClass(page)).toContain("skin-custom");
  await expect.poll(() => htmlStyle(page)).toMatch(/--color-primary:\s*#ff8800/);
});

test("restore the defaults so later specs see the stock look", async ({ page }) => {
  await gotoHydrated(page, "/settings");
  await pickSkin(page, "Luxe");
  await page.getByRole("button", { name: "Balanced", exact: true }).click();
  await page.getByRole("radio", { name: "Luxe", exact: true }).click();
  await save(page);

  await page.reload();
  await page.waitForLoadState("networkidle");
  const cls = await htmlClass(page);
  expect(cls).not.toMatch(/skin-|panel-/);
});
