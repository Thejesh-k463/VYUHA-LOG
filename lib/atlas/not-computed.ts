/**
 * The honesty list (v4.6.0 W5, owner rulings AQ10 / AQ11, Option B point 4):
 * what Atlas does NOT compute, and why — in Vyuha's OWN words.
 *
 * A static registry. No vendor name, no widget title, no dashboard id: the
 * list describes families of market context and the gate each one waits
 * behind, never another product's screen. `tests/atlas-not-computed.test.ts`
 * scans it for the forbidden vocabulary.
 *
 *   "later"  — computable once the named input exists (an intraday feed, a
 *              fundamentals source the user brings).
 *   "never"  — deliberately not computed here (owner: OI / delivery never).
 *
 * PURE: constants only.
 */

export type NotComputedWhy = "needs an intraday feed" | "needs fundamentals" | "not computed here";
export type NotComputedStatus = "later" | "never";

export interface NotComputedFamily {
  /** The family, in plain words. */
  family: string;
  why: NotComputedWhy;
  status: NotComputedStatus;
  /** One sentence on what the gate is, so a greyed tile can say it. */
  note: string;
}

export const NOT_COMPUTED: readonly NotComputedFamily[] = [
  {
    family: "Intraday advances and declines",
    why: "needs an intraday feed",
    status: "later",
    note: "Breadth through the session needs tick or minute data; Atlas reads one end-of-day close per symbol.",
  },
  {
    family: "Intraday volume pace",
    why: "needs an intraday feed",
    status: "later",
    note: "Volume against the time of day needs a live tape; the daily total is all a bhavcopy carries.",
  },
  {
    family: "Opening gaps and opening-range statistics",
    why: "needs an intraday feed",
    status: "later",
    note: "The open and the first minutes are in the file, but ranges through the day are not.",
  },
  {
    family: "Institutional buying and selling (foreign and domestic)",
    why: "needs fundamentals",
    status: "later",
    note: "Published separately from prices and never in a bhavcopy; nothing here fetches it.",
  },
  {
    family: "Promoter holding changes",
    why: "needs fundamentals",
    status: "later",
    note: "Shareholding patterns are quarterly filings, not price data.",
  },
  {
    family: "Earnings, valuation and balance-sheet screens",
    why: "needs fundamentals",
    status: "later",
    note: "Ratios need a fundamentals source the user brings; Atlas has prices and volumes only.",
  },
  {
    family: "Open interest and derivatives positioning",
    why: "not computed here",
    status: "never",
    note: "A derivatives book is a different market with its own denominators; the cash Atlas will not borrow one.",
  },
  {
    family: "Delivery percentage",
    why: "not computed here",
    status: "never",
    note: "Only the legacy file carries a delivery column, and a figure that exists on some sessions and not others is not a series.",
  },
];

/** The families under one gate, in registry order. */
export function notComputedBy(why: NotComputedWhy): NotComputedFamily[] {
  return NOT_COMPUTED.filter((f) => f.why === why);
}

/** The three gate headings, in the order tab 5 prints them. */
export const NOT_COMPUTED_GATES: readonly NotComputedWhy[] = ["needs an intraday feed", "needs fundamentals", "not computed here"];
