import { test, expect } from "@playwright/test";
import path from "node:path";
import { ensureTrades } from "./helpers";

/**
 * The in-app attachment viewer (components/trades/trade-attachments.tsx).
 *
 * `z-` prefixed: this spec seeds the shared database via `ensureTrades`, and
 * whichever spec runs first steals `import-dashboard.spec.ts`'s "Imported 122
 * trades" moment — same rule as every other z- spec.
 *
 * The load-bearing assertion is the LAST one: the viewer is a dialog NESTED
 * inside the edit-trade dialog, and Escape must close only the viewer. Radix
 * guarantees topmost-only Escape — this pins that assumption so a future
 * dialog refactor cannot silently break it.
 */

const PIXEL_A = path.join(process.cwd(), "tests", "fixtures", "pixel-a.png");
const PIXEL_B = path.join(process.cwd(), "tests", "fixtures", "pixel-b.png");

test("attachments: upload, view in-app, navigate, and Escape leaves the edit dialog open", async ({ page }) => {
  await ensureTrades(page);
  await page.goto("/trades");
  await page.waitForLoadState("networkidle");

  // Open the first row's full edit dialog — one of the three mount points.
  // Role + accessible name, not getByTitle: v2.99.70 moved this button onto
  // Radix <Tip> + aria-label, and the title locator hung the click for the
  // full 90 s test timeout (click() has no action timeout of its own).
  await page.getByRole("button", { name: /Edit trade — qty\/prices/ }).first().click();
  const editDialog = page.getByRole("dialog").filter({ hasText: /Edit trade —/ });
  await expect(editDialog).toBeVisible();

  // Upload both fixtures through the real input.
  const input = editDialog.locator('input[type="file"]');
  await input.setInputFiles(PIXEL_A);
  await expect(editDialog.getByTestId("attachment-thumb")).toHaveCount(1, { timeout: 15_000 });
  await input.setInputFiles(PIXEL_B);
  await expect(editDialog.getByTestId("attachment-thumb")).toHaveCount(2, { timeout: 15_000 });

  // Single click opens the in-app viewer — not a new browser tab.
  await editDialog.getByTestId("attachment-thumb").first().click();
  const viewer = page.getByTestId("attachment-viewer");
  await expect(viewer).toBeVisible();
  await expect(viewer.getByTestId("attachment-counter")).toHaveText("1 / 2");
  // Caption carries the file name and a size — provenance, not just pixels.
  await expect(viewer).toContainText("pixel-a.png");
  await expect(viewer).toContainText("KB");

  // Arrow key advances; the buttons clamp at the ends.
  await viewer.press("ArrowRight");
  await expect(viewer.getByTestId("attachment-counter")).toHaveText("2 / 2");
  await expect(viewer).toContainText("pixel-b.png");
  await expect(viewer.getByTestId("attachment-next")).toBeDisabled();
  await viewer.press("ArrowLeft");
  await expect(viewer.getByTestId("attachment-counter")).toHaveText("1 / 2");

  // The old capability survives as a link INSIDE the viewer — assert the
  // href, never click it (a new tab would leak out of the test).
  await expect(viewer.getByTestId("attachment-open-tab")).toHaveAttribute(
    "href",
    /\/api\/trades\/attachments\?id=\d+/,
  );

  // Escape closes ONLY the viewer; the edit dialog stays open underneath.
  await page.keyboard.press("Escape");
  await expect(viewer).not.toBeVisible();
  await expect(editDialog).toBeVisible();

  // Delete from within the viewer: reopen, delete one → the viewer slides to
  // the survivor; delete that → the viewer closes itself on an empty list.
  //
  // Mid-viewer thumbnail counts use PAGE-level locators: while the viewer (a
  // modal) is up, Radix marks everything beneath it aria-hidden, so the edit
  // dialog vanishes from the ROLE tree and `editDialog.getByTestId(...)`
  // resolves 0 even though the thumbnails are right there in the DOM.
  await editDialog.getByTestId("attachment-thumb").first().click();
  await expect(viewer).toBeVisible();
  await viewer.getByTestId("attachment-delete").click();
  await expect(page.getByTestId("attachment-thumb")).toHaveCount(1, { timeout: 15_000 });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByTestId("attachment-counter")).toHaveCount(0);
  await viewer.getByTestId("attachment-delete").click();
  await expect(viewer).not.toBeVisible({ timeout: 15_000 });
  await expect(editDialog).toBeVisible();
  await expect(editDialog.getByTestId("attachment-thumb")).toHaveCount(0);

  // Regression (2026-08-10 audit, lane C): after delete-to-empty, the stale
  // viewer index used to survive — and the NEXT upload satisfied the clamp
  // again, popping the viewer open uninvited. Upload once more and assert the
  // viewer stays closed until a thumbnail is actually clicked.
  await input.setInputFiles(PIXEL_A);
  await expect(editDialog.getByTestId("attachment-thumb")).toHaveCount(1, { timeout: 15_000 });
  await expect(viewer).not.toBeVisible();
});
