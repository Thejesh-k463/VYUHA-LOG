import { test, expect, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { E2E_DB_PATH, ensureTrades, gotoHydrated, gotoImportReady } from "./helpers";

/**
 * `/live` — the POSITIONS tab (v4.7.0 wave C4, design C4-DESIGN-2026-10-04) in a
 * real browser.
 *
 * WHAT IT HOLDS TO ACCOUNT:
 *   - the Charts tab is still the default and still the ONE region labelled
 *     "Open positions" (D3) — `e2e/z-live-desk.spec.ts` locates the desk by it;
 *   - `?tab=positions` keeps the tab across a reload (D1);
 *   - the keyboard (D2): j / k move the Positions focus, Enter opens the card,
 *     Esc closes it, j / k with the card open swap it — and the Charts tab's
 *     window listener does NOTHING meanwhile (the gate this spec proves red);
 *   - free vs Pro (P6, D10): a free card shows locks and the free payload
 *     carries no calculator defaults; an entitled card's calculator prints a
 *     quantity; "Open chart" lands on the Charts tab with that row expanded;
 *   - the Compact and Industry / Sector toggles persist (`useStoredValue` —
 *     asserted with `expect.poll`, AGENTS.md: client-restored state lands after
 *     hydration, never at `networkidle`).
 *
 * THE BOOK is the shared e2e book (`ensureTrades()`, the Dhan fixture's open
 * option positions plus whatever earlier specs imported). Nothing here asserts
 * a figure — only structure, so it holds however much else the suite imported.
 *
 * ENTITLEMENT: the e2e database starts as a day-1 trial (Pro). The free test
 * backdates `settings.trial_started_at` and restores it in `afterEach`, the
 * mechanism `z-live-desk.spec.ts` documents in full.
 *
 * `z-` prefix: this spec seeds via `ensureTrades` and so must sort after
 * `import-dashboard.spec.ts` (AGENTS.md).
 */

const CHARTS = 'div[role="region"][aria-label="Open positions"]';
const CHARTS_ROWS = `${CHARTS} tbody tr[data-row-index]`;
const CHARTS_FOCUSED = `${CHARTS} tbody tr[aria-selected="true"]`;
const POS = 'div[role="region"][aria-label="Positions"]';
const POS_ROWS = `${POS} tbody tr[data-pos-index]`;
const POS_FOCUSED = `${POS} tbody tr[aria-selected="true"]`;
const CARD = '[data-testid="position-card"]';

/** The ProLock chip's title — `components/system/pro-lock.tsx`. */
const LOCK = '[title="Pro — unlock with a licence key"]';

const TRIAL_DAYS = 7;
let restoreTrial: (() => void) | null = null;

/** Expire the trial in the served database; the undo is armed before the write. */
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

test.afterEach(() => {
  restoreTrial?.();
  restoreTrial = null;
});

/** The desk on the Charts tab, its own rows rendered before anything is decided. */
async function gotoCharts(page: Page): Promise<number> {
  await ensureTrades(page);
  await gotoHydrated(page, "/live");
  await expect(page.locator(CHARTS_ROWS).first()).toBeVisible();
  return page.locator(CHARTS_ROWS).count();
}

/** The desk opened straight on the Positions tab, its rows rendered. */
async function gotoPositions(page: Page): Promise<void> {
  await ensureTrades(page);
  await gotoHydrated(page, "/live?tab=positions");
  await expect(page.locator(POS_ROWS).first()).toBeVisible();
}

const tab = (page: Page, name: "Charts" | "Positions") => page.getByRole("tab", { name, exact: true });

/**
 * Open a row's card by clicking its TICKER cell. A bare `row.click()` lands on
 * the row's centre, which on a no-stop row is the stop cell's own Sizing Lab
 * button — a different action, by design.
 */
const clickRow = (row: Locator) => row.locator("td").first().click();

// ---------------------------------------------------------------------------

test("Charts stays the default tab; Positions is one click or one ?tab= away", async ({ page }) => {
  const chartsRows = await gotoCharts(page);
  expect(chartsRows, "the shared book has open positions").toBeGreaterThan(0);

  await expect(tab(page, "Charts")).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, "Positions")).toHaveAttribute("aria-selected", "false");
  // D3 — exactly one region carries the name z-live-desk.spec.ts locates.
  await expect(page.locator(CHARTS)).toHaveCount(1);
  await expect(page.locator(POS)).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("tab")).toBeNull();

  await tab(page, "Positions").click();
  await expect(tab(page, "Positions")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(POS_ROWS).first()).toBeVisible();
  // The same book, one row per position, on both tabs (no filter is set).
  await expect(page.locator(POS_ROWS)).toHaveCount(chartsRows);
  await expect(page.locator(CHARTS), "never two position tables at once").toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get("tab")).toBe("positions");

  // A reload keeps the tab — the URL is the initial state.
  await page.reload();
  await expect(page.locator(POS_ROWS).first()).toBeVisible();
  await expect(tab(page, "Positions")).toHaveAttribute("aria-selected", "true");

  await tab(page, "Charts").click();
  await expect(page.locator(CHARTS_ROWS).first()).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("tab")).toBeNull();
});

test("j / k / Enter / Esc drive the Positions card, and the Charts listener stays quiet", async ({ page }) => {
  await gotoPositions(page);
  const rows = page.locator(POS_ROWS);
  const n = await rows.count();
  test.skip(n < 2, "needs two open positions to prove the card follows j / k");

  // Hand the keyboard to the page body, not to the tab trigger the URL focused.
  await page.locator(POS).focus();

  await page.keyboard.press("j");
  await expect(page.locator(POS_FOCUSED)).toHaveAttribute("data-pos-index", "0");
  await page.keyboard.press("j");
  await expect(page.locator(POS_FOCUSED)).toHaveAttribute("data-pos-index", "1");
  await page.keyboard.press("k");
  await expect(page.locator(POS_FOCUSED)).toHaveAttribute("data-pos-index", "0");

  // Enter opens the card on the FOCUSED row.
  await page.keyboard.press("Enter");
  const card = page.locator(CARD);
  await expect(card).toBeVisible();
  const first = await rows.nth(0).getAttribute("data-trade-id");
  await expect(card).toHaveAttribute("data-trade-id", first!);

  // j with the card open moves the focus behind it AND swaps the card.
  await page.keyboard.press("j");
  await expect(page.locator(POS_FOCUSED)).toHaveAttribute("data-pos-index", "1");
  const second = await rows.nth(1).getAttribute("data-trade-id");
  await expect(card).toHaveAttribute("data-trade-id", second!);

  // Esc closes it.
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);

  // A click opens it too.
  await clickRow(rows.nth(0));
  await expect(card).toHaveAttribute("data-trade-id", first!);
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);

  // D2 — the Charts tab's window listener acted on NONE of those keys: back on
  // Charts no row is focused and no detail pane opened. With the gate removed,
  // the j / k above move the Charts focus too and the Enter expands a row.
  await tab(page, "Charts").click();
  await expect(page.locator(CHARTS_ROWS).first()).toBeVisible();
  await expect(page.locator(CHARTS_FOCUSED), "the Charts listener moved its focus from the Positions tab").toHaveCount(0);
  await expect(page.locator('section[aria-label$=" detail"]'), "the Charts listener expanded a row from the Positions tab").toHaveCount(0);
});

test("a free licence: the card shows locks, and the payload carries no calculator defaults", async ({ page }) => {
  await gotoPositions(page);
  expect(await page.locator(`${POS} ${LOCK}`).count(), "the desk must start ENTITLED").toBe(0);

  expireTrial();
  await page.reload();
  await expect(page.locator(POS_ROWS).first()).toBeVisible();
  await expect(page.locator(`${POS} ${LOCK}`).first(), "an expired trial must render the free wire").toBeVisible();

  // Hiding is not gating (D10): capital and the risk % never reach a free
  // browser. Unescape the RSC string literals first (z-live-desk.spec.ts).
  const payload = (await page.content()).replace(/\\"/g, '"');
  expect(payload, "the calculator's capital default reached a free client").not.toContain('"sizing":{"capitalP"');
  expect(payload, "riskBudgetP reached a free client").not.toContain("riskBudgetP");
  expect(payload, "no sizing field at all — the assertion above proves nothing").toContain('"sizing":null');

  // The Risk lens and the cohort header are locked strips, never empty.
  await expect(page.getByRole("region", { name: "Risk lens" }).locator(LOCK)).toBeVisible();
  await expect(page.getByTestId("positions-cohort").locator(LOCK)).toBeVisible();

  await clickRow(page.locator(POS_ROWS).first());
  const card = page.locator(CARD);
  await expect(card).toBeVisible();
  // The calculator is a lock — no inputs, no quantity (D10).
  const calc = card.getByRole("region", { name: "Size calculator" });
  await expect(calc.locator(LOCK)).toBeVisible();
  await expect(calc.locator("input")).toHaveCount(0);
  await expect(card.getByTestId("calc-qty")).toHaveCount(0);
  // Edit levels is Pro on /live; the facts (levels, the trade record) are free.
  await expect(card.getByRole("button", { name: /Edit levels/ })).toBeDisabled();
  await expect(card.getByRole("link", { name: "Trade record" })).toHaveAttribute("href", /\/trades\?trade=\d+$/);
  // Risk at stop / heat share are locks, not figures.
  expect(await card.locator(LOCK).count()).toBeGreaterThanOrEqual(4);
});

test("an entitled card's calculator prints a quantity, and Open chart lands on that row", async ({ page }) => {
  await gotoPositions(page);
  test.skip((await page.locator(`${POS} ${LOCK}`).count()) > 0, "this install renders the free wire");

  const row = page.locator(POS_ROWS).first();
  const tradeId = await row.getAttribute("data-trade-id");
  await clickRow(row);
  const card = page.locator(CARD);
  await expect(card).toHaveAttribute("data-trade-id", tradeId!);
  const symbol = ((await card.getByRole("heading").first().textContent()) ?? "").trim();
  expect(symbol).not.toBe("");

  // All four inputs are editable locally and written nowhere; with capital and
  // risk unset in the e2e settings, typing them is also what proves the fields
  // are the calculator's, not a read-out.
  const calc = card.getByRole("region", { name: "Size calculator" });
  await calc.getByLabel("Capital ₹").fill("1000000");
  await calc.getByLabel("Risk per trade %").fill("1");
  await calc.getByLabel("Entry ₹").fill("100");
  await calc.getByLabel("Stop ₹").fill("95");
  await expect(calc.getByTestId("calc-qty")).toHaveText(/^[1-9][\d,]*$/);
  await expect(calc.getByText(/riskBudget = floor/)).toBeVisible();

  // A refusal prints the sizing function's own sentence, not a 0.
  await calc.getByLabel("Stop ₹").fill("100");
  await expect(calc.getByText(/risk per share is zero/)).toBeVisible();
  await expect(calc.getByTestId("calc-qty")).toHaveCount(0);

  // Open chart: the Charts tab, that row focused and expanded (D9).
  await card.getByRole("button", { name: "Open chart" }).click();
  await expect(tab(page, "Charts")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(CHARTS_FOCUSED)).toHaveCount(1);
  await expect(page.getByRole("region", { name: `${symbol} detail` })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("tab")).toBeNull();
});

test("Compact rows and the Industry / Sector toggle persist across a reload", async ({ page }) => {
  await gotoPositions(page);
  const compact = page.getByRole("button", { name: "Compact rows" });
  await expect(compact).toHaveAttribute("aria-pressed", "false");
  const tall = (await page.locator(POS_ROWS).first().boundingBox())!.height;
  expect(tall, "the A-style row is tall (≈ 78 px)").toBeGreaterThanOrEqual(70);

  await compact.click();
  await expect(compact).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () => (await page.locator(POS_ROWS).first().boundingBox())?.height ?? 0)
    .toBeLessThanOrEqual(52);

  await page.reload();
  await expect(page.locator(POS_ROWS).first()).toBeVisible();
  await expect.poll(() => page.getByRole("button", { name: "Compact rows" }).getAttribute("aria-pressed")).toBe("true");

  // Industry / Sector is Pro (the cohort header is a lock on free).
  test.skip((await page.locator(`${POS} ${LOCK}`).count()) > 0, "this install renders the free wire");
  const cohort = page.getByTestId("positions-cohort");
  const sector = cohort.getByRole("button", { name: "Sector", exact: true });
  await expect(cohort.getByRole("button", { name: "Industry", exact: true })).toHaveAttribute("aria-pressed", "true");
  await sector.click();
  await expect(sector).toHaveAttribute("aria-pressed", "true");
  await expect(cohort.getByText("Concentration · by sector")).toBeVisible();

  await page.reload();
  await expect(page.locator(POS_ROWS).first()).toBeVisible();
  await expect
    .poll(() => page.getByTestId("positions-cohort").getByRole("button", { name: "Sector", exact: true }).getAttribute("aria-pressed"))
    .toBe("true");
});

// ---------------------------------------------------------------------------
// v4.8.0 P1 — the ledger is a WINDOW: "largest N + Show more".
//
// Measured on the perf book (3,460 open positions): this tab was a 12.1 MB
// document with 3,462 <tr>. It now renders the first WINDOW_STEP (150) rows of
// the deployed-₹ order, says "Showing 150 of N", and widens on Show more or
// when j / k step past the last shown row.
//
// THE BOOK IS ITS OWN, AND UNDONE — the mechanism `z-live-desk.spec.ts`
// documents beside `seedWindowedBook`: a scratch ACCOUNT, the desk pointed at
// it, the positions imported through the real /import path, and in `afterEach`
// the selection put back and the account PURGED. `ensureTrades` is NOT called
// once the scratch account is selected — it would import the shared fixture
// into it.
// ---------------------------------------------------------------------------

/** `WINDOW_STEP` in `components/ui/show-more.tsx`. */
const WINDOW_STEP = 150;
/** One step plus ten: a first window, ten rows held back. */
const BOOK_ROWS = WINDOW_STEP + 10;
const SCRATCH_ACCOUNT = "E2E Positions Window";

/** Set by `seedPositionsBook`, run by the `afterEach` below. */
let restoreBook: (() => Promise<void>) | null = null;

test.afterEach(async () => {
  const undo = restoreBook;
  restoreBook = null;
  await undo?.();
});

/**
 * A Dhan P&L export with `BOOK_ROWS` OPEN positions (the fixture's shape: the
 * `PnL report` title line names the broker, Buy Qty > Sell Qty makes a row
 * open). Row i buys 100 at ₹(100 + i), so DEPLOYED rupees are distinct and
 * ascending in i: the tab's deployed-descending order is total, and position 0
 * is `E2EPOS160`.
 */
function positionsCsv(dir: string): string {
  const body = Array.from({ length: BOOK_ROWS }, (_, i) => {
    const qty = 100;
    const buy = 100 + i;
    const close = buy + 10;
    const unreal = (close - buy) * qty;
    return `"E2EPOS${String(i + 1).padStart(3, "0")}","${qty}","${buy}.00","${(buy * qty).toFixed(2)}","0","0.00","0.00","${close}.00","0.00","0.00","${unreal.toFixed(2)}","10.00"`;
  });
  const file = path.join(dir, "dhan-positions-window-e2e.csv");
  fs.writeFileSync(
    file,
    [
      "PnL report,From 01-06-2026 to 17-06-2026",
      "Name,REDACTED NAME",
      "UCC,UCC0000000",
      "Scrip Name,Buy Qty.,Avg. Buy Price,Buy Value,Sell Qty.,Avg. Sell Price,Sell Value,Closing Price,Realised P&L,Realised P&L %,Unrealised P&L,Unrealised P&L %",
      ...body,
      "",
      "Net P&L,0.00,Brokerage,0.00,Gross P&L,0.00,Total Charges,0.00",
      "",
      "NOTE : This sheet was downloaded at 6/17/2026 01:16 AM",
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

/** The symbol at position `index` of the deployed-descending order. */
const symbolAt = (index: number) => `E2EPOS${String(BOOK_ROWS - index).padStart(3, "0")}`;

async function selectAccount(page: Page, id: number): Promise<void> {
  const res = await page.request.post("/api/accounts", { data: { action: "select", id } });
  expect(res.ok(), `selecting account ${id}`).toBeTruthy();
}

/** Create the scratch account, point the desk at it, fill it, and arm the undo. */
async function seedPositionsBook(page: Page): Promise<void> {
  await gotoHydrated(page, "/live");
  const switcher = page.getByLabel("Portfolio account");
  await expect(switcher, "the sidebar account switcher is how the selection is put back").toBeVisible();
  const previous = Number(await switcher.inputValue());

  const created = await page.request.post("/api/accounts", { data: { action: "upsert", name: SCRATCH_ACCOUNT } });
  expect(created.ok(), "creating the scratch account").toBeTruthy();
  const scratchId = ((await created.json()) as { id?: number }).id ?? 0;
  expect(scratchId, "the accounts API returned no id").toBeGreaterThan(0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyuha-e2e-positions-"));
  // Armed BEFORE the selection moves: any failure from here still puts the
  // journal back where the rest of the suite expects it.
  restoreBook = async () => {
    await selectAccount(page, previous);
    const purged = await page.request.post("/api/accounts", {
      data: { action: "delete", id: scratchId, mode: "purge", connections: "delete" },
    });
    expect(purged.ok(), "purging the scratch account").toBeTruthy();
    fs.rmSync(dir, { recursive: true, force: true });
  };

  await selectAccount(page, scratchId);
  await gotoImportReady(page);
  await page.locator('input[type="file"]').setInputFiles(positionsCsv(dir));
  const commit = page.getByRole("button", { name: /Commit\s+\d+\s+new trade/i });
  await expect(commit, "the generated Dhan P&L was not detected").toBeEnabled({ timeout: 30_000 });
  await commit.click();
  await expect(page.getByText(/Imported\s+\d+\s+trade/i)).toBeVisible({ timeout: 30_000 });
}

test("a book past one window: 150 rows and a stated note, j / k cross the edge, Show more shows the rest", async ({ page }) => {
  await seedPositionsBook(page);
  await gotoHydrated(page, "/live?tab=positions");
  const rows = page.locator(POS_ROWS);
  await expect(rows.first()).toBeVisible();

  const region = page.locator(POS);
  const note = region.getByText(`Showing ${WINDOW_STEP} of ${BOOK_ROWS} positions, largest deployed first.`);
  const showMore = region.getByRole("button", { name: `Show ${BOOK_ROWS - WINDOW_STEP} more` });

  // ── the first window: the LARGEST positions, and the note says what is held back ──
  await expect(rows).toHaveCount(WINDOW_STEP);
  await expect(note).toBeVisible();
  await expect(showMore).toBeVisible();
  await expect(rows.first(), "the window is not the largest positions").toContainText(symbolAt(0));
  await expect(rows.last()).toContainText(symbolAt(WINDOW_STEP - 1));
  // The Book row counts the BOOK, not the window.
  await expect(region.locator("tfoot")).toContainText(`${BOOK_ROWS} open`);

  // ── j / k: the window's edge is not the book's ───────────────────────────
  await region.focus();
  // k with nothing focused is the last row SHOWN — it does not mount the book.
  await page.keyboard.press("k");
  await expect(page.locator(POS_FOCUSED)).toHaveAttribute("data-pos-index", String(WINDOW_STEP - 1));
  await expect(rows).toHaveCount(WINDOW_STEP);

  // j on the last shown row is never a dead key: the window widens to hold the
  // row it moved to, and that row is scrolled into view once it exists.
  await page.keyboard.press("j");
  await expect(page.locator(POS_FOCUSED), "j past the last shown row moved nothing").toHaveAttribute("data-pos-index", String(WINDOW_STEP));
  await expect(page.locator(POS_FOCUSED)).toContainText(symbolAt(WINDOW_STEP));
  await expect(rows).toHaveCount(BOOK_ROWS);
  await expect(note, "the whole book is shown — the note must go").toHaveCount(0);
  await expect(page.locator(POS_FOCUSED), "the row j moved to was never scrolled into view").toBeInViewport();

  // Enter opens the card on that row — a row the first window did not hold.
  await page.keyboard.press("Enter");
  const card = page.locator(CARD);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-trade-id", (await page.locator(POS_FOCUSED).getAttribute("data-trade-id"))!);
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);

  // k back across the edge: the focus returns and the window does NOT shrink under it.
  await page.keyboard.press("k");
  await expect(page.locator(POS_FOCUSED)).toHaveAttribute("data-pos-index", String(WINDOW_STEP - 1));
  await expect(rows).toHaveCount(BOOK_ROWS);

  // ── Show more: the window is a render window, not a preference — a reload resets it ──
  await page.reload();
  await expect(rows.first()).toBeVisible();
  await expect(rows).toHaveCount(WINDOW_STEP);
  await expect(note).toBeVisible();
  await showMore.click();
  await expect(rows).toHaveCount(BOOK_ROWS);
  await expect(note).toHaveCount(0);
  await expect(showMore).toHaveCount(0);
  await expect(rows.last()).toContainText(symbolAt(BOOK_ROWS - 1));
});
