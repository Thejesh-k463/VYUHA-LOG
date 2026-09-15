import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { mtfDrift, unpricedMtfPositions, type OpenMtfPosition } from "@/lib/risk/mtf-drift";
import { MtfDriftCard } from "@/components/risk/mtf-drift-card";
import type { MtfMarginResolution } from "@/lib/risk/mtf-margins";

/**
 * L2 [1] (v4.3.0 wave 2L, PRE-EXISTING). `lib/risk/mtf-drift.ts:45` read a
 * never-resolved funded amount as `?? 0` — i.e. "the broker funded nothing" —
 * so a position the journal never priced was STATED as a 100% own-margin entry.
 * `storedOwnPct` came out 100, `deltaPct` = current - 100 a large NEGATIVE, and
 * the card then told the trader the requirement had FALLEN and that no top-up
 * was owed (`topUpAtCurrent` 0, rendered "—"). The same row read the way every
 * other reader reads a null (the 25% margin estimate) is +15 points with a real
 * 3,000 top-up, and the Trades table's own cell already refuses to state a
 * percentage for it ("MTF - funding not yet resolved", invariant 6).
 *
 * The fix: a null is EXCLUDED from the drift computation and NAMED on the card.
 * A STATED 0 really is 100% own capital and keeps its row — the same
 * null-vs-0 rule every other reader follows (wave 2I, I1).
 */
const resolve =
  (pct: number) =>
  (_broker: string, _symbol: string): MtfMarginResolution => ({
    pct,
    source: "stock-list",
    asOf: "2026-08-07",
    coverage: "complete",
    note: null,
  });

const pos = (over: Partial<OpenMtfPosition> = {}): OpenMtfPosition => ({
  id: 1,
  symbol: "Z",
  broker: "angelone",
  buyValue: 20000,
  mtfFundedAmount: 15000,
  ...over,
});

const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

describe("L2 [1] — an unpriced MTF row is excluded from drift, never stated at 100% own margin", () => {
  it("a null funded amount produces NO drift row", () => {
    // On revert: one row, storedOwnPct 100, deltaPct -60, topUpAtCurrent 0 —
    // the requirement reported as having FALLEN on a row nothing priced.
    const rows = mtfDrift([pos({ mtfFundedAmount: null })], resolve(40));
    expect(rows).toEqual([]);
  });

  it("it is counted so the card can name it, rather than disappearing", () => {
    const unpriced = unpricedMtfPositions([pos({ id: 1, mtfFundedAmount: null }), pos({ id: 2 })]);
    expect(unpriced.map((p) => p.id)).toEqual([1]);
  });

  it("a STATED 0 is still 100% own capital — that branch was always right", () => {
    const rows = mtfDrift([pos({ mtfFundedAmount: 0 })], resolve(40));
    expect(rows).toHaveLength(1);
    expect([rows[0].storedOwnPct, rows[0].deltaPct, rows[0].topUpAtCurrent]).toEqual([100, -60, 0]);
    expect(unpricedMtfPositions([pos({ mtfFundedAmount: 0 })])).toEqual([]);
  });

  it("a priced row is unchanged", () => {
    const rows = mtfDrift([pos({ mtfFundedAmount: 15000 })], resolve(40));
    expect(rows).toHaveLength(1);
    expect([rows[0].storedOwnPct, rows[0].currentPct, rows[0].deltaPct, rows[0].topUpAtCurrent]).toEqual([25, 40, 15, 3000]);
  });

  it("a zero-value row is neither drifted nor counted as unpriced", () => {
    expect(mtfDrift([pos({ buyValue: 0, mtfFundedAmount: null })], resolve(40))).toEqual([]);
    expect(unpricedMtfPositions([pos({ buyValue: 0, mtfFundedAmount: null })])).toEqual([]);
  });
});

describe("L2 [1] — the card says the unpriced rows are missing instead of suppressing them", () => {
  const render = (props: Parameters<typeof MtfDriftCard>[0]) =>
    textOf(renderToStaticMarkup(React.createElement(MtfDriftCard, props)));

  it("names how many rows it could not compare, and why", () => {
    const text = render({ drift: [], bundleAsOf: "2026-08-01", stale: false, unpriced: 1 });
    expect(text).toContain("1 open MTF position is not priced");
    expect(text).toContain("no broker-funded amount");
    // Never the figure it refuses to state (invariant 6).
    expect(text).not.toContain("100%");
  });

  it("pluralises, and still renders the drift table beside the note", () => {
    const rows = mtfDrift([pos({ id: 7, symbol: "RISER" })], resolve(40));
    const text = render({ drift: rows, bundleAsOf: "2026-08-01", stale: false, unpriced: 2 });
    expect(text).toContain("2 open MTF positions are not priced");
    expect(text).toContain("RISER");
    expect(text).toContain("+15 pts");
  });

  it("renders nothing at all when there is no drift, no staleness and nothing unpriced", () => {
    expect(renderToStaticMarkup(React.createElement(MtfDriftCard, { drift: [], bundleAsOf: "2026-08-01", stale: false, unpriced: 0 }))).toBe("");
    // The prop is optional, so the existing call site keeps compiling.
    expect(renderToStaticMarkup(React.createElement(MtfDriftCard, { drift: [], bundleAsOf: "2026-08-01", stale: false }))).toBe("");
  });
});
