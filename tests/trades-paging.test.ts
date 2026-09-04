import { describe, expect, it } from "vitest";
import {
  LOADED_COUNT_PREFIX,
  RELOADED_TO_FIRST_PAGE,
  SEARCH_DEBOUNCE_MS,
  WHOLE_BOOK_CAPTION,
  acceptsPage,
  appendPage,
  loadedScopeCaption,
  rowCountLabel,
} from "@/lib/domain/trades-paging";

/**
 * /trades server paging — the two things a component cannot be trusted with
 * on its own: WHICH response may land, and what the counter is allowed to
 * claim.
 *
 * Both are pure here (invariant 2) so the rules are asserted without a
 * browser; components/trades/trades-client.tsx holds no second copy.
 */

const page1 = { rows: [1, 2], cursor: "c1", total: 25_001, viewCounts: { all: 25_001 } };

describe("a page-2 response is only ever appended to the scope that asked for it", () => {
  it("REJECTS a response whose filters the user has since left (the router.refresh hole)", () => {
    // The bug: `loadMore` fired for account A, `router.refresh()` re-seeded the
    // table with account B's page 1, and A's rows 501-1000 appended on top of
    // B's — with B's total overwritten by A's.
    expect(
      acceptsPage({ requestedKey: "A", servedKey: "B", filterKey: "B", cancelled: false }, { ok: true }),
      "a page fetched for scope A must never land on scope B",
    ).toBe(false);
  });

  it("REJECTS once the request has been cancelled, and once the filters have moved on", () => {
    expect(acceptsPage({ requestedKey: "A", servedKey: "A", filterKey: "A", cancelled: true }, { ok: true })).toBe(false);
    expect(acceptsPage({ requestedKey: "A", servedKey: "A", filterKey: "B", cancelled: false }, { ok: true })).toBe(false);
  });

  it("rejects a body that is missing or not ok, and accepts the one true case", () => {
    const live = { requestedKey: "A", servedKey: "A", filterKey: "A", cancelled: false };
    expect(acceptsPage(live, null)).toBe(false);
    expect(acceptsPage(live, { ok: false })).toBe(false);
    expect(acceptsPage(live, { ok: true })).toBe(true);
  });

  it("appendPage appends rows and takes the server's fresh aggregates", () => {
    const next = appendPage(page1, { ok: true, rows: [3, 4], nextCursor: null, total: 25_001, viewCounts: { all: 25_001 } });
    expect(next.rows).toEqual([1, 2, 3, 4]);
    expect(next.cursor).toBeNull();
    expect(next.total).toBe(25_001);
  });
});

describe("the counter and the captions say what is actually true", () => {
  it("the bare counter node stays `N of M` — four e2e specs match it ANCHORED", () => {
    expect(rowCountLabel(500, 25_001)).toBe("500 of 25001");
    expect(rowCountLabel(500, 25_001)).toMatch(/^\d+ of \d+$/);
  });

  it("the word LOADED sits outside that node, so the pin survives and the copy is honest", () => {
    expect(LOADED_COUNT_PREFIX).toBe("Loaded");
    expect(LOADED_COUNT_PREFIX, "the prefix must not add digits to the pinned node").not.toMatch(/\d/);
  });

  it("the caption admits that sort and select are PAGE-LOCAL while the counts are not", () => {
    const c = loadedScopeCaption(25_001);
    expect(c).toBe("Sort and select act on the loaded rows; filters, search and counts cover all 25,001.");
    expect(c).toContain("loaded rows");
  });

  it("the KPI strip above is whole-book and says so", () => {
    expect(WHOLE_BOOK_CAPTION).toBe("Totals above cover the whole book");
  });

  it("a refresh that re-adopts page 1 after later pages were loaded says so", () => {
    expect(RELOADED_TO_FIRST_PAGE).toBe("Reloaded — showing the first 500 again");
  });

  it("the free-text box is debounced, so a five-letter symbol is one request and not five", () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(150);
  });
});
