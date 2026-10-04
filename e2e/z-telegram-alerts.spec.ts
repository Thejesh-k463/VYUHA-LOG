import { expect, test, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { E2E_DB_PATH, gotoHydrated } from "./helpers";

/**
 * v4.7.0 C5 — Telegram stop/target alerts, the browser half (design D11/D13).
 *
 * WHAT IT COVERS. The Settings card's "Stop / target alerts" section renders
 * beside the digest's status block; a FREE licence shows the Pro line with the
 * switch disabled; the window refuses a start that is not before its end; a
 * Pro switch-ON reaches the server, the root-layout runner POSTs the door, and
 * the card's ONE status line renders the server's reason code; and the
 * re-consent strip shows where Telegram is on with the v1 acknowledgement and
 * stays down after a dismissal.
 *
 * NO TOKEN, NO TELEGRAM. Nothing here saves a real token or reaches
 * api.telegram.org. "Connected" is a fact the PAGE derives from two columns
 * (`telegram_token_enc && telegram_chat_id`), so the spec writes a token cell
 * that is vault-SHAPED but malformed (`venc:` prefix, wrong arity):
 * `readSecret()` (lib/vault.ts) answers "malformed" for it, so every server
 * path that would dial — the digest job, "send test alert", the alert job —
 * finds no readable credential and stops before any network call. A plaintext
 * fake would NOT be safe: `readSecret()` returns plaintext verbatim and a send
 * would dial Telegram with it.
 *
 * STATE. Like `z-live-desk.spec.ts`, the columns no screen can set without a
 * real token (and the expired trial for the free case) are written straight
 * into the database the server is serving from, and EVERY touched column is
 * restored in `afterEach` and read back — the undo is registered before the
 * write, so a throwing test still hands the next spec a clean Telegram row.
 * Constants are hardcoded copies of the app's copy, following
 * `z-sidebar-fold.spec.ts`: no spec pulls app modules through Playwright.
 *
 * `z-` prefix: sorts after `import-dashboard.spec.ts` (AGENTS.md), though it
 * seeds no trades.
 */

/** `TRIAL_DAYS` in `lib/license.ts` — hardcoded copy. */
const TRIAL_DAYS = 7;
/** Vault-shaped, deliberately unreadable (see the header). */
const UNREADABLE_TOKEN = "venc:e2e-not-a-token";
const CHAT_ID = "e2e-chat";

/** Hardcoded copies (components/settings/telegram-card.tsx, telegram-reconsent-strip.tsx). */
const PRO_LINE = "Stop/target alerts are part of Vyuha Pro.";
const NO_CREDENTIALS_LINE = "the bot token and chat id are not both readable on this machine";
const WINDOW_ORDER_ERROR = "The window's start is not before its end.";
const STRIP_LINE = "Telegram digest paused — the disclosure changed.";

const COLUMNS = [
  "telegram_enabled",
  "telegram_ack_version",
  "telegram_token_enc",
  "telegram_chat_id",
  "telegram_alerts_enabled",
  "telegram_alert_from",
  "telegram_alert_to",
  "trial_started_at",
] as const;
type Column = (typeof COLUMNS)[number];

let restore: (() => void) | null = null;

function open(): Database.Database {
  const conn = new Database(E2E_DB_PATH);
  conn.pragma("busy_timeout = 10000");
  return conn;
}

/** Write `values` into the settings row, registering the undo FIRST. */
function seed(values: Partial<Record<Column, string | number | null>>): void {
  const conn = open();
  try {
    const row = conn.prepare(`select id, ${COLUMNS.join(", ")} from settings limit 1`).get() as
      | ({ id: number } & Record<Column, string | number | null>)
      | undefined;
    expect(row, "the e2e database has no settings row").toBeTruthy();
    const { id, ...before } = row!;
    if (!restore) {
      restore = () => {
        const back = open();
        try {
          const sets = COLUMNS.map((c) => `${c} = @${c}`).join(", ");
          back.prepare(`update settings set ${sets} where id = @id`).run({ ...before, id });
          const after = back.prepare(`select ${COLUMNS.join(", ")} from settings where id = ?`).get(id);
          expect(after, "the Telegram row was NOT restored — later specs would inherit it").toEqual(before);
        } finally {
          back.close();
        }
      };
    }
    const keys = Object.keys(values) as Column[];
    const sets = keys.map((c) => `${c} = @${c}`).join(", ");
    conn.prepare(`update settings set ${sets} where id = @id`).run({ ...values, id });
  } finally {
    conn.close();
  }
}

test.afterEach(() => {
  const undo = restore;
  restore = null;
  undo?.();
});

/** Telegram ON, the CURRENT disclosure (2) accepted, "connected" with an unreadable token. */
const CONNECTED = {
  telegram_enabled: 1,
  telegram_ack_version: 2,
  telegram_token_enc: UNREADABLE_TOKEN,
  telegram_chat_id: CHAT_ID,
  telegram_alerts_enabled: 0,
  telegram_alert_from: null,
  telegram_alert_to: null,
};

async function gotoTelegramCard(page: Page) {
  await gotoHydrated(page, "/settings#settings-telegram");
  const card = page.getByTestId("telegram-card");
  await expect(card).toBeVisible();
  return card;
}

test("the card is titled for both paths and the alerts section renders beside the digest's status", async ({ page }) => {
  seed(CONNECTED);
  const card = await gotoTelegramCard(page);
  await expect(page.getByText("Alerts — Telegram", { exact: true })).toBeVisible();
  await expect(card.getByTestId("telegram-status")).toBeVisible();
  const alerts = card.getByTestId("telegram-alerts");
  await expect(alerts).toBeVisible();
  await expect(alerts.getByText("Stop / target alerts")).toBeVisible();
  // R8's fact sits on the card.
  await expect(alerts).toContainText("Upstox and Angel One price equities only");
  // A day-1 trial is Pro: no Pro line, the switch can be turned on.
  await expect(alerts.getByTestId("telegram-alerts-pro")).toHaveCount(0);
  await expect(alerts.getByTestId("telegram-alerts-switch")).toBeEnabled();
});

test("the window refuses a start that is not before its end, and saves a valid one", async ({ page }) => {
  seed(CONNECTED);
  const card = await gotoTelegramCard(page);
  const alerts = card.getByTestId("telegram-alerts");
  await alerts.getByTestId("telegram-alerts-from").fill("14:00");
  await alerts.getByTestId("telegram-alerts-to").fill("10:00");
  await expect(alerts.getByTestId("telegram-alerts-window-error")).toHaveText(WINDOW_ORDER_ERROR);
  await expect(alerts.getByTestId("telegram-alerts-window-save")).toBeDisabled();

  await alerts.getByTestId("telegram-alerts-to").fill("15:00");
  await expect(alerts.getByTestId("telegram-alerts-window-error")).toHaveCount(0);
  await alerts.getByTestId("telegram-alerts-window-save").click();
  // The route's own confirmation, then the stored window survives a reload.
  await expect(page.getByText(/Alerts only between 14:00 and 15:00 IST/)).toBeVisible();
  await page.reload();
  await expect.poll(async () => page.getByTestId("telegram-alerts-from").inputValue()).toBe("14:00");
  await expect(page.getByTestId("telegram-alerts-window-clear")).toBeEnabled();
});

test("Pro: switching alerts ON mounts the runner, and the card's status line renders the server's reason", async ({ page }) => {
  seed(CONNECTED);
  const card = await gotoTelegramCard(page);
  const alerts = card.getByTestId("telegram-alerts");
  const door = page.waitForResponse((r) => r.url().endsWith("/api/telegram/alerts") && r.request().method() === "POST");
  await alerts.getByTestId("telegram-alerts-switch").click();
  // R10: a refusal is a 200, never a 4xx on every page.
  const res = await door;
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, refused: "no-credentials" });
  // The runner's stored code reaches the card's ONE status line.
  await expect.poll(async () => (await alerts.getByTestId("telegram-alerts-status").textContent()) ?? "").toContain(NO_CREDENTIALS_LINE);
});

test("a FREE licence shows the Pro line and cannot switch alerts on", async ({ page }) => {
  const expired = new Date(Date.now() - (TRIAL_DAYS + 3) * 24 * 60 * 60 * 1000).toISOString();
  seed({ ...CONNECTED, trial_started_at: expired });
  const card = await gotoTelegramCard(page);
  const alerts = card.getByTestId("telegram-alerts");
  await expect(alerts).toBeVisible();
  await expect(alerts.getByTestId("telegram-alerts-pro")).toContainText(PRO_LINE);
  await expect(alerts.getByTestId("telegram-alerts-switch")).toBeDisabled();
  // No window form on a free licence.
  await expect(alerts.getByTestId("telegram-alerts-from")).toHaveCount(0);
});

test("the re-consent strip shows for Telegram ON with the v1 acknowledgement, and stays down once dismissed", async ({ page }) => {
  // No token at all: the strip is about the ACK, and nothing can dial.
  seed({ telegram_enabled: 1, telegram_ack_version: 1, telegram_token_enc: null, telegram_chat_id: null, telegram_alerts_enabled: 0 });
  await gotoHydrated(page, "/trades");
  const strip = page.getByTestId("telegram-reconsent-strip");
  // Client-restored state (the dismissal lives in localStorage): poll, never assert once.
  await expect.poll(async () => strip.count()).toBe(1);
  await expect(strip).toContainText(STRIP_LINE);
  await expect(page.getByTestId("telegram-reconsent-link")).toHaveAttribute("href", "/settings#settings-telegram");

  await page.getByTestId("telegram-reconsent-dismiss").click();
  await expect(strip).toHaveCount(0);
  const stored = await page.evaluate(() => localStorage.getItem("vyuha-telegram-reconsent-dismissed"));
  expect(JSON.parse(stored ?? "null")).toEqual({ v: 1, version: 2 });

  // Survives navigation and a reload.
  await gotoHydrated(page, "/");
  await page.waitForTimeout(500);
  await expect.poll(async () => page.getByTestId("telegram-reconsent-strip").count()).toBe(0);
});

test("the strip is absent once the current disclosure is accepted", async ({ page }) => {
  seed({ telegram_enabled: 1, telegram_ack_version: 2, telegram_token_enc: null, telegram_chat_id: null, telegram_alerts_enabled: 0 });
  await gotoHydrated(page, "/trades");
  await page.waitForTimeout(500);
  await expect.poll(async () => page.getByTestId("telegram-reconsent-strip").count()).toBe(0);
});
