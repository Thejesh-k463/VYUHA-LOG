import { test, expect, type Page } from "@playwright/test";
import { ensureTrades } from "./helpers";

/**
 * Drag-to-reorder on the Trades table.
 *
 * NAMED `z-` DELIBERATELY. The suite shares one database and imports are
 * de-duplicated, so whichever spec runs first is the one that gets to see
 * "Imported 122 trades". As `column-order.spec.ts` this sorted ahead of
 * `import-dashboard.spec.ts`, seeded the book through `ensureTrades`, and that
 * spec then found nothing new to import and failed — on a side effect of THIS
 * file. Same reason `z-dhan-gtr.spec.ts` carries the prefix.
 *
 * This is here rather than in a unit test because the part that breaks is not
 * the maths — `tests/column-order.test.ts` covers that exhaustively — it is the
 * pointer sequence. Synthetic `dispatchEvent` cannot prove this works: React's
 * delegated listener and the hook's window-level move/up handlers only see
 * TRUSTED input, which is exactly what Playwright generates and a hand-rolled
 * `new PointerEvent()` does not.
 */

const KEY = "vyuha-trades-column-order";
const GRIP = 'thead th button[aria-label^="Reorder"]';

/**
 * Header labels in DOM order, upper-cased.
 *
 * `innerText` reflects the rendered `text-transform: uppercase`, so the header
 * band can read "NET" where the source says "Net". Normalising here keeps the
 * assertions independent of that styling.
 */
async function headers(page: Page): Promise<string[]> {
  const raw = await page.locator("table thead th").allInnerTexts();
  return raw.map((s) => s.trim().split("\n")[0].trim().toUpperCase());
}

/** Drag the grip in `label`'s header onto the left edge of `beforeLabel`'s. */
async function dragColumn(page: Page, label: string, beforeLabel: string) {
  // Matched case-insensitively: the accessible name follows the DOM text, but
  // pinning the case here would couple the test to the header styling.
  const from = page.getByRole("columnheader", { name: new RegExp(`^${label}$`, "i") });
  const to = page.getByRole("columnheader", { name: new RegExp(`^${beforeLabel}$`, "i") });
  // The grip is opacity-0 until the header is hovered; it still occupies layout
  // and still hit-tests, so a real pointer finds it either way.
  const grip = from.locator('button[aria-label^="Reorder"]');
  await to.scrollIntoViewIfNeeded();
  await grip.scrollIntoViewIfNeeded();
  const g = (await grip.boundingBox())!;
  const t = (await to.boundingBox())!;
  // `page.mouse` works in VIEWPORT coordinates and does not scroll. The Trades
  // table scrolls sideways, so a header can have a perfectly good bounding box
  // that is off-screen — the press then lands on nothing and the drag silently
  // does not happen. Fail here instead, where the reason is legible.
  const vp = page.viewportSize()!;
  for (const [name, b] of [["grip", g], ["target", t]] as const) {
    expect(b.x, `${name} is off-screen (viewport ${vp.width}px) — mouse input cannot reach it`).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width, `${name} is off-screen (viewport ${vp.width}px)`).toBeLessThanOrEqual(vp.width);
  }
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  // Several steps, not one jump: the hook decides the insertion point from
  // pointermove, and a single move is enough but a real drag is not one move.
  await page.mouse.move(t.x + 2, t.y + t.height / 2, { steps: 12 });
  // Read the live drag BEFORE releasing. Without this, a grab that never
  // started and a drop that computed a no-op are the same empty result, and
  // the failure points at the assertion rather than at the cause.
  const midDrag = await page.locator("table thead th").evaluateAll((ths) => ({
    grabbed: ths.filter((th) => th.className.includes("opacity-40")).length,
    indicators: ths.filter((th) => getComputedStyle(th).boxShadow.includes("inset")).length,
  }));
  await page.mouse.up();
  return midDrag;
}

async function freshTrades(page: Page): Promise<void> {
  await ensureTrades(page);
  // ensureTrades may have had to seed the shared database, which leaves the
  // page on /import — never assume it ends where it started.
  await page.goto("/trades");
  await page.waitForLoadState("networkidle");
  // Never inherit another spec's saved order — this key is per-device chrome
  // and survives everything else the suite resets.
  await page.evaluate((k) => localStorage.removeItem(k), KEY);
  await page.reload();
  await page.waitForLoadState("networkidle");
}

test("trades: a column drags to a new position, persists, and resets", async ({ page }) => {
  await freshTrades(page);

  const before = await headers(page);
  expect(before).toContain("SEGMENT");
  expect(before).toContain("BROKER");
  // The v2.99.96 column set: Buy/Sell value totals gave way to these four.
  for (const h of ["QTY", "INVESTED", "ENTRY", "EXIT"]) expect(before, `header ${h}`).toContain(h);
  expect(before).not.toContain("BUY");
  expect(before).not.toContain("SELL");
  expect(before.indexOf("SEGMENT")).toBeGreaterThan(before.indexOf("BROKER"));

  const midDrag = await dragColumn(page, "Segment", "Broker");
  // The grab itself, asserted separately from its outcome.
  expect(midDrag.grabbed, "the grabbed header should dim while dragging").toBe(1);
  expect(midDrag.indicators, "a drop line should mark the insertion point").toBe(1);

  const after = await headers(page);
  expect(after.indexOf("SEGMENT"), "Segment should have moved ahead of Broker").toBe(before.indexOf("BROKER"));
  expect(after.indexOf("SEGMENT")).toBeLessThan(after.indexOf("BROKER"));
  // Same columns, no duplicates, none lost.
  expect([...after].sort()).toEqual([...before].sort());
  // The pinned pair is untouched.
  expect(after[1]).toBe(before[1]);

  // Persisted in the versioned shape.
  const stored = await page.evaluate((k) => localStorage.getItem(k), KEY);
  expect(stored).toBeTruthy();
  const parsed = JSON.parse(stored!) as { v: number; order: string[] };
  expect(parsed.v).toBe(1);
  expect(parsed.order[0]).toBe("segment");

  // Survives a reload — the whole point of persisting it.
  //
  // Polled, not asserted once: the saved order is applied by the CLIENT, so it
  // cannot appear before this route hydrates, and `networkidle` says nothing
  // about that. In dev the Trades route is large enough for the gap to be
  // seconds. Asserting immediately here reads as "persistence is broken" when
  // the page simply has not woken up yet.
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect.poll(async () => (await headers(page)).join("|"), { timeout: 20_000 }).toBe(after.join("|"));

  // Reset returns the default order and clears the key, so the next release's
  // default is not frozen out by a stale array.
  await page.getByRole("button", { name: /Reset columns/i }).click();
  await expect
    .poll(async () => (await headers(page)).indexOf("SEGMENT"))
    .toBe(before.indexOf("SEGMENT"));
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBeNull();
});

test("trades: the pinned columns offer no grip, and the tracker table has none at all", async ({ page }) => {
  await freshTrades(page);

  // The grip is a real button inside the header, so its label would otherwise
  // be folded into the header's computed name and every cell would announce as
  // "Reorder netPnl column Net". The header names itself explicitly instead.
  await expect(page.getByRole("columnheader", { name: /^Net$/i })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: /Reorder/i })).toHaveCount(0);

  const count = await page.locator("table thead th").count();
  const grips = await page.locator(GRIP).count();
  // Two frozen columns (row select, Instrument) — every other header is movable.
  expect(grips).toBe(count - 2);
  const firstTwo = page.locator("table thead th").nth(0).locator('button[aria-label^="Reorder"]');
  expect(await firstTwo.count()).toBe(0);
  expect(await page.locator("table thead th").nth(1).locator('button[aria-label^="Reorder"]').count()).toBe(0);

  // Regression: DataTable is shared. Without `onReorder` the tracker tables
  // must render exactly as they did before the feature existed.
  await page.goto("/active");
  await page.waitForLoadState("networkidle");
  await expect(page.locator("table thead th").first()).toBeVisible();
  expect(await page.locator(GRIP).count()).toBe(0);
});

test("trades: virtualization — the far end renders on scroll, select-all counts the whole book", async ({ page }) => {
  await freshTrades(page);

  const counter = await page.getByText(/\d+\s+of\s+\d+/).first().textContent();
  const total = Number(counter?.match(/^(\d+)/)?.[1] ?? 0);
  expect(total).toBeGreaterThan(30); // the fixture book must exceed the window

  // The DOM holds a WINDOW, not the book — that is the feature. (+2 spacers)
  const rendered = await page.locator("tbody tr").count();
  expect(rendered).toBeLessThan(total);

  // Scroll the container to the bottom: the last rows materialise.
  const container = page.locator("div.table-luxe");
  await container.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect
    .poll(async () => {
      const texts = await page.locator("tbody tr").allTextContents();
      return texts.length > 0 && (await container.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 5));
    })
    .toBe(true);
  await expect(page.locator("tbody tr:not([aria-hidden])").last()).toBeVisible();

  // Select-all selects the FULL filtered population, not the rendered window.
  await page.locator('thead input[type="checkbox"]').check();
  await expect(page.getByText(new RegExp(`${total}\\s+selected`))).toBeVisible();
  await page.getByRole("button", { name: /Clear selection/ }).click();
});
