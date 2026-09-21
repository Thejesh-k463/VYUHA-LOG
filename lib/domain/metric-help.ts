// Metric education layer — a PURE registry (no DB, no React; AGENTS.md
// invariant 2) of what every performance/scaling KPI actually measures, in the
// conventions THIS codebase uses, not the textbook ones.
//
// House rules, enforced by tests/metric-help.test.ts:
//  - `healthyRange` is the USER'S OWN ARITHMETIC plus, where one exists, a
//    dated cited fact (owner ruling Q3, v4.4.0): a statement that is always
//    true of their own figures ("above 1.0 the book made money after charges"),
//    hedged ("commonly … depends on / assumes"), and never a band this
//    codebase cannot derive. The global bands this file used to publish —
//    "viable above ~1.25", ">50%", "~20% drawdown", Sharpe/Sortino/Calmar
//    levels — had no Indian source behind them and were invented benchmarks
//    (AGENTS.md invariant 6 in spirit); `tests/metric-help.test.ts` now fails
//    on any band without a source name and a year.
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
      "How much the book grew the capital you told it you started with — realised, dated trades only.",
    formula:
      "(ending equity − starting equity) ÷ starting equity, where equity walks the configured capital through each day's realised net P&L. Only trades with an exit date can join the walk.",
    healthyRange:
      "Above zero the book is ahead of the capital you started it with — arithmetic, not a target. Commonly read beside what the same rupees would have earned in a fixed deposit; Nithin Kamath's reading was that about 1% of active traders beat one over three years (Nithin Kamath, 2022). What it is worth depends on the capital base and on how long the window is.",
    caveat:
      "Realised and dated only: undated closed trades and open positions are invisible here, which is why this can disagree with the dashboard's Net P&L. The coverage note above states the gap when one exists.",
    whatToDo:
      "Traders who find this smaller than expected historically look at the gross-to-net gap first — charges compound against the walk on every single day it contains.",
  },
  xirr: {
    title: "XIRR — the money-weighted return",
    meaning:
      "What your actual rupees earned, counting when you put money in and when you took it out.",
    formula:
      "Internal rate of return over the opening capital and the cash ledger's external flows, closing on today's terminal value (capital + flows + realised + unrealised P&L), all carried in integer paise.",
    healthyRange:
      "Above zero your own dated rupees earned money after charges — arithmetic, not a target. Commonly read beside TWR and beside a fixed deposit over the same window; under about 30 days the card says so itself, so it depends on how long the flows have been running.",
    caveat:
      "Deposit timing moves it: capital that arrives just before a good month flatters XIRR without any change in skill. Skill in isolation is TWR's job, not this one's.",
    whatToDo:
      "Traders historically read XIRR beside TWR — XIRR lagging TWR has meant capital tended to arrive at unlucky times, XIRR leading it that timing helped.",
  },
  twr: {
    title: "TWR — the manager-skill return",
    meaning:
      "What the trading itself earned, with deposits and withdrawals taken out of the picture — the return a fund would report on the same trading.",
    formula:
      "Product of (1 + day's net P&L ÷ that day's pre-P&L equity) across days with realised P&L, minus 1. A deposit or withdrawal resizes the base for its day but is never counted as return. Annualised only past 30 days.",
    healthyRange:
      "Commonly read beside XIRR: when TWR leads XIRR, the trading did better than the timing of your deposits — your own two numbers compared, not a published bar. What either is worth depends on the market window and the trading style.",
    caveat:
      "Built from realised P&L on dated trades only — open positions and undated trades do not exist to it, so its window can be narrower than the book.",
    whatToDo:
      "Traders historically use the TWR-vs-XIRR gap to separate skill from deposit timing, and the benchmark panel below to ask whether the effort beat simply holding the index.",
  },
  cagr: {
    title: "CAGR — annualised growth",
    meaning:
      "The steady yearly growth rate that would have taken your starting capital to where it is now.",
    formula:
      "(1 + total return) ^ (365 ÷ calendar days) − 1, computed only when the dated history spans at least 30 days.",
    healthyRange:
      "This is your own growth restated as a yearly rate, nothing more. Commonly compared with a fixed deposit — Nithin Kamath's reading was that about 1% of active traders beat one over three years (Nithin Kamath, 2022). It depends above all on how long the history is: a hot quarter annualises into fiction.",
    caveat:
      "Annualising projects the observed window onto a full year it never lived. The under-30-day guard blocks the worst of it, but a two-month CAGR is still mostly extrapolation.",
    whatToDo:
      "Traders historically start trusting CAGR only once several quarters of history exist, and read it together with max drawdown — that pairing is exactly what Calmar is.",
  },
  sharpe: {
    title: "Sharpe — return per unit of wobble",
    meaning:
      "How much return you got for the amount of day-to-day swing you sat through.",
    formula:
      "(mean daily excess return over a {riskFreePct} annual risk-free rate) × {tradingDays}, divided by (daily standard deviation × √{tradingDays}). Only days with realised P&L participate in the series.",
    healthyRange:
      "Higher means the same rupees arrived with less day-to-day movement — a ratio of your own returns to your own swings. No Indian study publishes a level for a retail book, so nothing here calls a number healthy; what it means depends on the capital base and the style, and assumes a realised-only series can stand in for a daily-marked one. Commonly read against your own earlier periods.",
    caveat:
      "The series contains only days on which something was realised, annualised ×√{tradingDays} — so comparability with a fund's Sharpe, marked every day including flat ones, is limited. It also penalises upside volatility exactly like downside.",
    whatToDo:
      "Traders who dislike the upside penalty historically read Sortino beside it; traders with lumpy realised histories read both with suspicion and lean on drawdown figures instead.",
  },
  sortino: {
    title: "Sortino — Sharpe that only counts downside",
    meaning:
      "The same idea as Sharpe, but only the down days count against you — movement on winning days stops scoring against the book.",
    formula:
      "(mean daily excess return over a {riskFreePct} annual risk-free rate) × {tradingDays}, divided by (downside deviation × √{tradingDays}), on the same realised-only daily series as Sharpe.",
    healthyRange:
      "Commonly read beside Sharpe: when Sortino sits well above it, the movement you sat through was mostly upside — your own two numbers compared, not a published bar. It runs on the same realised-only series, so it depends on how continuously the book realises P&L and assumes enough losing days exist to measure.",
    caveat:
      "It shares Sharpe's blind spot: days with nothing realised do not exist to it, so comparisons with continuously marked fund figures remain limited.",
    whatToDo:
      "Traders historically compare it with Sharpe — a much higher Sortino has meant the wobble was mostly upside; a similar one, that losses drove it.",
  },
  calmar: {
    title: "Calmar — growth per unit of pain",
    meaning:
      "How much yearly growth you earned for each point of worst-case pain — CAGR divided by max drawdown.",
    formula:
      "CAGR % ÷ max drawdown % (the same %-of-equity walk as the Max drawdown card). Needs both a 30-day window and a nonzero drawdown to exist.",
    healthyRange:
      "Commonly read as your own growth divided by your own worst fall: above one, a year of growth covered the deepest valley the record contains — arithmetic, not a target. It depends heavily on how long that record is, because a short history has not met its worst drawdown yet.",
    caveat:
      "Its denominator is one single worst episode: a lone bad week can halve Calmar while every other number on this page barely moves.",
    whatToDo:
      "Traders historically use it to compare their own periods against each other rather than against published fund figures, whose marking conventions differ from a realised-only walk.",
  },
  maxDrawdown: {
    title: "Max drawdown — the deepest valley",
    meaning:
      "The most money you were down from your best point before the recovery began — the worst stretch this book has lived through.",
    formula:
      "This page walks the configured capital through each day's realised P&L, tracks the running peak, and takes the deepest (equity − peak) ÷ peak as the %; the ₹ figure is the deepest peak-to-trough difference of the same walk. The dashboard's Max DD uses a different convention — it walks cumulative realised P&L trade by trade from zero, with no capital base — so the two ₹ figures can legitimately disagree.",
    healthyRange:
      "This is the worst fall your own record actually contains, in your own rupees — and a fall you could not fund is the one that ends an account. Commonly read as the figure to size from rather than as a score. No Indian source publishes a line for it; what is survivable depends on the capital base, the leverage and whether the capital is replaceable.",
    caveat:
      "Realised-only and daily-bucketed: intraday troughs and open-position pain never register. And it only describes the past — the next drawdown owes the historical one nothing.",
    whatToDo:
      "Traders historically size positions from the drawdown they can live with, letting that cap position size, rather than sizing from the return they would like.",
  },
  volatility: {
    title: "Volatility — the size of a typical day",
    meaning:
      "How big a typical day is for this book, up or down, with no regard for direction.",
    formula:
      "Standard deviation of daily returns on days with realised P&L, multiplied by √{tradingDays}.",
    healthyRange:
      "Commonly read as your own typical day, annualised — and it counts a large green day exactly like a large red one. There is no level that is right; it depends on the capital base, the leverage and the style, and assumes the realised days are representative of the rest.",
    caveat:
      "Computed only on days with realised P&L and annualised ×√{tradingDays}, so it is not directly comparable with a fund's volatility marked every calendar day.",
    whatToDo:
      "Traders historically watch its trend more than its level — volatility that doubles while returns stay flat has been a reliable position-size-creep signal.",
  },
  positiveDays: {
    title: "Positive days — how often a day ends green",
    meaning:
      "Out of the days you actually closed something, how many ended green.",
    formula:
      "Days with net realised P&L above zero ÷ all days with realised P&L. Days on which nothing was closed do not count on either side.",
    healthyRange:
      "Frequency alone does not pay: a book can be green on most days and still lose money if the red days are bigger. Commonly read together with the best/worst-day card for exactly that reason, and what share is normal depends entirely on the trading style.",
    caveat:
      "A book can be green 70% of days and still lose money if the red days are bigger. Frequency without magnitude is half a statistic.",
    whatToDo:
      "Traders historically read it with the best/worst-day card beside it — frequency times magnitude is the actual arithmetic of a P&L.",
  },
  bestWorstDay: {
    title: "Best / worst day — the tails of the daily P&L",
    meaning:
      "The single largest daily gain and the single largest daily loss in the realised series — the tails that averages hide.",
    formula:
      "Maximum and minimum of daily net realised P&L; with capital configured they are expressed as % of the prior day's equity, without it as exact ₹ figures.",
    healthyRange:
      "Commonly read for asymmetry: when the worst day is several times the best, one day can undo many — that comparison is your own arithmetic. What magnitude is tolerable depends on the capital base and the style.",
    caveat:
      "Single-day extremes on realised P&L only: a slow multi-day bleed never appears here, and neither does an open position's worst moment.",
    whatToDo:
      "Traders historically interrogate the worst day — one trade or many, planned risk or a blow-up? Filtering the Trades view to that date answers it.",
  },

  // ── Performance — Monte Carlo ─────────────────────────────────────────────
  riskOfRuin: {
    title: "Risk of ruin — odds of ever losing half",
    meaning:
      "Out of a thousand simulated years that trade the way you have traded, in how many did the account ever halve.",
    formula:
      "Bootstrap: each simulated day replays one of your own realised daily returns at random (seeded, so the figure is reproducible); a path counts as ruin if it ever falls to half the starting equity within the horizon.",
    healthyRange:
      "Commonly read with size in mind: halving every position halves every daily return being resampled, and this figure falls with it — arithmetic on your own history. What level is tolerable depends on whether the capital is replaceable, and assumes the sampled past resembles what comes next.",
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
      "Commonly read against a coin flip — below half, the sampled days carried positive drift. That is arithmetic about your own record, not a forecast, and it depends entirely on how representative the sampled history is.",
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
      "Commonly read as a spread rather than a forecast: the useful question is whether the p5 year is one you could fund. That depends on the capital base and on what the capital is needed for, and assumes your recorded days repeat in a different order.",
    caveat:
      "These are percentiles of a resample of the past; the actual year ahead is under no obligation to stay inside them. 90% of paths landing between p5 and p95 is true by construction, not by prophecy.",
    whatToDo:
      "Traders historically plan around p5 — when the plausible bad year is unaffordable, position size, not the simulation, is what they change.",
  },

  // ── Performance — benchmark ───────────────────────────────────────────────
  alpha: {
    title: "Alpha — return the index does not explain",
    meaning:
      "The part of your return the index cannot explain — the bit that was yours, if any.",
    formula:
      "Daily α from a CAPM-style regression of portfolio excess returns on index excess returns (over a {riskFreePct} annual risk-free rate), annualised arithmetically — daily α × {tradingDays} — NOT geometrically compounded.",
    healthyRange:
      "Positive means your own days beat what beta times the index would have produced — arithmetic over the overlapping days, not a target. Commonly distrusted when R² is low, since the index then explains little either way; it depends on how many days overlap and assumes that overlap is long enough to mean anything.",
    caveat:
      "Arithmetic ×{tradingDays} annualisation overstates large daily alphas relative to compounding, and the regression runs on realised-only daily returns over whatever days overlap the index series — a short overlap makes it noisy.",
    whatToDo:
      "Traders historically distrust an alpha that sits on a low R² — when the index explains almost none of the variance, 'excess versus the index' explains little either way.",
  },
  beta: {
    title: "Beta — how hard the book swings with the index",
    meaning:
      "How hard your book swings when the index swings: 1 moves with it, above 1 amplifies it, near 0 ignores it, negative moves against it.",
    formula:
      "Covariance of portfolio and index excess returns ÷ variance of index excess returns, over the days both series have data.",
    healthyRange:
      "Commonly read as a description rather than a score: near 1 the book moves with the index, near 0 it ignores it, negative it leans against it. Which of those is right depends on what the strategy intends to be.",
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
      "Commonly read as: a high R² means most of your variance was the index's, a low one that the result was your own — neither is a target. It depends on the strategy's intent and assumes enough overlapping days to measure at all.",
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
      "Commonly the first honest question — did the effort beat simply holding the index over exactly these days? The answer is your own two chained returns side by side. Over a short overlap it flips easily, so it depends on how much of the history the window covers.",
    caveat:
      "The overlap is only the days you realised P&L AND the index traded — it can be a thin slice of both histories, and it says nothing about the days outside it.",
    whatToDo:
      "Traders trailing the index over a long overlap historically re-examine charges and churn before strategy — cost is the quieter thief.",
  },

  // ── Performance — the share card's KPIs ───────────────────────────────────
  netPnl: {
    title: "Net P&L — what was actually kept",
    meaning:
      "The money actually left in your hands after the broker and the government took their cut. Realised only — open positions live on the trackers, not here.",
    formula:
      "Gross P&L of closed trades − total charges (computed per broker × segment × exchange from the editable rate table).",
    healthyRange:
      "Above zero you kept money after the broker and the government took their cut — arithmetic, not a target. For context on an F&O book: SEBI found 93% of individual traders lost money over FY22–FY24, an average of about ₹2 lakh each (SEBI, 2024). Commonly read with the capital base in mind, because the same ₹1 lakh means different things on ₹2 lakh and on ₹2 crore — it depends entirely on that base.",
    caveat:
      "A ₹ total, so it says nothing about consistency, risk taken, or how much capital produced it.",
    whatToDo:
      "Traders historically read it beside charges and expectancy rather than alone — the composition of a P&L says more than its size.",
  },
  winRate: {
    title: "Win rate — and why it isn't the whole story",
    meaning:
      "Out of every hundred closed trades, how many ended green. Trades with no cost basis in the data are left out, so an unpriceable sale cannot masquerade as a 100% winner.",
    formula: "Wins ÷ priced closed trades (closed trades whose buy side exists in the data).",
    healthyRange:
      "Win rate on its own says nothing about money: if your average loss is 3× your average win, 75% wins only breaks you even — and the payoff ratio beside it does that sum with your own figures. Commonly read next to the win/loss size ratio for that reason; what is normal depends on the trading style.",
    caveat:
      "Frequency only: it says nothing about how big wins and losses are, which is the half that pays.",
    whatToDo:
      "Traders historically pair it with the win/loss size ratio and expectancy — the combination is what compounds, not the rate alone.",
  },
  profitFactor: {
    title: "Profit factor — winners ÷ losers, after charges",
    meaning:
      "For every rupee your losing trades took away, how many rupees the winners brought in — after charges. Above 1 the book makes money, whatever the win rate says.",
    formula:
      "Sum of winning trades' net P&L ÷ |sum of losing trades' net P&L|. With no losing trades yet it displays ∞ rather than an error or an invented cap; with neither wins nor losses it shows 0.",
    healthyRange:
      "Above 1.0 the book made money after charges — arithmetic, not a target: at 1.5, the winners paid for the losers one and a half times over. Commonly read with the trade count beside it, because a single outsized winner can hold it up for months — it depends on sample size.",
    caveat:
      "One outlier win can prop it up for months; an ∞ mostly means the losing trade simply hasn't happened yet.",
    whatToDo:
      "Traders historically recompute it mentally without the single best trade — a profit factor that survives that subtraction is the sturdier one.",
  },
  avgR: {
    title: "Avg R — return per unit of planned risk",
    meaning:
      "How much you made or lost against the risk you planned to take on each trade — this is THE R figure on the card (Expectancy beside it is rupees, not R). R = net P&L ÷ the risk planned at entry.",
    formula:
      "Sum of per-trade R ÷ count of trades with R recorded; a trade only earns an R when a stop-loss captured its planned risk.",
    healthyRange:
      "Above zero your average trade returned more than the risk it was planned with — arithmetic in R, not a target. A common Indian sizing rule puts that risk near 1% of capital a trade, ₹1,000 per lakh (@yashstocks, 2021). Commonly read with the sample line beside it, since it depends on how many trades carry a real stop rather than the default cap.",
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
      "Commonly read as the denominator of confidence: the same ratio over 12 closed trades and over 200 are not the same fact. How fast a book firms up depends on the trading style and assumes the trades are broadly of one kind.",
    caveat:
      "A count, not a quality signal — more trades mean more evidence, not more edge, and past a point mostly more charges.",
    whatToDo:
      "Traders historically re-read the ratio metrics only as this count grows — the same profit factor means different things at 12 trades and 200.",
  },
  expectancy: {
    title: "Expectancy — ₹ per trade, not R",
    meaning:
      "What one average trade was worth to you in rupees, after charges. It is NOT R-expectancy: no risk normalisation is applied, and Avg R is the R figure.",
    formula: "Net P&L of priced closed trades ÷ their count. A ₹ figure.",
    healthyRange:
      "Above zero the average trade out-earned its own charges — arithmetic, not a target. It is in rupees, so it moves with position size: ₹500 a trade on ₹5 lakh and ₹500 a trade on ₹50 lakh are different facts, and reading it depends on the capital base. Commonly read beside Avg R, the size-independent version of the same question.",
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
      "Commonly read only next to the capital it happened on — the same ₹ fall is a scratch on one book and a wound on another, so what it means depends entirely on the capital base.",
    caveat:
      "Realised-only and daily-bucketed, like everything on this page: open-position pain and intraday troughs are invisible to it.",
    whatToDo:
      "Traders sharing the card historically state the capital context beside it (the percent privacy mode does this) — a ₹ drawdown without a base invites the wrong reading.",
  },
  charges: {
    title: "Charges — the silent tax on the edge",
    meaning:
      "The full cost of doing business for these trades: brokerage plus every statutory levy — STT/CTT, GST, stamp duty, DP, MTF interest — priced from your broker's own editable rate card.",
    formula:
      "Sum of per-trade charges computed per broker × segment × exchange from charge_config; never a hard-coded statutory rate.",
    healthyRange:
      "Charges are already subtracted from every net figure here — this is money gone, not a forecast. SEBI put individual F&O transaction costs at about ₹26,000 per trader in FY24 (SEBI, 2024). Commonly read as a share of gross P&L; what is sustainable depends on the segment and the style, since scalping runs structurally higher.",
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
      "Commonly compared with your own average win: when the best trade is many multiples of it, the ratios above lean on one event — and recomputing them without it says how much. Whether that shape is a problem depends on the style, since trend-following expects exactly it.",
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
      "Commonly compared with the risk you planned for that trade: near 1R the stop held; several multiples of it means it did not, or was never there. That comparison depends on stops having been recorded honestly.",
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
      "Commonly read as the denominator for the two verdicts below — over a handful of ladders they are anecdote rather than evidence. How fast that changes depends on how often the style scales in at all.",
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
      "Commonly read against the harmed count over the same set — together they are your own record of whether adding paid. What the split means depends on the style: pyramiding into winners and averaging into losers produce very different versions of one count.",
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
      "Commonly read beside the ₹ impact rather than alone: a few harmed ladders costing little is a different fact from a few that were expensive. What it means depends on the style, and assumes the counterfactual exit was reachable.",
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
      "Positive means the adds paid for themselves overall, in your own rupees — arithmetic, not a target. Commonly read with the per-ladder table below, because it depends on whether one large ladder produced the whole figure.",
    caveat:
      "A single large ladder can dominate the total; the per-ladder table below is the honest read of whether the habit or one trade produced it.",
    whatToDo:
      "Traders historically split the table by shape — adds into profit versus averaging down — because the aggregate has repeatedly hidden one good habit paying for one bad one.",
  },
  // ── Capital goals (v3.6, decision #4) ─────────────────────────────────────
  goalProgress: {
    title: "Goal progress — the frozen-baseline walk",
    meaning:
      "How far the bucket has moved from the baseline frozen when the goal was created toward the ₹ level the goal resolves to, driven by realised P&L since that date.",
    formula:
      "Standing = frozen baseline + realised net P&L since the baseline date; progress % = (standing − baseline) ÷ (target level − baseline). A %-profit goal's target level is baseline × (1 + target%). Without a frozen baseline, an absolute goal falls back to current capital ÷ target.",
    healthyRange:
      "Commonly read against the time elapsed toward the target date rather than against a fixed bar — both of those numbers are your own. What counts as on pace depends on the capital base, the window and the trading style.",
    caveat:
      "Capital EDITS after creation are deliberately not progress — a deposit is not P&L, and compounding realised gains cannot double-count because each walk starts at its frozen figure. In the All-accounts view, progress is the SUM of each account's own walk from its own baseline date — never one blended series, which would re-count profit already inside a later-frozen baseline. Undated realised P&L belongs to no day and cannot join the walk.",
    whatToDo:
      "Traders historically read this beside the run-rate line below — a gap that looks large in ₹ often resolves into an ordinary number of ordinary weeks, or visibly does not.",
  },
  goalGap: {
    title: "Goal gap — what remains, in ₹",
    meaning:
      "The ₹ distance from the bucket's current standing to the goal's resolved target level. Zero or negative means the goal is met.",
    formula:
      "Target level − standing, where standing walks the frozen baseline through realised P&L since the baseline date (or falls back to current capital when no baseline was frozen).",
    healthyRange:
      "Commonly divided by your own run-rate to turn rupees into weeks — gap ÷ ₹-per-week is the whole of the arithmetic. What it is worth depends on the goal's size and on how much history the pace rests on.",
    caveat:
      "When capital was unknown at the goal's creation and remains unknown, there is no standing to subtract from — the card shows \"—\" rather than a gap computed on an invented base.",
    whatToDo:
      "Traders historically restate a stale goal rather than chase one — deleting and recreating re-freezes the baseline at today's figures.",
  },
  goalRunRate: {
    title: "Run-rate — your realised pace, ₹/week",
    meaning:
      "What the bucket actually realised per week over the trailing 30 and 90 days — the pace the goal's gap gets measured against.",
    formula:
      "Σ realised net P&L over the trailing window ÷ window days × 7, on dated realised trades only. Both windows are shown so a hot month cannot masquerade as the norm.",
    healthyRange:
      "Commonly read as the two windows agreeing: a 30-day pace far above the 90-day one is recency, not a new normal. Which one to plan on depends on sample size and trading style.",
    caveat:
      "Realised and dated only: open positions and undated trades contribute nothing, and a quiet trailing window shows a true ₹0 — while no realised history at all shows \"—\" because there is no pace to state.",
    whatToDo:
      "Traders historically trust the 90-day figure for planning and treat the 30-day one as weather; when the two diverge hard they look for what changed in the book, not in the goal.",
  },
  goalRequiredPace: {
    title: "Required pace — the date's arithmetic",
    meaning:
      "The ₹/week the remaining gap works out to between today and the goal's target date. Pure arithmetic — not a forecast, and not advice.",
    formula:
      "Gap ÷ calendar days to the target date × 7, stated only while a target date is set, lies ahead, and the gap is open.",
    healthyRange:
      "Commonly compared with your realised run-rate: when the required pace is a multiple of the realised one, it is the date talking rather than the trading. What is reachable depends entirely on the style and the capital base.",
    caveat:
      "Calendar weeks, not trading weeks, and the figure assumes a straight line to the date — markets do not pay in straight lines. Past the date it disappears rather than compounding into a fantasy number.",
    whatToDo:
      "Traders historically move the date, resize the goal, or accept the mismatch and keep the record honest — the number's job is to make that choice visible early.",
  },
  replayEod: {
    title: "EOD replay — closes, not the path",
    meaning:
      "The replay draws imported end-of-day bhavcopy closes with your recorded fills marked on top — it cannot show the intraday path price took between fills.",
    formula:
      "Line: imported EOD closes for the symbol across the ladder's date span. Markers: the recorded fill prices from each leg.",
    healthyRange:
      "Commonly read for shape — where in the move each add and each exit sat — rather than for precision. How much it shows depends on the holding period, and intraday styles get the least from it.",
    caveat:
      "A fill can sit far off the line legitimately: the day's close and your intraday price are different moments of the same day.",
    whatToDo:
      "Traders on intraday timeframes historically treat the replay as context, not evidence — the fill prices, not the line, are the record.",
  },

  // ── The Trade Review Desk — the Process Score and its five components ─────
  // Rendered by app/review/page.tsx: the summary card carries `processScore`
  // as a drill-down, and each component row carries its own one-liner under
  // "How each component is counted".
  processScore: {
    title: "Process Score — how the week was traded",
    meaning:
      "One number for how well the week was traded rather than for what it made: the mean of five habits the journal already records.",
    formula:
      "The arithmetic mean of whichever of the five components could be measured, rounded to a whole number. A component with nothing honest to measure drops out of the mean entirely rather than scoring zero, and the score itself is withheld below ten closed trades in the window.",
    healthyRange:
      "Commonly read as a trend across weeks rather than as a level — five habits from your own record, averaged. What a given level is worth depends on which components could be measured at all, and assumes the journal is filled in consistently week to week.",
    caveat:
      "It says nothing about profit. A disciplined week can lose money and a reckless one can make it — this measures the process the record shows, not the outcome it produced.",
    whatToDo:
      "Traders historically read the five component rows before the summary figure, because the number moves for five different reasons and only the rows say which one moved.",
  },
  processPlanned: {
    title: "Planned — a stop or target recorded",
    meaning:
      "The share of closed trades in the window that carry a stop-loss or a target written down before or at entry.",
    formula:
      "Closed trades carrying a planned SL or a planned target, divided by every closed trade in the window. Either field alone counts, and a trade with both counts once.",
    healthyRange:
      "Commonly the easiest of the five to move, because it measures record-keeping as much as planning. What it is worth depends on the style — a trader who plans an exit rule rather than a price leaves nothing here to read.",
    caveat:
      "It reads the field, not the intention: a trade planned in the trader's head and never typed in counts as unplanned, which is an honest reading of the record rather than of the trade.",
    whatToDo:
      "Traders historically fill both fields at entry rather than after the close, because a level typed in afterwards records the outcome and not the plan.",
  },
  processRiskCap: {
    title: "Risk cap — losses within the risk taken",
    meaning:
      "The share of losing trades in the window whose loss stayed inside the risk that trade was actually taken with.",
    formula:
      "Each losing closed trade is measured against its own recorded risk amount, or against the configured per-trade cap where the trade has none. Losses at or inside that limit, divided by every losing trade in the window.",
    healthyRange:
      "Every loss inside your own cap is a loss whose size you chose — that is all this counts. The 5% rule in Zerodha Varsity's position-sizing chapter is stated as a ceiling on capital at risk, never a level to aim at. Commonly read beside its coverage line, since a perfect figure over two losers depends on almost nothing.",
    caveat:
      "It refuses outright when a losing trade carries neither its own risk amount nor a configured cap. An earlier version measured every book against a hardcoded rupee limit nobody had chosen, and that fallback is gone.",
    whatToDo:
      "Traders historically set the per-trade cap in Settings first, since without it this component has no limit to read and stays out of the score altogether.",
  },
  processDailyStop: {
    title: "Daily stop — days inside the loss budget",
    meaning:
      "The share of trading days in the window whose net stayed at or above the configured daily loss stop.",
    formula:
      "Days are formed from the sell dates of closed trades in the window; each day's net is summed and compared with the configured daily stop. Days within it, divided by every day that traded.",
    healthyRange:
      "The daily stop is the limit you set, and this is the share of your own days that stayed inside it. SEBI's FY23 study reported more than 70% of individual intraday traders made losses (SEBI, 2024). Commonly read as a count of breach days rather than as a percentage; what it means depends on how many days the window held.",
    caveat:
      "The day is built from realised P&L on closed trades only, so an open position running against the book on the same day is invisible to it.",
    whatToDo:
      "Traders historically look at the breach days themselves in the Discipline report, since a percentage says how often and never which day.",
  },
  processRulesFollowed: {
    title: "Rules followed — the playbook checklist",
    meaning:
      "Among trades taken to a playbook, the share with no rule from that playbook's checklist recorded as broken.",
    formula:
      "Closed trades with a playbook and no journal entry marking one of its rules broken, divided by closed trades that have a playbook at all. A trade with no playbook has no rules to have followed and is left out of both sides.",
    healthyRange:
      "Commonly read next to its coverage line, which says how many trades had a playbook at all — a perfect figure over three tagged trades and a middling one over forty are different facts. What it is worth depends on how consistently the book is tagged.",
    caveat:
      "It is self-reported: the checklist is ticked by the trader in the journal dialog, so this measures the honesty of the record as much as the discipline of the trading.",
    whatToDo:
      "Traders historically tag the playbook at entry, because a playbook chosen after the exit tends to be the one the trade turned out to fit.",
  },
  processReviewed: {
    title: "Reviewed — trades read back",
    meaning:
      "The share of closed trades in the window carrying a review stamp. The queue on this desk is exactly its complement.",
    formula:
      "Closed trades whose review timestamp is set, divided by every closed trade in the window. Saving the journal sets the stamp, and so does marking a trade reviewed; a blank stamp reads as unreviewed.",
    healthyRange:
      "Commonly a housekeeping figure that a weekly ritual keeps high; an imported back-history reads as unreviewed because it was never read. What a lower reading means depends on how the book is worked.",
    caveat:
      "A stamp records that the trade was opened and closed on this desk, not that anything was learned from it — it is a measure of attention rather than of insight.",
    whatToDo:
      "Traders historically work the queue oldest-first once a week, since the stamp is what takes a trade out of it.",
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
