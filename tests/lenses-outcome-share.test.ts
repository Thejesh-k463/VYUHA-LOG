import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { outcomeShares, rateColumnOf, LENSES } from "@/lib/domain/lenses";
import type { LensGroupRow, LensEdge } from "@/lib/domain/lens-edge";
import { GroupList } from "@/components/lenses/lenses-client";

/**
 * The /lenses OUTCOME tab's Win rate column was a tautology (owner, 2026-09-18 — the v4.4.0
 * fix list; VYUHA-STATE §0 "FIX LIST"). `outcomeGroups` groups the book BY its result, so the
 * Winners row always read 100% and the Losers row 0% — correct arithmetic, a useless column,
 * and the owner read the 0% as "no loss shown". On the Outcome lens ONLY the column now states
 * each group's SHARE of the closed trades ("Share of trades": 33 of 42 = 79%, 9 of 42 = 21%);
 * every other lens keeps Win rate.
 *
 * Two rules ride with it: a share over a book with nothing closed is "—", never 0%
 * (invariant 6), and the share is FREE — it is counts (`LensTotals.closedCount`, already on
 * the free wire), so nothing new crosses the free/Pro boundary (`lib/domain/lens-edge.ts`).
 */

describe("outcomeShares — each group's share of the closed book", () => {
  it("33 of 42 and 9 of 42, and the open group is not a slice of the closed book", () => {
    const [win, loss, open] = outcomeShares([33, 9, 0]);
    expect(Math.round(win! * 100)).toBe(79);
    expect(Math.round(loss! * 100)).toBe(21);
    expect(open, "Still open holds no closed trade — its share is '—', not 0%").toBeNull();
  });

  it("the shares of the closed groups add up to the whole closed book", () => {
    const s = outcomeShares([33, 9, 1]);
    expect(s.reduce((a, b) => a! + b!, 0)).toBeCloseTo(1, 12);
  });

  it("invariant 6: a book with nothing closed has no denominator — every share is null", () => {
    expect(outcomeShares([0, 0])).toEqual([null, null]);
    expect(outcomeShares([])).toEqual([]);
  });

  it("only the Outcome lens swaps the column; the other five keep Win rate", () => {
    expect(rateColumnOf("outcome")).toEqual({ key: "share", label: "Share of trades" });
    for (const l of LENSES.filter((x) => x.kind !== "outcome")) {
      expect(rateColumnOf(l.kind), l.kind).toEqual({ key: "winRate", label: "Win rate" });
    }
  });
});

// ── The rendered list, both licences ────────────────────────────────────────

const edge = (winRate: number | null): LensEdge => ({
  wins: 0, losses: 0, winRate, profitFactor: null, expectancy: null, avgR: null,
  avgWin: null, avgLoss: null, maxWinStreak: 0, maxLossStreak: 0, currentStreak: 0,
  rCount: 0, rPlanCount: 0, rCapCount: 0,
});
const row = (key: string, label: string, count: number, openCount: number, netPnl: number, winRate: number | null, pro: boolean): LensGroupRow => ({
  group: { key, label, sub: "", count, scope: { kind: "filter", ids: [], label } },
  row: {
    totals: { count, openCount, closedCount: count - openCount, netPnl, charges: 0, unpricedCount: 0, unpricedNetPnl: 0, chargeHeads: null },
    edge: pro ? edge(winRate) : null,
  },
});
const book = (pro: boolean): LensGroupRow[] => [
  row("outcome:win", "Winners", 33, 0, 51_000, 1, pro),
  row("outcome:loss", "Losers", 9, 0, -12_173, 0, pro),
  row("outcome:open", "Still open", 3, 3, 0, null, pro),
];
const render = (kind: Parameters<typeof GroupList>[0]["kind"], pro: boolean) =>
  renderToStaticMarkup(
    React.createElement(GroupList, { kind, rows: book(pro), pro, busy: null, onOpen: () => {}, onDelete: () => {} }),
  );

describe("the /lenses group list draws the Outcome column as a share", () => {
  it("Outcome, Pro: 'Share of trades' 79% / 21% / —, and no tautological 100% / 0%", () => {
    const html = render("outcome", true);
    // THE assertion (on revert of the lenses-client.tsx column: the header reads
    // "Win rate" and the cells ">100%<" / ">0%<").
    expect(html).toContain(">Share of trades<");
    expect(html).not.toContain(">Win rate<");
    expect(html).toContain(">79%<");
    expect(html).toContain(">21%<");
    expect(html).toContain("33 of 42 closed trades");
    expect(html).not.toContain(">100%<");
    expect(html).not.toContain(">0%<");
  });

  it("Outcome, free: the share is counts, so it renders on the free wire too — not a lock", () => {
    const html = render("outcome", false);
    expect(html).toContain(">Share of trades<");
    expect(html).toContain(">79%<");
    expect(html).toContain(">21%<");
  });

  it("every other lens keeps its Win rate column", () => {
    const html = render("month", true);
    expect(html).toContain(">Win rate<");
    expect(html).not.toContain(">Share of trades<");
    expect(html).toContain(">100%<");
  });
});
