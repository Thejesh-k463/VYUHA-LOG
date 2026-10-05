import { test, expect } from "@playwright/test";
import { ensureTrades } from "./helpers";

/**
 * v4.7.0 C2 — the Edge Clinic's Clinic tab, end to end.
 *
 * The page NEVER runs the engine: on a cold cache it renders "Computing the
 * Clinic…", the client runner POSTs /api/edge-clinic/compute once and then
 * router.refresh()es, and the server re-reads a fresh cache row. So the
 * assertions POLL (AGENTS.md: client-driven state is asserted with
 * expect.poll, never once after networkidle) until the computing line is gone
 * and the whole-book cell is on screen.
 *
 * Seeds via ensureTrades, so the `z-` prefix keeps it sorting after
 * import-dashboard.spec.ts (AGENTS.md). A fresh e2e database is inside its Pro
 * trial, so the full report renders, not only the free teaser.
 */

test("the Clinic is the Edge Clinic's default tab, computes off the page, and shows the whole-book cell", async ({ page }) => {
  await ensureTrades(page);

  const res = await page.goto("/reports/edge-clinic");
  expect(res?.status(), "the hub rendered").toBeLessThan(400);
  const strip = page.getByRole("tablist");
  await expect(strip.getByRole("tab").first()).toHaveText("Clinic");
  await expect(strip.getByRole("tab", { name: "Clinic", exact: true })).toHaveAttribute("aria-selected", "true");

  // The free teaser renders for every copy.
  await expect(page.locator("[data-clinic-teaser]")).toBeVisible();

  // The runner leaves "Computing" behind once the compute route answered and
  // the refresh landed — then the book cell is in the grid.
  //
  // Measured 2026-10-03 (builder B): on a COLD dev compile cache the very first
  // POST to the compute route answered 404 once (the page then said "could not
  // read your book … Reload the page to try again"); the identical run on a warm
  // cache, and curl against a fresh server, answered 200. The runner deliberately
  // asks once and never polls, so this spec takes the user's own retry path —
  // a reload — when that line shows, rather than the product retrying in a loop.
  // Root cause not proven; a production build compiles nothing on demand.
  await expect
    .poll(
      async () => {
        if (await page.getByText("could not read your book", { exact: false }).count()) await page.reload();
        return page.locator('[data-cell-key="all|all"]').count();
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  await expect(page.getByText("Computing the Clinic", { exact: false })).toHaveCount(0);
  await expect(page.locator('[data-cell-key="all|all"]').first()).toContainText("Whole book");

  // A second visit reads the cache — fresh, so nothing computes.
  await page.reload();
  await expect(page.locator('[data-cell-key="all|all"]').first()).toBeVisible();
  await expect(page.locator('[data-clinic-status]')).toHaveCount(0);

  // v4.8.0 F1 — the decay card. The engine writes a decay copy block ("a possible drop in R
  // from trade N" / "no downward shift detected") only for a cell with at least 60 trades
  // carrying an R, and the card sits directly under that block — so an opened Detail holds
  // exactly as many cards as decay blocks, and a card shows its two figures as text. The
  // cells grid is server-rendered and nothing in a Detail fetches, so these counts are settled.
  const book = page.locator('[data-cell-key="all|all"]').first();
  await book.locator("summary").filter({ hasText: "Detail" }).click();
  const decayBlocks = await book.getByText(/a possible drop in R from trade \d+|no downward shift detected/).count();
  const decayCard = book.locator("[data-clinic-decay-card]");
  await expect(decayCard).toHaveCount(decayBlocks);
  if (decayBlocks > 0) {
    await expect(decayCard.locator('[data-decay-figure="usual"]')).toContainText(/USUAL · first \d+ trades\s*[+−]\d+\.\d\d(R| cap)/);
    await expect(decayCard.locator('[data-decay-figure="recent"]')).toContainText(/RECENT · (since trade|last) \d+( trades)?\s*[+−]\d+\.\d\d(R| cap)/);
    await expect(decayCard.locator('[data-decay-figure="recent"]')).toBeVisible();
  }
});

test("the Clinic's alias answers with a config-level 307 to its tab", async ({ page }) => {
  const wire = await page.request.get("/reports/clinic", { maxRedirects: 0 });
  expect(wire.status()).toBe(307);
  expect(wire.headers()["location"]).toMatch(/\/reports\/edge-clinic\?tab=clinic$/);
});
