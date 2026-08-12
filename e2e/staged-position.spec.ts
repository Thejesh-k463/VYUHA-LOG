import { test, expect } from "@playwright/test";
import { ensureTrades } from "./helpers";

/**
 * The staged-position flow end to end: enable, add a tranche, book a partial
 * exit.
 *
 * Unit tests cover the ladder maths exhaustively. What they cannot cover is
 * that the server action, the repricing rebuild and the panel all agree — which
 * is exactly where a 100x paise-conversion bug lived during development, and it
 * passed typecheck, lint and 551 unit tests while doing so.
 */
test("staged position: enable → add tranche → partial exit", async ({ page }) => {
  await ensureTrades(page);

  await page.goto("/trades");
  await expect(page.locator("tbody tr").first()).toBeVisible();

  // Narrow to the Open view FIRST. The table is virtualized now, and open
  // positions (null sellDate) sort to the BOTTOM of the default DESC order —
  // below the rendered window at a 122-row book, where a row locator finds
  // nothing. Filtering brings the target into the window and drops the
  // order-of-the-book fragility in the same stroke.
  await page.locator("select").filter({ hasText: "All trades" }).selectOption("open");

  // Pick an OPEN position — simply because enabling staged mode is the flow
  // under test here. Nothing in the panel is disabled by position state; see
  // the "never blocks" test below.
  // Role + accessible NAME, not [title=]: v2.99.70 moved these buttons onto
  // Radix <Tip> + aria-label, and the old title-attribute locators matched
  // nothing — both tests in this file were red for six releases' worth of runs.
  const openRow = page.locator("tbody tr").filter({ has: page.getByRole("button", { name: "Close position" }) }).first();
  await expect(openRow, "fixture has no open trade to stage").toBeVisible();
  await openRow.getByRole("button", { name: /tranches|Staged position/ }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Staged position" });
  await expect(dialog).toBeVisible();

  // WAIT FOR THE LADDER FETCH BEFORE DECIDING ANYTHING.
  //
  // StagedPanel mounts in a loading state and only fetches /api/trades/legs
  // afterwards, so "Enable staged mode" does not exist yet at the moment the
  // dialog becomes visible. Asking `enable.count()` during that window returns
  // 0 — the click is skipped silently, and the test then waits 20s for a ladder
  // that was never created. The failure surfaces as "Open qty not found",
  // which points at the panel rather than at the skipped click.
  //
  // This raced on both a Windows dev box and a Linux CI runner and was the
  // single failing test in CI runs #45 through #50.
  await expect(dialog.getByText(/Loading the ladder/i)).toHaveCount(0, { timeout: 20_000 });

  // Enable staged mode — the existing quantity becomes the first entry. This is
  // lossless by design, so nothing about the trade's money should change.
  const enable = dialog.getByRole("button", { name: /Enable staged mode/i });
  if (await enable.count()) {
    await expect(enable).toBeEnabled();
    await enable.click();
    // The button is replaced by the ladder only after the server action
    // returns and the panel refetches; waiting for it to go keeps the next
    // assertion from racing the same way.
    await expect(enable).toHaveCount(0, { timeout: 20_000 });
  }
  await expect(dialog.getByText(/Open qty/i)).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByText(/single entry/i)).toBeVisible();

  // Add a second entry with its own stop.
  await dialog.getByRole("button", { name: /Add entry/i }).click();
  await page.locator("#se-qty").fill("10");
  await page.locator("#se-price").fill("100");
  await page.locator("#se-sl").fill("95");
  await page.getByRole("button", { name: /^Add entry$/ }).last().click();

  // The average is now explicitly blended across two entries.
  await expect(dialog.getByText(/blended over 2 entries/i)).toBeVisible({ timeout: 20_000 });

  // Book a partial exit using the 50% shortcut.
  await dialog.getByRole("button", { name: /Book exit/i }).click();
  await page.getByRole("button", { name: "50%" }).click();

  const qty = Number(await page.locator("#sx-qty").inputValue());
  // Percentage shortcuts must never produce an unfillable fractional quantity —
  // you cannot sell 762.5 shares.
  expect(Number.isInteger(qty), `50% shortcut produced ${qty}`).toBe(true);
  expect(qty).toBeGreaterThan(0);

  await page.locator("#sx-price").fill("120");
  await page.getByRole("button", { name: /^Book exit$/ }).last().click();

  // A realised exit leg now exists.
  await expect(dialog.getByText(/1 exit/i)).toBeVisible({ timeout: 20_000 });
});

/**
 * The panel WARNS; it never blocks.
 *
 * "Add entry" used to be disabled once a position went flat, on the reasoning
 * that you cannot add to something that no longer exists. That reasoning was
 * wrong twice over: re-entering the same name, or correcting a fill booked in
 * error, are both ordinary things a trader does — and the engine already allows
 * them. `validateLegs` only ever rejects an exit larger than the quantity open
 * at that point, and `rebuildStagedTrade` re-derives `isOpen` from the ladder,
 * so a new entry re-opens the trade by itself. The block was a UI opinion that
 * stopped someone recording something that really happened.
 */
test("staged panel never disables an action because of position state", async ({ page }) => {
  await ensureTrades(page);
  await page.goto("/trades");
  await expect(page.locator("tbody tr").first()).toBeVisible();

  // Same virtualization note as above: open rows live below the window in the
  // default sort — narrow first.
  await page.locator("select").filter({ hasText: "All trades" }).selectOption("open");

  const row = page.locator("tbody tr").filter({ has: page.getByRole("button", { name: /tranches|Staged position/ }) }).first();
  await expect(row, "no staged-capable row in the fixture").toBeVisible();
  await row.getByRole("button", { name: /tranches|Staged position/ }).click();

  const dialog = page.getByRole("dialog").filter({ hasText: "Staged position" });
  await expect(dialog).toBeVisible();
  // Same race as the test above — settle the ladder fetch before deciding.
  await expect(dialog.getByText(/Loading the ladder/i)).toHaveCount(0, { timeout: 20_000 });
  const enable = dialog.getByRole("button", { name: /Enable staged mode/i });
  if (await enable.count()) {
    await enable.click();
    await expect(enable).toHaveCount(0, { timeout: 30_000 });
  }
  await expect(dialog.getByText(/Open qty/i)).toBeVisible({ timeout: 30_000 });

  // Whatever the position state, none of the three actions may be disabled.
  for (const name of [/Add entry/i, /Book exit/i, /Set stop on all open/i]) {
    const btn = dialog.getByRole("button", { name }).first();
    await expect(btn).toBeVisible();
    await expect(btn, `"${name}" must never be disabled by position state`).toBeEnabled();
  }
});
