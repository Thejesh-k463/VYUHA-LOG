import { test, expect, type Page } from "@playwright/test";
import { gotoHydrated } from "./helpers";

/**
 * The dated advance-tax challan ledger (v3.7, WS4), end to end: the editor on
 * /reports/advance-tax, the calculator switching from its typed scalar to the
 * ledger, and the Schedule IT surface on /reports/itr.
 *
 * ── Rules this spec is written against (AGENTS.md → Testing → e2e) ──────────
 *
 *  - The suite shares ONE database and runs alphabetically, so nothing here may
 *    assume it ran first. Every test starts by emptying the ledger itself, and
 *    the `z-` prefix keeps it away from import-dashboard.spec.ts's "Imported N
 *    trades" moment (it seeds no trades at all, but the prefix costs nothing).
 *  - Client-restored state is asserted with `expect.poll`, NEVER once after
 *    networkidle: the calculator reads localStorage after hydration, so a single
 *    assert sees the default and looks exactly like broken persistence
 *    (docs/DECISIONS.md 2026-08-10).
 *  - An absence assertion is only made AFTER the same mechanism has been shown
 *    to work in the same test — otherwise "not there yet" passes as "correctly
 *    not there".
 *
 * Account scoping: a challan is one account's payment, so the aggregate view is
 * read-only (invariant 9). An earlier spec may legitimately leave the
 * All-accounts view selected, so we select the single account ourselves rather
 * than asserting an ambient selection.
 *
 * Dates: never hard-coded. The FY moves with the calendar, so the paid-on date
 * is taken from the input's own `min` attribute — the server-computed first day
 * of the current FY, which is always inside the window and never in the future.
 *
 * Pro gate: these are Pro screens and LICENSE_ENFORCEMENT is "block", so the
 * page depends on the lazily-stamped trial (lib/queries/license.ts). The
 * "Assumptions" assertion below is the canary: if it fails, the trial lapsed on
 * this database rather than the ledger breaking.
 */

const STORE_KEY = "vyuha-advance-tax-calc";
const AMOUNT = "31337";
const AMOUNT_SHOWN = /31,337/;
const BARE_AMOUNT = "777";
const BSR = "0510308";
const SERIAL = "02451";

async function ensureSingleAccountView(page: Page): Promise<void> {
  const switcher = page.getByLabel("Portfolio account");
  if ((await switcher.inputValue()) === "0") {
    await switcher.selectOption({ label: "Primary" });
    await expect(page.getByText(/All-accounts view/)).toHaveCount(0, { timeout: 15_000 });
  }
}

/** Land on the planner with the calculator and the ledger card both rendered. */
async function gotoPlanner(page: Page): Promise<void> {
  await gotoHydrated(page, "/reports/advance-tax");
  await expect(page.getByText("Assumptions")).toBeVisible();
  await ensureSingleAccountView(page);
  await expect(page.getByText(/challan ledger \d{4}-\d{2}/)).toBeVisible();
}

/**
 * Empty the ledger, whatever an earlier run or a retry left behind. Row actions
 * are labelled by POSITION ("Remove row 1 — …") because duplicates are legal and
 * there is no natural key — so deleting row 1 until none remains is the loop.
 */
async function clearLedger(page: Page): Promise<void> {
  const first = page.getByRole("button", { name: /^Remove row 1 —/ });
  for (let i = 0; i < 12 && (await first.count()) > 0; i++) {
    const before = await page.getByRole("button", { name: /^Remove row \d+ —/ }).count();
    await first.click();
    // The delete is fetch + router.refresh(): poll the row count down.
    await expect
      .poll(async () => page.getByRole("button", { name: /^Remove row \d+ —/ }).count(), { timeout: 15_000 })
      .toBeLessThan(before);
  }
  await expect(page.getByText(/No advance-tax challans recorded for \d{4}-\d{2}/)).toBeVisible();
}

/** Record one payment, dated the first day of the FY the page is showing. */
async function recordPayment(page: Page, amount: string, refs: { bsr?: string; serial?: string } = {}): Promise<void> {
  const date = page.locator("#challan-paid-on");
  const fyStart = await date.getAttribute("min");
  expect(fyStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await date.fill(fyStart!);
  await page.locator("#challan-amount").fill(amount);
  if (refs.bsr) await page.locator("#challan-bsr").fill(refs.bsr);
  if (refs.serial) await page.locator("#challan-serial").fill(refs.serial);
  // The submit button is disabled until the client has hydrated AND validated the
  // filled fields. Clicking straight after fill() races that: `fill` dispatches its
  // events before React has attached, so the form still reads empty and the button
  // never enables — the click then burns the whole 90 s timeout on a disabled
  // element. Poll for enablement, which is the same rule AGENTS.md states for
  // client-restored state: never assert (or act) once and hope hydration won.
  const submit = page.getByRole("button", { name: "Record payment" });
  await expect.poll(async () => submit.isEnabled(), { timeout: 15_000 }).toBe(true);
  await submit.click();
}

const setStored = (page: Page, value: unknown) =>
  page.evaluate(({ k, v }) => localStorage.setItem(k, v), { k: STORE_KEY, v: JSON.stringify(value) });

/** The typed "paid so far" input — present only while the ledger is empty. */
const paidInput = (page: Page) => page.locator("#advance-tax-paid-field input");

test("with no challans the calculator keeps its typed scalar, and a future envelope version is discarded", async ({ page }) => {
  await gotoPlanner(page);
  await clearLedger(page);

  // No ledger ⇒ the v3.5 surface, untouched: the typed input, no read-out.
  await expect(paidInput(page)).toBeVisible();
  await expect(page.getByText(/From your challan ledger/)).toHaveCount(0);

  // A v:1 envelope IS restored — proved first, so the v:2 absence below is a
  // real absence and not just "the page had not got there yet".
  await setStored(page, { v: 1, gains: 987654 });
  await page.reload();
  await expect.poll(async () => page.getByText(/Using your saved figure/).count(), { timeout: 15_000 }).toBe(1);

  // A future version is discarded, never mis-read (the versioned-envelope rule).
  await setStored(page, { v: 2, gains: 987654 });
  await page.reload();
  await expect.poll(async () => page.getByText(/Using your saved figure/).count(), { timeout: 15_000 }).toBe(0);

  await page.evaluate((k) => localStorage.removeItem(k), STORE_KEY);
});

test("recording a challan replaces the typed figure and SAYS the saved one is ignored", async ({ page }) => {
  await gotoPlanner(page);
  await clearLedger(page);

  // A saved scalar the ledger is about to override. Prove it is IN FORCE first
  // — the value lands after hydration, so this polls (repo e2e rule).
  await setStored(page, { v: 1, paid: 54321 });
  await page.reload();
  await expect(page.getByText("Assumptions")).toBeVisible();
  await expect.poll(async () => paidInput(page).inputValue(), { timeout: 15_000 }).toBe("54321");

  await recordPayment(page, AMOUNT, { bsr: BSR, serial: SERIAL });

  // fetch + router.refresh() ⇒ poll. The row carries the receipt fields and the
  // server-computed instalment rung.
  const row = page.locator("tr").filter({ hasText: AMOUNT_SHOWN });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await expect(row).toContainText(BSR);
  await expect(row).toContainText(SERIAL);
  await expect(row).toContainText(/15 (Jun|Sep|Dec|Mar)|after/);

  // The calculator now reads the ledger, and states that the saved value lost:
  // the typed input is GONE, replaced by the read-out and the notice naming the
  // figure it is ignoring. A silently ignored saved input would be the defect.
  // Scope the count to the read-out itself. "across N payment(s)" also appears in
  // the explanatory note under the instalment table, so an unscoped getByText hits
  // strict mode with two matches — the same trap the duplicate badge below avoids
  // by anchoring on its title.
  const readout = page.getByText(/From your challan ledger:/);
  await expect(readout).toBeVisible({ timeout: 15_000 });
  await expect(readout).toContainText(/across 1 payment\b/);
  await expect(page.getByText(/is IGNORED for/)).toBeVisible();
  await expect(page.getByText(/Your saved figure of ₹54,321/)).toBeVisible();
  await expect(paidInput(page)).toHaveCount(0);
});

test("an identical second payment is warned about, never refused", async ({ page }) => {
  await gotoPlanner(page);
  await clearLedger(page);

  await recordPayment(page, AMOUNT, { bsr: BSR, serial: SERIAL });
  await expect(page.locator("tr").filter({ hasText: AMOUNT_SHOWN })).toHaveCount(1, { timeout: 15_000 });

  // Same date, same amount — legal, and the schema has no unique index for it.
  await recordPayment(page, AMOUNT);
  await expect(page.locator("tr").filter({ hasText: AMOUNT_SHOWN })).toHaveCount(2, { timeout: 15_000 });

  // Warned, on both rows, and explained. Anchored on the badge's own title so
  // the count cannot pick up the explanatory paragraph as a third match.
  await expect(page.getByTitle(/Another challan on this account/)).toHaveCount(2);
  await expect(page.getByText(/share a date and amount with another challan/)).toBeVisible();

  // And the money is counted twice, because both payments are real. Scoped to the
  // read-out for the same strict-mode reason as above.
  await expect(page.getByText(/From your challan ledger:/)).toContainText(/across 2 payments/);
});

test("a challan with no BSR or serial is accepted, and the ITR pack leaves those columns blank", async ({ page }) => {
  await gotoPlanner(page);
  await clearLedger(page);

  // No BSR, no serial — a self-assessment receipt often carries neither.
  await recordPayment(page, BARE_AMOUNT);
  const row = page.locator("tr").filter({ hasText: /₹777/ });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await expect(row).toContainText("—");

  await gotoHydrated(page, "/reports/itr");
  await expect(page.getByText("Taxes paid (advance tax)")).toBeVisible();
  const itrRow = page.locator("tr").filter({ hasText: /₹777/ });
  await expect(itrRow).toHaveCount(1);
  // Blank, not a placeholder and not 0 (invariant 6).
  await expect(itrRow).toContainText("—");
  await expect(itrRow).not.toContainText("₹0");
});

test("deleting every challan returns the calculator to the typed figure", async ({ page }) => {
  await gotoPlanner(page);
  await clearLedger(page);
  await setStored(page, { v: 1, paid: 54321 });
  await page.reload();
  await expect(page.getByText("Assumptions")).toBeVisible();
  // Server-rendered text proves nothing about hydration. Poll the client-restored
  // value first — otherwise recordPayment's fill() lands before React attaches and
  // hydration then resets the fields, leaving the submit button permanently
  // disabled. Same rule, same reason as the sibling test above.
  await expect.poll(async () => paidInput(page).inputValue(), { timeout: 15_000 }).toBe("54321");

  await recordPayment(page, AMOUNT);
  await expect(page.getByText(/From your challan ledger:/)).toBeVisible({ timeout: 15_000 });

  await clearLedger(page);

  // Back to the v3.5 surface: no read-out, no ignored-value notice, and the
  // saved scalar is in force again — it was ignored, never destroyed.
  await expect(page.getByText(/From your challan ledger/)).toHaveCount(0);
  await expect(page.getByText(/is IGNORED for/)).toHaveCount(0);
  await expect.poll(async () => paidInput(page).inputValue(), { timeout: 15_000 }).toBe("54321");

  await page.evaluate((k) => localStorage.removeItem(k), STORE_KEY);
});
