import { test, expect, type Page } from "@playwright/test";
import { gotoImportReady } from "./helpers";

/**
 * v4.7.0 wave C6 — the native read-only pulls (Fyers, Kotak Neo, Nuvama) on
 * the connect card, end to end.
 *
 * Named `z-` so it sorts after import-dashboard.spec.ts (AGENTS.md): it writes
 * broker connection rows through the route and removes them again, so the
 * shared e2e database is left as it was found.
 *
 * NO BROKER HOST IS EVER CONTACTED. The one pull this spec presses is a Fyers
 * pull with no cached token and no paste, which the route answers with 409
 * `needsAuthCode` BEFORE any network call (tests/broker-route-c6.test.ts pins
 * that ordering with fetch stubbed to throw); the Kotak connection is saved
 * and never pulled. The browser-side guard below fails the spec if the page
 * itself requests a broker host (the login link is shown, never followed).
 */

const C6_BROKERS = ["fyers", "kotakneo", "nuvama"] as const;
const BROKER_HOSTS = /fyers\.in|kotaksecurities\.com|nuvamawealth\.com/;
const UNVERIFIED = "documented, not yet verified with a real account"; // PULL_UNVERIFIED_LABEL

const tab = (page: Page, name: RegExp) => page.getByRole("button", { name });
/** The <input> right after its label (Label renders no htmlFor). */
const field = (page: Page, label: string) => page.locator(`label:text-is("${label}") + input`);

interface Conn {
  broker: string;
  accountId: number;
  pullAckCurrent?: boolean;
  unverified?: boolean;
}

async function connections(page: Page): Promise<Conn[]> {
  const res = await page.request.get("/api/import/broker");
  return ((await res.json()) as { connections?: Conn[] }).connections ?? [];
}

async function removeC6Rows(page: Page) {
  for (const c of await connections(page)) {
    if (!(C6_BROKERS as readonly string[]).includes(c.broker)) continue;
    await page.request
      .post("/api/import/broker", { data: { action: "disconnect", broker: c.broker, accountId: c.accountId } })
      .catch(() => null);
  }
}

/** In the All-accounts view with 2+ accounts the save waits on an explicit pick. */
async function pickAccountIfAsked(page: Page) {
  const picker = page.locator("#write-account-accountId");
  if ((await picker.count()) > 0) await picker.selectOption({ index: 1 });
}

test.describe.serial("C6 native pulls — consent, the daily paste, the unverified label", () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await removeC6Rows(page);
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await removeC6Rows(page);
    await page.close();
  });

  /** Broker-host requests the PAGE made during the current test (must stay empty). */
  let brokerRequests: string[] = [];
  test.beforeEach(async ({ page }) => {
    brokerRequests = [];
    page.on("request", (r) => {
      if (BROKER_HOSTS.test(new URL(r.url()).host)) brokerRequests.push(r.url());
    });
  });
  test.afterEach(() => {
    expect(brokerRequests, "the page requested a broker host").toEqual([]);
  });

  test("Fyers: the consent sheet gates the save — the server refuses a save without it, accepts one with it", async ({ page }) => {
    // The server is the control: a save without the shown version is a 409.
    const refused = await page.request.post("/api/import/broker", {
      data: { action: "save", broker: "fyers", apiKey: "E2EAPP-100", apiSecret: "e2e-secret" },
    });
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({ needsConsent: true, version: 1 });
    expect((await connections(page)).filter((c) => c.broker === "fyers")).toHaveLength(0);

    await gotoImportReady(page);
    await tab(page, /^Fyers \(API v3\)/).click();
    await expect(page.getByTestId("pull-unverified")).toHaveText(UNVERIFIED);
    await expect(page.getByTestId("pull-consent")).toBeVisible();
    await expect(page.getByTestId("pull-consent")).toContainText("Before you connect Fyers");

    await pickAccountIfAsked(page);
    await field(page, "App ID").fill("E2EAPP-100");
    await field(page, "App Secret").fill("e2e-secret");
    const save = page.getByRole("button", { name: "Save connection", exact: true });
    // The courtesy: not accepted → the button waits.
    await expect(save).toBeDisabled();
    await page.getByTestId("pull-consent-accept").check();
    await expect(save).toBeEnabled();
    await save.click();

    // Client-restored state: poll the server, then the card (AGENTS.md).
    await expect
      .poll(async () => (await connections(page)).find((c) => c.broker === "fyers")?.pullAckCurrent ?? null, { timeout: 20_000 })
      .toBe(true);
    // Accepted and current → the sheet is gone from the form.
    await expect(page.getByTestId("pull-consent")).toHaveCount(0, { timeout: 20_000 });
  });

  test("Fyers: Pull with no cached token → the paste box with Fyers' login link, answered before any network call", async ({ page }) => {
    // The route's own answer, first: 409 needsAuthCode with the login URL.
    const conn = (await connections(page)).find((c) => c.broker === "fyers");
    expect(conn, "the previous test saved a Fyers connection").toBeDefined();
    const res = await page.request.post("/api/import/broker", {
      data: { action: "pull", broker: "fyers", mode: "preview", accountId: conn!.accountId },
    });
    expect(res.status()).toBe(409);
    const body = (await res.json()) as { needsAuthCode?: boolean; loginUrl?: string };
    expect(body.needsAuthCode).toBe(true);
    expect(new URL(body.loginUrl!).host).toBe("api-t1.fyers.in");
    expect(new URL(body.loginUrl!).searchParams.get("redirect_uri")).toBe("https://127.0.0.1/");

    // …and the card's: the paste dialog, with the link shown, not followed.
    await gotoImportReady(page);
    await tab(page, /^Fyers \(API v3\)/).click();
    const preview = page.getByRole("button", { name: "Preview pull", exact: true });
    await expect(preview).toBeEnabled({ timeout: 20_000 });
    await preview.click();
    await expect(page.getByRole("heading", { name: "Fyers needs today's login" })).toBeVisible();
    await expect(page.getByTestId("login-link").locator("a")).toHaveAttribute("href", /^https:\/\/api-t1\.fyers\.in\/api\/v3\/generate-authcode\?/);
    await expect(page.getByTestId("login-paste")).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("Kotak Neo: saved behind its own consent sheet (and never pulled here)", async ({ page }) => {
    await gotoImportReady(page);
    await tab(page, /^Kotak Neo \(Trade API\)/).click();
    await expect(page.getByTestId("pull-consent")).toContainText("Before you connect Kotak Neo");

    await pickAccountIfAsked(page);
    await field(page, "Trade API access token").fill("e2e-kotak-token");
    await field(page, "Registered mobile number").fill("9999999999");
    await field(page, "UCC (client code)").fill("E2E12");
    await field(page, "MPIN").fill("123456");
    await field(page, "TOTP secret").fill("JBSWY3DPEHPK3PXP");
    const save = page.getByRole("button", { name: "Save connection", exact: true });
    await expect(save).toBeDisabled();
    await page.getByTestId("pull-consent-accept").check();
    await save.click();

    await expect
      .poll(async () => (await connections(page)).find((c) => c.broker === "kotakneo")?.pullAckCurrent ?? null, { timeout: 20_000 })
      .toBe(true);
  });

  test("all three cards carry the unverified label", async ({ page }) => {
    await gotoImportReady(page);
    for (const name of [/^Fyers \(API v3\)/, /^Kotak Neo \(Trade API\)/, /^Nuvama \(APIConnect\)/]) {
      await tab(page, name).click();
      await expect(page.getByTestId("pull-unverified")).toHaveText(UNVERIFIED);
    }
    // …and the older brokers do not.
    await tab(page, /^Dhan \(DhanHQ v2\)/).click();
    await expect(page.getByTestId("pull-unverified")).toHaveCount(0);
  });
});
