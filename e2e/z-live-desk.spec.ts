import { test, expect, type Page } from "@playwright/test";
import { ensureTrades, gotoHydrated } from "./helpers";

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
 * options, each with a non-zero Closing Price and no stored MTM row. So every
 * desk row's mark is the journal's own close — `staleness: "eod"` with a null
 * `asOf` — and the chip reads "End of day" with NO date after it. Constants
 * below are hardcoded copies of `components/live/desk-copy.ts`, following
 * `z-sidebar-fold.spec.ts`: no spec pulls app modules through Playwright's
 * transform.
 *
 * ENTITLEMENT. The e2e database is recreated by `e2e/prepare-db.ts` on every
 * run, so `trial_started_at` is NULL and `getEntitlement()` stamps it on its
 * first read — a day-1 TRIAL, i.e. `pro: true`. Tests 3 and 4 are the two
 * halves of that fork and each skips itself with a named reason when the other
 * one is the truth, so neither this file nor any other has to flip licence
 * state globally.
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
  for (let i = 0; i < n; i++) {
    // `textContent`, not `innerText`: the chip is a `Badge size="xs"`, which is
    // CSS-uppercased, and `innerText` returns "END OF DAY" — the transform, not
    // the copy. What is under test is the string `desk-copy.ts` exports.
    const chip = rows.nth(i).locator("td").nth(4).locator("span.inline-flex > div").first();
    await expect(chip, `row ${i} has no mark chip`).toBeVisible();
    const label = ((await chip.textContent()) ?? "").trim();
    expect(label, `row ${i} mark chip`).toMatch(MARK_LABELS);
    // What this seed actually produces: the mark is the journal's own Closing
    // Price (no `mtm_prices` row, no feed), i.e. staleness "eod" with a null
    // `asOf` — so the label is bare. A date here would mean the chip started
    // claiming a provenance the store cannot support.
    expect(label, `row ${i} mark chip carries a date`).toBe("End of day");
  }
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
  test.skip(
    !(await isFree(page)),
    "the e2e database is recreated per run, so trial_started_at stamps on the first entitlement read and /live renders PRO; " +
      "asserting the free wire would need an unlicensed database, and licence state is not flipped globally by a spec",
  );

  // Hiding is not gating: the SERVER must not compute the Pro figures at all,
  // so neither the sizing tree's numbers nor its "ok" shape may appear in what
  // the browser received.
  const html = await page.content();
  expect(html, "riskBudgetP reached the client on a free licence").not.toContain("riskBudgetP");
  expect(html, "an ungated stop object reached the client").not.toContain('"kind":"ok"');
  await expect(page.locator(ROWS).first().locator(LOCK).first()).toBeVisible();
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
