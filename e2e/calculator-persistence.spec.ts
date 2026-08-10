import { test, expect, type Page } from "@playwright/test";

/**
 * Per-mode calculator persistence (lib/domain/calc-snapshot.ts).
 *
 * Not `z-` prefixed: this spec seeds nothing — it never calls `ensureTrades`,
 * so it cannot steal the import specs' first slot.
 *
 * Every post-reload assertion POLLS: the snapshot is applied by client code
 * after hydration, and `networkidle` says nothing about that (see
 * docs/DECISIONS.md 2026-08-10 — asserting once reads the default and looks
 * exactly like broken persistence).
 */

const KEY = "vyuha-calc";

async function freshCalculator(page: Page): Promise<void> {
  await page.goto("/calculator");
  await page.waitForLoadState("networkidle");
  await page.evaluate((k) => localStorage.removeItem(k), KEY);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("calc-entry")).toBeVisible();
}

test("equity and F&O each remember their own inputs across toggles and reloads", async ({ page }) => {
  await freshCalculator(page);

  // Equity mode (the default): distinctive values.
  await page.getByTestId("calc-entry").fill("2450");
  await page.getByTestId("calc-ticker").fill("TCS");

  // First-ever visit to F&O inherits the shared fields (there is nothing
  // stored to restore yet) — then gets its own values, including BSE.
  await page.getByTestId("calc-mode-fno").click();
  await expect(page.getByTestId("calc-lots")).toBeVisible();
  await page.getByTestId("calc-entry").fill("110");
  await page.getByTestId("calc-lots").fill("3");
  await page.getByTestId("calc-exchange").selectOption("BSE");
  await page.getByTestId("calc-ticker").fill("SENSEX");

  // Back to Equity: ₹2,450 must NOT have become a "premium" of 110.
  await page.getByTestId("calc-mode-equity").click();
  await expect(page.getByTestId("calc-entry")).toHaveValue("2450");
  await expect(page.getByTestId("calc-ticker")).toHaveValue("TCS");
  await expect(page.getByTestId("calc-exchange")).toHaveValue("NSE");
  await expect(page.getByTestId("calc-shares")).toBeVisible();

  // And F&O kept its own book — including the BSE exchange, which the old
  // toggle used to force-reset to NSE.
  await page.getByTestId("calc-mode-fno").click();
  await expect(page.getByTestId("calc-entry")).toHaveValue("110");
  await expect(page.getByTestId("calc-lots")).toHaveValue("3");
  await expect(page.getByTestId("calc-exchange")).toHaveValue("BSE");
  await expect(page.getByTestId("calc-ticker")).toHaveValue("SENSEX");

  // Reload restores the last-active mode (F&O) and its branch.
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect.poll(() => page.getByTestId("calc-entry").inputValue(), { timeout: 15_000 }).toBe("110");
  await expect(page.getByTestId("calc-exchange")).toHaveValue("BSE");
  await expect(page.getByTestId("calc-lots")).toHaveValue("3");

  // The other branch survived the reload too.
  await page.getByTestId("calc-mode-equity").click();
  await expect(page.getByTestId("calc-entry")).toHaveValue("2450");
  await expect(page.getByTestId("calc-ticker")).toHaveValue("TCS");
});

test("typing alone persists — no toggle required before a reload", async ({ page }) => {
  await freshCalculator(page);

  await page.getByTestId("calc-entry").fill("777");
  // The background write is debounced ~400 ms; wait for the stored envelope
  // itself rather than a blind timeout.
  await expect
    .poll(async () => {
      const raw = await page.evaluate((k) => localStorage.getItem(k), KEY);
      return raw ? (JSON.parse(raw) as { equity?: { entry?: string } }).equity?.entry : null;
    }, { timeout: 5_000 })
    .toBe("777");

  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect.poll(() => page.getByTestId("calc-entry").inputValue(), { timeout: 15_000 }).toBe("777");
});

test("index picker: Sensex fills its lot, routes to BSE, and the page answers honestly", async ({ page }) => {
  await freshCalculator(page);

  await page.getByTestId("calc-mode-fno").click();
  await expect(page.getByTestId("calc-underlying")).toBeVisible();

  await page.getByTestId("calc-underlying").selectOption("SENSEX");
  await expect(page.getByTestId("calc-ticker")).toHaveValue("SENSEX");
  await expect(page.getByTestId("calc-lot-size")).toHaveValue("20");
  await expect(page.getByTestId("calc-exchange")).toHaveValue("BSE");
  // The lot names its source — a bare number with no provenance is a trap.
  await expect(page.getByTestId("calc-lot-source")).toContainText(/lots upload|bundled/);

  // Whatever the charge config holds, the page must answer: either a computed
  // result renders or the existing "no rate card" line names the BSE gap.
  // Silence would mean the BSE routing broke the results pane.
  const charges = page.getByText(/ROUND-TRIP CHARGES/i);
  const noCard = page.getByText(/No .*rate|rate card/i).first();
  await expect
    .poll(async () => (await charges.count()) > 0 || (await noCard.count()) > 0)
    .toBe(true);

  // Nifty 50 routes back to NSE with the January-2026 lot.
  await page.getByTestId("calc-underlying").selectOption("NIFTY");
  await expect(page.getByTestId("calc-lot-size")).toHaveValue("65");
  await expect(page.getByTestId("calc-exchange")).toHaveValue("NSE");

  // A manual lot edit is respected and LABELLED, never silently corrected.
  await page.getByTestId("calc-lot-size").fill("75");
  await expect(page.getByTestId("calc-lot-source")).toContainText(/manual override/);
  await expect(page.getByTestId("calc-lot-source")).toContainText("65");
});
