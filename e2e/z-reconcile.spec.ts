import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { gotoHydrated, gotoImportReady } from "./helpers";

/**
 * v3.9 "Trust the numbers" — Broker Truth, end to end.
 *
 * Imports the owner's own pair of redacted Dhan exports in the order he
 * actually uses them — the transaction report first, then the Realised P&L
 * whose SEGMENT summary states what Dhan says the book made — and then reads
 * /reports/reconcile.
 *
 * Two properties are asserted, and they are the whole feature:
 *   1. the equity segment row shows the BROKER'S figure, not Vyuha's; and
 *   2. where the two disagree, the row carries at least one REASON — a counted
 *      fact from the book, never a bare "mismatch".
 *
 * Ordering: the suite shares one database and imports are de-duplicated
 * (AGENTS.md), so the second file's positions may all be duplicates by the
 * time it lands. That does NOT make it a no-op — it still carries the
 * broker's stated figures, and the commit button says so ("Store N broker
 * figures"). Both button shapes are accepted here for that reason.
 *
 * `z-` prefix: this spec seeds, so it must sort after import-dashboard.spec.ts.
 */

const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "redacted");
const GTR = path.join(FIXTURES, "dhan-gtr-2026-04-01_2026-09-03-a2.csv");
const REALISED = path.join(FIXTURES, "dhan-realised-pnl-2026-04-01_2026-09-03-a2.xls");

/** Upload a file and commit it, whatever the commit produces. Returns the
 *  commit card's own text so a later assertion can be made against it. */
async function importFile(page: Page, file: string): Promise<string> {
  await gotoImportReady(page);
  await page.locator('input[type="file"]').setInputFiles(file);

  // The preview is produced by a fetch the dropzone fires on change; the
  // button is the first thing that proves the parse landed, so it is what we
  // wait on rather than any count (a count read too early is the default).
  const commit = page.getByRole("button", { name: /Commit\s+\d+\s+new trade|Store\s+\d+\s+(broker figure|fill time)/i });
  await expect(commit).toBeVisible({ timeout: 30_000 });
  await expect(commit).toBeEnabled({ timeout: 30_000 });
  await commit.click();

  const card = page.getByText(/Imported\s+\d+\s+trade/i);
  await expect(card).toBeVisible({ timeout: 30_000 });
  return (await page.locator("body").innerText()) ?? "";
}

test.describe.configure({ mode: "serial" });

test.describe("broker truth", () => {
  test("a Dhan Realised P&L states the equity segment, and the screen shows it beside the book", async ({ page }) => {
    await importFile(page, GTR);
    const after = await importFile(page, REALISED);

    // The commit says how many broker figures it stored, and points here.
    expect(after, "a reference import must not report itself as \"Imported 0 trades\" and nothing else")
      .toMatch(/\d+ broker figures? stored — see Broker Truth/);

    await gotoHydrated(page, "/reports/reconcile");

    // Sources: the statement is named, from the import registry.
    await expect(page.getByTestId("reconcile-sources")).toContainText(/Realised P&L/i, { timeout: 20_000 });

    // The equity segment row. `expect.poll` rather than one assert after
    // networkidle: the tables are rendered by a client island (AGENTS.md).
    const equityRow = page.locator('[data-recon-key="equity"]').first();
    await expect(equityRow).toBeVisible({ timeout: 20_000 });

    // The BROKER column carries a rupee figure of its own — the file's, not
    // an echo of Vyuha's. A row that showed only our own total would look
    // identical to a perfect reconciliation.
    const cells = equityRow.locator("td");
    const brokerCell = (await cells.nth(1).innerText()).trim();
    expect(brokerCell, "the broker's own stated figure").toMatch(/₹/);
    expect(brokerCell).not.toBe("—");

    // And the delta is stated as a figure, never left implied.
    const deltaCell = (await equityRow.locator("[data-recon-delta]").innerText()).trim();
    expect(deltaCell).toMatch(/₹/);

    // A status word, and it is never the word "mismatch".
    const rowText = await equityRow.innerText();
    expect(rowText).toMatch(/Within tolerance|Broker higher|Vyuha higher/);
    expect(rowText.toLowerCase()).not.toContain("mismatch");
  });

  test("a row that disagrees carries at least one counted reason, and no generic line", async ({ page }) => {
    await gotoHydrated(page, "/reports/reconcile");

    const rows = page.locator("[data-recon-key]");
    await expect.poll(() => rows.count(), { timeout: 20_000 }).toBeGreaterThan(0);

    // Somewhere in this book at least one line must explain itself: the two
    // sides are built from different files and never agree to the paisa on
    // everything. Each reason is a sentence with a number in it.
    const reasons = page.locator("[data-reason]");
    await expect.poll(() => reasons.count(), { timeout: 20_000 }).toBeGreaterThan(0);

    const first = (await reasons.first().innerText()).trim();
    expect(first.length, "a reason must be a sentence, not a code").toBeGreaterThan(20);
    expect(first).toMatch(/\d/);
    // The four sanctioned reason codes — anything else is an invented excuse.
    const codes = await reasons.evaluateAll((els) => els.map((e) => e.getAttribute("data-reason")));
    for (const c of codes) {
      expect(["unpriced_sales", "charges_omitted", "open_lots", "product_difference"]).toContain(c);
    }

    // A row out of tolerance for which none of the four facts fired says WHICH
    // facts it checked — `data-checked`, deliberately not a fifth reason code.
    // The suite shares one database and this spec's two files are imported
    // into it, so how many such rows exist is not fixed; what they may say is.
    const checked = page.locator("[data-checked]");

    // The loop below asserts nothing when there are no such rows, and an empty
    // `[data-checked]` set is exactly what a screen that stopped explaining
    // itself would produce. So pin the floor first: the equity row must carry
    // at least one counted reason OR a checked-and-found-nothing line — never
    // neither, which is a silent gap wearing a status word.
    const equityRow = page.locator('[data-recon-key="equity"]').first();
    if (await equityRow.count()) {
      const explained =
        (await equityRow.locator("[data-reason]").count()) + (await equityRow.locator("[data-checked]").count());
      expect(explained, "an equity row with no reason and no checked line explains nothing").toBeGreaterThan(0);
    }

    for (const text of await checked.allInnerTexts()) {
      expect(text.trim().length, "a checked-and-found-nothing line is a sentence too").toBeGreaterThan(20);
      expect(text.toLowerCase()).not.toContain("mismatch");
      expect(text, "it must NAME the facts, with their zero counts").toMatch(/\d/);
    }
  });
});
