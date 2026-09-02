import { test, expect, type Page } from "@playwright/test";
import { ensureTrades } from "./helpers";

/**
 * The Trade Review Desk — three panels, one shared database.
 *
 * `z-` PREFIXED because it seeds via `ensureTrades`: specs run alphabetically
 * and whichever seeds first is the one that gets to see "Imported 122 trades",
 * so an unprefixed name here would steal that moment from
 * `import-dashboard.spec.ts` and fail it on a side effect (AGENTS.md).
 *
 * Every write it makes it PUTS BACK. Marking a trade reviewed and completing a
 * week both change state other specs read (the /trades reviewed marker, the
 * dashboard card), and this suite has one database for the whole run — so the
 * stamp is reopened again, and the weekly completion is written only when the
 * week is not already complete, which also makes a re-run idempotent.
 *
 * Client-restored chrome is asserted with `expect.poll`, never once after
 * navigation: the prefs land after hydration, and a single assert reads the
 * default and looks exactly like broken persistence.
 */

/** The unwindowed count of unreviewed trades, from the panel's own line. */
async function queueTotal(page: Page): Promise<number> {
  const text = await page.getByTestId("queue-window").textContent();
  return Number(text?.match(/of\s+(\d+)\s+unreviewed/)?.[1] ?? -1);
}

test.beforeEach(async ({ page }) => {
  await ensureTrades(page);
});

test("the desk renders all three panels, and the sidebar leads to it", async ({ page }) => {
  await page.goto("/review");
  await page.waitForLoadState("networkidle");

  await expect(page.getByText(/^This week — \d{4}-W\d{2}$/)).toBeVisible();
  await expect(page.getByText("Review queue", { exact: true })).toBeVisible();
  await expect(page.getByText(/^Sunday ritual — \d{4}-W\d{2}$/)).toBeVisible();

  // The nav registration — the desk is reachable without typing a URL.
  await expect(page.locator("aside").getByRole("link", { name: "Trade Review Desk" })).toBeVisible();
});

test("the Process Score shows its arithmetic, never a bare number", async ({ page }) => {
  await page.goto("/review");
  await page.waitForLoadState("networkidle");

  // All five components, each with its own numerator over denominator.
  for (const label of [
    "SL or target recorded",
    "Losses within the risk taken",
    "Days within the daily stop",
    "Playbook rules followed",
    "Trades reviewed",
  ]) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  // "n of m · pct" — the row form the panel promises.
  await expect(page.getByText(/\d+ of \d+ · /).first()).toBeVisible();
  await expect(page.getByText("How each component is counted")).toBeVisible();
});

test("the queue states what it is holding back, and reuses the journal dialog", async ({ page }) => {
  await page.goto("/review");
  await page.waitForLoadState("networkidle");

  await expect(page.getByTestId("queue-window")).toHaveText(/\d+ of \d+ unreviewed trade/);
  expect(await queueTotal(page)).toBeGreaterThan(0);

  // The SAME dialog the Trades screen opens — a fork would not carry these.
  // "Open journal", not "Journal": the sidebar has a Journal GROUP header, and
  // a first()-scoped name collision would click the nav instead of a row.
  await page.getByRole("button", { name: "Open journal" }).first().click();
  await expect(page.getByText(/^Trade journal — /)).toBeVisible();
  await expect(page.getByRole("button", { name: "Save journal" })).toBeVisible();
  await expect(page.getByText("Mistakes (tick all that apply)")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("a trade can be marked reviewed and put straight back", async ({ page }) => {
  await page.goto("/review");
  await page.waitForLoadState("networkidle");

  const before = await queueTotal(page);
  expect(before).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Mark reviewed" }).first().click();
  await expect.poll(async () => queueTotal(page), { timeout: 20_000 }).toBe(before - 1);

  // …and back again, so the shared database ends where it started.
  await page.getByRole("button", { name: "Reopen" }).first().click();
  await expect.poll(async () => queueTotal(page), { timeout: 20_000 }).toBe(before);
});

test("queue order is per-device chrome and survives a reload", async ({ page }) => {
  await page.goto("/review");
  await page.waitForLoadState("networkidle");

  const order = page.locator("#review-sort");
  await order.selectOption("oldest");
  await expect(order).toHaveValue("oldest");

  await page.reload();
  // Restored from localStorage by client code AFTER hydration — polled.
  await expect.poll(async () => order.inputValue(), { timeout: 20_000 }).toBe("oldest");

  await order.selectOption("recent");
  await expect.poll(async () => order.inputValue(), { timeout: 20_000 }).toBe("recent");
});

test("the ritual week completes once, and the history strip keeps the score it showed", async ({ page }) => {
  await page.goto("/review");
  await page.waitForLoadState("networkidle");

  const badge = page.getByTestId("ritual-completed");
  if ((await badge.count()) === 0) {
    await page.locator("#weekly-note").fill("Reviewed by the end-to-end suite.");
    await page.getByRole("button", { name: /Complete this week/ }).click();
    await expect(badge).toBeVisible({ timeout: 20_000 });
  }

  // Completed weeks are listed with BOTH scores — the one on screen at
  // completion and the one recomputed now.
  const history = page.getByTestId("ritual-history");
  await expect(history).toBeVisible();
  await expect(history.getByText(/score then/).first()).toBeVisible();
  await expect(history.getByText(/score now/).first()).toBeVisible();

  // Completion is recorded once: the button is gone, the note stays editable.
  await expect(page.getByRole("button", { name: /Complete this week/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save note" })).toBeVisible();
});

test("the exit-trigger mix states how many rows it excluded", async ({ page }) => {
  await page.goto("/review");
  await page.waitForLoadState("networkidle");

  await expect(page.getByTestId("trigger-coverage")).toHaveText(
    /\d+ of \d+ closed trades? recorded an exit reason; \d+ left it blank/,
  );
});
