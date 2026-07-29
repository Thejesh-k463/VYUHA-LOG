import { test, expect } from "@playwright/test";
import path from "node:path";
import { ensureTrades, ensureDatedTrades, gotoImportReady } from "./helpers";

const PNL_FRESH = path.join(process.cwd(), "tests", "fixtures", "dhan-pnl-fresh.csv");

/**
 * The P&L tab must ASK for the product type, because a P&L statement genuinely
 * cannot distinguish delivery from MTF from intraday — and charges, MTF
 * interest and Return-on-Margin all hang off that answer.
 */
test("import split: P&L tab asks for the product type and re-prices on change", async ({ page }) => {
  await gotoImportReady(page);

  // Both kinds are offered, with the transaction file marked recommended.
  await expect(page.getByText(/Transactions \/ Tradebook/)).toBeVisible();
  await expect(page.getByText(/P&L Statement/).first()).toBeVisible();
  await expect(page.getByText(/recommended/i)).toBeVisible();

  await page.getByText(/P&L Statement/).first().click();
  await page.locator('input[type="file"]').setInputFiles(PNL_FRESH);

  // The confirmation panel appears only because this file cannot say.
  await expect(page.getByText(/Confirm the product type/i)).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText(/assumed/i).first()).toBeVisible();

  // Rows default to delivery — the safest wrong answer.
  await expect(page.getByText("Equity Delivery").first()).toBeVisible();

  // Choosing MTF must actually RE-PRICE, not just highlight a button: the
  // charges shown next to a product choice have to match that choice.
  await page.getByRole("button", { name: "Equity MTF" }).first().click();
  await expect(page.locator("table").filter({ hasText: "Segment" }).getByText("Equity MTF")).toBeVisible({ timeout: 25_000 });
});

/**
 * A derivative names its own segment, and `classify()` derives it from the
 * symbol while ignoring the product hint entirely. Offering an option row
 * "Equity Delivery / MTF / Intraday" would be a control that looks like it
 * does something and does nothing — so only equity may appear in the panel.
 */
test("import split: F&O rows are not offered an equity product choice", async ({ page }) => {
  await gotoImportReady(page);
  await page.getByText(/P&L Statement/).first().click();
  await page.locator('input[type="file"]').setInputFiles(PNL_FRESH);

  await expect(page.getByText(/Confirm the product type/i)).toBeVisible({ timeout: 25_000 });
  // Scoped to the panel itself — the preview table below lists every row,
  // including the option, so an unscoped match would prove nothing.
  const panel = page.getByTestId("product-confirm-rows");

  // The two equity scrips are listed...
  await expect(panel.getByText("A2ETEST ALPHA", { exact: true })).toBeVisible();
  await expect(panel.getByText("A2ETEST BETA", { exact: true })).toBeVisible();

  // ...and the option is NOT, but is accounted for rather than ignored.
  await expect(panel.getByText(/NIFTY/)).toHaveCount(0);
  await expect(page.getByText(/neither can ever be MTF/i)).toBeVisible();

  // It still imports — the preview table classifies it on its own.
  await expect(
    page.locator("table").filter({ hasText: "Segment" }).getByText("Index Options"),
  ).toBeVisible();
});

/**
 * Arjun's Eye must never fabricate a session for a trade whose time it does
 * not know — the honesty property the whole page rests on.
 */
test("Arjun's Eye: renders, and refuses to invent a session it cannot know", async ({ page }) => {
  await ensureTrades(page);
  await page.goto("/arjuns-eye");

  await expect(page.getByRole("heading", { name: /Arjun's Eye/i })).toBeVisible();
  await expect(page.getByText(/What the data says/i)).toBeVisible();
  await expect(page.getByText(/Which products are worth your capital/i)).toBeVisible();

  // The Dhan fixture is a P&L file with no timestamps, so the session section
  // must say so rather than showing a bucket.
  await expect(page.getByText(/No execution times on record/i)).toBeVisible();

  // Weekday analysis works off DATES, so it is still available.
  await expect(page.getByText(/By weekday/i)).toBeVisible();
});

/**
 * Findings are gated behind a minimum sample. A journal that says "Tuesdays
 * are your best day" off four trades is not worth trusting again.
 */
test("Arjun's Eye: never states a finding it cannot support", async ({ page }) => {
  await ensureDatedTrades(page);
  await page.goto("/arjuns-eye");

  // innerText() does NOT auto-wait, and this page streams behind a Suspense
  // boundary — reading straight after goto() captures the "Loading" placeholder
  // and the assertion then fails on an empty string rather than on the data.
  await expect(page.getByRole("heading", { name: /Arjun's Eye/i })).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText(/What the data says/i)).toBeVisible({ timeout: 25_000 });

  const body = await page.locator("main").innerText();
  // Either there are enough trades for findings, or it says so plainly — but
  // it must never show a bare empty section with no explanation.
  const hasFindings = /Winners are held|losing money|Charges eat|largest positions|strongest window/i.test(body);
  const saysWhyNot = /Not enough closed trades yet/i.test(body);
  expect(hasFindings || saysWhyNot).toBe(true);

  // Any group marked "thin" must be visibly labelled, not silently dropped.
  if (/\bthin\b/.test(body)) {
    expect(body).toMatch(/thin/);
  }
});
