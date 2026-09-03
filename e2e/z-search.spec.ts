import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import Database from "better-sqlite3";
import { ensureTrades, gotoHydrated } from "./helpers";

/**
 * Search v1 in the command palette (v3.8 Wave 3).
 *
 * Ctrl+K parity with command-palette.spec.ts, then the search itself: a
 * trigram of "breakout" in a seeded trade's note finds that trade; chips
 * narrow the fetch; a Pro-gated screen is shown LOCKED under the free tier
 * (never hidden); opening a result then reopening the palette offers
 * "← previous search", which restores the query and results WITHOUT a
 * refetch; "Back to <screen>" returns to the prior page by push, not
 * history. Finally a rapid open/type/close loop — small enough for CI — must
 * leave no console error and a palette that still opens.
 *
 * Seeding reuses `ensureTrades` (the shared Dhan fixture) and sets ONE
 * trade's note through the journal route, the app's own write path, so the
 * FTS triggers index it exactly as a user's edit would be indexed.
 *
 * Free tier: the e2e database is on its lazily-stamped trial (Pro), so the
 * lock test lapses the trial directly in the SQLite file Playwright owns and
 * `afterAll` nulls it again — the next entitlement read restamps a fresh
 * trial, so specs sorting after this one see exactly what they saw before.
 * `z-` prefix: seeds, so it must sort after import-dashboard (AGENTS.md).
 */

const E2E_DB = process.env.VYUHA_DB_PATH ?? path.join(process.cwd(), "data", "e2e.sqlite");

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(E2E_DB);
  db.pragma("busy_timeout = 10000");
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const NOTE = "breakout retest (e2e search seed)";

async function seedNotedTrade(page: Page): Promise<void> {
  await ensureTrades(page);
  const row = withDb((db) => db.prepare("SELECT id FROM trades ORDER BY id LIMIT 1").get() as { id: number } | undefined);
  expect(row?.id, "ensureTrades left no trade to annotate").toBeTruthy();
  const res = await page.request.post("/api/trades/journal", { data: { id: row!.id, notes: NOTE } });
  expect(res.ok()).toBeTruthy();
}

function setTrial(startedAt: string | null): void {
  withDb((db) => db.prepare("UPDATE settings SET trial_started_at = ?").run(startedAt));
}

const dialogOf = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const inputOf = (page: Page) => dialogOf(page).getByPlaceholder(/Jump to a screen/);
const tradesGroup = (page: Page) => dialogOf(page).locator('[data-search-group="trades"]');

test.describe.configure({ mode: "serial" });

test.describe("palette search", () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: "http://localhost:3100" });
    const page = await ctx.newPage();
    await seedNotedTrade(page);
    await ctx.close();
    // Free tier for the whole file — nothing here needs Pro.
    setTrial("2020-01-01T00:00:00.000Z");
  });

  test.afterAll(() => {
    setTrial(null);
  });

  test("Ctrl+K parity; a trigram of a note finds the trade; chips narrow the fetch", async ({ page }) => {
    await gotoHydrated(page, "/");
    await page.keyboard.press("Control+k");
    const dialog = dialogOf(page);
    await expect(dialog).toBeVisible();
    const input = inputOf(page);
    await expect(input).toBeFocused();

    // Nothing is fetched before the user types (perf contract).
    let searches = 0;
    page.on("request", (r) => {
      if (r.url().includes("/api/search")) searches++;
    });
    await page.waitForTimeout(400);
    expect(searches).toBe(0);

    await input.fill("kou");
    await expect.poll(() => tradesGroup(page).count(), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect(tradesGroup(page).locator("[data-search-result]").first()).toBeVisible();

    // Chips: "Screens" alone → `cat=screens` on the wire and the trades group gone.
    const screensChip = dialog.getByRole("button", { name: "Screens", exact: true });
    await expect(screensChip).toHaveAttribute("aria-pressed", "false");
    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes("/api/search") && r.url().includes("cat=screens")),
      screensChip.click(),
    ]);
    expect(new URL(req.url()).searchParams.get("cat")).toBe("screens");
    await expect(screensChip).toHaveAttribute("aria-pressed", "true");
    await expect(tradesGroup(page)).toHaveCount(0);

    // Toggling it off widens the search again.
    await screensChip.click();
    await expect.poll(() => tradesGroup(page).count(), { timeout: 20_000 }).toBeGreaterThan(0);
  });

  test("a Pro-gated screen is shown locked with what unlocks it, under the free tier", async ({ page }) => {
    await gotoHydrated(page, "/");
    await page.keyboard.press("Control+k");
    await inputOf(page).fill("risk");
    const lockLine = dialogOf(page).getByText(/Unlocks with Pro — Portfolio Risk cockpit/).first();
    await expect(lockLine).toBeVisible({ timeout: 20_000 });
    // Still navigable — the result is a button, not a disabled row.
    const row = dialogOf(page).locator('[data-search-result="screens"]').filter({ hasText: "Portfolio Risk" }).first();
    await expect(row).toBeEnabled();
  });

  test("← previous search restores query and results without a refetch; Back to <screen> pushes", async ({ page }) => {
    await gotoHydrated(page, "/playbooks");
    await page.keyboard.press("Control+k");
    const dialog = dialogOf(page);
    await expect(dialog).toBeVisible();

    // Neither back control shows before it can act.
    await expect(dialog.getByRole("button", { name: /previous search/ })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: /^Back to / })).toHaveCount(0);

    await inputOf(page).fill("kou");
    await expect.poll(() => tradesGroup(page).count(), { timeout: 20_000 }).toBeGreaterThan(0);
    await tradesGroup(page).locator("[data-search-result]").first().click();
    await expect(dialog).toBeHidden();
    await page.waitForURL(/\/trades\?symbol=/);

    let searches = 0;
    page.on("request", (r) => {
      if (r.url().includes("/api/search")) searches++;
    });

    await page.keyboard.press("Control+k");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /previous search/ }).click();
    await expect(inputOf(page)).toHaveValue("kou");
    await expect.poll(() => tradesGroup(page).count(), { timeout: 20_000 }).toBeGreaterThan(0);
    // Once popped, the stack is empty and the control is gone.
    await expect(dialog.getByRole("button", { name: /previous search/ })).toHaveCount(0);
    await page.waitForTimeout(400); // longer than the 150 ms debounce
    expect(searches, "restoring a previous search must not refetch").toBe(0);

    // The route beneath this one is /playbooks: the label names it, push lands there.
    await dialog.getByRole("button", { name: "Back to Playbooks" }).click();
    await expect(dialog).toBeHidden();
    await page.waitForURL(/\/playbooks$/);
  });

  test("a rapid open / type / close loop leaves no console error and a palette that still opens", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    await gotoHydrated(page, "/");
    const dialog = dialogOf(page);
    const CYCLES = 100;
    for (let i = 0; i < CYCLES; i++) {
      await page.keyboard.press("Control+k");
      await expect(dialog).toBeVisible();
      await page.keyboard.type(i % 2 ? "ri" : "kou");
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }

    await page.keyboard.press("Control+k");
    await expect(dialog).toBeVisible();
    await expect(inputOf(page)).toBeFocused();
    await expect(inputOf(page)).toHaveValue("");
    expect(errors).toEqual([]);
  });
});
