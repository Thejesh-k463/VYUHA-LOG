import { test, expect } from "@playwright/test";
import { gotoHydrated } from "./helpers";

/**
 * WS3 — the first-run wizard, end to end.
 *
 * ── The hazard this spec is written around ─────────────────────────────────
 *
 * The Playwright suite shares ONE database for the whole run and no other spec
 * dismisses anything at start-up, so a blocking first-run modal would break
 * many of them. Wave 1 stamped `onboarding_completed_at` in the dev/e2e seed
 * profile precisely so that never happens — the first test below is the assert
 * that it holds.
 *
 * This spec is the only one that opens the wizard, and it puts the flag back
 * whatever happens (afterEach), because `z-onboarding` sorts BEFORE
 * z-replay-chart / z-sidebar-fold / z-surveillance: a mid-spec failure that
 * left the flag NULL would take those three down with it. The restored value is
 * a fresh timestamp rather than the seeded one; nothing anywhere reads that
 * instant — every consumer asks only "is it NULL" (app/layout.tsx,
 * app/api/onboarding/route.ts).
 *
 * `z-` prefixed for the ordering rule in AGENTS.md.
 */

test.afterEach(async ({ page }) => {
  const restored = await page.request.post("/api/onboarding", { data: { action: "complete" } });
  // CHECKED, not fired and forgotten. This is the only restore of the flag in
  // the whole suite; discarding the result means a route that 404s, 500s or
  // quietly changes its action vocabulary leaves `onboarding_completed_at`
  // NULL, and the next four specs alphabetically — z-replay-chart,
  // z-review-desk, z-sidebar-fold, z-surveillance — all run behind a blocking
  // first-run modal, failing on something that is not their own subject.
  expect(
    restored.ok(),
    `restoring onboarding_completed_at failed (HTTP ${restored.status()}); z-replay-chart, ` +
      "z-review-desk, z-sidebar-fold and z-surveillance would run behind the first-run wizard",
  ).toBeTruthy();
});

test("the shared e2e database opens no wizard — every other spec stays unblocked", async ({ page }) => {
  await gotoHydrated(page, "/");
  await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);
  // …and not on the surfaces the other specs actually drive, either.
  await gotoHydrated(page, "/trades");
  await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);
});

test("reset → walk all four steps → complete, resuming across a navigation", async ({ page }) => {
  await gotoHydrated(page, "/");
  const reset = await page.request.post("/api/onboarding", { data: { action: "reset" } });
  expect(reset.ok()).toBeTruthy();

  await gotoHydrated(page, "/");
  await expect(page.getByTestId("onboarding-wizard")).toBeVisible();
  await expect(page.getByTestId("onboarding-step-1")).toBeVisible();

  // Step 1 arrives prefilled from the server, and capital is genuinely
  // optional: nothing is typed here, so the account is left exactly as found
  // (the wizard skips the upsert when nothing changed).
  await expect(page.getByTestId("onboarding-account-name")).not.toHaveValue("");
  await page.getByTestId("onboarding-next").click();
  await expect(page.getByTestId("onboarding-step-2")).toBeVisible();

  // Following one of step 2's own routes must not leave a modal over it…
  await page.getByTestId("onboarding-goto-import").click();
  await page.waitForURL("**/import");
  await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);

  // …and coming back resumes at step 2 rather than starting over. The step is
  // restored by client code after hydration, so this leans on the web-first
  // assertion's retry rather than reading once after networkidle (AGENTS.md:
  // a single assert there reads the default and looks like broken persistence).
  await gotoHydrated(page, "/");
  await expect(page.getByTestId("onboarding-step-2")).toBeVisible();

  await page.getByTestId("onboarding-next").click();
  await expect(page.getByTestId("onboarding-step-3")).toBeVisible();
  // One sentence and a link out — the consent UI is NOT duplicated here.
  await expect(page.getByTestId("onboarding-goto-settings")).toBeVisible();
  await expect(page.getByTestId("onboarding-wizard")).not.toContainText(/disclosure you accept|I accept/i);

  await page.getByTestId("onboarding-next").click();
  await expect(page.getByTestId("onboarding-step-4")).toBeVisible();

  const completed = page.waitForResponse((r) => r.url().includes("/api/onboarding") && r.request().method() === "POST");
  await page.getByTestId("onboarding-next").click();
  await completed;
  await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);

  // Completed stays completed across a reload — the flag, not a React state.
  await gotoHydrated(page, "/");
  await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);
});

test("“Skip for now” completes the flag — a skipped wizard does not return every launch", async ({ page }) => {
  await gotoHydrated(page, "/");
  expect((await page.request.post("/api/onboarding", { data: { action: "reset" } })).ok()).toBeTruthy();

  await gotoHydrated(page, "/");
  await expect(page.getByTestId("onboarding-wizard")).toBeVisible();
  const completed = page.waitForResponse((r) => r.url().includes("/api/onboarding") && r.request().method() === "POST");
  await page.getByTestId("onboarding-skip").click();
  await completed;
  await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);

  await gotoHydrated(page, "/");
  await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);
});

test("Settings can put it back", async ({ page }) => {
  await gotoHydrated(page, "/settings");
  const rerun = page.getByTestId("rerun-setup");
  await expect(rerun).toBeVisible();
  const reset = page.waitForResponse((r) => r.url().includes("/api/onboarding") && r.request().method() === "POST");
  await rerun.click();
  await reset;

  await gotoHydrated(page, "/");
  await expect(page.getByTestId("onboarding-wizard")).toBeVisible();
  await expect(page.getByTestId("onboarding-step-1")).toBeVisible();
});
