import { test, expect } from "@playwright/test";
import { ensureTrades } from "./helpers";

/**
 * Compiler-sensitive surface protocol.
 *
 * Written for the 2026-08-11 React Compiler attempt (rolled back the same
 * day for an upstream JSX-whitespace hydration bug — see next.config.ts and
 * DECISIONS.md). The spec STAYS: these three surfaces are exactly where any
 * future compiler retry — or any memoization refactor — fails silently, and
 * nothing else in the suite touches them:
 *
 *  1. TABLE SORTING — the "use no memo" proof. DataTable opts out of the
 *     compiler because TanStack's table instance mutates without identity
 *     change; if that directive is ever lost, sorting is exactly what dies.
 *     Proven on the TRADES table (guaranteed rows; same component the
 *     trackers share, now also under virtualization).
 *  2. SIDEBAR ORDER RESTORE — the deferred mount-restore idiom
 *     (Promise.resolve().then(setState)) applying persisted state after
 *     hydration, under compiled components. Seeded via localStorage rather
 *     than drag: the pointer mechanics have their own spec; the compiler
 *     risk is the RESTORE.
 *  3. LIVE CHARGE PREVIEW — a debounced fetch-effect chain writing state
 *     while the user types.
 *
 * `z-` prefixed: seeds via ensureTrades.
 */

test("trades table still sorts under the compiler", async ({ page }) => {
  await ensureTrades(page);
  await page.goto("/trades");
  await page.waitForLoadState("networkidle");
  const table = page.locator("table").first();
  await expect(table.locator("tbody tr").nth(2)).toBeVisible({ timeout: 20_000 });

  const netValues = async () => {
    const heads = await table.locator("thead th").allInnerTexts();
    const idx = heads.findIndex((h) => /^net/i.test(h.trim()));
    expect(idx, "Net column").toBeGreaterThan(-1);
    const rows = await table.locator("tbody tr:not([aria-hidden])").all();
    const out: number[] = [];
    for (const r of rows.slice(0, 8)) {
      const t = (await r.locator("td").nth(idx).innerText()).replace(/[^\d.-]/g, "");
      if (t !== "" && t !== "-") out.push(Number(t));
    }
    return out;
  };

  // If compiler memoization froze the row JSX against the mutable table
  // instance, the numbers will NOT move — the silent failure this spec
  // exists to catch. Direction is TanStack's choice (numeric columns sort
  // descending-first), so assert a fully-sorted window either way, then the
  // REVERSE on the second click — reversal is the unfakeable part.
  const sortedState = async () => {
    const v = await netValues();
    if (v.length <= 2) return "few";
    const asc = JSON.stringify(v) === JSON.stringify([...v].sort((a, b) => a - b));
    const desc = JSON.stringify(v) === JSON.stringify([...v].sort((a, b) => b - a));
    return asc ? "asc" : desc ? "desc" : "unsorted";
  };
  await table.getByRole("columnheader", { name: /^Net$/i }).click();
  await expect
    .poll(sortedState, { timeout: 15_000 })
    .toMatch(/asc|desc/);
  const firstDir = await sortedState();

  await table.getByRole("columnheader", { name: /^Net$/i }).click();
  await expect
    .poll(sortedState, { timeout: 15_000 })
    .toBe(firstDir === "asc" ? "desc" : "asc");
});

test("a persisted sidebar order is RESTORED after reload under the compiler", async ({ page }) => {
  await ensureTrades(page);
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  // Default order first. The swap lives inside "Positions" — a group with
  // FOUR items (Overview holds only Dashboard, where a swap is a no-op).
  await page.evaluate(() => localStorage.removeItem("vyuha-nav-order"));
  await page.reload();
  await page.waitForLoadState("networkidle");

  const riskPos = () => page.locator('aside nav a[href="/risk"]').boundingBox().then((b) => b!.y);
  const equityPos = () => page.locator('aside nav a[href="/equity"]').boundingBox().then((b) => b!.y);
  expect(await riskPos()).toBeLessThan(await equityPos()); // default: Risk above Equity

  // Persist an order that puts /equity FIRST in Positions, then reload. The
  // compiler-sensitive path is the deferred mount restore that applies it
  // (Promise.resolve().then(setState) — the sidebar's documented idiom).
  await page.evaluate(() => {
    localStorage.setItem(
      "vyuha-nav-order",
      JSON.stringify({ groups: [], items: { Positions: ["/equity", "/risk"] } }),
    );
  });
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect
    .poll(async () => (await equityPos()) < (await riskPos()), { timeout: 20_000 })
    .toBe(true);

  await page.evaluate(() => localStorage.removeItem("vyuha-nav-order"));
});

test("the live charge preview re-prices as the entry price changes", async ({ page }) => {
  await ensureTrades(page);
  await page.goto("/trades?add=manual");
  const dialog = page.getByRole("dialog").filter({ hasText: /Add trade/ });
  await expect(dialog).toBeVisible({ timeout: 20_000 });

  await dialog.getByPlaceholder(/RELIANCE or OPT/).fill("RELIANCE");
  await dialog.locator('input[name="buyQty"]:not([type="hidden"])').fill("10");
  await dialog.locator('input[name="avgBuyPrice"]:not([type="hidden"])').fill("500");

  // The label span's text never changes; the VALUE is its sibling inside the
  // Cell's flex row. Anchor on the label, step up to the row — its
  // textContent carries the figure. (.last() of a hasText match would find
  // the innermost node, i.e. the label itself — the exact trap this replaces.)
  const totalRow = dialog
    .locator("span", { hasText: /^Total charges$/ })
    .locator("xpath=..");
  await expect(totalRow).toBeVisible({ timeout: 15_000 });
  const firstTotal = await totalRow.textContent();

  // Double the price: the debounced effect chain must re-price. A compiler
  // regression here looks like a preview frozen at the first figure.
  await dialog.locator('input[name="avgBuyPrice"]:not([type="hidden"])').fill("5000");
  await expect
    .poll(async () => (await totalRow.textContent()) !== firstTotal, { timeout: 15_000 })
    .toBe(true);
});
