import { test, expect, type Page } from "@playwright/test";
import { gotoImportReady } from "./helpers";

/**
 * The relaxed broker-connect save gate, end to end (v3.8 Wave 3, owner
 * rulings 2026-09-04).
 *
 * Named `z-` so it sorts after import-dashboard.spec.ts (AGENTS.md): it
 * writes a broker connection row through the route, and removes it again
 * before it finishes, so the shared e2e database is left as it was found.
 *
 * The scenario is the owner's daily one: a Dhan connection exists, today's
 * token needs re-pasting, the Client ID box is BLANK — and the save must be
 * allowed (the server keeps the stored key), the placeholder must say so in
 * words rather than show a digit string that looks like a filled box, and the
 * row must say HOW it authenticates.
 */

const KEY_KEPT_PLACEHOLDER = "saved — leave blank to keep"; // pinned in tests/broker-connect-copy.test.ts
const DHAN_TAB = /Dhan \(DhanHQ v2\)/;

/** The Client ID box: the <input> right after its label (Label renders no htmlFor). */
const keyBox = (page: Page) => page.locator('label:text-is("Client ID") + input');
const tokenBox = (page: Page) => page.getByPlaceholder("paste after login");

async function removeDhanRow(page: Page) {
  // Idempotent: a missing row is not an error worth failing the spec on.
  await page.request.post("/api/import/broker", { data: { action: "disconnect", broker: "dhan" } }).catch(() => null);
}

async function dhanRows(page: Page): Promise<unknown[]> {
  const res = await page.request.get("/api/import/broker");
  const body = (await res.json()) as { connections?: { broker: string }[] };
  return (body.connections ?? []).filter((c) => c.broker === "dhan");
}

async function openDhanTab(page: Page) {
  await gotoImportReady(page);
  await page.getByRole("button", { name: DHAN_TAB }).click();
  await expect(keyBox(page)).toBeVisible();
}

test.describe.serial("broker connect — the empty Client ID box", () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await removeDhanRow(page);
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await removeDhanRow(page);
    await page.close();
  });

  test("no saved row: the placeholder is the field label and a blank box blocks the save", async ({ page }) => {
    expect(await dhanRows(page)).toHaveLength(0);
    await openDhanTab(page);

    await expect(keyBox(page)).toHaveAttribute("placeholder", "Client ID");
    await expect(keyBox(page)).toHaveValue("");
    // Even with a token pasted, no key + no row = nothing to keep = blocked.
    await tokenBox(page).fill("e2e-fresh-token");
    await expect(page.getByRole("button", { name: "Save connection", exact: true })).toBeDisabled();
    // And no mode pill: there is no connection to describe.
    await expect(page.getByTestId("connection-mode")).toHaveCount(0);
  });

  test("saved row: blank box is allowed, the placeholder says to leave it blank, the row names its mode", async ({ page }) => {
    // Seed through the route (the vault encrypts at rest; the column cannot be
    // written by hand). A non-JWT token reads back as "expiry unknown".
    const res = await page.request.post("/api/import/broker", {
      data: { action: "save", broker: "dhan", apiKey: "1100001234", accessToken: "e2e-pasted-token" },
    });
    expect(res.ok(), await res.text()).toBe(true);
    expect(await dhanRows(page)).toHaveLength(1);

    await openDhanTab(page);

    // Client-restored state: the connection list lands after the card's own
    // fetch, so poll rather than assert once (AGENTS.md).
    await expect.poll(() => keyBox(page).getAttribute("placeholder"), { timeout: 20_000 }).toBe(KEY_KEPT_PLACEHOLDER);
    await expect(keyBox(page)).toHaveValue("");
    await expect(page.getByTestId("connection-mode")).toHaveText(/pasted token · expiry unknown/);

    // The owner's daily flow: paste today's token, leave the Client ID blank.
    await tokenBox(page).fill("e2e-fresh-token");
    const update = page.getByRole("button", { name: "Update connection", exact: true });
    await expect(update).toBeEnabled();

    // The stored key is named as kept, masked — the value never leaves the server.
    await expect(page.getByText(/stored key .* stays unless you type a new one/)).toBeVisible();
  });
});
