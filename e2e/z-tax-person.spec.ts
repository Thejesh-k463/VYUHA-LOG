import { test, expect, type Page } from "@playwright/test";
import { ensureTrades, gotoHydrated } from "./helpers";

/**
 * v4.5.0 wave TP — TAX PER TAX PERSON, in a browser (STATE §0.3 V7).
 *
 * Wave TP shipped the one deliberate widening of invariant 8
 * (`lib/queries/tax-scope.ts`) with unit tests only. The rule it exists to
 * enforce is a SCREEN rule, and invariant 6 ("never fabricate a denominator" —
 * here, never a total nobody can file):
 *
 *   • ONE tax person in the book → `/reports/tax` states WHOSE figures these
 *     are ("Tax person: <label> — accounts: …", `TaxPersonLine`) and shows the
 *     figures;
 *   • TWO tax persons with the All-accounts view (0) selected → `resolveTaxScope`
 *     returns `accountIds: []` plus `candidates`, the page returns EARLY with
 *     `TaxPersonPicker` and NOTHING else: no card, no table, NOT ONE RUPEE on
 *     screen. A rupee figure rendered in that state is an invariant-6 defect,
 *     not a cosmetic one — it is a number spanning two people's returns;
 *   • picking a person (`?person=<key>`, a VIEW param — no write, nothing
 *     persisted, invariant 9) shows THAT person's header line and figures.
 *
 * …and the export carries the same line: `taxScopeHeader(scope)` is handed to
 * `ExportButtons` as `note` and written ABOVE the header row, so an exported
 * tax sheet can never be a person-less number in a spreadsheet. That is pinned
 * here by taking the CSV download and reading its first line.
 *
 * SEEDING IS UNDONE. The suite shares ONE database across the run
 * (`e2e/helpers.ts`), so the second tax person is a scratch ACCOUNT created
 * through the app's own `/api/accounts` route (a route handler + fetch, never
 * SQL into `accounts`), and `afterAll` purges it and puts the account
 * selection back — every later spec sees the one-person book it saw before.
 *
 * `z-` PREFIXED because it calls `ensureTrades`, which may import: only
 * `import-dashboard.spec.ts` is entitled to see the first "Imported N trades"
 * (AGENTS.md).
 */

/** Nothing else in the suite uses either string. */
const SCRATCH_ACCOUNT = "E2E Tax Person B";
const SCRATCH_IDENTITY = "E2E Person B";

/** The account this run started on, and the scratch account to purge. */
let previousAccountId = 0;
let scratchId = 0;

/** `lib/queries/tax-scope.ts` taxScopeHeader / `TaxPersonLine` — the same words. */
const PERSON_LINE = /Tax person:/;

/**
 * The whole person line, not the label that introduces it.
 *
 * `TaxPersonLine` splits the sentence across three sibling `<span>`s, so
 * `getByText(/Tax person:/)` resolves to the FIRST one alone and reads
 * "Tax person: " — a locator that can never see the person's name, and whose
 * failure ("Received: Tax person: ") reads like a product bug. The parent
 * element is the sentence.
 */
const personLine = (page: Page) =>
  page.locator("main").getByText(PERSON_LINE).first().locator("xpath=..");

async function selectAccount(page: Page, id: number): Promise<void> {
  const res = await page.request.post("/api/accounts", { data: { action: "select", id } });
  expect(res.ok(), `selecting account ${id}`).toBeTruthy();
}

/**
 * Every rupee figure inside the page body.
 *
 * Scoped to `<main>` (app/layout.tsx) on purpose: the sidebar carries its own
 * chrome, and a whole-page count would be measuring the shell rather than the
 * tax report. The assertion below is that this is EXACTLY ZERO under two
 * persons — the page must render no figure at all, not a hidden one.
 */
const rupees = (page: Page) => page.locator("main").getByText(/₹/);

test.describe.configure({ mode: "serial" });

test.afterAll(async ({ browser }) => {
  if (!scratchId) return;
  const page = await browser.newPage();
  try {
    await selectAccount(page, previousAccountId);
    const purged = await page.request.post("/api/accounts", {
      data: { action: "delete", id: scratchId, mode: "purge", connections: "delete" },
    });
    expect(purged.ok(), "purging the scratch tax-person account").toBeTruthy();
    scratchId = 0;
  } finally {
    await page.close();
  }
});

test("one tax person: the page names the person, its accounts, and shows figures", async ({ page }) => {
  await ensureTrades(page);
  await gotoHydrated(page, "/trades");

  // 0 is a VIEW (invariant 9) and an earlier spec may have left it selected;
  // the single account is chosen rather than assumed, and remembered so the
  // rest of the suite gets its book back.
  const switcher = page.getByLabel("Portfolio account");
  await expect(switcher, "the sidebar account switcher names the person").toBeVisible();
  if ((await switcher.inputValue()) === "0") {
    await switcher.selectOption({ label: "Primary" });
    await expect(page.getByText(/All-accounts view/)).toHaveCount(0, { timeout: 15_000 });
  }
  previousAccountId = Number(await switcher.inputValue());
  expect(previousAccountId, "a real account must be selected").toBeGreaterThan(0);

  await gotoHydrated(page, "/reports/tax");
  // The default account states no tax identity, so it is its OWN person
  // (under-merge, never over-merge) and the label is the account's name.
  const line = personLine(page);
  await expect(line).toBeVisible();
  await expect(line).toContainText(/Tax person:\s*Primary/);
  await expect(line).toContainText(/accounts:\s*Primary/);

  // …and the figures are there: one person's return is a number that exists.
  await expect(page.getByText("Per financial year", { exact: true })).toBeVisible();
  await expect.poll(async () => await rupees(page).count(), { timeout: 20_000 }).toBeGreaterThan(0);
});

test("the CSV export carries the person line above its header row", async ({ page }) => {
  await gotoHydrated(page, "/reports/tax");

  // The buttons sit in the same CardHeader as the title, so the title's parent
  // is the one card whose export this is — never a bare `.first()` over a page
  // that carries several export buttons.
  const header = page.getByText("Per financial year", { exact: true }).locator("xpath=..");
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30_000 }),
    header.getByRole("button", { name: "CSV" }).click(),
  ]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const first = Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0];
  expect(first, "the export's first line is the tax-person note").toMatch(/^"?Tax person: Primary — accounts: Primary/);
});

test("two tax persons under All accounts: a picker, and NOT ONE rupee on screen", async ({ page }) => {
  const created = await page.request.post("/api/accounts", {
    data: { action: "upsert", name: SCRATCH_ACCOUNT, taxIdentity: SCRATCH_IDENTITY },
  });
  expect(created.ok(), "creating the second tax person's account").toBeTruthy();
  scratchId = ((await created.json()) as { id?: number }).id ?? 0;
  expect(scratchId, "the accounts API returned no id").toBeGreaterThan(0);

  // All accounts (0) — the only state in which the book spans two persons.
  await selectAccount(page, 0);
  await gotoHydrated(page, "/reports/tax");

  await expect(page.getByText("Choose a tax person")).toBeVisible();
  await expect(page.locator("main").getByRole("link", { name: SCRATCH_IDENTITY })).toBeVisible();
  // The page RETURNED EARLY: no card, no table, and no figure of any kind.
  // A rupee here is an invariant-6 defect (a total across two returns).
  await expect(page.getByText("Per financial year", { exact: true })).toHaveCount(0);
  await expect(rupees(page), "a figure under two tax persons is a number nobody can file").toHaveCount(0);
  await expect(page.locator("main").getByText(PERSON_LINE)).toHaveCount(0);
});

test("picking a person shows that person's header line and figures again", async ({ page }) => {
  await gotoHydrated(page, "/reports/tax");
  await expect(page.getByText("Choose a tax person")).toBeVisible();

  // The unassigned account's key is the lower-case `account:<id>` the picker
  // puts in the link; `resolveTaxScope` normalises both sides before comparing.
  await page.locator("main").getByRole("link", { name: "Primary", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`\\?person=account%3A${previousAccountId}$`));

  const line = personLine(page);
  await expect(line).toBeVisible({ timeout: 20_000 });
  await expect(line).toContainText(/Tax person:\s*Primary/);
  await expect(page.getByText("Per financial year", { exact: true })).toBeVisible();
  await expect.poll(async () => await rupees(page).count(), { timeout: 20_000 }).toBeGreaterThan(0);

  // The choice is a VIEW: nothing was written, so the selector still says
  // All accounts and the picker returns the moment the param goes.
  await gotoHydrated(page, "/reports/tax");
  await expect(page.getByText("Choose a tax person")).toBeVisible();
  await expect(page.getByLabel("Portfolio account")).toHaveValue("0");
});
