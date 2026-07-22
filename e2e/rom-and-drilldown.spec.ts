import { test, expect } from "@playwright/test";
import { ensureTrades, ensureDatedTrades } from "./helpers";

/**
 * The Return-on-Margin report renders and its numbers hold together.
 */
test("ROM report: renders, groups by segment, never prints an impossible annualised figure", async ({ page }) => {
  await ensureTrades(page);
  await page.goto("/reports/rom");

  await expect(page.getByRole("heading", { name: /Return on Margin/i })).toBeVisible();
  await expect(page.getByText(/Capital deployed/i).first()).toBeVisible();
  await expect(page.getByText(/where capital works hardest/i)).toBeVisible();

  // Annualising is a linear extrapolation, clamped to [-100, +1000]. Scan the
  // TABLE CELLS only — the explanatory prose deliberately quotes an uncapped
  // figure ("extrapolates to -3,887%") to explain why the clamp exists, and
  // scanning the whole page would flag that as a regression.
  const cells = await page.$$eval("table td", (tds) => tds.map((t) => t.textContent?.trim() ?? ""));
  let checked = 0;
  for (const c of cells) {
    const m = c.match(/^([-+]?\d[\d,]*\.?\d*)%\s*\*?$/);
    if (!m) continue;
    const v = Number(m[1].replace(/,/g, ""));
    expect(v, `annualised/ROM cell out of clamp: ${c}`).toBeGreaterThanOrEqual(-101);
    expect(v, `annualised/ROM cell out of clamp: ${c}`).toBeLessThanOrEqual(1001);
    checked++;
  }
  // Guard the guard: if the selector stops matching, this test must fail loudly
  // rather than silently pass by checking nothing.
  expect(checked).toBeGreaterThan(0);
});

/**
 * The KPI drill-down deep link must land on a filtered table whose rows ADD UP
 * to the figure that was clicked. That reconciliation is the whole point — a
 * link showing roughly-related trades is worse than no link, and an earlier
 * version of this filter was off because it matched either leg of the trade
 * while the dashboard buckets realised P&L on the exit date.
 */
test("KPI drill-down: worst-day link filters trades that sum to the headline", async ({ page }) => {
  // Needs a book WITH dates — see ensureDatedTrades.
  await ensureDatedTrades(page);
  await page.goto("/");

  await page.locator('[role="button"]', { hasText: "Net P&L" }).first().click();
  const dialog = page.getByRole("dialog").filter({ hasText: /where it came from/i });
  await expect(dialog).toBeVisible();

  const worstText = (await dialog.innerText()).match(/Worst day[\s\S]*?(-?₹[\d,]+)/)?.[1];
  expect(worstText, "worst-day figure not found in the drill-down").toBeTruthy();
  const worst = Number(worstText!.replace(/[^\d.-]/g, ""));

  const link = dialog.locator('a[href*="/trades?from="]').last();
  await expect(link).toBeVisible();
  await link.click();

  await expect(page).toHaveURL(/\/trades/);
  await expect(page.locator("tbody tr").first()).toBeVisible();

  const headers = await page.$$eval("thead th", (ths) => ths.map((t) => t.textContent?.trim() ?? ""));
  const netIdx = headers.findIndex((h) => /^Net/i.test(h));
  expect(netIdx, "Net column not found").toBeGreaterThan(-1);

  const nets = await page.$$eval(
    "tbody tr",
    (rows, i) => rows.map((r) => r.querySelectorAll("td")[i]?.textContent?.trim() ?? ""),
    netIdx,
  );
  expect(nets.length).toBeGreaterThan(0);
  const sum = nets.map((n) => Number(n.replace(/[^\d.-]/g, ""))).reduce((a, b) => a + b, 0);

  expect(Math.round(sum), "filtered trades must reconcile with the clicked figure").toBe(Math.round(worst));
});
