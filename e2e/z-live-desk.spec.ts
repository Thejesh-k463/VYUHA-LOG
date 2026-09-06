import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { E2E_DB_PATH, ensureTrades, gotoHydrated, gotoImportReady } from "./helpers";

/**
 * `/live` — the Live Desk in a real browser (v4.0 shipped with none).
 *
 * WHY THIS FILE EXISTS. v4.0's keyboard-scroll fix was wrong TWICE and nothing
 * caught it: the unit tests cover `deskAction`/`nextIndex` (pure) and the
 * source guards cover the copy, but "the focused row is actually visible" is a
 * statement about layout — sticky <thead>, a `max-h-[60vh]` scroll box and a
 * virtualiser's `scrollMargin` — which only a browser can settle. Test 2 below
 * is that assertion, made with `boundingBox()` against the header and the box.
 * The second class it must catch is spec drift of the kind the sidebar-fold
 * spec surfaced a day late, so every locator here is the one the component
 * actually renders (`aria-selected`, `data-row-index`, `role=region`).
 *
 * WHAT THE SEED PROVIDES. `lib/db/seed-core.ts` writes settings, capital,
 * charge and risk config and ONE account — no trades at all. The book comes
 * from `ensureTrades()` (the Dhan P&L fixture, shared across the run and
 * de-duplicated), whose 122 rows include exactly SIX open positions, all
 * options, each with a non-zero Closing Price and no stored MTM row — so their
 * mark is the journal's own close, `staleness: "eod"` with a null `asOf`, and
 * the chip reads "End of day" with NO date after it.
 *
 * WHAT THE REST OF THE SUITE ADDS. The run shares ONE database and this file
 * sorts 20th of 29, so the book it sees is not the book it seeded:
 * `z-dhan-gtr.spec.ts` commits a 79-row Global Transaction Report — a
 * TRADEBOOK, which has no Closing Price column — and `staged-position.spec.ts`
 * books exits that close one of the six P&L positions. The desk therefore
 * carries open positions with no mark at all (`markP: null`, `staleness:
 * null`), which sort LAST under the default `unrealisedP` DESC order.
 * Asserting `toBe("End of day")` on every row was true only when this file ran
 * ALONE; in the full suite row 5 reads "No mark stored for this position yet."
 * and CI was red on ubuntu and macOS for it (run 34023883519). What is asserted
 * now is what holds however much anyone else has imported: every chip is
 * something `stalenessLabel()` can return, NO chip carries a date — nothing
 * this database can reach supplies an `asOf`, since the quote provider finds no
 * bhavcopy and no spec writes `mtm_prices` — and at least one row still reads
 * the bare "End of day", so the journal's-own-close path cannot quietly stop
 * being exercised. Constants below are hardcoded copies of
 * `components/live/desk-copy.ts`, following `z-sidebar-fold.spec.ts`: no spec
 * pulls app modules through Playwright's transform.
 *
 * ENTITLEMENT. The e2e database is recreated by `e2e/prepare-db.ts` on every
 * run, so `trial_started_at` is NULL and `getEntitlement()` stamps it on its
 * first read — a day-1 TRIAL, i.e. `pro: true`. The FREE half of that fork is
 * unreachable through the app on purpose: no route handler and no screen can
 * expire a trial. So the free test backdates that one column in the e2e
 * database, reloads, and puts it back in `afterEach` — `getEntitlement()` is
 * `cache()`d per REQUEST and re-reads the column on every render, so one
 * reload is the whole mechanism and one restore is the whole undo. Licence
 * state is never flipped globally, and the Pro test above it keeps its
 * `test.skip` guard as the second line of defence.
 *
 * `z-` prefix: this spec seeds via `ensureTrades` and so must sort after
 * `import-dashboard.spec.ts` (AGENTS.md).
 */

/** The scrolling box that owns the sticky header — `tracker-client.tsx`. */
const DESK = 'div[role="region"][aria-label="Open positions"]';
const ROWS = `${DESK} tbody tr[data-row-index]`;
const FOCUSED = `${DESK} tbody tr[aria-selected="true"]`;

/** The ProLock chip's title — `components/system/pro-lock.tsx`. */
const LOCK = '[title="Pro — unlock with a licence key"]';

/** Every label `stalenessLabel()` can return, and nothing else. */
const MARK_LABELS = /^(End of day|Stored mark|Delayed|Last traded|No mark stored for this position yet\.)/;

/** The ` · <asOf>` half of `stalenessLabel()` — a claim of provenance. */
const DATED_MARK = /·\s*\S/;

/** Sub-pixel slack: layout boxes are fractional, the assertion is not about that. */
const TOL = 1;

async function gotoDesk(page: Page): Promise<void> {
  await ensureTrades(page);
  await gotoHydrated(page, "/live");
  await expect(page.locator(ROWS).first()).toBeVisible();
}

/** True when this install renders the free wire (a lock where a figure goes). */
async function isFree(page: Page): Promise<boolean> {
  return (await page.locator(`${DESK} tbody ${LOCK}`).count()) > 0;
}

/**
 * Give ONE open position a trailing stop, and report which one.
 *
 * The Sizing Lab hand-off is refused without a stop (`seedFromParams` returns
 * the sample when `stop` is missing or equals the entry), and "Risk at stop"
 * is an em dash without one — so the two tests that need a stop have to create
 * it rather than hope for it. It is created THROUGH THE APP: a partial POST to
 * `/api/positions/risk`, which writes `trailing_sl` and nothing else (the
 * route only writes the fields present in the body, and `riskAmount` is
 * recomputed from `slPlanned`, which stays null). One trade, one column — the
 * smallest footprint that still exercises the real write path, so no other
 * spec's numbers move.
 *
 * Idempotent: the same value is written on every call.
 */
async function ensureTrailingStop(page: Page): Promise<{ symbol: string; side: "long" | "short"; stopP: number }> {
  const res = await page.request.get("/api/trades/page?view=open");
  expect(res.ok(), "open-trades page API").toBeTruthy();
  const body = (await res.json()) as {
    rows: { id: number; symbol: string; buyQty: number; sellQty: number; avgBuyPrice: number; avgSellPrice: number }[];
  };
  const t = body.rows.find((r) => r.buyQty > r.sellQty);
  expect(t, "the fixture has no long open position to put a stop on").toBeTruthy();
  const row = t!;

  // 10% under the entry for a long. NOT breakeven: `entry === stop` is exactly
  // the case the Lab rejects as unusable, so a breakeven stop would send the
  // hand-off back to the sample and the test would pass for the wrong reason.
  const stopRupees = Math.round(row.avgBuyPrice * 0.9 * 100) / 100;
  const saved = await page.request.post("/api/positions/risk", {
    data: { tradeId: row.id, trailingSl: stopRupees },
  });
  expect(saved.ok(), "saving the trailing stop").toBeTruthy();

  return { symbol: row.symbol, side: "long", stopP: Math.round(stopRupees * 100) };
}

/** Narrow the desk to one symbol and hand focus back to the table. */
async function filterTo(page: Page, symbol: string): Promise<void> {
  await page.getByLabel("Filter the desk by symbol").fill(symbol);
  // Escape is the ONE key that survives a typing target (`desk-keys.ts`): it
  // blurs the filter and focuses the scroll box, which is what makes j/k live
  // again. Without it every following keystroke belongs to the input.
  await page.keyboard.press("Escape");
  await expect(page.locator(ROWS)).toHaveCount(1);
}

/**
 * The geometry the two wrong fixes got wrong, stated once.
 *
 * The <thead> is `sticky top-0` INSIDE the scroll box, so the top band of that
 * box is permanently covered: a row parked there is invisible even though
 * `scrollIntoView({block:"nearest"})` and the virtualiser's `align:"auto"`
 * both consider it in view. The two failure shapes seen in v4.0 were a row top
 * landing one whole header BELOW the header (2× header height) and a row whose
 * bottom was clipped by the box. Both are caught here.
 */
async function expectFocusedRowFullyVisible(page: Page, when: string): Promise<void> {
  const focused = page.locator(FOCUSED);
  await expect(focused, `${when}: exactly one row is focused`).toHaveCount(1);

  await expect
    .poll(async () => {
      const row = await focused.boundingBox();
      const head = await page.locator(`${DESK} thead`).boundingBox();
      if (!row || !head) return null;
      // > 0 means the row starts below the header's bottom edge; < 0 means the
      // header is covering it.
      return row.y - (head.y + head.height);
    }, { message: `${when}: the focused row's top must clear the sticky header` })
    .toBeGreaterThanOrEqual(-TOL);

  await expect
    .poll(async () => {
      const row = await focused.boundingBox();
      const box = await page.locator(DESK).boundingBox();
      if (!row || !box) return null;
      // > 0 means the row's bottom is above the box's bottom edge.
      return box.y + box.height - (row.y + row.height);
    }, { message: `${when}: the focused row's bottom must be inside the scroll box` })
    .toBeGreaterThanOrEqual(-TOL);
}

/** `TRIAL_DAYS` in `lib/license.ts` — hardcoded copy, same rule as the copy above. */
const TRIAL_DAYS = 7;

/** Set by `expireTrial()`, run by the `afterEach` below, and only ever null otherwise. */
let restoreTrial: (() => void) | null = null;

/**
 * Expire the Pro trial in the database the server is serving from.
 *
 * The free wire has no other door: `getEntitlement()` stamps `trial_started_at`
 * on the first read of a fresh install and NOTHING in the product can move it
 * — no route handler, no screen, deliberately (it is security state, and
 * `settings-baseline.ts` even keeps it out of restore). A second Playwright
 * project with its own database and its own dev server would cost a second
 * Next server for the whole run to assert one payload; this costs one UPDATE
 * and one reload, because the entitlement is `cache()`d per REQUEST and read
 * fresh on every render.
 *
 * The undo is registered BEFORE the write is visible to anyone, so a test that
 * throws mid-way still hands the next spec the trial it expects.
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
        // Read it BACK. A restore that silently did not happen would leave every
        // later spec on a free licence, and the first symptom would be a Pro
        // assertion failing three spec files away.
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

/**
 * Both undos, unconditionally: a test that throws between a write and its
 * assertions must not hand the NEXT spec file an expired trial or a journal
 * pointed at a scratch account. `restoreBook` is declared beside the test that
 * arms it, at the foot of this file.
 */
test.afterEach(async () => {
  restoreTrial?.();
  restoreTrial = null;
  const undoBook = restoreBook;
  restoreBook = null;
  if (undoBook) await undoBook();
});

// ---------------------------------------------------------------------------

test("the desk renders the open book, the market clock and a real mark label", async ({ page }) => {
  await gotoDesk(page);

  // The sidebar clock — the same signal `gotoHydrated` gates on, asserted here
  // as a fact about the screen rather than as a side effect of navigation.
  await expect(page.locator("aside").getByText(/\d{2}:\d{2} IST/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Live Desk" })).toBeVisible();

  const rows = page.locator(ROWS);
  const n = await rows.count();
  expect(n, "the Dhan fixture's open positions").toBeGreaterThan(0);

  // Every row carries its account (Q19: "account id on every row").
  for (const value of await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-account-id")))) {
    expect(value, "a desk row with no account id").toMatch(/^\d+$/);
  }

  // The account FILTER is rendered only when the book spans more than one
  // account (`accountIds.length > 1`), and the seed creates exactly one. Assert
  // whichever is true of the database as it stands, so this reddens if the chip
  // group ever stops appearing for a multi-account book.
  const accounts = new Set(
    await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-account-id"))),
  );
  const accountFilter = page.getByRole("group", { name: "Filter by account" });
  if (accounts.size > 1) {
    await expect(accountFilter).toBeVisible();
    await expect(accountFilter.getByRole("button", { name: "All accounts" })).toBeVisible();
  } else {
    await expect(accountFilter, "one account seeded — no account chips to offer").toHaveCount(0);
  }
  // The symbol filter is unconditional.
  await expect(page.getByLabel("Filter the desk by symbol")).toBeVisible();

  // The mark chip says one of the things `stalenessLabel()` can say — never an
  // invented word, never a bare number.
  let fromTheJournalsClose = 0;
  for (let i = 0; i < n; i++) {
    // `textContent`, not `innerText`: the chip is a `Badge size="xs"`, which is
    // CSS-uppercased, and `innerText` returns "END OF DAY" — the transform, not
    // the copy. What is under test is the string `desk-copy.ts` exports.
    const chip = rows.nth(i).locator("td").nth(4).locator("span.inline-flex > div").first();
    await expect(chip, `row ${i} has no mark chip`).toBeVisible();
    const label = ((await chip.textContent()) ?? "").trim();
    expect(label, `row ${i} mark chip`).toMatch(MARK_LABELS);
    // NOTHING in this database can supply an `asOf`: no spec writes
    // `mtm_prices`, and the end-of-day provider finds no bhavcopy — so every
    // mark is either the journal's own Closing Price (staleness "eod", null
    // asOf) or absent. A date here would mean the chip started claiming a
    // provenance the store cannot support. See the header for why this is
    // NOT `toBe("End of day")` per row.
    expect(label, `row ${i} mark chip carries a date`).not.toMatch(DATED_MARK);
    if (label === "End of day") fromTheJournalsClose++;
  }
  // …and the eod path is genuinely exercised, whatever else the suite imported:
  // the six P&L positions carry a Closing Price and nothing removes it.
  expect(fromTheJournalsClose, "no row's mark came from the journal's own close").toBeGreaterThan(0);
});

test("j and k keep the focused row clear of the sticky header and inside the box", async ({ page }) => {
  // A SHORT viewport, not more rows. The desk windows only past 40 positions
  // (VIRTUAL_THRESHOLD) and the fixture has six, so the honest way to make the
  // `max-h-[60vh]` box overflow is to shrink 60vh under the table's height —
  // which exercises the un-windowed j/k path, the one whose by-hand header
  // correction was written twice.
  await page.setViewportSize({ width: 1280, height: 420 });
  await gotoDesk(page);

  const rows = page.locator(ROWS);
  const n = await rows.count();
  const overflow = await page.locator(DESK).evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(overflow, "the desk box must actually scroll or this test proves nothing").toBeGreaterThan(0);

  // Down to the last row: clamped, never wrapping (`nextIndex`).
  for (let i = 0; i < n; i++) await page.keyboard.press("j");
  await expect(page.locator(FOCUSED)).toHaveAttribute("data-row-index", String(n - 1));
  await expectFocusedRowFullyVisible(page, "after j to the last row");

  // …and back to the first, which is the direction that used to park the row
  // underneath the header.
  for (let i = 0; i < n - 1; i++) await page.keyboard.press("k");
  await expect(page.locator(FOCUSED)).toHaveAttribute("data-row-index", "0");
  await expectFocusedRowFullyVisible(page, "after k back to the first row");
});

test("an entitled desk prints the Pro figures instead of a lock", async ({ page }) => {
  await gotoDesk(page);
  test.skip(await isFree(page), "this install renders the free wire — the Pro half is asserted by the free test");

  const { symbol } = await ensureTrailingStop(page);
  await page.reload();
  await expect(page.locator(ROWS).first()).toBeVisible();
  await filterTo(page, symbol);

  const row = page.locator(ROWS).first();
  // Risk at stop / Open R / % of capital — the three Pro columns, in order.
  await expect(row.locator(LOCK), "an entitled row must carry no lock").toHaveCount(0);
  await expect(row.locator("td").nth(9), "Risk at stop").toHaveText(/\d/);
  await expect(row.locator("td").nth(10), "Open R").toHaveText(/\d|—/);
  await expect(row.locator("td").nth(11), "% of capital").toHaveText(/\d/);
  // Portfolio heat is the panel-level half of the same entitlement.
  await expect(page.getByText("Portfolio heat")).toBeVisible();
  await expect(page.getByText(/Pro — R, risk at stop/)).toHaveCount(0);
});

test("a free licence ships no Pro figures in the payload", async ({ page }) => {
  await gotoDesk(page);
  expect(await isFree(page), "the desk must start ENTITLED — see ENTITLEMENT in the header").toBe(false);

  expireTrial();
  await page.reload();
  await expect(page.locator(ROWS).first()).toBeVisible();
  expect(await isFree(page), "an expired trial must render the free wire").toBe(true);

  // Hiding is not gating: the SERVER must not compute the Pro figures at all,
  // so neither the sizing tree's numbers nor its "ok" shape may appear in what
  // the browser received.
  //
  // UNESCAPE FIRST. The RSC payload reaches the DOM inside
  // `self.__next_f.push([1,"…"])` string literals, where every quote is
  // backslash-escaped — so `toContain('"kind":"ok"')` against raw
  // `page.content()` can never match and would pass on an ungated payload too.
  const payload = (await page.content()).replace(/\\"/g, '"');
  expect(payload, "riskBudgetP reached the client on a free licence").not.toContain("riskBudgetP");
  expect(payload, "an ungated stop object reached the client").not.toContain('"kind":"ok"');
  // …and the gated shape IS there, so the two assertions above are about a
  // stop that was computed and withheld, not about a payload with no stops.
  expect(payload, "no gated stop in the payload — the assertions above prove nothing").toContain('"kind":"gated"');

  // The core journal is never gated (invariant 7): symbol, quantity and mark
  // are the user's own record and stay on screen.
  const row = page.locator(ROWS).first();
  await expect(row.locator("td").nth(0), "symbol").toHaveText(/\S/);
  await expect(row.locator("td").nth(2), "quantity").toHaveText(/\d/);
  await expect(row.locator("td").nth(4), "mark").toHaveText(/\d/);
  // The three Pro columns are locks, not figures — and never a 0 or an em dash,
  // which mean "cannot be computed" rather than "not yours yet".
  for (const [cell, label] of [[9, "Risk at stop"], [10, "Open R"], [11, "% of capital"]] as const) {
    await expect(row.locator("td").nth(cell).locator(LOCK), `${label} must be locked`).toBeVisible();
  }
  // Portfolio heat is the panel-level half of the same entitlement.
  await expect(page.getByText(/Pro — R, risk at stop/).first()).toBeVisible();
});

test("expanding a row and opening the Sizing Lab carries the side", async ({ page }) => {
  const { symbol, side, stopP } = await ensureTrailingStop(page);
  await gotoDesk(page);
  await filterTo(page, symbol);

  // Enter expands the FOCUSED row, so j first — the hand-off is a keyboard
  // path as much as a click one.
  await page.keyboard.press("j");
  await expect(page.locator(FOCUSED)).toHaveCount(1);
  const rowSide = (await page.locator(FOCUSED).locator("td").first().innerText()).includes("short") ? "short" : "long";
  expect(rowSide, "the row's own side label").toBe(side);
  await page.keyboard.press("Enter");

  const detail = page.getByRole("region", { name: `${symbol} detail` });
  await expect(detail).toBeVisible();
  await detail.getByRole("button", { name: "Open the Sizing Lab" }).click();

  await page.waitForURL(/\/sizing-lab\?/);
  const url = new URL(page.url());
  // `side` travels EXPLICITLY: the Lab used to infer it from the levels, which
  // reads a long whose stop was trailed as a short.
  expect(url.searchParams.get("side"), "side on the hand-off").toBe(side);
  expect(url.searchParams.get("symbol")).toBe(symbol);
  expect(url.searchParams.get("stop"), "the stop the row is carrying").toBe(String(stopP));
  expect(url.searchParams.get("from")).toBe("live");

  // And the Lab opened on the POSITION, not on its sample setup.
  await expect(page.getByText(`Opened on your ${symbol} position from the Live Desk`, { exact: false })).toBeVisible();
  await expect(page.getByText(/Opens on a sample swing trade/)).toHaveCount(0);
});

/**
 * ── The WINDOWED half of the same geometry ──────────────────────────────────
 *
 * The test above runs the un-windowed path: six positions in a short viewport,
 * where the focused row is always mounted and `scrollIntoView({block:"nearest"})`
 * plus a by-hand header correction is what moves the box. Past
 * VIRTUAL_THRESHOLD (40, `tracker-client.tsx`) the desk hands the job to
 * `virtualizer.scrollToIndex` instead, and the row j is moving TO is not in the
 * DOM at all — a completely different code path, with its own `scrollMargin` /
 * `scrollPaddingStart` correction that the same two wrong fixes would have
 * broken the same way. Nothing exercised it in a browser until now.
 *
 * SEEDING IS ACCOUNT-SCOPED AND UNDONE. The fixture has six open positions and
 * the run shares one database, so this test makes its own book: a scratch
 * ACCOUNT (created through `/api/accounts`), the desk pointed at it, 45 open
 * positions imported through the real `/import` path — the same door
 * `ensureTrades` uses, never SQL into `trades` — and then, in `afterEach`, the
 * selection put back and the account PURGED, which is the app's own
 * "everything this account owns" delete. Every later spec sees the book it saw
 * before, and the desk this test drives holds nothing but its own 45 rows.
 */

/** > VIRTUAL_THRESHOLD (40) in `components/live/tracker-client.tsx`. */
const WINDOW_ROWS = 45;
const SCRATCH_ACCOUNT = "E2E Desk Window";

/** Set by `seedWindowedBook`, run by the `afterEach` above. */
let restoreBook: (() => Promise<void>) | null = null;

/**
 * A Dhan P&L export with `WINDOW_ROWS` OPEN positions, written to a temp dir.
 *
 * The shape is the fixture's: the `PnL report` title line, the twelve-column
 * header and the `Net P&L` footer, which is what `detectDhanCsv` scores — the
 * broker is named by the file's own title, not by its name, so this is
 * detected exactly the way a real export is. Buy Qty > Sell Qty makes each row
 * an open position, and a non-zero Closing Price gives each one an end-of-day
 * mark, so the rows sort deterministically by unrealised P&L.
 */
function windowedCsv(dir: string): string {
  const body = Array.from({ length: WINDOW_ROWS }, (_, i) => {
    const qty = 100;
    const buy = 100 + i;
    // A DIFFERENT gain per row, so the default `unrealisedP` DESC sort has a
    // total order and `data-row-index` means the same thing on every run.
    const close = buy + 10 + i;
    const unreal = (close - buy) * qty;
    return `"E2EWIN${String(i + 1).padStart(2, "0")}","${qty}","${buy}.00","${(buy * qty).toFixed(2)}","0","0.00","0.00","${close}.00","0.00","0.00","${unreal.toFixed(2)}","10.00"`;
  });
  const file = path.join(dir, "dhan-desk-window-e2e.csv");
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

/**
 * Everything a failed geometry poll needs to be diagnosable in one line.
 *
 * `expect.poll` reports only the number it was given, and "the row's bottom is
 * 628px outside the box" does not say WHY — a box that never scrolled and a row
 * measured against the wrong element look identical from there. The scroll
 * offset, the focused index and the mounted range tell them apart.
 */
async function deskState(page: Page): Promise<string> {
  const box = await page.locator(DESK).evaluate((el) => ({
    scrollTop: Math.round(el.scrollTop),
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
  }));
  const focusedIndex = await page.locator(FOCUSED).getAttribute("data-row-index");
  const indices = await page.locator(ROWS).evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-row-index"))));
  return `[focus ${focusedIndex}, mounted ${indices[0]}…${indices.at(-1)} of ${indices.length}, scrollTop ${box.scrollTop}, box ${box.clientHeight}/${box.scrollHeight}]`;
}

async function selectAccount(page: Page, id: number): Promise<void> {
  const res = await page.request.post("/api/accounts", { data: { action: "select", id } });
  expect(res.ok(), `selecting account ${id}`).toBeTruthy();
}

/** Create the scratch account, point the desk at it, fill it, and arm the undo. */
async function seedWindowedBook(page: Page): Promise<void> {
  await gotoHydrated(page, "/live");
  const switcher = page.getByLabel("Portfolio account");
  await expect(switcher, "the sidebar account switcher is how the selection is put back").toBeVisible();
  const previous = Number(await switcher.inputValue());

  const created = await page.request.post("/api/accounts", {
    data: { action: "upsert", name: SCRATCH_ACCOUNT },
  });
  expect(created.ok(), "creating the scratch account").toBeTruthy();
  const scratchId = ((await created.json()) as { id?: number }).id ?? 0;
  expect(scratchId, "the accounts API returned no id").toBeGreaterThan(0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyuha-e2e-desk-"));
  // Armed BEFORE the selection moves: from here on, any failure still puts the
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
  await page.locator('input[type="file"]').setInputFiles(windowedCsv(dir));
  const commit = page.getByRole("button", { name: /Commit\s+\d+\s+new trade/i });
  await expect(commit, "the generated Dhan P&L was not detected").toBeEnabled({ timeout: 30_000 });
  await commit.click();
  await expect(page.getByText(/Imported\s+\d+\s+trade/i)).toBeVisible({ timeout: 30_000 });
}

/**
 * The half of the windowed path that WORKS, kept running so it cannot rot
 * while the geometry below is fixme'd.
 *
 * Past VIRTUAL_THRESHOLD the row j is moving to is not in the DOM, so the
 * component has to call `virtualizer.scrollToIndex` — delete that branch and
 * the focused row is never mounted at all, which is what this asserts. It also
 * keeps the seeding machinery (scratch account → real import → purge) exercised
 * on every run, so the day the geometry is fixed, un-fixme'ing the test below
 * is the only change needed.
 */
test("a windowed desk mounts the row j moves to, and k brings it back", async ({ page }) => {
  await seedWindowedBook(page);
  await page.setViewportSize({ width: 1280, height: 420 });
  await gotoHydrated(page, "/live");
  await expect(page.locator(ROWS).first()).toBeVisible();

  // This desk is the scratch account's and nobody else's…
  await expect(page.getByText(`${WINDOW_ROWS} of ${WINDOW_ROWS} open positions`)).toBeVisible();
  // …and it really is windowing, or this is the un-windowed test again.
  await expect(page.getByText(/rows are windowed as you scroll/)).toBeVisible();
  const mounted = await page.locator(ROWS).count();
  expect(mounted, "every row is mounted — the windowed path was never taken").toBeLessThan(WINDOW_ROWS);

  for (let i = 0; i < WINDOW_ROWS; i++) await page.keyboard.press("j");
  // Clamped at the end, never wrapping (`nextIndex`), and MOUNTED: the last row
  // of a 45-row desk is nowhere near the initial window.
  await expect(page.locator(FOCUSED), `the last row was never mounted ${await deskState(page)}`).toHaveCount(1);
  await expect(page.locator(FOCUSED)).toHaveAttribute("data-row-index", String(WINDOW_ROWS - 1));

  for (let i = 0; i < WINDOW_ROWS - 1; i++) await page.keyboard.press("k");
  await expect(page.locator(FOCUSED), `the first row was never re-mounted ${await deskState(page)}`).toHaveCount(1);
  await expect(page.locator(FOCUSED)).toHaveAttribute("data-row-index", "0");
});

/**
 * The v4.0 scroll bug in its THIRD form — the one nobody could reach, because
 * it needs more than VIRTUAL_THRESHOLD (40) open positions. Found by this
 * harness, 2026-09-06, and kept here as the record of what it looked like.
 *
 * Measured on this exact seed (45 rows, 1280×420), at the first press that
 * leaves the initially-mounted window:
 *
 *     after j crossed the window boundary
 *     [focus 18, mounted 0…30 of 31, scrollTop 579, box 250/2998]:
 *     the focused row's bottom must be inside the scroll box
 *     expect(received).toBeGreaterThanOrEqual(expected)
 *     Expected: >= -1     Received: -628.5
 *
 * The box DID scroll (scrollTop 579), to where the virtualiser believed row 18
 * ends: `estimateSize: () => ROW_HEIGHT` said 44 px. The real rows are
 * 2998/45 ≈ 66.6 px, because the Mark cell renders TWO block-level lines (the
 * level, then `<StalenessChip>`) — structural, not a font metric, so it was 44
 * vs ~66 on every platform. Nothing passed `virtualizer.measureElement` to a
 * row, so the model was never corrected: every offset was short by
 * (66.6 − 44) × index, and by row 18 the focused row sat 628 px BELOW the fold.
 *
 * Fixed in `components/live/tracker-client.tsx`: each windowed `<tr>` now
 * carries `ref={virtualizer.measureElement}` + `data-index`, the tanstack
 * answer for variable rows, and ROW_HEIGHT is the honest first guess (66) so
 * the paint before measurement is close. That took the same assertion from
 * −628.5 to −1.5, which exposed the SECOND half: virtual-core sizes the
 * viewport from `offsetHeight` (252 here — the BORDER box) but scrolls in
 * client-box coordinates (250), so `align:"end"` overshoots by the box's own
 * borders and clips the row's last 2 px. `scrollPaddingEnd` is now the
 * measured `offsetHeight − clientHeight`. The assertions below are unchanged
 * from the failing version.
 */
test("j and k clear the sticky header on the WINDOWED path too", async ({ page }) => {
  await seedWindowedBook(page);

  // The same short viewport as the un-windowed test, so the only thing that
  // differs between the two is which scroll path the component takes.
  await page.setViewportSize({ width: 1280, height: 420 });
  await gotoHydrated(page, "/live");
  const rows = page.locator(ROWS);
  await expect(rows.first()).toBeVisible();

  // This desk is the scratch account's and nobody else's.
  await expect(page.getByText(`${WINDOW_ROWS} of ${WINDOW_ROWS} open positions`)).toBeVisible();
  // …and it really is windowing, or this test is the un-windowed one again.
  await expect(page.getByText(/rows are windowed as you scroll/)).toBeVisible();
  const mounted = await rows.count();
  expect(mounted, "every row is mounted — the windowed path was never taken").toBeLessThan(WINDOW_ROWS);

  // Down through the boundary. The first press focuses row 0, so by press
  // `mounted + 1` the focused row is one the page did NOT have in the DOM when
  // it loaded — the case `scrollIntoView` cannot serve.
  for (let i = 0; i < WINDOW_ROWS; i++) {
    await page.keyboard.press("j");
    if (i === mounted) await expectFocusedRowFullyVisible(page, `after j crossed the window boundary ${await deskState(page)}`);
  }
  await expect(page.locator(FOCUSED)).toHaveAttribute("data-row-index", String(WINDOW_ROWS - 1));
  await expectFocusedRowFullyVisible(page, "after j to the last row of a windowed desk");

  // …and back up, the direction that used to park the row under the header.
  for (let i = 0; i < WINDOW_ROWS - 1; i++) {
    await page.keyboard.press("k");
    if (i === WINDOW_ROWS - mounted) {
      await expectFocusedRowFullyVisible(page, "after k crossed the window boundary");
    }
  }
  await expect(page.locator(FOCUSED)).toHaveAttribute("data-row-index", "0");
  await expectFocusedRowFullyVisible(page, "after k back to the first row of a windowed desk");
});
