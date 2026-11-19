import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ensureTrades, gotoHydrated } from "./helpers";

/**
 * Shell geometry — STATE row 25 (owner, 2026-11-19).
 *
 * The defect: after scrolling to the end of a page, the app shell ended
 * mid-window (sidebar footer at ~440 px of a 1130 px window, blank canvas
 * below) on the dashboard and on Settings → Appearance. Every other spec
 * asserts CONTENT, never the shell's geometry, which is why it shipped.
 *
 * The root cause: the shell is `h-screen overflow-hidden` and `<main>` scrolls,
 * but `<main>` was `position: static`. An absolutely positioned descendant with
 * no positioned ancestor (SectionStack's `sr-only` live region,
 * `data-testid="section-order-status"`) takes the INITIAL containing block, so
 * `<main>`'s overflow does not clip it; it sat at the bottom of main's content
 * (y ≈ 2,400 px) and made the DOCUMENT scrollable. A wheel past the end of
 * `<main>` then chains to the document and scrolls the whole shell up.
 *
 * The check, on EVERY sidebar route plus the skin / panel-style switch:
 * after wheeling far past the end of `<main>`, the document has not scrolled,
 * is no taller or wider than the window, and the shell's box is the window.
 * A short window makes every route's content overflow `<main>`, which is the
 * precondition for the defect.
 */
// NOT serial: every route is its own verdict, so one red route never hides the
// rest (the skin test previews without saving, so nothing leaks between tests).

const VIEWPORT = { width: 1440, height: 640 };
/**
 * Every sidebar route, read from the SOURCE of NAV_ITEMS rather than imported:
 * no spec pulls React component code through Playwright's transform (see
 * z-sidebar-fold.spec.ts), and a hand-written list is how a new screen would
 * escape this check. NAV_ITEMS = its `{ href: "/…"` literals + one entry per
 * hub in lib/domain/hubs.ts (`...HUBS.map`), whose hub hrefs sit at 4 spaces.
 */
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const NAV_HREFS = [...read("components/layout/nav-config.ts").matchAll(/\{ href: "(\/[^"]*)"/g)].map((m) => m[1]);
const HUB_HREFS = [...read("lib/domain/hubs.ts").matchAll(/^ {4}href: "(\/[^"]*)"/gm)].map((m) => m[1]);
const ROUTES = [...new Set([...NAV_HREFS, ...HUB_HREFS])];

test("the route list was read (a regex that matches nothing would pass every route vacuously)", () => {
  expect(NAV_HREFS.length).toBeGreaterThanOrEqual(40);
  expect(HUB_HREFS).toEqual(["/reports/edge-clinic", "/reports/capital", "/reports/costs"]);
});

type Geometry = {
  innerW: number;
  innerH: number;
  docH: number;
  docW: number;
  scrollY: number;
  scrollX: number;
  shellTop: number;
  shellH: number;
  mainOverflowX: number;
  escapees: string[];
};

async function wheelPastEnd(page: Page): Promise<void> {
  const box = await page.locator("main").boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 300));
  // Programmatic end first (fast), then real wheel ticks: the defect needs the
  // wheel to CHAIN from a main that is already at its end to the document.
  await page.locator("main").evaluate((m) => {
    m.scrollTop = m.scrollHeight;
  });
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 2_000);
  await page.mouse.wheel(400, 0);
  // Two frames so a chained scroll has landed before reading.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const se = document.scrollingElement as HTMLElement;
    const main = document.querySelector("main") as HTMLElement;
    const shell = main.parentElement as HTMLElement;
    const r = shell.getBoundingClientRect();
    // Named for the failure message: what still escapes <main>'s clipping.
    const escapees = [...main.querySelectorAll<HTMLElement>("*")]
      .filter((e) => getComputedStyle(e).position === "absolute" && e.offsetParent === document.body)
      .map((e) => e.getAttribute("data-testid") ?? `${e.tagName.toLowerCase()}.${String(e.className).split(" ")[0]}`)
      .slice(0, 5);
    return {
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      docH: se.scrollHeight,
      docW: se.scrollWidth,
      scrollY: window.scrollY,
      scrollX: window.scrollX,
      shellTop: Math.round(r.top),
      shellH: Math.round(r.height),
      mainOverflowX: main.scrollWidth - main.clientWidth,
      escapees,
    };
  });
}

function expectShellFillsWindow(g: Geometry, where: string): void {
  const ctx = `${where}: ${JSON.stringify(g)}`;
  expect(g.scrollY, ctx).toBe(0);
  expect(g.scrollX, ctx).toBe(0);
  expect(g.docH, ctx).toBeLessThanOrEqual(g.innerH + 1);
  expect(g.docW, ctx).toBeLessThanOrEqual(g.innerW + 1);
  expect(g.shellTop, ctx).toBe(0);
  expect(Math.abs(g.shellH - g.innerH), ctx).toBeLessThanOrEqual(1);
  // A far-right sr-only clipped by a positioned <main> must not give <main>
  // itself a horizontal scrollbar.
  expect(g.mainOverflowX, ctx).toBeLessThanOrEqual(1);
}

test.beforeAll(async ({ browser }) => {
  // A long dashboard is the defect's precondition; the run shares one DB.
  const page = await browser.newPage();
  await ensureTrades(page);
  await page.close();
});

test.use({ viewport: VIEWPORT });

/**
 * Loaded + hydrated, WITHOUT networkidle: /arjuns-eye and /instruments keep the
 * network busy past the 90 s test budget on a cold dev compile (measured
 * 2026-11-19), and the escaping element exists as soon as the page hydrates.
 * The sidebar clock is the same hydration signal gotoHydrated uses.
 */
async function gotoShell(page: Page, route: string): Promise<void> {
  await page.goto(route);
  await expect(page.locator("aside").getByText(/\d{2}:\d{2} IST/)).toBeVisible({ timeout: 60_000 });
}

for (const route of ROUTES) {
  test(`shell fills the window after scrolling past the end: ${route}`, async ({ page }) => {
    await gotoShell(page, route);
    await wheelPastEnd(page);
    expectShellFillsWindow(await geometry(page), route);
  });
}

test("shell fills the window after a skin and panel-style switch on Settings", async ({ page }) => {
  await gotoHydrated(page, "/settings");
  // Preview only — nothing is saved, so no later spec sees a changed look.
  const rose = page.getByRole("button", { name: "Rose", exact: true });
  await rose.click();
  await expect(rose).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("radio", { name: "Flat", exact: true }).click();
  await expect.poll(async () => (await page.locator("html").getAttribute("class")) ?? "").toContain("panel-flat");
  await wheelPastEnd(page);
  expectShellFillsWindow(await geometry(page), "/settings after skin + panel switch");
});
