import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import Database from "better-sqlite3";
import { ensureTrades, gotoHydrated } from "./helpers";

/**
 * The floating search assistant (v3.9, Search v2).
 *
 * What only a browser can prove: that the panel is really PERSISTENT. It is
 * mounted by the root layout, its position and open-ness live in a versioned
 * localStorage envelope, and neither an in-app navigation nor a full reload
 * may lose either. A unit test can prove the envelope parses; only this can
 * prove the panel comes back where the user left it, still showing results.
 *
 * Seeding is `ensureTrades` — the shared Dhan fixture, idempotent, so this
 * spec is independent of file ordering (AGENTS.md). It then reads a SYMBOL out
 * of the database it just made sure of, rather than hard-coding one: the
 * fixture's contents are not this spec's business, and a trigram search needs
 * a term that is actually in the book.
 *
 * `z-` prefix: it seeds, so it must sort after import-dashboard.spec.ts.
 *
 * Every assertion about restored client state is an `expect.poll` — the
 * envelope is applied after hydration, and `networkidle` says nothing about
 * hydration (AGENTS.md; a single assert reads the default and looks exactly
 * like broken persistence).
 */

const E2E_DB = path.join(process.cwd(), "data", "e2e.sqlite");

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(E2E_DB);
  db.pragma("busy_timeout = 10000");
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const panelOf = (page: Page) => page.locator("[data-search-panel]");
const headerOf = (page: Page) => page.locator("[data-search-panel-header]");
const launcherOf = (page: Page) => page.getByRole("button", { name: /Search assistant/i });

/** The panel's top-left in viewport pixels — what the stored envelope holds. */
async function boxOf(page: Page): Promise<{ x: number; y: number }> {
  const b = await panelOf(page).boundingBox();
  expect(b, "the panel has no box — it is not on screen").toBeTruthy();
  return { x: Math.round(b!.x), y: Math.round(b!.y) };
}

test.describe("floating search panel", () => {
  test("opens, searches, drags, and survives a reload and a navigation", async ({ page }) => {
    await ensureTrades(page);

    // A symbol the seeded book actually contains, long enough for the trigram
    // index (terms below 3 characters match nothing — the panel says so).
    const symbol = withDb(
      (db) => (db.prepare("SELECT symbol FROM trades WHERE length(symbol) >= 3 ORDER BY id LIMIT 1").get() as { symbol: string } | undefined)?.symbol,
    );
    expect(symbol, "ensureTrades left no symbol to search for").toBeTruthy();

    await gotoHydrated(page, "/trades");

    // ── Open ────────────────────────────────────────────────────────────────
    await launcherOf(page).click();
    await expect(panelOf(page)).toBeVisible();

    // ── Search — the same engine as the palette, so the same grouped rows ───
    await panelOf(page).locator("input").fill(symbol!);
    await expect(page.locator("[data-search-results]")).toBeVisible();
    await expect
      .poll(async () => page.locator('[data-search-result="trades"]').count(), { timeout: 20_000 })
      .toBeGreaterThan(0);

    // ── Drag the header 120px left and up ───────────────────────────────────
    const before = await boxOf(page);
    const grab = await headerOf(page).boundingBox();
    await page.mouse.move(grab!.x + grab!.width / 2, grab!.y + grab!.height / 2);
    await page.mouse.down();
    // Two moves: one is sometimes coalesced into the press by the browser, and
    // a drag that never reports a move commits nothing.
    await page.mouse.move(grab!.x + grab!.width / 2 - 60, grab!.y + grab!.height / 2 - 60);
    await page.mouse.move(grab!.x + grab!.width / 2 - 120, grab!.y + grab!.height / 2 - 120);
    await page.mouse.up();

    await expect.poll(async () => (await boxOf(page)).x).toBeLessThan(before.x - 100);
    const moved = await boxOf(page);
    expect(Math.abs(moved.x - (before.x - 120))).toBeLessThanOrEqual(2);
    expect(Math.abs(moved.y - (before.y - 120))).toBeLessThanOrEqual(2);

    // ── Reload: still open, still at the moved position, still searching ────
    await gotoHydrated(page, "/trades");
    await expect.poll(async () => panelOf(page).count(), { timeout: 20_000 }).toBe(1);
    await expect.poll(async () => (await boxOf(page)).x, { timeout: 20_000 }).toBeGreaterThan(moved.x - 3);
    const afterReload = await boxOf(page);
    expect(Math.abs(afterReload.x - moved.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(afterReload.y - moved.y)).toBeLessThanOrEqual(2);

    // The query itself is not persisted (a stale query would re-fetch on every
    // page load), so type it again — and the panel must answer as before.
    await panelOf(page).locator("input").fill(symbol!);
    await expect
      .poll(async () => page.locator('[data-search-result="trades"]').count(), { timeout: 20_000 })
      .toBeGreaterThan(0);

    // ── Navigate away and back: the panel never unmounts ────────────────────
    await page.getByRole("link", { name: /^Dashboard$/ }).first().click();
    await expect.poll(async () => panelOf(page).count(), { timeout: 20_000 }).toBe(1);
    // The results are still on screen — an in-app navigation is not a reset.
    await expect
      .poll(async () => page.locator('[data-search-result="trades"]').count(), { timeout: 20_000 })
      .toBeGreaterThan(0);

    await gotoHydrated(page, "/trades");
    await expect.poll(async () => panelOf(page).count(), { timeout: 20_000 }).toBe(1);
    // `count() === 1` proves the panel is MOUNTED, not that it is in position —
    // the entrance animation runs for 220ms and the box moves under it. Settle
    // it the same way the reload above does; asserting once here is the exact
    // thing AGENTS.md forbids, and it read as broken persistence on the slower
    // ubuntu runner while macOS passed (DECISIONS.md 2026-09-05).
    await expect.poll(async () => (await boxOf(page)).x, { timeout: 20_000 }).toBeGreaterThan(moved.x - 3);
    const afterNav = await boxOf(page);
    expect(Math.abs(afterNav.x - moved.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(afterNav.y - moved.y)).toBeLessThanOrEqual(2);

    // ── Leave the shared database's chrome as it was found ──────────────────
    // The envelope is per-browser-profile, and Playwright's context is thrown
    // away — but the panel is closed anyway so a spec that follows sees the
    // app it expects.
    await panelOf(page).getByRole("button", { name: /Close search assistant/i }).click();
    await expect(panelOf(page)).toHaveCount(0);
  });
});
