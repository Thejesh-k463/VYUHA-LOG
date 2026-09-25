import { test, expect, type ConsoleMessage, type Page } from "@playwright/test";
import { gotoHydrated } from "./helpers";

/**
 * THE CONSOLE AUDIT — the three React warnings fix-list B2 fixes, in a browser
 * (STATE §0.3 V7: "the console clean of the three warnings fix-list B2 fixes").
 *
 * A React key warning is invisible to vitest, to typecheck and to `next build`:
 * it is printed by React's DEV renderer, into the browser console, while the
 * page looks perfectly correct. It is not cosmetic — a duplicate or missing
 * key makes React reconcile the WRONG row on the next render, which is the same
 * class of failure as the Trades-view filter that the set-state-in-effect rule
 * exists to prevent (AGENTS.md): nothing errors, and the screen is wrong.
 *
 * So this spec walks the five surfaces the fix list names, collects every
 * console warning and error, PRINTS all of them (the PROBE block below is the
 * deliverable for B2 — React 19 appends the component stack to the message
 * text, which is what names the file to fix), and then asserts that none of
 * them is one of the three.
 *
 * `zz-` PREFIXED so it sorts LAST: every seeding spec has run, so the book it
 * audits is the fullest the suite ever produces — an empty table renders no
 * rows and therefore no key warning at all. It only ever READS; it seeds
 * nothing and restores nothing, so no later spec can be affected by it.
 *
 * There is no `/onboarding` route: onboarding renders on `/` (see
 * `e2e/z-onboarding.spec.ts`), so `/` is the page visited for it.
 */

/** The three warnings fix-list B2 exists to remove. */
const B2_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "missing key", re: /Each child in a list should have a unique "key"/ },
  { name: "duplicate key", re: /Encountered two children with the same key/ },
  { name: "setState while rendering", re: /Cannot update a component .* while rendering/ },
];

/**
 * NOT OURS — excluded deliberately, not silenced.
 *
 * Radix UI's focus-scope / dismissable-layer primitives set `aria-hidden` on
 * siblings in a layout effect, which React 19's hydration pass reports as a
 * mismatched attribute on the four surfaces that mount one. It is the
 * LIBRARY's markup, produced by library code we do not own, and no edit inside
 * this repo removes it; asserting on it would make this spec red for a reason
 * nobody here can fix. Every such message is still PRINTED below — excluded
 * from the assertion only, never from the evidence.
 */
const NOT_OURS = /aria-hidden/;

/**
 * The five surfaces fix-list B2 named, plus `/atlas` and `/settings` (v4.6.0
 * W5): a "two children with the same key, `1`" warning surfaced in the W5 run
 * with no page attribution, and neither of the two new surfaces was walked.
 * The fresh e2e database is a day-1 trial, so `/atlas` renders the Pro panel.
 */
const PAGES = ["/live", "/trades", "/strategies", "/", "/reports/tax", "/atlas", "/settings"];

interface Captured {
  page: string;
  type: string;
  text: string;
}

const captured: Captured[] = [];

/** Attach BEFORE the first navigation: a listener bound later misses the first render. */
function listen(page: Page, where: () => string): void {
  page.on("console", (msg: ConsoleMessage) => {
    const type = msg.type();
    if (type !== "warning" && type !== "error") return;
    captured.push({ page: where(), type, text: msg.text() });
  });
  // An uncaught exception is not a console message; it would otherwise be
  // invisible here while being strictly worse than any warning.
  page.on("pageerror", (err) => {
    captured.push({ page: where(), type: "pageerror", text: `${err.message}\n${err.stack ?? ""}` });
  });
}

test("the audited surfaces render without React's key or render-phase-update warnings", async ({ page }) => {
  // 90 s is the config's per-test budget and seven dev-mode route compiles fit
  // inside it only just; this walks them one at a time and asserts once.
  test.slow();

  let current = PAGES[0];
  listen(page, () => current);

  for (const path of PAGES) {
    current = path;
    await gotoHydrated(page, path);
    // React logs its key warnings during render, and a client island's render
    // can follow hydration by a tick — so give the page a settled beat rather
    // than deciding on the navigation's own resolution (AGENTS.md: never
    // assert client-driven state once after networkidle).
    await page.waitForTimeout(1_500);
  }

  // The deliverable: everything seen, verbatim, whether asserted on or not.
  console.log("PROBE-BEGIN console-audit");
  if (captured.length === 0) console.log(`(no console warnings or errors on any of the ${PAGES.length} pages)`);
  for (const c of captured) console.log(`--- [${c.type}] ${c.page}\n${c.text}`);
  console.log(`PROBE-END console-audit (${captured.length} message(s))`);

  const offenders = captured.filter(
    (c) => !NOT_OURS.test(c.text) && B2_PATTERNS.some((p) => p.re.test(c.text)),
  );
  const report = offenders.map((o) => `[${o.type}] ${o.page}\n${o.text}`).join("\n\n");
  expect(offenders.map((o) => `${o.page} · ${o.text.slice(0, 120)}`), report).toEqual([]);
});
