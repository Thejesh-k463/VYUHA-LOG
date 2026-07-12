// Curated starter setups from globally-recognized trading approaches — a
// starting point the user picks, edits to their own style, and saves via the
// same add-playbook flow. Not prescriptive advice; just checklists to adapt.

export interface PresetPlaybook {
  name: string;
  description: string;
  rules: string[];
}

export const PRESET_PLAYBOOKS: PresetPlaybook[] = [
  {
    name: "Opening Range Breakout (ORB)",
    description: "Trade the break of the first N-minute range once the market shows direction.",
    rules: [
      "Mark the high/low of the first 15–30 minutes",
      "Enter only on a decisive close beyond the range, not a wick",
      "Stop at the opposite side of the range",
      "Skip the setup on flat/rangebound opens",
    ],
  },
  {
    name: "VWAP Reversion / Reversal",
    description: "Fade extended moves back toward VWAP, or ride a reclaim of VWAP as a trend shift.",
    rules: [
      "Only trade when price is meaningfully stretched from VWAP",
      "Wait for a rejection candle/confirmation, don't pre-empt",
      "Target VWAP itself, not beyond, unless momentum confirms",
      "No trade if VWAP is flat and choppy",
    ],
  },
  {
    name: "Trend Following (Moving Average Pullback)",
    description: "Join an established trend on a pullback to a key moving average (e.g. 20/50 EMA).",
    rules: [
      "Only trade in the direction of the higher-timeframe trend",
      "Wait for price to pull back to the MA, not chase extension",
      "Enter on a rejection/reversal candle at the MA",
      "Stop below/above the most recent swing point",
    ],
  },
  {
    name: "Breakout–Pullback (Retest Entry)",
    description: "Let a breakout happen, then enter on the retest of the broken level instead of chasing the initial move.",
    rules: [
      "Identify a clear resistance/support level with prior tests",
      "Wait for a clean breakout with volume/momentum",
      "Enter only on the retest holding as new support/resistance",
      "Invalidate the idea if price closes back through the level",
    ],
  },
  {
    name: "Mean Reversion (Range Fade)",
    description: "Fade extremes within an established, well-defined trading range.",
    rules: [
      "Confirm the instrument is in a genuine range, not trending",
      "Enter near range boundaries, not the middle",
      "Stop just beyond the range boundary",
      "Exit at or before the opposite boundary — don't overstay",
    ],
  },
  {
    name: "Gap-and-Go",
    description: "Trade continuation of a significant overnight/opening gap in the direction of the gap.",
    rules: [
      "Only trade gaps backed by a clear news/earnings catalyst",
      "Wait for the first few minutes to establish direction",
      "Enter on continuation above/below the opening range",
      "Reduce size — gap days are higher volatility, wider stops",
    ],
  },
  {
    name: "Momentum / Relative Strength",
    description: "Trade the strongest (or weakest) names in a hot sector during a clear market trend.",
    rules: [
      "Screen for stocks leading their sector on volume + price",
      "Enter only when broader market trend agrees with direction",
      "Trail the stop instead of setting a fixed target",
      "Exit fully on the first clear reversal signal",
    ],
  },
  {
    name: "Options: Theta Decay (Premium Selling)",
    description: "Sell premium (e.g. credit spreads/iron condors) in range-bound or high-IV conditions, targeting time decay.",
    rules: [
      "Only sell premium when implied vol is elevated vs historical",
      "Define max loss upfront — defined-risk structures only",
      "Manage/close at a fixed profit target, don't hold to expiry greed",
      "Avoid initiating new positions right before major events/earnings",
    ],
  },
  {
    name: "Earnings/Event Play",
    description: "Trade the reaction to a scheduled catalyst (earnings, policy, results) rather than pre-empting it.",
    rules: [
      "No position sized to \"guess\" the outcome ahead of the event",
      "Enter only after the market has reacted and shown direction",
      "Size down given the wider expected volatility",
      "Have a clear invalidation level before entry",
    ],
  },
  {
    name: "Swing Trade — Multi-Day Setup",
    description: "Hold a position for several days to weeks, targeting a larger structural move.",
    rules: [
      "Confirm setup on daily/weekly timeframe, not just intraday noise",
      "Risk a fixed, small % of capital per swing",
      "Use a wider stop that respects the timeframe — no intraday-tight stops",
      "Review the thesis only on new information, not daily price noise",
    ],
  },
];
