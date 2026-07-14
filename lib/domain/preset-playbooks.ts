// Curated starter setups from globally-recognized trading approaches — a
// starting point the user picks, edits to their own metrics (risk %, R:R,
// timeframes, deltas), and saves via the same add-playbook flow. Grouped by
// the trading ecosystem each comes from. Not prescriptive advice; just
// checklists to adapt. Every metric in a rule (1%, 2xATR, 16-delta, 7-8%…)
// is deliberately editable before saving — they are the knobs, not gospel.

export interface PresetPlaybook {
  name: string;
  category: string;
  description: string;
  rules: string[];
}

export const PRESET_PLAYBOOKS: PresetPlaybook[] = [
  // ------------------------------------------------------------------
  // Intraday & Momentum — the classic day-trading ecosystem (US/India)
  // ------------------------------------------------------------------
  {
    name: "Opening Range Breakout (ORB)",
    category: "Intraday & Momentum",
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
    category: "Intraday & Momentum",
    description: "Fade extended moves back toward VWAP, or ride a reclaim of VWAP as a trend shift.",
    rules: [
      "Only trade when price is meaningfully stretched from VWAP",
      "Wait for a rejection candle/confirmation, don't pre-empt",
      "Target VWAP itself, not beyond, unless momentum confirms",
      "No trade if VWAP is flat and choppy",
    ],
  },
  {
    name: "Gap-and-Go",
    category: "Intraday & Momentum",
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
    category: "Intraday & Momentum",
    description: "Trade the strongest (or weakest) names in a hot sector during a clear market trend.",
    rules: [
      "Screen for stocks leading their sector on volume + price",
      "Enter only when broader market trend agrees with direction",
      "Trail the stop instead of setting a fixed target",
      "Exit fully on the first clear reversal signal",
    ],
  },

  // ------------------------------------------------------------------
  // Breakout & Trend — systematic trend-following lineage (Turtles,
  // Darvas, momentum research)
  // ------------------------------------------------------------------
  {
    name: "Trend Following (Moving Average Pullback)",
    category: "Breakout & Trend",
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
    category: "Breakout & Trend",
    description: "Let a breakout happen, then enter on the retest of the broken level instead of chasing the initial move.",
    rules: [
      "Identify a clear resistance/support level with prior tests",
      "Wait for a clean breakout with volume/momentum",
      "Enter only on the retest holding as new support/resistance",
      "Invalidate the idea if price closes back through the level",
    ],
  },
  {
    name: "Donchian Channel Breakout (Turtle-style)",
    category: "Breakout & Trend",
    description: "Mechanical breakout system from the famous Turtle experiment — N-day channel entries with ATR-based sizing.",
    rules: [
      "Enter on a close above the 20-day high (long) — no discretion",
      "Size the position off ATR so a 2×ATR move ≈ 1% of capital",
      "Initial stop 2×ATR from entry; add units only per plan",
      "Exit on the opposite 10-day channel — never override the system",
    ],
  },
  {
    name: "52-Week-High Momentum",
    category: "Breakout & Trend",
    description: "Research-backed momentum: stocks near their 52-week high tend to keep outperforming.",
    rules: [
      "Screen for stocks within 5% of their 52-week high on rising volume",
      "Enter on the fresh breakout to a new high, not in anticipation",
      "Stop below the most recent consolidation low",
      "Hold while higher highs keep printing; exit on trend break",
    ],
  },
  {
    name: "Darvas Box",
    category: "Breakout & Trend",
    description: "Nicolas Darvas' box theory — buy breakouts from tight consolidation boxes, trail box-by-box.",
    rules: [
      "Mark the box: a tight high–low range holding at least 3 sessions",
      "Buy only a close above the box top on expanding volume",
      "Stop just below the broken box top",
      "Trail the stop up box-by-box as new boxes form",
    ],
  },

  // ------------------------------------------------------------------
  // Positional / Growth — the O'Neil / Minervini / Wyckoff / Weinstein
  // school of multi-week position trading
  // ------------------------------------------------------------------
  {
    name: "CANSLIM Breakout (O'Neil)",
    category: "Positional / Growth",
    description: "William O'Neil's growth framework — strong earnings + sound base + market uptrend.",
    rules: [
      "Current & annual earnings growth ≥ 25% before the chart even matters",
      "Buy at the pivot of a sound base (cup-with-handle, flat base), never >5% extended",
      "Cut every loss at 7–8% below the buy point — no exceptions",
      "New buys only in a confirmed market uptrend (the M in CANSLIM)",
    ],
  },
  {
    name: "VCP Breakout (Minervini SEPA)",
    category: "Positional / Growth",
    description: "Mark Minervini's Volatility Contraction Pattern — tightening pullbacks with drying volume, then the pivot.",
    rules: [
      "Stock must be in a Stage-2 uptrend (above rising 150/200-DMA)",
      "Contractions tighten left to right with volume drying up",
      "Buy the pivot breakout from the final, tightest contraction",
      "Risk ≤ 1R with the stop under the pivot; sell into strength per plan",
    ],
  },
  {
    name: "Wyckoff Spring (Accumulation)",
    category: "Positional / Growth",
    description: "Enter on the spring/shakeout at the end of a Wyckoff accumulation range — the false break that traps sellers.",
    rules: [
      "Identify a genuine accumulation range after a downtrend",
      "Enter on the spring: a false break below support that snaps back inside",
      "Stop below the spring low",
      "Target the projected markup from the range (structure or P&F count)",
    ],
  },
  {
    name: "Stage 2 Breakout (Weinstein)",
    category: "Positional / Growth",
    description: "Stan Weinstein's stage analysis — own stocks only in Stage 2 above a rising 30-week MA.",
    rules: [
      "Buy only Stage-2 breakouts above a rising 30-week MA",
      "Confirm with volume expansion on the breakout week",
      "Never hold through a Stage-4 decline — no averaging down",
      "Trail with the 30-week MA; exit on a decisive weekly close below it",
    ],
  },

  // ------------------------------------------------------------------
  // Mean Reversion — the quant/short-term reversion ecosystem
  // ------------------------------------------------------------------
  {
    name: "Mean Reversion (Range Fade)",
    category: "Mean Reversion",
    description: "Fade extremes within an established, well-defined trading range.",
    rules: [
      "Confirm the instrument is in a genuine range, not trending",
      "Enter near range boundaries, not the middle",
      "Stop just beyond the range boundary",
      "Exit at or before the opposite boundary — don't overstay",
    ],
  },
  {
    name: "RSI-2 Pullback (Connors)",
    category: "Mean Reversion",
    description: "Larry Connors' short-term reversion — deep 2-period-RSI oversold inside a long-term uptrend.",
    rules: [
      "Only in instruments trading above their 200-DMA (trend filter)",
      "Enter when 2-period RSI closes below 10",
      "Exit on a close above the 5-DMA — this is a days-not-weeks trade",
      "Size for overnight gap risk; never widen the stop",
    ],
  },
  {
    name: "Bollinger Band Reversion",
    category: "Mean Reversion",
    description: "Fade closes outside the bands back to the mean — only in a range regime.",
    rules: [
      "Range regime only: band width contracting, no higher-timeframe trend",
      "Fade a close outside the band on a reversal candle back inside",
      "Target the middle band (20-DMA); stop beyond the extreme",
      "Skip entirely when bands are expanding — that's breakout regime",
    ],
  },

  // ------------------------------------------------------------------
  // Price Action / SMC — level-first discretionary trading (incl. the
  // ICT/Smart-Money-Concepts ecosystem)
  // ------------------------------------------------------------------
  {
    name: "Liquidity Sweep + FVG (ICT/SMC)",
    category: "Price Action / SMC",
    description: "Smart-money concepts: trade the stop-hunt through an obvious level, enter on the displacement back.",
    rules: [
      "Mark prior day/session highs-lows where stops cluster (liquidity pools)",
      "Wait for a sweep through the level that immediately rejects",
      "Enter on the return through a fair-value gap / order block",
      "Stop beyond the sweep extreme; target the opposite liquidity pool",
    ],
  },
  {
    name: "Supply & Demand Zones",
    category: "Price Action / SMC",
    description: "Trade the first retest of fresh institutional supply/demand zones left by strong departures.",
    rules: [
      "Mark fresh zones from strong departures (rally-base-rally, drop-base-drop)",
      "Enter on the FIRST retest of an untested zone only",
      "Stop just beyond the zone's far edge",
      "Minimum 1:2 planned R:R or skip the trade",
    ],
  },
  {
    name: "Pin Bar / Rejection at Key Level",
    category: "Price Action / SMC",
    description: "Classic price-action rejection — but only at pre-marked levels, never in the middle of nowhere.",
    rules: [
      "Only at pre-marked levels: prior S/R, round numbers, higher-timeframe MAs",
      "Rejection wick must be ≥ 2/3 of the candle's range",
      "Enter on break of the pin bar's nose; stop beyond the wick",
      "Level first, candle second — no level, no trade",
    ],
  },

  // ------------------------------------------------------------------
  // Options & Events — income structures + event trading (incl. the
  // India weekly-expiry ecosystem)
  // ------------------------------------------------------------------
  {
    name: "Options: Theta Decay (Premium Selling)",
    category: "Options & Events",
    description: "Sell premium (e.g. credit spreads/iron condors) in range-bound or high-IV conditions, targeting time decay.",
    rules: [
      "Only sell premium when implied vol is elevated vs historical",
      "Define max loss upfront — defined-risk structures only",
      "Manage/close at a fixed profit target, don't hold to expiry greed",
      "Avoid initiating new positions right before major events/earnings",
    ],
  },
  {
    name: "Iron Condor (Range-Bound Index)",
    category: "Options & Events",
    description: "Defined-risk four-leg premium sale on an index expected to stay inside a range.",
    rules: [
      "Sell only when IV looks overpriced vs realized movement",
      "Short strikes beyond ±1 SD (~16-delta); wings define the max loss",
      "Take profit at 50% of max credit; exit/adjust at 2× credit loss",
      "No new condors right before major scheduled events",
    ],
  },
  {
    name: "Expiry-Day Theta (India Weekly)",
    category: "Options & Events",
    description: "India's weekly index expiry ecosystem — harvesting the final-day premium crush with hard risk caps.",
    rules: [
      "Index weeklies on expiry day only — defined-risk spreads, never naked",
      "Enter after the opening volatility settles, not at the bell",
      "Strikes beyond the day's expected move; exit if a short strike is breached",
      "Hard daily loss cap; one adjustment max — never martingale",
    ],
  },
  {
    name: "Earnings/Event Play",
    category: "Options & Events",
    description: "Trade the reaction to a scheduled catalyst (earnings, policy, results) rather than pre-empting it.",
    rules: [
      "No position sized to \"guess\" the outcome ahead of the event",
      "Enter only after the market has reacted and shown direction",
      "Size down given the wider expected volatility",
      "Have a clear invalidation level before entry",
    ],
  },

  // ------------------------------------------------------------------
  // Swing & Overnight — multi-day holds (incl. the India BTST pattern)
  // ------------------------------------------------------------------
  {
    name: "Swing Trade — Multi-Day Setup",
    category: "Swing & Overnight",
    description: "Hold a position for several days to weeks, targeting a larger structural move.",
    rules: [
      "Confirm setup on daily/weekly timeframe, not just intraday noise",
      "Risk a fixed, small % of capital per swing",
      "Use a wider stop that respects the timeframe — no intraday-tight stops",
      "Review the thesis only on new information, not daily price noise",
    ],
  },
  {
    name: "BTST (Buy Today, Sell Tomorrow)",
    category: "Swing & Overnight",
    description: "India's overnight momentum pattern — strong close, gap capture, out by next morning.",
    rules: [
      "Only stocks closing strong (top of range) with momentum/news into the close",
      "Enter in the last 15–30 minutes, not mid-day",
      "Exit into next-day opening strength or the first 30 minutes",
      "Size for gap-down risk; skip ahead of major overnight events",
    ],
  },
];

/** Category names in display order (order of first appearance). */
export function presetCategories(): string[] {
  const seen: string[] = [];
  for (const p of PRESET_PLAYBOOKS) if (!seen.includes(p.category)) seen.push(p.category);
  return seen;
}
