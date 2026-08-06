import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ensureTrades } from "./helpers";

/**
 * B2 — end-to-end coverage for the v2.97 surfaces.
 *
 * Everything here shipped in v2.97 with unit tests at most; none of it had ever
 * been driven through the real app. These flows exercise the wiring that unit
 * tests cannot see: the route handlers, the client components, and the round
 * trip back into a rendered page.
 *
 * The backup flow is the one that matters most. `restoreDatabase` is unit
 * tested against a temp database, but the path a USER takes runs through a file
 * download, a browser `confirm()`, and a multipart-free JSON POST — none of
 * which the unit tests touch. A backup that cannot actually be restored through
 * the UI is worthless no matter how green the engine tests are.
 */

const DOWNLOADS = path.join(process.cwd(), "test-results", "e2e-downloads");

test.beforeAll(() => {
  fs.mkdirSync(DOWNLOADS, { recursive: true });
});

test("Data Quality Center scores the book and every issue links somewhere", async ({ page }) => {
  await ensureTrades(page);

  await page.goto("/data-quality");
  await page.waitForLoadState("networkidle");

  await expect(page.getByRole("heading", { name: /Data Quality Center/i })).toBeVisible();

  // The score badge is "<n>/100" — assert it parses as a real bounded score
  // rather than just that some text rendered.
  const badge = await page.getByText(/^\d+\/100$/).first().textContent();
  const score = Number(badge?.split("/")[0]);
  expect(Number.isFinite(score)).toBe(true);
  expect(score).toBeGreaterThanOrEqual(0);
  expect(score).toBeLessThanOrEqual(100);

  await expect(page.getByText("Records checked")).toBeVisible();
  await expect(page.getByText("Affected trades")).toBeVisible();

  // Every diagnostic must offer a route to fix it — a finding with nowhere to
  // go is just a complaint.
  const reviews = page.getByRole("link", { name: /^Review$/ });
  const n = await reviews.count();
  if (n > 0) {
    const hrefs: string[] = [];
    for (let i = 0; i < n; i++) {
      const href = await reviews.nth(i).getAttribute("href");
      expect(href).toBeTruthy();
      expect(href!.startsWith("/")).toBe(true);
      hrefs.push(href!);
    }

    // And the first one must actually RESOLVE, not 404. Navigate directly
    // rather than clicking: these are Next <Link>s, so a click is a
    // client-side transition that `networkidle` reports as settled before the
    // route has swapped — the URL assertion then races and reads the old page.
    const target = hrefs[0];
    const res = await page.goto(target);
    expect(res?.status()).toBeLessThan(400);
    await page.waitForLoadState("networkidle");
    // A real screen, not the 404 boundary.
    await expect(page.locator("h1, h2").first()).toBeVisible();
    await expect(page.getByText(/This page could not be found/i)).toHaveCount(0);
  }
});

test("a session plan produces a deterministic post-market review", async ({ page }) => {
  await ensureTrades(page);

  await page.goto("/sessions");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: /Session Plan & Review/i })).toBeVisible();

  // A plan tight enough that the review has something to say: one trade
  // allowed, a symbol the book will not match, and an early cutoff.
  await page.locator('input[name="symbols"]').fill("ZZZNOTHING");
  await page.locator('input[name="maxTrades"]').fill("1");
  await page.locator('input[name="maxLoss"]').fill("500");
  await page.locator('input[name="cutoff"]').fill("09:30");
  await page.locator('textarea[name="thesis"]').fill("E2E plan — expect the review to grade this.");

  await page.getByRole("button", { name: /Save session plan/i }).click();
  await expect(page.getByText(/Plan saved\./i)).toBeVisible({ timeout: 20_000 });

  // The saved plan comes back as a graded card.
  await page.waitForLoadState("networkidle");
  const adherence = page.getByText(/\d+% adherence/).first();
  await expect(adherence).toBeVisible();
  const pct = Number((await adherence.textContent())?.match(/(\d+)%/)?.[1]);
  expect(pct).toBeGreaterThanOrEqual(0);
  expect(pct).toBeLessThanOrEqual(100);

  // The review always states a finding — including when nothing was traded.
  await expect(page.locator("li", { hasText: "▸" }).first()).toBeVisible();
  await expect(page.getByText(/E2E plan — expect the review/i)).toBeVisible();
});

test("switching accounts changes what the journal shows, and back again", async ({ page }) => {
  await ensureTrades(page);

  await page.goto("/trades");
  await page.waitForLoadState("networkidle");

  const switcher = page.getByLabel("Portfolio account");
  await expect(switcher).toBeVisible();

  // A6 — a single-account install must NOT be sitting in the aggregate view.
  await expect(switcher).not.toHaveValue("0");

  const countOf = async () => {
    const t = await page.getByText(/\d+\s+of\s+\d+/).first().textContent().catch(() => null);
    return Number(t?.match(/of\s+(\d+)/)?.[1] ?? 0);
  };
  const primaryCount = await countOf();
  expect(primaryCount).toBeGreaterThan(0);

  // A second account starts empty — proving isolation is real end to end, not
  // just in the query unit tests.
  await page.goto("/settings");
  await page.waitForLoadState("networkidle");
  const nameField = page.locator('input[name="name"]').first();
  if (await nameField.count()) {
    await nameField.fill("E2E Second Book");
    const addBtn = page.getByRole("button", { name: /Add account|Save account|Create account/i }).first();
    if (await addBtn.count()) {
      await addBtn.click();
      await page.waitForLoadState("networkidle");

      await page.goto("/trades");
      await page.waitForLoadState("networkidle");
      const sw = page.getByLabel("Portfolio account");
      const second = sw.locator('option', { hasText: "E2E Second Book" });
      if (await second.count()) {
        // POLL the counter, never networkidle: switching accounts is a POST
        // followed by a router refresh, and networkidle can resolve in the gap
        // between the two — the assertion then reads the OLD account's counter
        // (observed: expected 0, received the primary book's 125).
        await sw.selectOption({ label: "E2E Second Book" });
        await expect.poll(countOf, { timeout: 15_000 }).toBe(0);

        // The aggregate view sees both books at once.
        await sw.selectOption("0");
        await expect.poll(countOf, { timeout: 15_000 }).toBe(primaryCount);

        // Back to the real account so later specs see a normal journal.
        await sw.selectOption({ label: "Primary" });
        await expect.poll(countOf, { timeout: 15_000 }).toBe(primaryCount);
      }
    }
  }
});

test("a complete backup exports and restores through the real UI", async ({ page }) => {
  await ensureTrades(page);

  await page.goto("/trades");
  await page.waitForLoadState("networkidle");
  const tradeCount = await page.getByText(/\d+\s+of\s+\d+/).first().textContent();
  const before = Number(tradeCount?.match(/of\s+(\d+)/)?.[1] ?? 0);
  expect(before).toBeGreaterThan(0);

  await page.goto("/backup");
  await page.waitForLoadState("networkidle");

  // ---- export -------------------------------------------------------------
  const download = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: /Complete backup/i }).click();
  const file = await download;
  const saved = path.join(DOWNLOADS, "vyuha-e2e-backup.json");
  await file.saveAs(saved);

  await expect(page.getByText(/Complete backup downloaded/i)).toBeVisible({ timeout: 30_000 });

  // The file on disk must be a real backup, not an error page.
  const dump = JSON.parse(fs.readFileSync(saved, "utf8"));
  expect(dump.vyuhaBackup).toBe(true);
  expect(Array.isArray(dump.tables.trades)).toBe(true);

  // Do NOT compare the dump's row count against the page's "N of M" counter.
  // They are different populations: the trades table is account-scoped and
  // view-filtered, while the dump is every row in every account. The equality
  // held only while the fixture had one account and no active filter, and broke
  // the moment the account-switching spec above added a second book (122 on the
  // page vs 247 in the file). The dump must simply be non-empty and internally
  // consistent; the page count is checked before-vs-after instead, which is a
  // like-for-like comparison.
  expect(dump.tables.trades.length).toBeGreaterThan(0);
  expect(dump.counts.trades).toBe(dump.tables.trades.length);

  // ---- restore ------------------------------------------------------------
  // The panel asks for confirmation before replacing anything; accept it.
  page.on("dialog", (d) => void d.accept());

  await page.locator('input[type="file"]').setInputFiles(saved);
  await expect(page.getByText(/Restored \d+ rows across \d+ tables/i)).toBeVisible({ timeout: 60_000 });

  // The journal must be intact afterwards — a restore that loses trades is the
  // exact failure this whole flow exists to catch.
  await page.goto("/trades");
  await page.waitForLoadState("networkidle");
  const after = await page.getByText(/\d+\s+of\s+\d+/).first().textContent();
  expect(Number(after?.match(/of\s+(\d+)/)?.[1] ?? 0)).toBe(before);
});

test("an encrypted backup cannot be read without its password", async ({ page }) => {
  await ensureTrades(page);

  await page.goto("/backup");
  await page.waitForLoadState("networkidle");

  await page.getByPlaceholder(/Optional password/i).fill("e2e-backup-password");

  const download = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: /Complete backup/i }).click();
  const file = await download;
  const saved = path.join(DOWNLOADS, "vyuha-e2e-encrypted.json");
  await file.saveAs(saved);

  await expect(page.getByText(/AES-256 encryption/i)).toBeVisible({ timeout: 30_000 });

  const raw = fs.readFileSync(saved, "utf8");
  const sealed = JSON.parse(raw);
  expect(sealed.vyuhaEncrypted).toBe(true);
  expect(sealed.algorithm).toBe("aes-256-gcm");
  // A4 — the cost parameters travel with the file so it stays openable later.
  expect(sealed.kdfParams?.N).toBeGreaterThan(16384);
  // The whole point: no plaintext table data on disk.
  expect(raw).not.toContain("vyuhaBackup");
  expect(raw).not.toContain("dedup_hash");

  // Restoring with the WRONG password must fail without touching the journal.
  page.on("dialog", async (d) => {
    if (d.type() === "prompt") await d.accept("definitely-not-the-password");
    else await d.accept();
  });
  await page.locator('input[type="file"]').setInputFiles(saved);
  await expect(page.getByText(/Could not decrypt backup/i)).toBeVisible({ timeout: 30_000 });
});
