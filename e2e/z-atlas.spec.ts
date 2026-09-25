import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { E2E_DB_PATH, gotoHydrated } from "./helpers";

/**
 * `/atlas` v3 in a real browser (v4.6.0 W5: Q51 cohort analytics + Atlas panel v3).
 *
 * WHY THIS FILE EXISTS. The unit tests render the panel statically and pin its
 * copy; what only a browser can settle is the CLIENT half — the per-machine
 * preferences landing after hydration (AGENTS.md: `expect.poll`, never a
 * single assert after `networkidle`), the level and statistic toggles, the
 * index filter's fetch (`GET /api/atlas/view?index=`), and the settings
 * editor echoing the route's 400 inline.
 *
 * ENTITLEMENT. The e2e database is recreated by `e2e/prepare-db.ts` on every
 * run, so `trial_started_at` is NULL and `getEntitlement()` stamps a day-1
 * TRIAL on first read — `pro: true`. Nothing here backdates it (that is
 * `z-live-desk.spec.ts`'s job for the FREE fork); the first test asserts the
 * PANEL rendered, so a locked preview fails loudly instead of skipping.
 *
 * BARS. The seed writes no `price_history`, and an empty Atlas renders only
 * the empty state. `beforeAll` seeds 30 weekday sessions for twelve large-cap
 * symbols straight through the helper's DB handle (the same door
 * `z-live-desk` uses for the trial), tagged `source = 'e2e-atlas'`, and
 * `afterAll` deletes exactly those rows plus the Atlas cache THIS SPEC produced
 * — the `atlas_daily.as_of` keys present before its first /atlas open are
 * recorded in `beforeAll` and left alone, because an earlier spec may have
 * visited /atlas and its rows are not ours to wipe. The suite shares one
 * database, and a later spec must not inherit a market.
 * Weekdays, not calendar sessions: a holiday among them only makes the store
 * hold more than the calendar expects, which the panel states.
 *
 * The `z-` prefix sorts this after `import-dashboard.spec.ts` (AGENTS.md).
 */

const SOURCE = "e2e-atlas";
const SYMBOLS = ["RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "SBIN", "ITC", "LT", "HINDUNILVR", "BHARTIARTL", "WIPRO", "HCLTECH"];
const SESSIONS = 30;

/** The last `n` weekdays (UTC), oldest first, ending two days ago so "today" is never a stored session. */
function weekdaysBack(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 2);
  while (out.length < n) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) out.unshift(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

function withDb<T>(fn: (conn: Database.Database) => T): T {
  const conn = new Database(E2E_DB_PATH);
  try {
    conn.pragma("busy_timeout = 10000");
    return fn(conn);
  } finally {
    conn.close();
  }
}

function seedBars(): void {
  withDb((conn) => {
    const dates = weekdaysBack(SESSIONS);
    const ins = conn.prepare(
      "insert or ignore into price_history (symbol, date, open, high, low, close, volume, source) values (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    conn.transaction(() => {
      SYMBOLS.forEach((symbol, k) => {
        const base = 100 + k * 50;
        const drift = ((k % 3) - 1) * 0.6;
        dates.forEach((date, i) => {
          const close = Number((base + i * drift + Math.sin(i + k)).toFixed(2));
          ins.run(symbol, date, close, close + 1, close - 1, close, 100_000 + i * 1_000 + k * 500, SOURCE);
        });
      });
    })();
  });
}

/** The `atlas_daily.as_of` keys an EARLIER spec left; recorded before this spec's first /atlas open. */
let preExistingAsOf: string[] = [];

function atlasDailyAsOf(): string[] {
  return withDb((conn) => (conn.prepare("select as_of from atlas_daily").all() as { as_of: string }[]).map((r) => r.as_of));
}

function atlasDailyCount(): number {
  return withDb((conn) => (conn.prepare("select count(*) as n from atlas_daily").get() as { n: number }).n);
}

function cleanup(): void {
  withDb((conn) => {
    // Only the rows THIS spec produced: an `as_of` that was not there before.
    const marks = preExistingAsOf.map(() => "?").join(", ");
    const notOurs = preExistingAsOf.length ? ` where as_of not in (${marks})` : "";
    conn.transaction(() => {
      conn.prepare("delete from price_history where source = ?").run(SOURCE);
      conn.prepare(`delete from atlas_metric${notOurs}`).run(...preExistingAsOf);
      conn.prepare(`delete from atlas_staleness${notOurs}`).run(...preExistingAsOf);
      conn.prepare(`delete from atlas_daily${notOurs}`).run(...preExistingAsOf);
    })();
    const left = conn.prepare("select count(*) as n from price_history where source = ?").get(SOURCE) as { n: number };
    expect(left.n, "the seeded bars were NOT removed — later specs would inherit a market").toBe(0);
  });
}

test.beforeAll(() => {
  seedBars();
  preExistingAsOf = atlasDailyAsOf();
});
test.afterAll(() => cleanup());

/** Open /atlas and wait for the PRO panel — the first compute over the seeded bars runs on this request. */
async function openAtlas(page: Page): Promise<void> {
  await gotoHydrated(page, "/atlas");
  await expect(
    page.getByTestId("atlas-panel"),
    "the Pro panel must render; a locked preview means the trial is not live in the e2e database",
  ).toBeVisible({ timeout: 30_000 });
}

test("renders the five tabs and the regime card with its thresholds printed", async ({ page }) => {
  await openAtlas(page);
  for (const key of ["market", "sectors", "cap", "mine", "coverage"]) {
    await expect(page.getByTestId(`atlas-tab-${key}`)).toBeVisible();
  }
  const regime = page.getByTestId("atlas-regime");
  await expect(regime).toContainText(/Regime — (expansion|contraction|neutral|unknown)/);
  const thresholds = page.getByTestId("atlas-regime-thresholds");
  await expect(thresholds).toContainText(/above-SMA50 ≥ \d+%/);
  await expect(thresholds).toContainText(/net high−low > -?\d+/);
  await expect(thresholds).toContainText(/above-SMA50 ≤ \d+%/);
  await expect(regime).toContainText("does not vote");
  // The two footer lines, verbatim, on the screen.
  await expect(page.getByText("Computed from your stored end-of-day bhavcopy. No Chartink data is used.").first()).toBeVisible();
  await expect(page.getByText("Vyuha computes; it does not advise.").first()).toBeVisible();
});

test("the level toggle switches the rotation table and survives a reload", async ({ page }) => {
  await openAtlas(page);
  await page.getByTestId("atlas-tab-sectors").click();
  const table = page.getByTestId("atlas-rotation");
  await expect(table).toHaveAttribute("data-level", "sector");
  await page.getByTestId("atlas-level-toggle").getByRole("button", { name: "Industry" }).click();
  await expect(table).toHaveAttribute("data-level", "industry");
  // The stored value wears the versioned envelope (AQ4).
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("vyuha-atlas-level")))
    .toBe(JSON.stringify({ v: 1, level: "industry" }));
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("vyuha-atlas-tab")))
    .toBe(JSON.stringify({ v: 1, tab: "sectors" }));

  await page.reload();
  await page.waitForLoadState("networkidle");
  // Client-restored state lands AFTER hydration: the default (sector) paints first
  // and the stored choice follows, so this polls rather than asserting once.
  await expect
    .poll(async () => {
      const rows = page.locator('[data-testid="atlas-rotation"]');
      return (await rows.count()) > 0 ? rows.first().getAttribute("data-level") : null;
    }, { timeout: 20_000 })
    .toBe("industry");
});

test("the statistic toggle relabels median → mean, read from the persisted rows", async ({ page }) => {
  await openAtlas(page);
  await page.getByTestId("atlas-tab-sectors").click();
  const table = page.getByTestId("atlas-rotation");
  await expect(table).toHaveAttribute("data-statistic", "median");
  await page.getByTestId("atlas-statistic-toggle").getByRole("button", { name: /Mean/ }).click();
  await expect(table).toHaveAttribute("data-statistic", "mean");
  await expect(table).toContainText("the table is showing the mean now");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("vyuha-atlas-statistic")))
    .toBe(JSON.stringify({ v: 1, statistic: "mean" }));
  // No request went out for the toggle: the mean was already in the payload.
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.getByTestId("atlas-statistic-toggle").getByRole("button", { name: "Median" }).click();
  await expect(table).toHaveAttribute("data-statistic", "median");
  expect(requests.filter((u) => u.includes("/api/atlas"))).toEqual([]);
});

test("the My names tab shows one of its honest states, decided from its own render", async ({ page }) => {
  await openAtlas(page);
  await page.getByTestId("atlas-tab-mine").click();
  const card = page.getByTestId("atlas-my-names");
  await expect(card).toBeVisible();
  // The content is server-rendered with the page, so once the tab is on screen
  // it is final — no fetch to wait for, no count taken early. Three states are
  // honest here and which one shows depends on what earlier specs imported:
  // the dark state (under 21 sessions, "you have N"), no open equity position,
  // or cohort rows with their "n of m priced".
  await expect(card).toContainText(/Needs 21 sessions .* you have \d+|No open equity positions to attribute\.|of \d+ priced/);
  await expect(page.getByTestId("atlas-entry-days")).toBeVisible();
});

test("the index filter fetches /api/atlas/view?index= and the header states the restriction", async ({ page }) => {
  await openAtlas(page);
  await expect(page.getByTestId("atlas-filter-header")).toContainText("the whole stored universe");
  const cachedBefore = atlasDailyCount();
  const responded = page.waitForResponse(
    (r) => r.url().includes("/api/atlas/view?index=") && r.request().method() === "GET",
    { timeout: 30_000 },
  );
  await page.locator("#atlas-index-filter").selectOption("Nifty 50");
  const res = await responded;
  expect(res.status()).toBe(200);
  expect(new URL(res.url()).searchParams.get("index")).toBe("Nifty 50");
  await expect(page.getByTestId("atlas-filter-header")).toContainText(/restricted to Nifty 50 \(\d+ of \d+ priced\)/);
  await expect(page.getByTestId("atlas-panel")).toHaveAttribute("data-filtered", "yes");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("vyuha-atlas-index-filter")))
    .toBe(JSON.stringify({ v: 1, index: "Nifty 50" }));
  // The stored cache did not grow across the filter fetch: the filter is a view
  // over the bars, never a persist (A8). Before/after, not an absolute count —
  // an earlier spec may have visited /atlas and left its own row.
  expect(atlasDailyCount()).toBe(cachedBefore);
});

test("/settings shows the regime editor and echoes the route's 400 inline", async ({ page }) => {
  await gotoHydrated(page, "/settings");
  const editor = page.getByTestId("atlas-regime-editor");
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("Currently the shipped defaults.");
  const contraction = editor.getByTestId("atlas-regime-contractionAboveSma50Ppm");
  await expect(contraction).toHaveValue("40");
  // A contraction ceiling ABOVE the expansion floor: the route refuses with a sentence.
  await contraction.fill("60");
  await editor.getByTestId("atlas-regime-save").click();
  await expect(editor.getByTestId("atlas-regime-error")).toContainText(
    "The contraction ceiling for above-SMA50 must be below the expansion floor, or a market could be both at once.",
  );
  // Nothing was stored: a reload shows the defaults again.
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("atlas-regime-contractionAboveSma50Ppm")).toHaveValue("40");
  await expect(page.getByTestId("atlas-regime-editor")).toContainText("Currently the shipped defaults.");
});
