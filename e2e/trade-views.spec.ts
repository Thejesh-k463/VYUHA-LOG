import { test, expect } from "@playwright/test";
import { ensureTrades } from "./helpers";

/**
 * The status + outcome filter on /trades.
 *
 * The interesting property is not that it filters — it is that the COUNTS in
 * the dropdown reconcile with what choosing that option actually returns. A
 * filter whose label disagrees with its result is worse than no filter.
 */
test("trades: status/outcome views filter, and their counts reconcile", async ({ page }) => {
  await ensureTrades(page);
  await page.goto("/trades");
  await expect(page.locator("tbody tr").first()).toBeVisible({ timeout: 30_000 });

  const view = page.locator("select").filter({ hasText: "All trades" });
  await expect(view).toBeVisible();

  // Every option carries its own count, e.g. "Open (9)".
  const labels = await view.locator("option").allTextContents();
  const parse = (re: RegExp) => {
    const hit = labels.find((l) => re.test(l));
    return hit ? Number(hit.match(/\((\d+)\)/)![1]) : null;
  };
  const all = parse(/^All trades/)!;
  const open = parse(/^Open /)!;
  const closed = parse(/^Closed /)!;
  const gain = parse(/In gain/)!;
  const loss = parse(/In loss/)!;
  const profit = parse(/Profit — closed/)!;
  const lossC = parse(/Loss — closed/)!;

  // Status is a partition of the book: nothing counted twice, nothing missed.
  expect(open + closed, "open + closed must equal all").toBe(all);
  // Outcomes are subsets of their status.
  expect(gain + loss).toBeLessThanOrEqual(open);
  expect(profit + lossC).toBeLessThanOrEqual(closed);

  // Choosing a view returns exactly the number it advertised.
  //
  // Read the "N of M" counter, NOT tbody row counts: the table is virtualized
  // (data-table.tsx `virtual`), so the DOM holds only the window + overscan —
  // rendered rows < population is CORRECT behaviour now.
  //
  // The SECOND number, deliberately. Since v3.9 the table is server-PAGED, so
  // the first number is the rows LOADED (at most TRADES_PAGE_SIZE = 500) and
  // the second is `page.total`, the SQL count over the whole filtered book —
  // which is the population the dropdown counted. Asserting the first number
  // only passed because the e2e database holds 303 rows: it would have gone
  // green on a 500-row page of a 25,000-row book while the reconcile contract
  // this spec exists to pin was broken.
  for (const [value, expected] of [["open", open], ["closed", closed], ["closed-loss", lossC]] as const) {
    await view.selectOption(value);
    await expect
      .poll(async () => {
        // Anchored, like z-remove-broker.spec.ts: "Loaded" and the "· N in the
        // book" tail live in sibling nodes, so this node is the bare pair.
        const counter = await page.getByText(/^\d+ of \d+$/).first().textContent();
        return Number(counter?.match(/of\s+(\d+)/)?.[1] ?? -1);
      }, { timeout: 15_000 })
      .toBe(expected);
  }
});

/**
 * An OPEN position with no mark price has no unrealised result. It must appear
 * under "Open" and under NEITHER gain nor loss — reading Vyuha's stored 0 as
 * breakeven would file it under a result it never had.
 */
test("trades: unmarked open positions are excluded from gain/loss, and it says so", async ({ page }) => {
  await ensureTrades(page);
  await page.goto("/trades");
  await expect(page.locator("tbody tr").first()).toBeVisible({ timeout: 30_000 });

  const view = page.locator("select").filter({ hasText: "All trades" });
  const labels = await view.locator("option").allTextContents();
  const n = (re: RegExp) => Number(labels.find((l) => re.test(l))!.match(/\((\d+)\)/)![1]);

  const open = n(/^Open /);
  const gain = n(/In gain/);
  const loss = n(/In loss/);
  const unmarked = open - gain - loss;

  await view.selectOption("open-gain");
  if (unmarked > 0) {
    // The gap must be explained on screen, not left as a silent shortfall.
    await expect(page.getByText(/no mark price/i)).toBeVisible();
  }
  // Whatever the marks, gain + loss can never exceed the open count.
  expect(gain + loss).toBeLessThanOrEqual(open);
});
