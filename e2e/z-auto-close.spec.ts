import { test, expect, type Page } from "@playwright/test";
import { gotoHydrated, gotoImportReady } from "./helpers";

/**
 * v4.5.0 W2b — the import's automatic close, in a browser, end to end.
 *
 * Auto-close is ON by default (owner ruling A1): a sale of a position this
 * account already holds CLOSES it instead of landing as a second, opposite row.
 * Three things only a browser can show, and all three broke in review at least
 * once:
 *
 *   1. the PREVIEW states the close before anything is written, and the
 *      per-import escape hatch is there, unticked, beside it;
 *   2. ticking the box RE-READS the same file with auto-close off — the close
 *      sentence goes, and unticking brings it back. That round trip is a fetch
 *      the client fires from the change handler, so it is asserted with
 *      `expect.poll`, never once after `networkidle` (AGENTS.md);
 *   3. the row the close produced carries "Un-close", a row nothing closed does
 *      NOT, and pressing it puts the two rows back — a route handler + fetch +
 *      `router.refresh()`, so again a poll.
 *
 * `z-` PREFIXED: this spec IMPORTS, so it must sort after
 * `import-dashboard.spec.ts`, which is the spec entitled to see the first
 * "Imported N trades" (AGENTS.md).
 *
 * The scrip name is this spec's alone — the suite shares ONE database across
 * the run, so every assertion below is scoped to it by the /trades search box,
 * and no count here is ever compared with a whole-database figure.
 *
 * The two CSVs are built in-spec rather than committed as fixtures: they are
 * two rows, and the FILE NAME is the Dhan Global Transaction Report's broker
 * fingerprint (AGENTS.md: a broker-named parser must see the broker's name),
 * so the name has to be stated here anyway.
 */

/** Nothing else in the suite imports this name; it is how every row is found. */
const SCRIP = "E2E Autoclose Scrip";
const FILE_NAME = "Dhan_GlobalTransction_Report.csv";

/** `lib/import/close-open-lots.ts` autoCloseSentences — the close's own words. */
const CLOSE_SENTENCE = /closed against open positions this account already held/i;
/** `components/import/import-client.tsx` importedHeadline, the added-0 branch. */
const HEADLINE = "Closed 1 position you already held · 0 duplicates skipped.";

const GTR_HEAD = [
  "Global transction report,From 01-07-2026 to 29-07-2026",
  "Name,TESTUSER",
  "UCC,TEST0001A",
  "Mobile,9000000000",
  "Email ID,testuser@example.com",
  "",
  "Date,Scrip Name,Exchange,Bill No.,Buy Qty.,Buy Value,Sell Qty.,Sell Value,Brokerage,GST,STT,SEBI Fees,Stamp Duty,Txn. Charges,Oth. Charges,Gross Amount",
];
const BUY_ROW = `"01 Jul 2026 00:00:00","${SCRIP}","NSE","7900001","10","1000.00","0","0.00","0.00","0.00","1.00","0.00","0.00","0.00","0.00","-1001.00"`;
const SELL_ROW = `"02 Jul 2026 00:00:00","${SCRIP}","NSE","7900002","0","0.00","10","1200.00","0.00","0.00","1.00","0.00","0.00","0.00","0.00","1199.00"`;

const csv = (row: string) => `${[...GTR_HEAD, row].join("\n")}\n`;

/**
 * Drop one of the two CSVs on the import dropzone and wait for the preview.
 *
 * `setInputFiles` on a not-yet-hydrated page is a silent no-op, which is what
 * `gotoImportReady` exists to prevent; and the preview's own fetch has to land
 * before anything about it is asserted (AGENTS.md: wait for the panel's own
 * fetch).
 */
async function dropAndPreview(page: Page, row: string): Promise<void> {
  await gotoImportReady(page);
  await page.locator('input[type="file"]').setInputFiles({
    name: FILE_NAME,
    mimeType: "text/csv",
    buffer: Buffer.from(csv(row), "utf8"),
  });
  await expect(page.getByTestId("preview-shape")).toBeVisible({ timeout: 30_000 });
}

/** The Commit button of the preview that is on screen. */
const commitButton = (page: Page) => page.getByRole("button", { name: /^Commit \d+ new trade/ });

/**
 * An earlier spec may legitimately leave the All-accounts view selected, and 0
 * is a VIEW, never a place a write may land (invariant 9). So the single
 * account is chosen here rather than assumed.
 */
async function ensureSingleAccountView(page: Page): Promise<void> {
  const switcher = page.getByLabel("Portfolio account");
  if ((await switcher.inputValue()) === "0") {
    await switcher.selectOption({ label: "Primary" });
    await expect(page.getByText(/All-accounts view/)).toHaveCount(0, { timeout: 15_000 });
  }
}

/** /trades, filtered to this spec's scrip alone. */
async function gotoOurRows(page: Page): Promise<void> {
  await gotoHydrated(page, "/trades");
  await ensureSingleAccountView(page);
  await page.getByPlaceholder(/Search symbol/i).fill(SCRIP);
}

/** The table rows currently showing this spec's scrip. */
const ourRows = (page: Page) => page.locator("tbody tr").filter({ hasText: SCRIP });

test.describe.configure({ mode: "serial" });

test("the lot is imported and opens", async ({ page }) => {
  await gotoHydrated(page, "/trades");
  await ensureSingleAccountView(page);

  await dropAndPreview(page, BUY_ROW);
  // A first purchase closes nothing, so the preview says nothing about closing.
  await expect(page.getByText(CLOSE_SENTENCE)).toHaveCount(0);
  await commitButton(page).click();
  await expect(page.getByTestId("commit-headline")).toBeVisible({ timeout: 60_000 });

  await gotoOurRows(page);
  await expect.poll(async () => await ourRows(page).count(), { timeout: 20_000 }).toBe(1);
  // …and it is OPEN: no un-close is offered on a row no import closed.
  await expect(ourRows(page).getByTestId("un-close")).toHaveCount(0);
});

test("the sale's preview states the close, and the escape hatch is there and unticked", async ({ page }) => {
  await dropAndPreview(page, SELL_ROW);

  const keep = page.getByTestId("keep-sells-separate");
  await expect(keep).toBeVisible();
  await expect(keep).not.toBeChecked();

  // The preview's own warnings name what it would close, BEFORE anything is
  // written — the whole point of stating the plan on the preview.
  await expect(page.getByText(CLOSE_SENTENCE).first()).toBeVisible();
});

test("ticking the box re-reads the file with auto-close off, and unticking brings the close back", async ({ page }) => {
  await dropAndPreview(page, SELL_ROW);
  const keep = page.getByTestId("keep-sells-separate");
  await expect(page.getByText(CLOSE_SENTENCE).first()).toBeVisible();

  // The change handler fires a fresh preview request; the sentence disappears
  // when THAT response renders, not when the click returns.
  await keep.check();
  await expect.poll(async () => await page.getByText(CLOSE_SENTENCE).count(), { timeout: 20_000 }).toBe(0);
  await expect(keep).toBeChecked();

  await keep.uncheck();
  await expect
    .poll(async () => await page.getByText(CLOSE_SENTENCE).count(), { timeout: 20_000 })
    .toBeGreaterThan(0);
  await expect(keep).not.toBeChecked();
});

test("committed with the box unticked, the card says what it closed — not 'Imported 0 trades'", async ({ page }) => {
  await dropAndPreview(page, SELL_ROW);
  await expect(page.getByTestId("keep-sells-separate")).not.toBeChecked();
  await commitButton(page).click();

  const headline = page.getByTestId("commit-headline");
  await expect(headline).toBeVisible({ timeout: 60_000 });
  await expect(headline).toHaveText(HEADLINE);
  // The commit's own sentences reach the card and name the close.
  await expect(page.getByTestId("commit-warnings")).toContainText(CLOSE_SENTENCE);
});

test("the closed row offers Un-close, a row nothing closed does not, and pressing it puts both rows back", async ({ page }) => {
  await gotoOurRows(page);
  // ONE row now, where two open rows used to sit: the lot was converted in place.
  await expect.poll(async () => await ourRows(page).count(), { timeout: 20_000 }).toBe(1);
  await expect(ourRows(page).getByTestId("un-close")).toHaveCount(1);

  // A row from another spec's import was never closed by an import, so it is
  // offered no un-close. (Scoped to one other row — never a whole-database count.)
  await page.getByPlaceholder(/Search symbol/i).fill("");
  const other = page.locator("tbody tr").filter({ hasNotText: SCRIP }).first();
  await expect(other).toBeVisible({ timeout: 20_000 });
  await expect(other.getByTestId("un-close")).toHaveCount(0);

  // Un-close: a route handler + fetch + router.refresh(), so the table is
  // re-rendered asynchronously — poll, never assert once.
  await page.getByPlaceholder(/Search symbol/i).fill(SCRIP);
  await expect.poll(async () => await ourRows(page).count(), { timeout: 20_000 }).toBe(1);
  await ourRows(page).getByTestId("un-close").first().click();

  const msg = page.getByTestId("un-close-message");
  await expect(msg).toBeVisible({ timeout: 30_000 });
  await expect(msg).toContainText(/Un-closed\./);
  // The position is open again and the sale is back as its own row.
  await expect.poll(async () => await ourRows(page).count(), { timeout: 30_000 }).toBe(2);
  await expect(ourRows(page).getByTestId("un-close")).toHaveCount(0);
});
