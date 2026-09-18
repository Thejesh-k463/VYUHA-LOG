import { test, expect, type Page } from "@playwright/test";
import { ensureDatedTrades, ensureTrades, gotoHydrated } from "./helpers";

/**
 * User-movable page sections — the v4.4.0 pilot on /settings and the dashboard.
 *
 * NAMED `z-` DELIBERATELY: the dashboard case seeds through `ensureTrades`, and
 * a seeding spec that sorts before `import-dashboard.spec.ts` steals its
 * "Imported N trades" moment (AGENTS.md).
 *
 * The maths is exhaustively unit-tested (tests/section-order.test.ts). What
 * only a browser proves: the TRUSTED pointer sequence (a synthetic
 * PointerEvent never reaches the hook's window listeners), that a stored order
 * is applied after hydration (every restored-state assertion POLLS — a single
 * assert after `networkidle` reads the default order and looks exactly like
 * broken persistence), that focus survives a keyboard move, that a moved chart
 * is MOVED rather than remounted, and that Appearance's own save survives
 * navigation.
 */
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1400, height: 1000 } });

const SETTINGS_DEFAULT = [
  "settings-capital-golive", "settings-capital-management", "settings-capital-goals", "settings-capital-growth",
  "settings-workspace", "settings-preferences", "settings-accounts", "settings-defaults", "settings-risk-rules",
  "settings-charge-rates", "settings-telegram", "settings-live-feed", "settings-integrations", "settings-license",
  "settings-first-run", "settings-app-updates", "settings-appearance",
];
const DASH_DEFAULT = ["dash-kpis", "dash-equity-curve", "dash-daily-calendar", "dash-by-segment", "dash-streaks"];

const key = (page: "settings" | "dashboard") => `vyuha-section-order:${page}`;

/** Section ids in DOM order. */
async function order(page: Page, stack: "settings" | "dashboard"): Promise<string[]> {
  return page
    .locator(`[data-section-stack="${stack}"] > [data-section]`)
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-section") ?? ""));
}

async function stored(page: Page, stack: "settings" | "dashboard") {
  return page.evaluate((k) => localStorage.getItem(k), key(stack));
}

/** Land on `path` with no saved order — this key survives everything else the suite resets. */
async function fresh(page: Page, path: string, stack: "settings" | "dashboard") {
  await gotoHydrated(page, path);
  await page.evaluate((k) => localStorage.removeItem(k), key(stack));
  await page.reload();
  await page.waitForLoadState("networkidle");
}

const status = (page: Page) => page.getByTestId("section-order-status");

test("settings: the default order — capital first, goals under total capital, Appearance last", async ({ page }) => {
  await fresh(page, "/settings", "settings");
  await expect.poll(() => order(page, "settings"), { timeout: 20_000 }).toEqual(SETTINGS_DEFAULT);
  // Out of Rearrange mode the page carries no grips at all.
  await expect(page.getByRole("button", { name: /^Move / })).toHaveCount(0);
});

test("settings: a real pointer drag moves a card, persists across reload, and Reset restores", async ({ page }) => {
  await fresh(page, "/settings", "settings");
  await page.getByRole("button", { name: "Rearrange", exact: true }).click();

  const grip = page.getByRole("button", { name: "Move Capital management", exact: true });
  const target = page.locator('[data-section="settings-capital-golive"]');
  await target.scrollIntoViewIfNeeded();
  const g = (await grip.boundingBox())!;
  const t = (await target.boundingBox())!;
  // page.mouse works in VIEWPORT coordinates and does not scroll: fail here,
  // legibly, if either end is off-screen rather than drag nothing.
  const vp = page.viewportSize()!;
  for (const [name, b] of [["grip", g], ["target", t]] as const) {
    expect(b.y, `${name} is above the viewport`).toBeGreaterThanOrEqual(0);
    expect(b.y, `${name} is below the viewport`).toBeLessThanOrEqual(vp.height);
  }
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2, t.y + 6, { steps: 14 });
  // Read the live drag BEFORE releasing: a grab that never started and a drop
  // that computed a no-op are otherwise the same empty result.
  const mid = await page.evaluate(() => ({
    dragged: document.querySelectorAll("[data-section][data-dragging]").length,
    lines: document.querySelectorAll("[data-drop-line]").length,
  }));
  await page.mouse.up();
  expect(mid.dragged, "the grabbed section follows the pointer").toBe(1);
  expect(mid.lines, "an insertion line marks where it lands").toBe(1);

  const moved = ["settings-capital-management", "settings-capital-golive", ...SETTINGS_DEFAULT.slice(2)];
  await expect.poll(() => order(page, "settings")).toEqual(moved);
  const raw = await stored(page, "settings");
  expect(JSON.parse(raw!)).toMatchObject({ v: 1 });
  expect((JSON.parse(raw!) as { order: string[] }).order[0]).toBe("settings-capital-management");

  // Survives a reload — polled: the saved order is applied after hydration.
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect.poll(() => order(page, "settings"), { timeout: 20_000 }).toEqual(moved);

  // Reset shows only while an order is stored, and clears the key.
  await page.getByRole("button", { name: "Rearrange", exact: true }).click();
  await page.getByRole("button", { name: "Reset layout", exact: true }).click();
  await expect.poll(() => order(page, "settings")).toEqual(SETTINGS_DEFAULT);
  expect(await stored(page, "settings")).toBeNull();
  await expect(page.getByRole("button", { name: "Reset layout", exact: true })).toHaveCount(0);
});

test("settings: the keyboard path — Home/End/↓ on the grip, Alt+↓ from inside a card, position announced", async ({ page }) => {
  await fresh(page, "/settings", "settings");
  await page.getByRole("button", { name: "Rearrange", exact: true }).click();

  const grip = page.getByRole("button", { name: "Move Appearance", exact: true });
  await grip.focus();
  await page.keyboard.press("Home");
  await expect.poll(async () => (await order(page, "settings"))[0]).toBe("settings-appearance");
  await expect(status(page)).toHaveText("Appearance moved to position 1 of 17.");
  // Focus stays on the grip, so repeated presses walk the card.
  await expect(grip).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await order(page, "settings"))[1]).toBe("settings-appearance");
  await expect(status(page)).toHaveText("Appearance moved to position 2 of 17.");
  await expect(grip).toBeFocused();
  await page.keyboard.press("End");
  await expect.poll(async () => (await order(page, "settings")).at(-1)).toBe("settings-appearance");
  await expect(status(page)).toHaveText("Appearance moved to position 17 of 17.");

  // Alt+↓ from a control INSIDE a section moves that section.
  const golive = page.locator('[data-section="settings-capital-golive"]');
  await golive.getByRole("button", { name: "Save settings" }).focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect.poll(async () => (await order(page, "settings")).slice(0, 2)).toEqual([
    "settings-capital-management",
    "settings-capital-golive",
  ]);
  await expect(status(page)).toHaveText("Capital & Go-Live moved to position 2 of 17.");

  // The section names itself in the mode — the grip's label never folds into it.
  await expect(page.getByRole("group", { name: "Appearance", exact: true })).toHaveCount(1);

  await page.getByRole("button", { name: "Reset layout", exact: true }).click();
  await expect.poll(() => order(page, "settings")).toEqual(SETTINGS_DEFAULT);
});

test("settings: the Reorder list dialog — Move up / Move down, 'saved on this device', Reset", async ({ page }) => {
  await fresh(page, "/settings", "settings");
  await page.getByRole("button", { name: "Rearrange", exact: true }).click();
  await page.getByRole("button", { name: "Reorder list", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Rearrange sections" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("This arrangement is saved on this device.")).toBeVisible();
  // The first card cannot go up; the last cannot go down.
  await expect(dialog.getByRole("button", { name: "Move Capital & Go-Live up" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Move Appearance down" })).toBeDisabled();

  await dialog.getByRole("button", { name: "Move Appearance up" }).click();
  await expect.poll(async () => (await order(page, "settings")).slice(-2)).toEqual([
    "settings-appearance",
    "settings-app-updates",
  ]);
  await expect(status(page)).toHaveText("Appearance moved to position 16 of 17.");
  await expect(dialog.getByRole("button", { name: "Move Appearance up" })).toBeFocused();

  await dialog.getByRole("button", { name: "Reset layout", exact: true }).click();
  await expect.poll(() => order(page, "settings")).toEqual(SETTINGS_DEFAULT);
  expect(await stored(page, "settings")).toBeNull();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("dashboard: a moved cockpit card is MOVED, not remounted — the equity curve keeps its node", async ({ page }) => {
  // The Dhan fixture carries no dates (no curve to draw); the dated Zerodha
  // tradebook gives the equity curve something to plot.
  await ensureTrades(page);
  await ensureDatedTrades(page);
  await fresh(page, "/", "dashboard");
  await expect.poll(() => order(page, "dashboard"), { timeout: 20_000 }).toEqual(DASH_DEFAULT);
  const curve = page.locator('[data-section="dash-equity-curve"] .recharts-surface').first();
  await expect(curve).toBeVisible({ timeout: 20_000 });
  // Tag the rendered chart node. A remount (an unstable key) replaces it with
  // a fresh node that carries no tag — and replays every chart animation.
  await curve.evaluate((el) => el.setAttribute("data-probe-node", "kept"));

  await page.getByRole("button", { name: "Rearrange", exact: true }).click();
  await page.getByRole("button", { name: "Move Daily P&L calendar", exact: true }).focus();
  await page.keyboard.press("Home");
  const moved = ["dash-daily-calendar", "dash-kpis", "dash-equity-curve", "dash-by-segment", "dash-streaks"];
  await expect.poll(() => order(page, "dashboard")).toEqual(moved);
  await expect(page.locator('[data-section="dash-equity-curve"] [data-probe-node="kept"]')).toHaveCount(1);
  expect(await page.locator('[data-section="dash-equity-curve"] .recharts-surface path').count()).toBeGreaterThan(0);

  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect.poll(() => order(page, "dashboard"), { timeout: 20_000 }).toEqual(moved);
  // Settings' arrangement is a different key: the dashboard never parses it.
  expect(await stored(page, "settings")).toBeNull();

  await page.getByRole("button", { name: "Rearrange", exact: true }).click();
  await page.getByRole("button", { name: "Reset layout", exact: true }).click();
  await expect.poll(() => order(page, "dashboard")).toEqual(DASH_DEFAULT);
  expect(await stored(page, "dashboard")).toBeNull();
});

test("Appearance saves on its own, survives navigation, and a Save settings does not revert it", async ({ page }) => {
  const htmlClass = async () => (await page.locator("html").getAttribute("class")) ?? "";
  await gotoHydrated(page, "/settings");
  const appearance = page.locator('[data-section="settings-appearance"]');
  const pick = async (label: string) => {
    const pill = appearance.getByRole("button", { name: label, exact: true });
    await pill.click();
    await expect(pill).toHaveAttribute("aria-pressed", "true");
  };
  const saveLook = async () => {
    const btn = appearance.getByRole("button", { name: /^Save appearance$/ });
    await btn.click();
    await expect(btn).toHaveText(/^Save appearance$/, { timeout: 15_000 });
  };

  await pick("Rose");
  await saveLook();
  // A settings-form save from ANOTHER card must send the saved look, not an
  // older one — or it would quietly revert the skin just saved.
  const saveSettings = page.locator('[data-section="settings-preferences"]').getByRole("button", { name: /^Save settings$/ });
  await saveSettings.click();
  await expect(saveSettings).toHaveText(/^Save settings$/, { timeout: 15_000 });

  // Navigate away in-app, then from a cold load: the stored look is rendered.
  await page.locator("aside").getByRole("link", { name: "Dashboard", exact: true }).first().click();
  await page.waitForURL((u) => u.pathname === "/");
  await expect.poll(htmlClass).toContain("skin-rose");
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect.poll(htmlClass).toContain("skin-rose");

  // Restore the stock look for later specs.
  await gotoHydrated(page, "/settings");
  await pick("Luxe");
  await saveLook();
  await page.reload();
  await page.waitForLoadState("networkidle");
  expect(await htmlClass()).not.toContain("skin-rose");
});
