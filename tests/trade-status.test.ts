import { describe, it, expect } from "vitest";
import {
  statusOf, outcomeOf, isStaged, isMarked, matchesView, countViews, countForView,
  TRADE_VIEWS, type StatusTrade, type TradeView,
} from "@/lib/analytics/trade-status";

const t = (p: Partial<StatusTrade> = {}): StatusTrade => ({
  isOpen: false, staged: false, netPnl: 0, unrealisedPnl: 0, closingPrice: null, ...p,
});

describe("statusOf", () => {
  it("separates open, closed and staged", () => {
    expect(statusOf(t({ isOpen: true }))).toBe("open");
    expect(statusOf(t({ isOpen: false }))).toBe("closed");
    expect(statusOf(t({ isOpen: true, staged: true }))).toBe("staged");
  });

  it("treats a CLOSED staged position as staged too — the ladder is what matters", () => {
    expect(statusOf(t({ isOpen: false, staged: true }))).toBe("staged");
    expect(isStaged(t({ staged: true }))).toBe(true);
    expect(isStaged(t({ staged: null }))).toBe(false);
  });
});

describe("outcomeOf — closed trades have a realised result", () => {
  it("reads net P&L, which is money that actually moved", () => {
    expect(outcomeOf(t({ netPnl: 14087 }))).toBe("closed-profit");
    expect(outcomeOf(t({ netPnl: -8883 }))).toBe("closed-loss");
    expect(outcomeOf(t({ netPnl: 0 }))).toBe("closed-flat");
  });
});

describe("outcomeOf — an OPEN trade without a mark has no result at all", () => {
  it("returns open-unmarked rather than reading unrealisedPnl 0 as flat", () => {
    // This is the trap: Vyuha stores 0 for an unmarked position, so treating
    // 0 as breakeven would file every unmarked holding under a result it
    // never had — and it would then appear in neither gain nor loss silently.
    const unmarked = t({ isOpen: true, unrealisedPnl: 0, closingPrice: null });
    expect(isMarked(unmarked)).toBe(false);
    expect(outcomeOf(unmarked)).toBe("open-unmarked");
  });

  it("classifies gain and loss once a mark exists", () => {
    expect(outcomeOf(t({ isOpen: true, closingPrice: 250, unrealisedPnl: 5000 }))).toBe("open-gain");
    expect(outcomeOf(t({ isOpen: true, closingPrice: 250, unrealisedPnl: -5000 }))).toBe("open-loss");
    expect(outcomeOf(t({ isOpen: true, closingPrice: 250, unrealisedPnl: 0 }))).toBe("open-flat");
  });

  it("rejects a zero or negative mark as no mark at all", () => {
    expect(isMarked(t({ isOpen: true, closingPrice: 0 }))).toBe(false);
    expect(outcomeOf(t({ isOpen: true, closingPrice: 0, unrealisedPnl: 900 }))).toBe("open-unmarked");
  });

  it("never lets an open trade be read as a realised profit", () => {
    // netPnl on an open staged position is the realised part of the ladder;
    // it must not make the position look closed-profit.
    const o = t({ isOpen: true, netPnl: 14087, closingPrice: null });
    expect(outcomeOf(o)).toBe("open-unmarked");
    expect(outcomeOf(o)).not.toBe("closed-profit");
  });
});

describe("matchesView", () => {
  const openGain = t({ isOpen: true, closingPrice: 250, unrealisedPnl: 5000 });
  const openLoss = t({ isOpen: true, closingPrice: 250, unrealisedPnl: -5000 });
  const openUnmarked = t({ isOpen: true, closingPrice: null });
  const win = t({ netPnl: 1000 });
  const lose = t({ netPnl: -1000 });
  const stagedOpen = t({ isOpen: true, staged: true, closingPrice: 100, unrealisedPnl: 10 });

  it("'all' returns everything", () => {
    for (const x of [openGain, openLoss, openUnmarked, win, lose, stagedOpen]) {
      expect(matchesView(x, "all")).toBe(true);
    }
  });

  it("status views are broad — 'open' includes unmarked and staged positions", () => {
    expect(matchesView(openUnmarked, "open")).toBe(true);
    expect(matchesView(stagedOpen, "open")).toBe(true);
    expect(matchesView(win, "open")).toBe(false);
  });

  it("'staged' finds scaled positions whether open or closed", () => {
    expect(matchesView(stagedOpen, "staged")).toBe(true);
    expect(matchesView(t({ isOpen: false, staged: true }), "staged")).toBe(true);
    expect(matchesView(win, "staged")).toBe(false);
  });

  it("outcome views are narrow — an unmarked open trade is in NEITHER gain nor loss", () => {
    expect(matchesView(openUnmarked, "open-gain")).toBe(false);
    expect(matchesView(openUnmarked, "open-loss")).toBe(false);
    // …but it is still findable under the status view.
    expect(matchesView(openUnmarked, "open")).toBe(true);
  });

  it("keeps realised and unrealised results apart", () => {
    expect(matchesView(openGain, "closed-profit")).toBe(false);
    expect(matchesView(win, "open-gain")).toBe(false);
    expect(matchesView(openLoss, "open-loss")).toBe(true);
    expect(matchesView(lose, "closed-loss")).toBe(true);
  });
});

describe("countViews", () => {
  const book: StatusTrade[] = [
    t({ isOpen: true, closingPrice: 250, unrealisedPnl: 5000 }),   // open gain
    t({ isOpen: true, closingPrice: 250, unrealisedPnl: -900 }),   // open loss
    t({ isOpen: true, closingPrice: null }),                        // open, unmarked
    t({ isOpen: true, staged: true, closingPrice: 100, unrealisedPnl: 1 }), // staged open gain
    t({ netPnl: 1000 }),                                            // closed profit
    t({ netPnl: -1000 }),                                           // closed loss
    t({ netPnl: 0 }),                                               // closed flat
  ];
  const c = countViews(book);

  it("counts every bucket without double-counting the total", () => {
    expect(c.all).toBe(7);
    expect(c.open).toBe(4);
    expect(c.closed).toBe(3);
    expect(c.open + c.closed).toBe(c.all);
  });

  it("counts staged alongside status rather than instead of it", () => {
    expect(c.staged).toBe(1);
  });

  it("reports unmarked opens separately so they are never silently dropped", () => {
    expect(c.openGain).toBe(2);
    expect(c.openLoss).toBe(1);
    expect(c.openUnmarked).toBe(1);
    // Every open trade lands in exactly one outcome bucket.
    expect(c.openGain + c.openLoss + c.openUnmarked).toBe(c.open);
  });

  it("closed outcomes reconcile with the closed count", () => {
    expect(c.closedProfit).toBe(1);
    expect(c.closedLoss).toBe(1);
    // The third closed trade is flat, which is neither profit nor loss.
    expect(c.closedProfit + c.closedLoss).toBe(c.closed - 1);
  });

  it("countForView agrees with matchesView for every option offered", () => {
    for (const v of TRADE_VIEWS) {
      const byFilter = book.filter((x) => matchesView(x, v.value as TradeView)).length;
      expect(countForView(c, v.value as TradeView), v.value).toBe(byFilter);
    }
  });

  it("handles an empty book", () => {
    const z = countViews([]);
    expect(z.all).toBe(0);
    expect(z.openUnmarked).toBe(0);
  });
});
