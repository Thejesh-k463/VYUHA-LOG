// Metric education layer — a PURE registry (no DB, no React; AGENTS.md
// invariant 2) of what every performance/scaling KPI actually measures, in the
// conventions THIS codebase uses, not the textbook ones.
//
// House rules, enforced by tests/metric-help.test.ts:
//  - `healthyRange` is ALWAYS a hedged heuristic with its assumption stated
//    ("commonly read as … depends on capital base and trading style") — never
//    a target. A journal that hands out targets invents a benchmark it does
//    not have (AGENTS.md invariant 6 in spirit).
//  - `whatToDo` is DESCRIPTIVE — what traders historically change when they
//    dislike the number — never "you should".
//  - Label honesty: where a figure's convention differs from what its name
//    suggests (Expectancy is ₹ not R; two max-drawdown definitions coexist;
//    Sharpe runs on realised-only days; alpha annualises arithmetically), the
//    entry says so.
//
// Rendering goes through the EXISTING KpiCard `detail` prop: `metricDetail()`
// adapts an entry into the KpiDetail row shape (plain strings, so it crosses
// the RSC boundary), `metricGlossary()` gives compact term/definition pairs,
// and `metricCaveatLine()` a one-liner for inline paragraphs.

export interface MetricHelpEntry {
  /** Dialog title in the house voice — "Metric — and the catch". */
  title: string;
  /** What it measures. Becomes the dialog summary. */
  meaning: string;
  /** How it is computed — this codebase's actual convention, not the textbook's. */
  formula: string;
  /** A hedged heuristic with its assumption stated. Never a target. */
  healthyRange: string;
  /** The label-honesty line — what the name suggests but the number is not. */
  caveat: string;
  /** What traders historically change. Descriptive, never prescriptive. */
  whatToDo: string;
}

/** Substituted into entries as `{key}` — e.g. the page's RISK_FREE constant
 *  arrives as `{riskFreePct}` so the rate is stated once, in the page. */
export type MetricHelpVars = Record<string, string>;

export const METRIC_HELP = {
  // ── Performance — the KPI band ────────────────────────────────────────────
  totalReturn: {
    title: "Total return — end equity over start",
    meaning:
      "How much the realised P&L walk grew the configured starting capital over the dated trade history.",
    formula:
      "(ending equity − starting equity) ÷ starting equity, where equity walks the configured capital through each day's realised net P&L. Only trades with an exit date can join the walk.",
    healthyRange:
      "Commonly read next to what the same rupees would have earned parked in an index or fixed income over the same window; there is no universal bar — it depends on the capital base, the window length and the trading style.",
    caveat:
      "Realised and dated only: undated closed trades and open positions are invisible here, which is why this can disagree with the dashboard's Net P&L. The coverage note above states the gap when one exists.",
    whatToDo:
      "Traders who find this smaller than expected historically look at the gross-to-net gap first — charges compound against the walk on every single day it contains.",
  },
  xirr: {
    title: "XIRR — the money-weighted return",
    meaning:
      "The annualised rate that makes your deposits, withdrawals and today's terminal value net out — the return your actual rupees experienced, timing included.",
    formula:
      "Internal rate of return over the opening capital and the cash ledger's external flows, closing on today's terminal value (capital + flows + realised + unrealised P&L), all carried in integer paise.",
    healthyRange:
      "Commonly compared against a fixed-income alternative over the same window; it depends on the capital base, on when deposits arrived and on trading style, and under ~30 days it is unstable enough that the card says so.",
    caveat:
      "Deposit timing moves it: capital that arrives just before a good month flatters XIRR without any change in skill. Skill in isolation is TWR's job, not this one's.",
    whatToDo:
      "Traders historically read XIRR beside TWR — XIRR lagging TWR has meant capital tended to arrive at unlucky times, XIRR leading it that timing helped.",
  },
  twr: {
    title: "TWR — the manager-skill return",
    meaning:
      "Chains each day's return on that day's equity while neutralising deposits and withdrawals — the return a fund would report on the same trading.",
    formula:
      "Product of (1 + day's net P&L ÷ that day's pre-P&L equity) across days with realised P&L, minus 1. A deposit or withdrawal resizes the base for its day but is never counted as return. Annualised only past 30 days.",
    healthyRange:
      "Commonly read against a benchmark index over the same window rather than against a fixed number; what is good depends on the capital base, the market regime and the trading style.",
    caveat:
      "Built from realised P&L on dated trades only — open positions and undated trades do not exist to it, so its window can be narrower than the book.",
    whatToDo:
      "Traders historically use the TWR-vs-XIRR gap to separate skill from deposit timing, and the benchmark panel below to ask whether the effort beat simply holding the index.",
  },
  cagr: {
    title: "CAGR — annualised growth",
    meaning:
      "The constant yearly rate that would compound the starting equity into the ending equity over the same calendar span.",
    formula:
      "(1 + total return) ^ (365 ÷ calendar days) − 1, computed only when the dated history spans at least 30 days.",
    healthyRange:
      "Commonly compared with index and fixed-income returns over long horizons; it depends on the capital base, leverage and above all on how long the history is — a hot quarter annualises into fiction.",
    caveat:
      "Annualising projects the observed window onto a full year it never lived. The under-30-day guard blocks the worst of it, but a two-month CAGR is still mostly extrapolation.",
    whatToDo:
      "Traders historically start trusting CAGR only once several quarters of history exist, and read it together with max drawdown — that pairing is exactly what Calmar is.",
  },
  sharpe: {
    title: "Sharpe — return per unit of wobble",
    meaning:
      "Average daily return in excess of the risk-free rate, divided by the volatility of those daily returns, annualised — how much return each unit of variability bought.",
    formula:
      "(mean daily excess return over a {riskFreePct} annual risk-free rate) × 252, divided by (daily standard deviation × √252). Only days with realised P&L participate in the series.",
    healthyRange:
      "In fund literature above 1 is commonly called decent and above 2 strong — but that assumes a continuously marked daily series; on a realised-only series the bar shifts, and it depends on the capital base and trading style.",
    caveat:
      "The series contains only days on which something was realised, annualised ×√252 — so comparability with a fund's Sharpe, marked every day including flat ones, is limited. It also penalises upside volatility exactly like downside.",
    whatToDo:
      "Traders who dislike the upside penalty historically read Sortino beside it; traders with lumpy realised histories read both with suspicion and lean on drawdown figures instead.",
  },
  sortino: {
    title: "Sortino — Sharpe that only counts downside",
    meaning:
      "The same excess return as Sharpe, divided by downside deviation only — volatility contributed by winning days stops counting against the score.",
    formula:
      "(mean daily excess return over a {riskFreePct} annual risk-free rate) × 252, divided by (downside deviation × √252), on the same realised-only daily series as Sharpe.",
    healthyRange:
      "Commonly read as healthy when comfortably above Sharpe and above ~1, with the same assumption baked in — a realised-only series — so it depends on trading style and how continuously the book realises P&L.",
    caveat:
      "It shares Sharpe's blind spot: days with nothing realised do not exist to it, so comparisons with continuously marked fund figures remain limited.",
    whatToDo:
      "Traders historically compare it with Sharpe — a much higher Sortino has meant the wobble was mostly upside; a similar one, that losses drove it.",
  },
  calmar: {
    title: "Calmar — growth per unit of pain",
    meaning:
      "CAGR divided by max drawdown — how much annualised growth each percentage point of worst-case pain bought.",
    formula:
      "CAGR % ÷ max drawdown % (the same %-of-equity walk as the Max drawdown card). Needs both a 30-day window and a nonzero drawdown to exist.",
    healthyRange:
      "Commonly read as respectable above ~1 in managed-futures circles — but the figure depends heavily on history length, because short histories understate the drawdown that will eventually arrive.",
    caveat:
      "Its denominator is one single worst episode: a lone bad week can halve Calmar while every other number on this page barely moves.",
    whatToDo:
      "Traders historically use it to compare their own periods against each other rather than against published fund figures, whose marking conventions differ from a realised-only walk.",
  },
  maxDrawdown: {
    title: "Max drawdown — the deepest valley",
    meaning:
      "The worst peak-to-trough fall of the equity walk — how much of a prior high was given back before the recovery began.",
    formula:
      "This page walks the configured capital through each day's realised P&L, tracks the running peak, and takes the deepest (equity − peak) ÷ peak as the %; the ₹ figure is the deepest peak-to-trough difference of the same walk. The dashboard's Max DD uses a different convention — it walks cumulative realised P&L trade by trade from zero, with no capital base — so the two ₹ figures can legitimately disagree.",
    healthyRange:
      "Risk-focused traders commonly try to keep it under ~20% of equity, but what is survivable depends on the capital base, leverage and whether the capital is replaceable — there is no universal line.",
    caveat:
      "Realised-only and daily-bucketed: intraday troughs and open-position pain never register. And it only describes the past — the next drawdown owes the historical one nothing.",
    whatToDo:
      "Traders historically size positions from the drawdown they can live with, letting that cap position size, rather than sizing from the return they would like.",
  },
  volatility: {
    title: "Volatility — the size of a typical day",
    meaning:
      "Annualised standard deviation of daily returns — how big a typical day is, up or down, with no regard for direction.",
    formula:
      "Standard deviation of daily returns on days with realised P&L, multiplied by √252.",
    healthyRange:
      "Equity indices commonly run ~15–20% annualised; a trading book can sensibly run well above or below that — it depends on the capital base, leverage and style, and a great winning streak raises it just like a losing one.",
    caveat:
      "Computed only on days with realised P&L and annualised ×√252, so it is not directly comparable with a fund's volatility marked every calendar day.",
    whatToDo:
      "Traders historically watch its trend more than its level — volatility that doubles while returns stay flat has been a reliable position-size-creep signal.",
  },
  positiveDays: {
    title: "Positive days — how often a day ends green",
    meaning:
      "The share of trading days — days with realised P&L — that closed with a net gain.",
    formula:
      "Days with net realised P&L above zero ÷ all days with realised P&L. Days on which nothing was closed do not count on either side.",
    healthyRange:
      "Commonly read around 50–60% for intraday styles while trend-followers healthily run far lower — it depends entirely on trading style, and says nothing on its own about magnitude.",
    caveat:
      "A book can be green 70% of days and still lose money if the red days are bigger. Frequency without magnitude is half a statistic.",
    whatToDo:
      "Traders historically read it with the best/worst-day card beside it — frequency times magnitude is the actual arithmetic of a P&L.",
  },
  bestWorstDay: {
    title: "Best / worst day — the tails of the daily P&L",
    meaning:
      "The single largest daily gain and daily loss in the realised series — the tails that averages hide.",
    formula:
      "Maximum and minimum of daily net realised P&L; with capital configured they are expressed as % of the prior day's equity, without it as exact ₹ figures.",
    healthyRange:
      "Commonly watched for asymmetry — a worst day that dwarfs the best is read as tail risk; what magnitude is acceptable depends on the capital base and trading style.",
    caveat:
      "Single-day extremes on realised P&L only: a slow multi-day bleed never appears here, and neither does an open position's worst moment.",
    whatToDo:
      "Traders historically interrogate the worst day — one trade or many, planned risk or a blow-up? Filtering the Trades view to that date answers it.",
  },

  // ── Performance — Monte Carlo ─────────────────────────────────────────────
  riskOfRuin: {
    title: "Risk of ruin — odds of ever losing half",
    meaning:
      "The share of simulated year-ahead paths that at ANY point touched −50% of today's equity — a path statistic, not just where the year ends.",
    formula:
      "Bootstrap: each simulated day replays one of your own realised daily returns at random (seeded, so the figure is reproducible); a path counts as ruin if it ever falls to half the starting equity within the horizon.",
    healthyRange:
      "Commonly wanted near zero — low single digits at most — but the tolerable level depends on whether the capital is replaceable and on the trading style being simulated.",
    caveat:
      "The simulation can only replay the history it was given: a regime it never saw, or a size change made tomorrow, is not in the deck. Informational, not predictive.",
    whatToDo:
      "Traders historically answer a high figure with size rather than signal — smaller positions shrink every daily return being resampled, and ruin odds fall fast.",
  },
  probEndingDown: {
    title: "P(ending down) — odds the year ends underwater",
    meaning:
      "The share of simulated paths whose terminal equity lands below today's — the odds of a flat-to-losing year, given your own return distribution.",
    formula:
      "Simulated paths ending below the starting equity ÷ all paths, over the same seeded bootstrap as the other Monte Carlo figures.",
    healthyRange:
      "Commonly read against a coin flip — well under 50% suggests the sampled days carry positive drift; it depends entirely on how representative the sampled history is of what comes next.",
    caveat:
      "Path-blind: a path that dipped 40% mid-year and recovered counts as fine here. Risk of ruin, beside it, exists to catch exactly those.",
    whatToDo:
      "Traders historically read it with the percentile cards — the odds of ending down matter less than whether the plausible bad year is survivable.",
  },
  mcOutcomes: {
    title: "Monte Carlo percentiles — the spread of plausible years",
    meaning:
      "Where the simulated year-ahead equity lands at chosen percentiles — a plausible bad year (p5), the median (p50) and a plausible good one (p95).",
    formula:
      "Percentiles of terminal equity across all simulated paths, each path built by resampling your own realised daily returns with replacement.",
    healthyRange:
      "Commonly read as a spread, never a forecast — the useful question is whether the p5 outcome is survivable, which depends on the capital base and what the capital is needed for.",
    caveat:
      "These are percentiles of a resample of the past; the actual year ahead is under no obligation to stay inside them. 90% of paths landing between p5 and p95 is true by construction, not by prophecy.",
    whatToDo:
      "Traders historically plan around p5 — when the plausible bad year is unaffordable, position size, not the simulation, is what they change.",
  },

  // ── Performance — benchmark ───────────────────────────────────────────────
  alpha: {
    title: "Alpha — return the index does not explain",
    meaning:
      "The annualised excess return left after subtracting what beta times the index's own move would have produced — the edge, if one exists.",
    formula:
      "Daily α from a CAPM-style regression of portfolio excess returns on index excess returns (over a {riskFreePct} annual risk-free rate), annualised arithmetically — daily α × 252 — NOT geometrically compounded.",
    healthyRange:
      "Commonly read as any reliably positive figure being noteworthy, since most funds do not sustain one — but its reliability depends on the overlap window's length and on the capital base behind the daily returns.",
    caveat:
      "Arithmetic ×252 annualisation overstates large daily alphas relative to compounding, and the regression runs on realised-only daily returns over whatever days overlap the index series — a short overlap makes it noisy.",
    whatToDo:
      "Traders historically distrust an alpha that sits on a low R² — when the index explains almost none of the variance, 'excess versus the index' explains little either way.",
  },
  beta: {
    title: "Beta — how hard the book swings with the index",
    meaning:
      "The regression slope of your daily returns on the index's: 1 moves with it, above 1 amplifies it, near 0 ignores it, negative moves against it.",
    formula:
      "Covariance of portfolio and index excess returns ÷ variance of index excess returns, over the days both series have data.",
    healthyRange:
      "Commonly read near 1 for index-tracking books and near 0 for market-neutral ones — neither is better; it depends on what the strategy intends to be.",
    caveat:
      "On a sparse realised-only series, beta can be dominated by a handful of overlapping days — the overlap count in the badge is the confidence figure.",
    whatToDo:
      "Traders historically use beta to reprice their returns: a +20% book at beta 1.5 in a +15% market earned less than the raw number suggests.",
  },
  correlation: {
    title: "Correlation & R² — how much the index explains",
    meaning:
      "Correlation is the direction and tightness of the daily relationship with the index; R², its square, is the share of your variance the index accounts for.",
    formula:
      "Pearson correlation of the two daily return series over their overlapping days; R² = correlation².",
    healthyRange:
      "Commonly read as: high R² means the book is mostly market exposure wearing a costume, low R² means the results are its own for better or worse — neither is a target, and it depends on the strategy's intent.",
    caveat:
      "A small overlap makes both unstable, and a realised-only series deflates measured correlation against a continuously marked index.",
    whatToDo:
      "Traders historically read alpha and beta THROUGH R² — with R² near zero, both regression outputs are mostly noise.",
  },
  benchmarkWindow: {
    title: "Window returns — same days, same race",
    meaning:
      "Your chained return and the index's chained return over exactly the overlapping days — an apples-to-apples race on the same track.",
    formula:
      "Product of (1 + daily return) − 1 for each series, restricted to the days both have data.",
    healthyRange:
      "Commonly the first honest question — did the effort beat holding the index? Over short overlaps the answer flips easily, so it depends on how much of the history the window covers.",
    caveat:
      "The overlap is only the days you realised P&L AND the index traded — it can be a thin slice of both histories, and it says nothing about the days outside it.",
    whatToDo:
      "Traders trailing the index over a long overlap historically re-examine charges and churn before strategy — cost is the quieter thief.",
  },

  // ── Performance — the share card's KPIs ───────────────────────────────────
  netPnl: {
    title: "Net P&L — what was actually kept",
    meaning:
      "Realised gross P&L minus every charge the engine computed for these trades. Realised money only — open positions live on the trackers, not here.",
    formula:
      "Gross P&L of closed trades − total charges (computed per broker × segment × exchange from the editable rate table).",
    healthyRange:
      "Commonly the headline, but it carries no denominator — the same ₹1L means different things on ₹2L and ₹2Cr of capital, which depends entirely on the capital base; the share card's percent mode exists to add that context.",
    caveat:
      "A ₹ total, so it says nothing about consistency, risk taken, or how much capital produced it.",
    whatToDo:
      "Traders historically read it beside charges and expectancy rather than alone — the composition of a P&L says more than its size.",
  },
  winRate: {
    title: "Win rate — and why it isn't the whole story",
    meaning:
      "Winning trades as a share of priced closed trades. Trades with no cost basis in the data are excluded, so an unpriceable sale cannot masquerade as a 100% winner.",
    formula: "Wins ÷ priced closed trades (closed trades whose buy side exists in the data).",
    healthyRange:
      "Commonly read as good above 50% — but a low win rate with large winners routinely beats a high one with large losers, so it depends on trading style and on win/loss sizes.",
    caveat:
      "Frequency only: it says nothing about how big wins and losses are, which is the half that pays.",
    whatToDo:
      "Traders historically pair it with the win/loss size ratio and expectancy — the combination is what compounds, not the rate alone.",
  },
  profitFactor: {
    title: "Profit factor — gross wins over gross losses",
    meaning:
      "Gross winnings ÷ gross losses across priced closed trades. Above 1 the book makes money; below 1 it bleeds, whatever the win rate says.",
    formula:
      "Sum of winning trades' net P&L ÷ |sum of losing trades' net P&L|. With no losing trades yet it displays ∞ rather than an error or an invented cap; with neither wins nor losses it shows 0.",
    healthyRange:
      "Commonly read as viable above ~1.25 and strong above ~2 — but under roughly 20 closed trades it is mostly noise, so it depends on sample size and trading style.",
    caveat:
      "One outlier win can prop it up for months; an ∞ mostly means the losing trade simply hasn't happened yet.",
    whatToDo:
      "Traders historically recompute it mentally without the single best trade — a profit factor that survives that subtraction is the sturdier one.",
  },
  avgR: {
    title: "Avg R — return per unit of planned risk",
    meaning:
      "Mean R-multiple across closed trades that recorded a planned risk — this is THE R figure on the card (Expectancy beside it is ₹, not R). R = net P&L ÷ the risk planned at entry.",
    formula:
      "Sum of per-trade R ÷ count of trades with R recorded; a trade only earns an R when a stop-loss captured its planned risk.",
    healthyRange:
      "Commonly read as positive being the whole game — winners running larger than planned risk — assuming stops were recorded honestly; it depends on that discipline and on style.",
    caveat:
      "Only trades with a recorded SL participate, so a thin R sample can misrepresent the book — the dashboard's Avg R popup shows the sample size.",
    whatToDo:
      "Traders historically record stops on every entry precisely so this number stops being a sample and becomes the book.",
  },
  trades: {
    title: "Trades — the confidence divisor",
    meaning:
      "The count of closed trades behind every figure on the card — including trades the edge ratios exclude for a missing cost basis.",
    formula: "Count of closed trades in the current book.",
    healthyRange:
      "Commonly read as the denominator of confidence: below ~20–30 closed trades every ratio nearby is provisional, and how fast that firms up depends on trading style.",
    caveat:
      "A count, not a quality signal — more trades mean more evidence, not more edge, and past a point mostly more charges.",
    whatToDo:
      "Traders historically re-read the ratio metrics only as this count grows — the same profit factor means different things at 12 trades and 200.",
  },
  expectancy: {
    title: "Expectancy — ₹ per trade, not R",
    meaning:
      "The mean net ₹ result per priced closed trade — what the average trade paid. It is NOT R-expectancy: no risk normalisation is applied, and Avg R is the R figure.",
    formula: "Net P&L of priced closed trades ÷ their count. A ₹ figure.",
    healthyRange:
      "Commonly read as the number that compounds — positive after charges is the bar — but its size only means something relative to the capital base and trade frequency, and it depends on both.",
    caveat:
      "₹-denominated, so doubling position size doubles it with zero change in edge; the size-independent version of this question is Avg R.",
    whatToDo:
      "Traders wanting a size-independent read historically switch to Avg R, and use ₹ expectancy for the practical question — does the average trade out-earn its charges?",
  },
  shareMaxDrawdown: {
    title: "Max drawdown (share card) — which convention this is",
    meaning:
      "On this page's share card, the ₹ peak-to-trough of the daily equity walk — the same walk as the Max drawdown card above, in rupees.",
    formula:
      "Deepest (equity − running peak) in ₹ over the capital-plus-daily-realised-P&L walk. The dashboard's Max DD figure uses the other convention in this codebase — cumulative realised P&L walked trade by trade from zero — so the two ₹ figures can differ.",
    healthyRange:
      "Commonly read relative to capital rather than in isolation — the same ₹ fall is a scratch on one book and a wound on another, so it depends entirely on the capital base.",
    caveat:
      "Realised-only and daily-bucketed, like everything on this page: open-position pain and intraday troughs are invisible to it.",
    whatToDo:
      "Traders sharing the card historically state the capital context beside it (the percent privacy mode does this) — a ₹ drawdown without a base invites the wrong reading.",
  },
  charges: {
    title: "Charges — the silent tax on the edge",
    meaning:
      "Every charge the engine computed for these trades — brokerage, STT/CTT, GST, stamp duty, DP, MTF interest — from the editable per-broker rate table.",
    formula:
      "Sum of per-trade charges computed per broker × segment × exchange from charge_config; never a hard-coded statutory rate.",
    healthyRange:
      "Commonly watched as a share of gross P&L — past roughly 30% costs are commonly read as eating the edge — though the sustainable level depends on segment and style; scalping runs structurally higher.",
    caveat:
      "Only as accurate as the rate table and the imported data — a broker whose statement omits a charge type will understate this.",
    whatToDo:
      "Traders historically open the Charges & MTF Leak report when this looks heavy — it names the biggest single leak instead of leaving a lump sum.",
  },
  bestTrade: {
    title: "Best trade — the right tail",
    meaning:
      "The single largest net gain among closed trades — the outlier the averages quietly lean on.",
    formula: "Maximum net P&L across closed trades.",
    healthyRange:
      "Commonly compared against the average win: a best trade many multiples of it means the ratios lean on one event, which depends on style — trend-following expects exactly that shape.",
    caveat:
      "One trade. If profit factor or expectancy collapse without it, the edge was thinner than the averages implied.",
    whatToDo:
      "Traders historically recompute the headline ratios excluding it — an edge that survives its own best day is the one worth trusting.",
  },
  worstTrade: {
    title: "Worst trade — the left tail",
    meaning:
      "The single largest net loss among closed trades — the event risk that actually happened.",
    formula: "Minimum net P&L across closed trades.",
    healthyRange:
      "Commonly compared against the planned risk per trade: a worst trade near 1R is read as discipline holding; many multiples of it as a stop that failed or never existed — which depends on honest stop recording.",
    caveat:
      "A single realised number — it says nothing about the worse trade that hasn't happened yet, or about open-position exposure.",
    whatToDo:
      "Traders historically write the post-mortem for this one trade first; a journal entry on the worst trade tends to be worth more than ten on the good ones.",
  },

  // ── Scaling quality ───────────────────────────────────────────────────────
  closedLadders: {
    title: "Closed ladders — the comparable set",
    meaning:
      "Staged positions in which every tranche has exited — only a fully closed ladder has a complete counterfactual to compare against.",
    formula:
      "Count of staged positions with all quantity exited and a computable first-entry-only baseline; open ladders are excluded entirely, not counted as neutral.",
    healthyRange:
      "Commonly read as the denominator to watch: below a handful of closed ladders the improved/harmed split is anecdote, and how fast it becomes evidence depends on how often the style scales.",
    caveat:
      "A ladder missing its first entry leg, or one still open, contributes nothing here even though it appears in the journal.",
    whatToDo:
      "Traders historically let this count grow before drawing conclusions — the verdicts below firm up with the sample.",
  },
  scalingImproved: {
    title: "Scaling improved — ladders the adds paid for",
    meaning:
      "Closed ladders whose actual net beat the first-entry-only counterfactual by more than the noise threshold — the larger of ₹10 or 1% of the baseline.",
    formula:
      "Actual net (all tranches, ALL entry and exit charges) minus the counterfactual: the first tranche held to the ladder's weighted-average exit, bearing its own entry charges plus a proportional share of exit charges.",
    healthyRange:
      "Commonly wanted to outnumber 'harmed' over a meaningful sample — though what the split means depends on style: pyramiding into winners and averaging into losers produce very different versions of the same count.",
    caveat:
      "The counterfactual assumes the first tranche would have ridden to the same weighted-average exit — it isolates the money scaling added; it does not claim that path was executable unchanged.",
    whatToDo:
      "Traders historically look at WHICH ladders improved in the table below — adds into working trades and averages into failing ones are different habits sharing one number.",
  },
  scalingHarmed: {
    title: "Scaling harmed — ladders the adds cost",
    meaning:
      "Closed ladders whose actual net fell short of the first-entry-only counterfactual by more than the noise threshold — the larger of ₹10 or 1% of the baseline.",
    formula:
      "Same comparison as 'improved', on the other side of the threshold: actual net (all tranches, all charges) minus the first-tranche-held counterfactual, below −threshold.",
    healthyRange:
      "Commonly wanted to be the minority verdict — but a few harmed ladders are normal in any scaling style, so what matters depends on the ₹ impact beside the count.",
    caveat:
      "The extra tranches' brokerage counts against scaling here — deliberately, because it is a real cost of the habit — so thin-margin ladders can land 'harmed' on charges alone.",
    whatToDo:
      "Traders historically check whether harmed ladders share a shape — averaging down into losers is the classic one — before judging the habit as a whole.",
  },
  totalScalingImpact: {
    title: "Total scaling impact — the habit's ₹ verdict",
    meaning:
      "The ₹ sum across closed ladders of actual net minus the first-entry-only counterfactual — the total money that scaling decisions added or removed.",
    formula:
      "Σ (actual net − first-entry-only baseline) over closed ladders, each side carrying its own full entry and exit charges.",
    healthyRange:
      "Commonly read as: positive means the habit pays overall — but a small figure either way over a thin sample is noise, and it depends on ladder count and on whether one large ladder dominates.",
    caveat:
      "A single large ladder can dominate the total; the per-ladder table below is the honest read of whether the habit or one trade produced it.",
    whatToDo:
      "Traders historically split the table by shape — adds into profit versus averaging down — because the aggregate has repeatedly hidden one good habit paying for one bad one.",
  },
  replayEod: {
    title: "EOD replay — closes, not the path",
    meaning:
      "The replay draws imported end-of-day bhavcopy closes with your recorded fills marked on top — it cannot show the intraday path price took between fills.",
    formula:
      "Line: imported EOD closes for the symbol across the ladder's date span. Markers: the recorded fill prices from each leg.",
    healthyRange:
      "Commonly read for shape — where in the move each add and exit sat — rather than for precision; how much it reveals depends on holding period, and intraday styles get the least from it.",
    caveat:
      "A fill can sit far off the line legitimately: the day's close and your intraday price are different moments of the same day.",
    whatToDo:
      "Traders on intraday timeframes historically treat the replay as context, not evidence — the fill prices, not the line, are the record.",
  },
} satisfies Record<string, MetricHelpEntry>;

export type MetricHelpId = keyof typeof METRIC_HELP;
export const METRIC_HELP_IDS = Object.keys(METRIC_HELP) as MetricHelpId[];

// ── Adapters — registry entry → KpiCard `detail` shapes ─────────────────────
// Structurally match components/kpi-card.tsx's KpiDetail without importing it:
// lib/domain stays free of React imports (AGENTS.md invariant 2), and the
// objects are plain strings so they serialize across the RSC boundary.

export interface MetricDetailRow {
  label: string;
  value: string;
  hint?: string;
}

export interface MetricDetailData {
  title: string;
  summary: string;
  rows: MetricDetailRow[];
  note?: string;
}

/** Substitute `{key}` placeholders; throw on any left unresolved so a page
 *  that forgets to pass the risk-free rate fails loudly, not silently wrong. */
function interpolate(text: string, vars: MetricHelpVars | undefined, id: string): string {
  let out = text;
  for (const [k, v] of Object.entries(vars ?? {})) out = out.split(`{${k}}`).join(v);
  const leftover = out.match(/\{[a-zA-Z][a-zA-Z0-9]*\}/);
  if (leftover) {
    throw new Error(`metric-help: "${id}" needs a value for ${leftover[0]} — pass it in vars`);
  }
  return out;
}

function entry(id: MetricHelpId): MetricHelpEntry {
  const e = METRIC_HELP[id];
  if (!e) throw new Error(`metric-help: unknown metric id "${id}"`);
  return e;
}

/** Short term for glossary lists — the title before its " — " tagline. */
function termOf(e: MetricHelpEntry): string {
  return e.title.split(" — ")[0];
}

/**
 * Adapt a registry entry into the KpiCard `detail` prop.
 *
 * @param opts.vars  substitutions for `{placeholders}` (e.g. riskFreePct)
 * @param opts.note  page-state note appended to the dialog foot — e.g. WHY a
 *                   card shows "—" in the capital-unknown state
 * @param opts.also  companion metrics folded in as one compact row each
 *                   (e.g. Sortino inside the Sharpe card, whose sub shows it)
 */
export function metricDetail(
  id: MetricHelpId,
  opts?: { vars?: MetricHelpVars; note?: string; also?: MetricHelpId[] },
): MetricDetailData {
  const e = entry(id);
  const t = (s: string) => interpolate(s, opts?.vars, id);
  const rows: MetricDetailRow[] = [
    { label: "How it's computed", value: "", hint: t(e.formula) },
    { label: "Commonly read as", value: "", hint: t(e.healthyRange) },
    { label: "The caveat", value: "", hint: t(e.caveat) },
    { label: "What traders change", value: "", hint: t(e.whatToDo) },
  ];
  for (const alsoId of opts?.also ?? []) {
    const a = entry(alsoId);
    const ta = (s: string) => interpolate(s, opts?.vars, alsoId);
    rows.push({
      label: a.title,
      value: "",
      hint: `${ta(a.meaning)} ${ta(a.formula)} ${ta(a.caveat)}`,
    });
  }
  return { title: t(e.title), summary: t(e.meaning), rows, note: opts?.note };
}

/** Compact term/definition pairs for a definitions list (the share-card KPIs). */
export function metricGlossary(
  ids: MetricHelpId[],
): { id: MetricHelpId; term: string; meaning: string; caveat: string }[] {
  return ids.map((id) => {
    const e = entry(id);
    return { id, term: termOf(e), meaning: e.meaning, caveat: e.caveat };
  });
}

/** One-line inline caveat — meaning + caveat — for surfaces that are a
 *  paragraph rather than a card (the EOD replay note). */
export function metricCaveatLine(id: MetricHelpId, vars?: MetricHelpVars): string {
  const e = entry(id);
  return `${interpolate(e.meaning, vars, id)} ${interpolate(e.caveat, vars, id)}`;
}
