import { test, expect } from "@playwright/test";
import { ensureTrades } from "./helpers";

/**
 * The lightweight-charts replay on /reports/scaling.
 *
 * `z-` prefixed for the same reason as the other z- specs: the suite shares one
 * database and imports are de-duplicated, so a spec that seeds through
 * `ensureTrades` must not take the first slot away from the import specs.
 *
 * SCOPE — what this can and cannot prove:
 *
 * It proves the route SURVIVES. lightweight-charts touches `document` as soon
 * as a chart is constructed, so it is loaded through `next/dynamic` with
 * `ssr: false`. Get that wrong and the page still builds clean (it is
 * force-dynamic, nothing prerenders) and then 500s on every request — a failure
 * no unit test or `next build` can see.
 *
 * It does NOT prove the chart DRAWS. The series is canvas, and this library
 * renders an invisible line rather than throwing when handed a colour it cannot
 * parse (see docs/DECISIONS.md). Proving paint needs a staged position WITH
 * bhavcopy EOD coverage, which this fixture book does not have — so the honest
 * empty state is an acceptable outcome here, and pixel verification belongs to
 * a book that has the data.
 */
test("reports/scaling: the replay route survives the browser-only chart", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("response", (r) => {
    if (r.url().includes("/reports/scaling") && r.status() >= 500) errors.push(`HTTP ${r.status()}`);
  });

  await ensureTrades(page);
  await page.goto("/reports/scaling");
  await page.waitForLoadState("networkidle");

  // The page itself rendered, not an error boundary.
  await expect(page.getByText(/Visual EOD replay/i)).toBeVisible();

  // Either the chart mounted, or the component said plainly that it has no
  // data. What must NOT happen is a crash, or the dynamic import hanging on its
  // loading skeleton forever.
  const canvas = page.locator("canvas");
  const emptyState = page.getByText(/No staged position has EOD price-history coverage/i);
  await expect
    .poll(async () => (await canvas.count()) > 0 || (await emptyState.count()) > 0, { timeout: 20_000 })
    .toBe(true);

  const stillLoading = await page.getByLabel("Loading chart").count();
  expect(stillLoading, "the dynamic import never resolved").toBe(0);
  expect(errors, "client errors on the replay route").toEqual([]);
});
