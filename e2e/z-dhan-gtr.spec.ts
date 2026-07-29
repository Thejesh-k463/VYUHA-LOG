import { test, expect } from "@playwright/test";
import path from "node:path";
import { gotoImportReady } from "./helpers";

/**
 * Named `z-` deliberately.
 *
 * The suite runs single-worker against ONE shared database (see
 * playwright.config.ts), and this spec commits 79 real trades. Running before
 * the others would enlarge the book every later assertion is written against —
 * which is exactly how it first broke the drill-down reconciliation. Sorting
 * last keeps this end-to-end proof without making it everyone else's problem.
 */

const GTR = path.join(process.cwd(), "tests", "fixtures", "dhan-gtr.csv");

/**
 * The Global Transaction Report is the file that finally answers the three
 * questions an aggregated P&L cannot: when, what product, and what it really
 * cost. This walks the whole path — detect, segregate, commit — against the
 * real 92-row report.
 */
test("Dhan transaction report: detected, product-segregated, committed with real dates", async ({ page }) => {
  await gotoImportReady(page);
  await page.locator('input[type="file"]').setInputFiles(GTR);

  // Detected as its own format, not as the ordinary Dhan P&L export.
  await expect(page.getByText(/Global Transaction Report/i).first()).toBeVisible({ timeout: 30_000 });

  // The whole point: delivery and intraday are told apart, from the charge
  // signature alone, in a file with no product column.
  const table = page.locator("table").filter({ hasText: "Segment" });
  await expect(table.getByText("Equity Intraday").first()).toBeVisible();
  await expect(table.getByText("Equity Delivery").first()).toBeVisible();

  // MTF is never claimed — it cannot be known from this file.
  await expect(page.getByText(/MTF cannot be identified from this file/i)).toBeVisible();

  // And the unmatched holding is flagged rather than scored as a free win.
  await expect(page.getByText(/without a matching purchase/i)).toBeVisible();

  await page.getByRole("button", { name: /^(Commit|Import)/i }).first().click();
  await expect(page.getByText(/added/i).first()).toBeVisible({ timeout: 60_000 });
});

/**
 * A sale with no purchase has buyValue 0, which reads as a 100% winner. The
 * journal must refuse to score it until a cost is supplied — and must say so.
 */
test("unpriced sales are quarantined from the edge statistics", async ({ page }) => {
  await page.goto("/trades");
  await expect(page.getByRole("heading", { name: "Trades" })).toBeVisible({ timeout: 25_000 });

  const body = await page.locator("main").innerText();
  // Either this book has an unpriced sale and it is disclosed, or it has none.
  if (/no purchase on record/i.test(body)) {
    await expect(page.getByText(/out of win rate, expectancy/i)).toBeVisible();
    // A recovered basis must be offered as a suggestion, never applied silently.
    await expect(page.getByText(/IPO allotment/i).first()).toBeVisible();
  }
  expect(body).not.toMatch(/NaN|Infinity/);
});

/**
 * An IPO allotment arrives as an open holding with NEITHER a cost basis nor a
 * mark price — credited on allotment, never bought. It can be neither valued
 * nor scored, so Vyuha must offer a way out rather than leaving it stranded.
 */
test("unmarked open holdings are surfaced with a route into the IPO section", async ({ page }) => {
  await page.goto("/trades");
  await expect(page.getByRole("heading", { name: "Trades" })).toBeVisible({ timeout: 30_000 });

  const body = await page.locator("main").innerText();
  if (/with no mark price/i.test(body)) {
    // The consequence must be stated, not just the fact.
    await expect(page.getByText(/no unrealised result/i).first()).toBeVisible();
    // And there must be an actual way to resolve it.
    await expect(page.getByRole("button", { name: /came from an IPO/i }).first()).toBeVisible();
  }
  expect(body).not.toMatch(/NaN|Infinity/);
});
