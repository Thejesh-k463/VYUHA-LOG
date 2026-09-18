import { test, expect, type Locator, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { E2E_DB_PATH, ensureTrades, gotoHydrated } from "./helpers";

/**
 * The Signal book — the FIRST tab on /strategies (v4.3.0) — end to end. Written for
 * the v4.4.0 fix list: the tab shipped with no e2e spec (DECISIONS 2026-09-18, "v4.3.0
 * gains ONE single strategy", seam boundaries with no runtime case: the tab's mount,
 * `signal-section.tsx`'s own client state — vitest here runs node, no jsdom).
 *
 * Three things only a browser can show:
 *   1. the tab renders, and is the tab /strategies opens on;
 *   2. a signal recorded on the Add trade form (F&O → Option → Record the signal)
 *      reaches the book with the numbers typed — the section posts RAW strings and
 *      the server builds the envelope, so this is the whole wire;
 *   3. the free/Pro split: the table is the user's own record and stays free
 *      (invariant 7); the three read-backs are Pro and are withheld SERVER-side
 *      (`withholdSignalAnalytics`), so on a free licence their text is nowhere in
 *      what the browser received — not hidden, absent.
 *
 * `z-` PREFIXED: it seeds via `ensureTrades`, so it must sort after
 * `import-dashboard.spec.ts` (AGENTS.md). Serial: the split test reads the row the
 * Add test wrote. The one trade this spec adds is keyed by an improbable strike and
 * removed before and after the run, so no later spec sees an extra row.
 *
 * Constants are hardcoded copies (the z-sidebar-fold / z-live-desk convention: no
 * spec pulls app modules through Playwright's transform).
 */

/** An improbable strike: the one key this spec's trade is found — and removed — by. */
const STRIKE = 12345;
const STRIKE_TEXT = "12,345"; // lib/format num(…, 0), en-IN
const SPOT = "23456.7";
const SPOT_TEXT = "23,456.70";
const MODEL = "S2";
/** components/strategies/signal-book.tsx — the Locked block's heading and one Pro block's. */
const LOCKED_HEADING = "Rule adherence, edge and ladder";
const PRO_HEADING = "Edge by model, direction and exit";
/** lib/license.ts TRIAL_DAYS, as z-live-desk.spec.ts copies it. */
const TRIAL_DAYS = 7;

function removeSpecTrade(): void {
  const conn = new Database(E2E_DB_PATH);
  try {
    conn.pragma("busy_timeout = 10000");
    conn.prepare("delete from trades where strike = ? and signal_json is not null").run(STRIKE);
  } finally {
    conn.close();
  }
}

/** Set by `expireTrial()`, run by the `afterEach` below, and only ever null otherwise. */
let restoreTrial: (() => void) | null = null;

/**
 * Expire the Pro trial in the database the server is serving from — a copy of
 * `z-live-desk.spec.ts`'s `expireTrial()`, whose header states why this is the
 * only door to the free wire. The undo is registered BEFORE the write, and read
 * back, so a test that throws mid-way still hands the next spec its trial.
 */
function expireTrial(): void {
  const conn = new Database(E2E_DB_PATH);
  try {
    conn.pragma("busy_timeout = 10000");
    const row = conn.prepare("select id, trial_started_at as startedAt from settings limit 1").get() as
      | { id: number; startedAt: string | null }
      | undefined;
    expect(row, "the e2e database has no settings row").toBeTruthy();
    const { id, startedAt } = row!;
    restoreTrial = () => {
      const back = new Database(E2E_DB_PATH);
      try {
        back.pragma("busy_timeout = 10000");
        back.prepare("update settings set trial_started_at = ? where id = ?").run(startedAt, id);
        const after = back.prepare("select trial_started_at as t from settings where id = ?").get(id) as { t: string | null };
        expect(after.t, "the trial was NOT restored — later specs would run free").toBe(startedAt);
      } finally {
        back.close();
      }
    };
    const expired = new Date(Date.now() - (TRIAL_DAYS + 3) * 24 * 60 * 60 * 1000).toISOString();
    conn.prepare("update settings set trial_started_at = ? where id = ?").run(expired, id);
  } finally {
    conn.close();
  }
}

/** A form field by its visible label: the manual form's `Field` and the Signal section both wrap label + control in `div.space-y-1`. */
function field(scope: Locator, page: Page, label: string | RegExp): Locator {
  return scope
    .locator("div.space-y-1")
    .filter({ has: page.getByText(label, { exact: typeof label === "string" }) })
    .locator("input, select")
    .first();
}

/** The Signal book's row for this spec's trade. */
const specRow = (page: Page) => page.locator("tbody tr").filter({ hasText: STRIKE_TEXT }).filter({ hasText: MODEL });

test.describe.configure({ mode: "serial" });

test.beforeAll(() => removeSpecTrade());
test.afterAll(() => removeSpecTrade());

test.beforeEach(async ({ page }) => {
  await ensureTrades(page);
});

test.afterEach(() => {
  restoreTrial?.();
  restoreTrial = null;
});

test("the Signal book is the tab /strategies opens on, beside the catalogue", async ({ page }) => {
  await page.goto("/strategies");
  await expect(page.getByRole("tab", { name: "Signal book" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Structures you hold" })).toBeVisible();
  // Either state of the tab renders: its empty state, or its table.
  await expect(
    page.getByText("No signals recorded yet").or(page.getByRole("columnheader", { name: "T1 / T2 / SL" })),
  ).toBeVisible();
});

test("a signal recorded on the Add trade form shows in the book with the numbers typed", async ({ page }) => {
  await gotoHydrated(page, "/trades");
  await page.getByRole("button", { name: "Add trade" }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Auto-classified with a live charge preview" });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "F&O (options / futures)" }).click();
  await field(dialog, page, "Underlying / ticker").fill("NIFTY");
  await field(dialog, page, "Contract").selectOption("option");
  await field(dialog, page, "Expiry").fill("2026-09-30");
  await field(dialog, page, "Strike").fill(String(STRIKE));
  await field(dialog, page, "Option type").selectOption("CE");
  await field(dialog, page, "Lot size").fill("75");
  await field(dialog, page, /^Lots/).fill("1");
  await field(dialog, page, "Entry premium").fill("100");
  await field(dialog, page, "Exit premium").fill("130");
  await field(dialog, page, "Entry date").fill("2026-09-01");
  await field(dialog, page, "Exit date").fill("2026-09-01");

  // The Signal section starts OFF on Add and posts nothing until switched on.
  await dialog.getByRole("button", { name: "Record the signal" }).click();
  await expect(dialog.getByRole("button", { name: "Recording" })).toBeVisible();
  await field(dialog, page, "Model").selectOption(MODEL);
  await field(dialog, page, "Spot").fill(SPOT);

  await dialog.getByRole("button", { name: "Add trade", exact: true }).click();
  // A saved trade with an id turns the form into the attach-charts step.
  const done = dialog.getByRole("button", { name: "Done" });
  await expect(done, "the trade was not saved — read the toast").toBeVisible({ timeout: 20_000 });
  await done.click();

  await page.goto("/strategies");
  const row = specRow(page);
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await expect(row).toContainText("NIFTY");
  await expect(row).toContainText("CE");
  await expect(row).toContainText(SPOT_TEXT);
  // T1 / T2 / SL were pre-filled at +30% / +60% / −25% of the 100 entry and posted as shown.
  await expect(row).toContainText("130.00 / 160.00 / 75.00");
});

test("the free/Pro split: the table stays free, the read-backs are Pro and withheld server-side", async ({ page }) => {
  await page.goto("/strategies");
  await expect(specRow(page)).toHaveCount(1, { timeout: 15_000 });

  // PRO (the e2e database starts on a day-1 trial — see z-live-desk.spec.ts).
  await expect(page.getByRole("heading", { name: PRO_HEADING }), "the book must start ENTITLED").toBeVisible();
  await expect(page.getByText(LOCKED_HEADING)).toHaveCount(0);

  // FREE: the same row, the lock in place of the read-backs, and the read-backs'
  // text nowhere in what the server sent. Polled: the entitlement is read per
  // request, and one reload is the whole mechanism.
  expireTrial();
  await page.reload();
  await expect(specRow(page), "the table is the user's own record and stays free").toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByText(LOCKED_HEADING)).toBeVisible();
  await expect(page.getByRole("heading", { name: PRO_HEADING })).toHaveCount(0);
  await expect.poll(async () => (await page.content()).includes(PRO_HEADING), { timeout: 15_000 }).toBe(false);
});
