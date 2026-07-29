/**
 * "What kind of trade is this?" — status and outcome, as one vocabulary.
 *
 * ZERO DB and ZERO React imports; pure functions over plain data.
 *
 * ── Why an open trade's outcome is not the same question as a closed one's ──
 *
 * A CLOSED trade has a realised result: net P&L is money that has actually
 * moved, and calling it a profit or a loss is a statement of fact.
 *
 * An OPEN trade has no realised result at all. Whether it is "in gain" depends
 * entirely on a mark price — and if no mark has been set, the honest answer is
 * **not zero, and not breakeven, but unknown**. Vyuha stores `unrealisedPnl`
 * as 0 for an unmarked position, so treating 0 as "flat" would quietly file
 * every unmarked holding under a result it never had.
 *
 * So `outcomeOf` returns `open-unmarked` for those, and the filter says so
 * rather than sorting them into a bucket they do not belong in.
 */

export type TradeStatus = "open" | "closed" | "staged";

export type TradeOutcome =
  | "open-gain"
  | "open-loss"
  | "open-flat"
  | "open-unmarked"
  | "closed-profit"
  | "closed-loss"
  | "closed-flat";

export interface StatusTrade {
  isOpen: boolean;
  staged?: boolean | null;
  netPnl: number;
  unrealisedPnl?: number | null;
  /** The mark used for an open position. Null = never marked. */
  closingPrice?: number | null;
}

/**
 * Status is deliberately NOT exclusive: a staged position is also open or
 * closed, and hiding one behind the other would make "show me my staged
 * trades" and "show me what is open" fight each other.
 */
export function isStaged(t: StatusTrade): boolean {
  return t.staged === true;
}

export function statusOf(t: StatusTrade): TradeStatus {
  if (isStaged(t)) return "staged";
  return t.isOpen ? "open" : "closed";
}

/** True when an open position has a mark to measure an unrealised result from. */
export function isMarked(t: StatusTrade): boolean {
  return t.closingPrice != null && Number.isFinite(t.closingPrice) && t.closingPrice > 0;
}

export function outcomeOf(t: StatusTrade): TradeOutcome {
  if (t.isOpen) {
    // No mark, no opinion. `unrealisedPnl` is 0 for an unmarked position, and
    // reading that 0 as "flat" would invent a result the trade never had.
    if (!isMarked(t)) return "open-unmarked";
    const u = t.unrealisedPnl ?? 0;
    return u > 0 ? "open-gain" : u < 0 ? "open-loss" : "open-flat";
  }
  return t.netPnl > 0 ? "closed-profit" : t.netPnl < 0 ? "closed-loss" : "closed-flat";
}

/** The single filter vocabulary the Trades page exposes. */
export type TradeView =
  | "all"
  | "open"
  | "closed"
  | "staged"
  | "open-gain"
  | "open-loss"
  | "closed-profit"
  | "closed-loss";

export const TRADE_VIEWS: { value: TradeView; label: string; group: string }[] = [
  { value: "all", label: "All trades", group: "" },
  { value: "open", label: "Open", group: "Status" },
  { value: "closed", label: "Closed", group: "Status" },
  { value: "staged", label: "Staged (scaled) positions", group: "Status" },
  { value: "open-gain", label: "In gain — open", group: "Outcome" },
  { value: "open-loss", label: "In loss — open", group: "Outcome" },
  { value: "closed-profit", label: "Profit — closed", group: "Outcome" },
  { value: "closed-loss", label: "Loss — closed", group: "Outcome" },
];

/**
 * Does this trade belong in the chosen view?
 *
 * The status views (open/closed/staged) are broad on purpose — "Open" means
 * every open position, marked or not. The outcome views are narrow for the
 * same reason in reverse: an unmarked open position appears in neither "in
 * gain" nor "in loss", because it is in neither.
 */
export function matchesView(t: StatusTrade, view: TradeView): boolean {
  switch (view) {
    case "all":
      return true;
    case "open":
      return t.isOpen;
    case "closed":
      return !t.isOpen;
    case "staged":
      return isStaged(t);
    case "open-gain":
      return outcomeOf(t) === "open-gain";
    case "open-loss":
      return outcomeOf(t) === "open-loss";
    case "closed-profit":
      return outcomeOf(t) === "closed-profit";
    case "closed-loss":
      return outcomeOf(t) === "closed-loss";
    default:
      return true;
  }
}

export interface ViewCounts {
  all: number;
  open: number;
  closed: number;
  staged: number;
  openGain: number;
  openLoss: number;
  closedProfit: number;
  closedLoss: number;
  /** Open positions with no mark — excluded from gain/loss, reported instead. */
  openUnmarked: number;
}

/** Counts for every view, so the dropdown can show what it will return. */
export function countViews(trades: StatusTrade[]): ViewCounts {
  const c: ViewCounts = {
    all: trades.length, open: 0, closed: 0, staged: 0,
    openGain: 0, openLoss: 0, closedProfit: 0, closedLoss: 0, openUnmarked: 0,
  };
  for (const t of trades) {
    if (t.isOpen) c.open++;
    else c.closed++;
    if (isStaged(t)) c.staged++;
    switch (outcomeOf(t)) {
      case "open-gain": c.openGain++; break;
      case "open-loss": c.openLoss++; break;
      case "open-unmarked": c.openUnmarked++; break;
      case "closed-profit": c.closedProfit++; break;
      case "closed-loss": c.closedLoss++; break;
    }
  }
  return c;
}

/** Count for one view, used to label each option. */
export function countForView(c: ViewCounts, view: TradeView): number {
  switch (view) {
    case "all": return c.all;
    case "open": return c.open;
    case "closed": return c.closed;
    case "staged": return c.staged;
    case "open-gain": return c.openGain;
    case "open-loss": return c.openLoss;
    case "closed-profit": return c.closedProfit;
    case "closed-loss": return c.closedLoss;
    default: return 0;
  }
}
