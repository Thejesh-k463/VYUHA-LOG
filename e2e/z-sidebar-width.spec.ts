import { test, expect, type Page } from "@playwright/test";
import { gotoHydrated } from "./helpers";

/**
 * The resizable sidebar width (v4.4.0) in a real browser.
 *
 * What only a browser can prove: that a TRUSTED pointer drag moves the edge
 * (synthetic PointerEvents cannot — `z-column-order.spec.ts` records why), that
 * the width survives a reload, that a stored width too wide for THIS window is
 * re-clamped on read, and that nothing overflows at the 180 px minimum. The
 * pure half — envelope, clamp, key map — is `tests/sidebar-width.test.ts`.
 *
 * Every restored-state assertion is an `expect.poll`: the width is read from
 * localStorage after hydration, so a single assert after `networkidle` reads
 * the 232 px default and looks exactly like broken persistence (AGENTS.md;
 * DECISIONS.md 2026-08-10).
 *
 * Constants are hardcoded copies of `components/layout/use-sidebar-width.ts`,
 * following `z-sidebar-fold.spec.ts`: no spec pulls app modules through
 * Playwright's transform. Each test gets a fresh browser context, so each
 * starts at the default width with nothing to clear.
 *
 * `z-` prefix: it seeds nothing, but sorting after `import-dashboard.spec.ts`
 * costs nothing either.
 */

const KEY = "vyuha-sidebar-width";
const DEFAULT_W = 232;
const MIN_W = 180;
const MAX_W = 420;
const CONTENT_MIN_W = 640;
const COLLAPSED_W = 56;

/** Sub-pixel slack: layout boxes are fractional, the assertions are not about that. */
const TOL = 1;

const asideOf = (page: Page) => page.locator("aside");
const handleOf = (page: Page) => asideOf(page).getByRole("separator", { name: "Sidebar width" });

async function widthOf(page: Page): Promise<number> {
  const b = await asideOf(page).boundingBox();
  return b ? Math.round(b.width) : -1;
}

async function stored(page: Page): Promise<unknown> {
  const raw = await page.evaluate((k) => localStorage.getItem(k), KEY);
  return raw === null ? null : JSON.parse(raw);
}

test("a trusted drag moves the edge live, and the width survives a reload", async ({ page }) => {
  await gotoHydrated(page, "/");
  await expect.poll(() => widthOf(page)).toBe(DEFAULT_W);

  const grab = await handleOf(page).boundingBox();
  expect(grab, "the width handle has no box — it is not on screen").toBeTruthy();
  const x = grab!.x + grab!.width / 2;
  const y = grab!.y + grab!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // Two moves: one is sometimes coalesced into the press, and a drag that
  // never reports a move commits nothing.
  await page.mouse.move(x + 40, y);
  await page.mouse.move(x + 80, y);

  // W1 — mid-drag, the 200 ms width transition must be OFF, or the edge trails
  // the pointer and rubber-bands on release. The computed style is the honest
  // reading; a box sampled mid-transition is a timing guess.
  const transition = () => asideOf(page).evaluate((el) => getComputedStyle(el).transitionProperty);
  await expect.poll(transition, { message: "the width transition is still on mid-drag" }).toBe("none");
  await expect.poll(() => widthOf(page)).toBe(DEFAULT_W + 80);

  await page.mouse.up();
  await expect.poll(() => widthOf(page)).toBe(DEFAULT_W + 80);
  await expect.poll(transition, { message: "the collapse animation is back after the drag" }).toContain("width");
  // W10 — the versioned envelope, never a bare number.
  await expect.poll(() => stored(page)).toEqual({ v: 1, px: DEFAULT_W + 80 });

  // W6 — a full navigation; the width is restored after hydration, so polled.
  await gotoHydrated(page, "/");
  await expect.poll(() => widthOf(page), { timeout: 20_000 }).toBe(DEFAULT_W + 80);
});

test("Escape mid-drag cancels: the edge snaps back and nothing is written", async ({ page }) => {
  await gotoHydrated(page, "/");
  const grab = (await handleOf(page).boundingBox())!;
  await page.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2);
  await page.mouse.down();
  await page.mouse.move(grab.x + 30, grab.y + grab.height / 2);
  await page.mouse.move(grab.x + 60, grab.y + grab.height / 2);
  await expect.poll(() => widthOf(page)).toBeGreaterThan(DEFAULT_W + 20);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect.poll(() => widthOf(page)).toBe(DEFAULT_W);
  expect(await stored(page)).toBeNull();
});

test("the keyboard resizes it; Enter, double-click and the footer Reset each put it back", async ({ page }) => {
  await gotoHydrated(page, "/");
  const handle = handleOf(page);
  await handle.focus();

  await page.keyboard.press("ArrowRight");
  await expect.poll(() => widthOf(page)).toBe(DEFAULT_W + 16);
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => widthOf(page)).toBe(DEFAULT_W + 16 + 64);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => widthOf(page)).toBe(DEFAULT_W + 64);
  await page.keyboard.press("Home");
  await expect.poll(() => widthOf(page)).toBe(MIN_W);
  // 1280 − 640 = 640 > 420, so End is the ruled maximum at this viewport.
  await page.keyboard.press("End");
  await expect.poll(() => widthOf(page)).toBe(MAX_W);
  await expect(handle).toHaveAttribute("aria-valuenow", String(MAX_W));

  // Enter resets: the key is CLEARED, not set to 232.
  await page.keyboard.press("Enter");
  await expect.poll(() => widthOf(page)).toBe(DEFAULT_W);
  await expect.poll(() => stored(page)).toBeNull();

  // Double-click resets too — and its two clicks write nothing on the way.
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => widthOf(page)).toBe(DEFAULT_W + 16);
  await handle.dblclick();
  await expect.poll(() => widthOf(page)).toBe(DEFAULT_W);
  await expect.poll(() => stored(page)).toBeNull();

  // The footer Reset is offered while EITHER key is stored, and clears the width.
  const reset = asideOf(page).getByRole("button", { name: "Reset" });
  await expect(reset, "no order and no width stored — nothing to reset").toHaveCount(0);
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => widthOf(page)).toBe(DEFAULT_W - 16);
  await expect(reset).toBeVisible();
  await reset.click();
  await expect.poll(() => widthOf(page)).toBe(DEFAULT_W);
  await expect.poll(() => stored(page)).toBeNull();
  await expect(reset).toHaveCount(0);
});

test("a stored width too wide for this window is re-clamped on read, and on resize", async ({ page }) => {
  // W2 — a width saved on a wide monitor, reopened at the desktop's 1024 px
  // window floor. 900 is what no drag can store; the clamp must recover it
  // anyway, because a hand-edited or future-build value arrives the same way.
  await page.addInitScript(
    ({ k, v }) => {
      if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
    },
    { k: KEY, v: JSON.stringify({ v: 1, px: 900 }) },
  );
  await page.setViewportSize({ width: 1024, height: 768 });
  await gotoHydrated(page, "/");
  await expect.poll(() => widthOf(page), { timeout: 20_000 }).toBe(1024 - CONTENT_MIN_W);
  const main = await page.locator("main").boundingBox();
  expect(Math.round(main!.width), "main keeps its content floor").toBeGreaterThanOrEqual(CONTENT_MIN_W - TOL);

  // The same stored value on a wider window is the ruled maximum…
  await page.setViewportSize({ width: 1440, height: 768 });
  await expect.poll(() => widthOf(page)).toBe(MAX_W);
  // …and re-clamps LIVE when the window shrinks, without a reload.
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect.poll(() => widthOf(page)).toBe(1024 - CONTENT_MIN_W);
});

test("at the 180 px minimum nothing overflows the sidebar", async ({ page }) => {
  // W3 — without `truncate min-w-0` the longest labels run past the border and
  // `nav` (overflow-y:auto ⇒ overflow-x:auto) grows a horizontal scrollbar;
  // the brand caption's `nowrap` overflow is invisible to a bounding-rect check
  // of its parent, so its OWN right edge is measured against the aside's.
  await gotoHydrated(page, "/");
  // Every group open, so every label is on screen at the narrow width.
  // `.first()` each time — the clicked button unmounts, so nth locators shift.
  const more = page.getByRole("button", { name: /^Show \d+ more / });
  for (let i = 0; i < 20 && (await more.count()) > 0; i++) await more.first().click();
  await expect(more).toHaveCount(0);
  // The "Jump to… / Ctrl K" button wrapped BOTH halves onto a second line at
  // 180 px (measured 2026-09-18: 46 px tall) — no overflow, so only its height
  // shows it. It must be as tall at the minimum as at the default.
  const jump = asideOf(page).getByRole("button", { name: "Command palette (Ctrl+K)" });
  const jumpHeight = async () => Math.round((await jump.boundingBox())?.height ?? -1);
  const jumpAtDefault = await jumpHeight();

  await handleOf(page).focus();
  await page.keyboard.press("Home");
  await expect.poll(() => widthOf(page)).toBe(MIN_W);
  await expect.poll(jumpHeight, { message: "the Jump to… button wrapped at 180 px" }).toBe(jumpAtDefault);

  const nav = asideOf(page).locator("nav");
  await expect
    .poll(() => nav.evaluate((el) => el.scrollWidth - el.clientWidth), { message: "the nav scrolls sideways at 180 px" })
    .toBeLessThanOrEqual(0);

  const asideRight = await asideOf(page).evaluate((el) => el.getBoundingClientRect().right);
  const overflowing = await asideOf(page).evaluate((aside, right) => {
    const out: string[] = [];
    for (const el of Array.from(aside.querySelectorAll("a, div, span"))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > right + 1 && !el.closest('[role="separator"]')) out.push((el.textContent ?? "").trim().slice(0, 40));
    }
    return out;
  }, asideRight);
  expect(overflowing, "elements painting past the sidebar's right edge").toEqual([]);
});

test("collapse is independent: the rail is 56 px and expanding restores the width", async ({ page }) => {
  await gotoHydrated(page, "/");
  await handleOf(page).focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => widthOf(page)).toBe(DEFAULT_W + 64);

  await asideOf(page).getByRole("button", { name: "Collapse sidebar" }).click();
  await expect.poll(() => widthOf(page)).toBe(COLLAPSED_W);
  await expect(handleOf(page), "no width handle on the icon rail").toHaveCount(0);

  await asideOf(page).getByRole("button", { name: "Expand sidebar" }).click();
  await expect.poll(() => widthOf(page)).toBe(DEFAULT_W + 64);
  // The two keys never merged: the width is still the {v:1,px} envelope.
  expect(await stored(page)).toEqual({ v: 1, px: DEFAULT_W + 64 });
});
