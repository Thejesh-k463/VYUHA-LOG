import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * ₹ amount stored as INTEGER paise at rest (P0.1 — exact money, no float drift),
 * exposed as rupees (number) at runtime so call sites keep working unchanged.
 * Per-unit PRICE columns (avg prices, SL/TSL/target, strike, FMV) stay REAL —
 * they are levels/quotients, not money amounts.
 */
const moneyPaise = customType<{ data: number; driverData: number }>({
  dataType: () => "integer",
  toDriver: (rupees) => Math.round(rupees * 100),
  fromDriver: (paise) => paise / 100,
});

/**
 * Vyuha schema — single-user local trade journal.
 *
 * Conventions:
 *  - ₹ AMOUNT columns are stored as INTEGER paise (P0.1) via the `moneyPaise`
 *    custom type below, exposed as rupees at runtime. Per-unit PRICE/level
 *    columns stay REAL. The pure charges engine computes natively in paise and
 *    applies statutory rounding (STT/CTT/stamp to nearest rupee).
 *  - Dates are stored as ISO strings (YYYY-MM-DD); timestamps as ISO datetime.
 *  - Booleans use integer({ mode: "boolean" }).
 *  - JSON columns use text({ mode: "json" }).
 */

const now = sql`(datetime('now'))`;

// ---------------------------------------------------------------------------
// trades — one row per round-trip or per leg (closed or open)
// ---------------------------------------------------------------------------
export const trades = sqliteTable(
  "trades",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id").notNull().default(1),

    // Classification
    broker: text("broker").notNull(), // dhan | zerodha | groww
    bucket: text("bucket").notNull(), // equity | active
    segment: text("segment").notNull(), // eq_delivery | eq_mtf | eq_intraday | index_option | stock_option | commodity_future | commodity_option | future
    instrumentType: text("instrument_type").notNull(), // equity | option | future
    exchange: text("exchange").notNull(), // NSE | BSE | MCX

    // Instrument
    symbol: text("symbol").notNull(), // underlying, e.g. NIFTY / RELIANCE
    tradingsymbol: text("tradingsymbol").notNull(), // raw scrip name as imported
    isin: text("isin"),
    expiry: text("expiry"), // ISO date
    strike: real("strike"),
    optionType: text("option_type"), // CE | PE | null
    lotSize: integer("lot_size"),

    // Quantities / prices
    buyQty: real("buy_qty").notNull().default(0),
    avgBuyPrice: real("avg_buy_price").notNull().default(0),
    buyValue: moneyPaise("buy_value_paise").notNull().default(0),
    sellQty: real("sell_qty").notNull().default(0),
    avgSellPrice: real("avg_sell_price").notNull().default(0),
    sellValue: moneyPaise("sell_value_paise").notNull().default(0),
    closingPrice: real("closing_price"), // for open MTM

    // Dates / times
    buyDate: text("buy_date"),
    sellDate: text("sell_date"),
    entryTime: text("entry_time"),
    exitTime: text("exit_time"),

    // P&L
    grossPnl: moneyPaise("gross_pnl_paise").notNull().default(0),
    chargesTotal: moneyPaise("charges_total_paise").notNull().default(0),
    netPnl: moneyPaise("net_pnl_paise").notNull().default(0),
    unrealisedPnl: moneyPaise("unrealised_pnl_paise").notNull().default(0),
    realisedPct: real("realised_pct"),
    isOpen: integer("is_open", { mode: "boolean" }).notNull().default(false),

    // Order counts (brokerage is per executed order; P&L files are aggregated)
    buyOrderCount: integer("buy_order_count").notNull().default(1),
    sellOrderCount: integer("sell_order_count").notNull().default(1),

    // Journal
    setupTag: text("setup_tag"),
    notes: text("notes"),
    playbookId: integer("playbook_id"), // links to playbooks.id (P2.4 behavioral journaling)
    emotionTag: text("emotion_tag"), // one of EMOTION_TAGS in lib/analytics/behavior.ts
    slPlanned: real("sl_planned"), // original stop-loss
    trailingSl: real("trailing_sl"), // trailing stop-loss (TSL)
    targetPlanned: real("target_planned"),
    riskAmount: moneyPaise("risk_amount_paise"),
    impliedVol: real("implied_vol"), // user-entered IV %, e.g. 20 for 20% (option Greeks)
    entryIv: real("entry_iv"),
    exitIv: real("exit_iv"),
    entryDte: integer("entry_dte"),
    hedgeStatus: text("hedge_status"), // unhedged | hedged | partial | not_applicable
    expiryOutcome: text("expiry_outcome"), // squared_off | expired_worthless | exercised | assigned | open
    adjustmentGroup: text("adjustment_group"),
    fmv31Jan2018: real("fmv_31jan2018"), // per-share FMV on 31-Jan-2018 (LTCG grandfathering; pre-2018 lots only)
    rMultiple: real("r_multiple"),
    ruleViolations: text("rule_violations", { mode: "json" }).$type<string[]>(),
    mistakeTags: text("mistake_tags", { mode: "json" }).$type<string[]>(),

    // Staged (scaled) position — S1. When true, this trade's quantities and
    // prices are DERIVED from its trade_legs rows rather than typed directly:
    // buy_qty/avg_buy_price/sell_qty/avg_sell_price and the whole charge
    // breakdown are recomputed from the legs on every mutation. False keeps the
    // classic single-entry behaviour byte-for-byte, so nothing existing moves.
    staged: integer("staged", { mode: "boolean" }).notNull().default(false),

    /**
     * How this position was acquired, when it was NOT bought inside the
     * imported window.
     *
     *   null       bought normally — the overwhelming majority
     *   "unknown"  sold with no matching purchase in the file; the stock was
     *              acquired earlier, so the cost basis is unknowable from the
     *              data alone
     *   "ipo"      user-confirmed IPO allotment
     *   "bonus"    bonus / split / corporate action credit
     *   "gift"     transfer-in, gift or inheritance
     *
     * Anything other than null with `buy_value_paise = 0` has NO usable cost
     * basis, and is excluded from win rate, expectancy and ROM until the user
     * supplies one — reporting a 100% gain because the buy value happens to be
     * zero would be a fabrication.
     */
    acquisition: text("acquisition"),
    /** Per-share cost the user supplied for an acquisition-flagged trade. */
    acquisitionPrice: real("acquisition_price"),
    /** When the shares were acquired — starts the tax holding period. */
    acquisitionDate: text("acquisition_date"),
    /**
     * Cost per share RECOVERED from an import file's own footer, offered as a
     * suggestion. Deliberately a separate column from `acquisitionPrice`: a
     * derived number must never sit where a confirmed one lives, or the UI
     * cannot tell the user which of the two they are looking at.
     */
    suggestedBasisPrice: real("suggested_basis_price"),
    /** Provenance notes written by the importer (product derived, mixed bill…). */
    importNotes: text("import_notes"),

    // Charges breakdown
    brokerage: moneyPaise("brokerage_paise").notNull().default(0),
    sttCtt: moneyPaise("stt_ctt_paise").notNull().default(0),
    exchangeTxn: moneyPaise("exchange_txn_paise").notNull().default(0),
    sebi: moneyPaise("sebi_paise").notNull().default(0),
    stampDuty: moneyPaise("stamp_duty_paise").notNull().default(0),
    ipft: moneyPaise("ipft_paise").notNull().default(0),
    gst: moneyPaise("gst_paise").notNull().default(0),
    dpCharges: moneyPaise("dp_charges_paise").notNull().default(0),
    mtfInterest: moneyPaise("mtf_interest_paise").notNull().default(0),
    // Broker-financed principal for an eq_mtf position (own-margin share excluded) —
    // set once at entry (explicit or auto-estimated from margin_config's eq_mtf %)
    // and reused by the daily accrual job + close-position recompute, so interest
    // is never silently recomputed off the FULL position value. Null = not MTF.
    mtfFundedAmount: moneyPaise("mtf_funded_amount_paise"),
    pledgeCharges: moneyPaise("pledge_charges_paise").notNull().default(0),

    // Provenance / dedup
    sourceFile: text("source_file"),
    importBatchId: integer("import_batch_id"),
    dedupHash: text("dedup_hash").notNull(),

    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("trades_account_broker_dedup_uq").on(t.accountId, t.broker, t.dedupHash),
    index("trades_segment_idx").on(t.segment),
    index("trades_bucket_idx").on(t.bucket),
    index("trades_sell_date_idx").on(t.sellDate),
    // Hot paths: every tracker/risk/accrual query filters is_open; the
    // playbook expectancy/discipline rollups group by playbook_id.
    index("trades_is_open_idx").on(t.isOpen),
    index("trades_playbook_idx").on(t.playbookId),
    index("trades_account_idx").on(t.accountId),
    // getTrades()'s exact filter+sort — WHERE account_id ORDER BY sell_date
    // DESC, created_at DESC — as one composite, so the hottest query in the
    // app (25 force-dynamic pages) is an index scan instead of a filesort.
    index("trades_account_sell_created_idx").on(t.accountId, sql`${t.sellDate} DESC`, sql`${t.createdAt} DESC`),
  ],
);

// ---------------------------------------------------------------------------
// trade_legs — the individual executions behind a staged (scaled) position.
//
// One row per fill: kind "entry" adds exposure, kind "exit" removes it. The
// parent trade row stays the aggregate (so every existing report, tax pack and
// risk view keeps working untouched) and is recomputed from these rows.
//
// Accounting, decided deliberately and relied on by lib/domain/staged.ts:
//   • PRICING is weighted-average — an exit books against the blended average
//     of all entry legs open at that moment. This matches the average price
//     your broker shows, so journal P&L never disagrees with the broker app.
//   • QUANTITY CONSUMPTION is FIFO — an exit retires the oldest open entry
//     legs first. Weighted-average pricing alone cannot say WHICH stop is
//     still live once you scale out; FIFO keeps quantities whole (no
//     fractional shares) and matches how traders describe it ("booked my
//     first tranche"). The two rules are independent and both are enforced.
//   • R is frozen at the FIRST entry's risk for the life of the position, so a
//     3R stays a 3R whether or not you pyramided.
//
// Charges are booked PER LEG (brokerage is per order, STT per execution), with
// DP charged once per exit DATE rather than once per leg.
// ---------------------------------------------------------------------------
export const tradeLegs = sqliteTable(
  "trade_legs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tradeId: integer("trade_id").notNull(),
    kind: text("kind").notNull(), // entry | exit
    /** 1-based order the legs were executed in; ties broken by id. */
    seq: integer("seq").notNull().default(1),

    tradeDate: text("trade_date").notNull(), // ISO date of this fill
    tradeTime: text("trade_time"), // HH:MM, when the broker file carries it
    qty: real("qty").notNull(),
    price: real("price").notNull(),

    // Entry legs only — each tranche carries its own stop, so you can run a
    // wide stop on the core and tight stops on the adds. "Apply to all" in the
    // UI simply writes the same value across every open entry leg.
    slPlanned: real("sl_planned"),
    trailingSl: real("trailing_sl"),
    targetPlanned: real("target_planned"),

    /** Charges attributable to THIS fill (paise). Parent = sum of legs. */
    chargesTotal: moneyPaise("charges_total_paise").notNull().default(0),
    /** Realised net P&L for an exit leg (paise); always 0 on entry legs. */
    netPnl: moneyPaise("net_pnl_paise").notNull().default(0),
    /** Blended average cost this exit booked against — frozen for audit. */
    avgCostAtExit: real("avg_cost_at_exit"),

    note: text("note"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [
    index("trade_legs_trade_idx").on(t.tradeId),
    index("trade_legs_order_idx").on(t.tradeId, t.seq),
  ],
);

// ---------------------------------------------------------------------------
// capital_snapshots
// ---------------------------------------------------------------------------
export const capitalSnapshots = sqliteTable("capital_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id").notNull().default(1),
  bucket: text("bucket").notNull(),
  asOfDate: text("as_of_date").notNull(),
  openingCapital: real("opening_capital").notNull().default(0),
  deployed: real("deployed").notNull().default(0),
  available: real("available").notNull().default(0),
  realisedPnlToDate: real("realised_pnl_to_date").notNull().default(0),
  createdAt: text("created_at").notNull().default(now),
});

// ---------------------------------------------------------------------------
// charge_config — editable rate table keyed by broker + segment + exchange.
// The charges engine reads ONLY from this table; nothing is hard-coded.
// Rates are stored as fractions of turnover (e.g. 0.1% => 0.001).
// ---------------------------------------------------------------------------
export const chargeConfig = sqliteTable(
  "charge_config",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    broker: text("broker").notNull(),
    /**
     * Which PRICING PLAN this row describes.
     *
     * "default" is the free/standard plan every account starts on, and is what
     * most traders are on. Brokers that sell a paid tier (Kotak Neo's Pro plan
     * at ₹249/month) get a second set of rows, so the comparison can show both
     * side by side and answer the question a trader actually has: would paying
     * for the upgrade have earned its fee back on MY book?
     */
    plan: text("plan").notNull().default("default"),
    /** Human label for the plan, e.g. "Trade Free Pro". */
    planLabel: text("plan_label"),
    /**
     * Monthly subscription for this plan, in rupees. Zero for a free plan.
     * A paid plan compared on brokerage alone would always look cheaper than
     * it is — the fee is the whole reason it is a choice.
     */
    subscriptionMonthly: real("subscription_monthly").notNull().default(0),
    segment: text("segment").notNull(),
    exchange: text("exchange").notNull(),

    // Brokerage (per executed order):
    //   if brokerageFlat is set -> fee = brokerageFlat
    //   else fee = clamp(brokeragePct * turnoverPerOrder, brokerageFloor, brokerageCap)
    //   (brokerageCap null => no cap)
    brokerageFlat: real("brokerage_flat"),
    brokeragePct: real("brokerage_pct").notNull().default(0),
    brokerageCap: real("brokerage_cap"),
    brokerageFloor: real("brokerage_floor").notNull().default(0),

    // STT / CTT
    sttPct: real("stt_pct").notNull().default(0),
    sttSide: text("stt_side").notNull().default("none"), // both | buy | sell | none

    // Exchange transaction charges (both sides, on turnover / premium)
    exchangeTxnPct: real("exchange_txn_pct").notNull().default(0),

    // SEBI turnover fee (both sides)
    sebiPct: real("sebi_pct").notNull().default(0),

    // Stamp duty (BUY side only)
    stampPct: real("stamp_pct").notNull().default(0),

    // IPFT (both sides; NSE only typically)
    ipftPct: real("ipft_pct").notNull().default(0),

    // GST (on brokerage + exchange + sebi + ipft + dp + pledge)
    gstPct: real("gst_pct").notNull().default(0.18),

    // DP charges (delivery SELL, per scrip)
    dpCharge: real("dp_charge").notNull().default(0),
    /** Percentage DP fee; dpCharge becomes the floor when this is > 0. */
    dpPct: real("dp_pct").notNull().default(0),
    dpGstApplicable: integer("dp_gst_applicable", { mode: "boolean" })
      .notNull()
      .default(false),
    dpMinValue: real("dp_min_value").notNull().default(0), // skip DP if debit value < this

    // MTF interest (annual). For tiered brokers, mtfTiers holds the slabs.
    mtfInterestAnnual: real("mtf_interest_annual").notNull().default(0),
    /** The broker publishes no MTF rate; see ChargeRates.mtfRateUnknown. */
    mtfRateUnknown: integer("mtf_rate_unknown", { mode: "boolean" }).notNull().default(false),
    mtfTiers: text("mtf_tiers", { mode: "json" }).$type<
      { upTo: number | null; rate: number }[]
    >(),

    // Pledge / unpledge per ISIN
    pledgeCharge: real("pledge_charge").notNull().default(0),
    unpledgeCharge: real("unpledge_charge").notNull().default(0),

    /**
     * True once the user has edited this row by hand.
     *
     * The seed refreshes rate rows on every launch so a published correction
     * (a revised MTF rate, a new plan) reaches installed copies — but it skips
     * rows carrying this flag, because a user's own figure outranks ours.
     */
    userEdited: integer("user_edited", { mode: "boolean" }).notNull().default(false),

    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [
    // Plan is part of the key: a paid tier shares broker+segment+exchange with
    // the free one and must still be storable alongside it.
    uniqueIndex("charge_config_uq").on(t.broker, t.plan, t.segment, t.exchange),
  ],
);

// ---------------------------------------------------------------------------
// risk_config — per-bucket and per-segment risk rules (and global).
// scope: global | bucket | segment ; key: '' | equity|active | <segment>
// ---------------------------------------------------------------------------
export const riskConfig = sqliteTable(
  "risk_config",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    scope: text("scope").notNull(), // global | bucket | segment
    key: text("key").notNull().default(""), // bucket name or segment name
    perTradeMaxLoss: real("per_trade_max_loss"),
    maxOpen: integer("max_open"),
    maxTradesDay: integer("max_trades_day"),
    dailyLossStop: real("daily_loss_stop"),
    concentrationPct: real("concentration_pct"),
    monthlyTargetBase: real("monthly_target_base"),
    monthlyTargetStretch: real("monthly_target_stretch"),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("risk_config_scope_key_uq").on(t.scope, t.key)],
);

// ---------------------------------------------------------------------------
// import_batches
// ---------------------------------------------------------------------------
export const importBatches = sqliteTable("import_batches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id").notNull().default(1),
  broker: text("broker").notNull(),
  fileName: text("file_name").notNull(),
  rowCount: integer("row_count").notNull().default(0),
  addedCount: integer("added_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  importedAt: text("imported_at").notNull().default(now),
  status: text("status").notNull().default("completed"), // completed | failed | partial
  notes: text("notes"),
});

// ---------------------------------------------------------------------------
// classification_overrides — manual re-tagging, re-applied on re-import.
// Keyed by broker + dedup_hash so it survives delete/re-import cycles.
// ---------------------------------------------------------------------------
export const classificationOverrides = sqliteTable(
  "classification_overrides",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    broker: text("broker").notNull(),
    dedupHash: text("dedup_hash").notNull(),
    segment: text("segment"),
    bucket: text("bucket"),
    exchange: text("exchange"),
    isMtf: integer("is_mtf", { mode: "boolean" }),
    setupTag: text("setup_tag"),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("class_override_uq").on(t.broker, t.dedupHash),
  ],
);

// ---------------------------------------------------------------------------
// mtm_prices — manual / EOD price entry for open-position MTM (bulk paste).
// ---------------------------------------------------------------------------
export const mtmPrices = sqliteTable(
  "mtm_prices",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    broker: text("broker"),
    symbol: text("symbol").notNull(),
    tradingsymbol: text("tradingsymbol"),
    price: real("price").notNull(),
    asOfDate: text("as_of_date").notNull(),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [index("mtm_symbol_idx").on(t.symbol)],
);

// ---------------------------------------------------------------------------
// settings — single row (id = 1)
// ---------------------------------------------------------------------------
export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  goLiveDate: text("go_live_date").notNull(),
  equityCapital: real("equity_capital").notNull(),
  activeCapital: real("active_capital").notNull(),
  theme: text("theme").notNull().default("dark"),
  // RETIRED FEATURE, LIVE COLUMN. The C8 accent skins (terminal | tape | ice)
  // were dropped in v3: the Dark Luxe palette gives gold and violet fixed
  // meanings (money / analytics) and a swappable amber primary collided with
  // the gold role. The column stays because dropping it buys nothing and costs
  // a migration that would have to rewrite every existing settings row; stored
  // "tape"/"ice" values are simply never turned into a class (app/layout.tsx),
  // so those users fall back to Terminal with no error and no data loss.
  accentSkin: text("accent_skin").notNull().default("terminal"),
  // compact | comfortable — one root font-size (16px vs 17px); everything is
  // rem-sized so the whole interface scales together (app/globals.css).
  density: text("density").notNull().default("compact"),
  // both | equity | fno — which book the user trades. Hides the other book's
  // screens and sets bucket defaults; never gates a route or a total.
  // See lib/domain/workspace.ts.
  workspace: text("workspace").notNull().default("both"),
  baseCurrency: text("base_currency").notNull().default("INR"),
  fyStartMonth: integer("fy_start_month").notNull().default(4), // April
  colorblindSafe: integer("colorblind_safe", { mode: "boolean" })
    .notNull()
    .default(false),
  defaultBuyOrders: integer("default_buy_orders").notNull().default(1),
  defaultSellOrders: integer("default_sell_orders").notNull().default(1),
  // Cumulative realised P&L already compounded into the bucket capitals (so the
  // "add realised P&L to capital" action never double-counts).
  pnlRolledIn: real("pnl_rolled_in").notNull().default(0),
  licenseKey: text("license_key"), // verified offline against the vendor public key (lib/license.ts)
  // T3.8 — opt-in EOD bhavcopy auto-MTM (off by default: the user decides when
  // the app is allowed to fetch from NSE and overwrite matched MTM prices).
  autoMtmEnabled: integer("auto_mtm_enabled", { mode: "boolean" }).notNull().default(false),
  lastAutoMtmDate: text("last_auto_mtm_date"), // bhavcopy date last applied (once-per-day guard)
  // Monetization v2 — offline full-Pro trial (TRIAL_DAYS), stamped on first run
  // (backfilled to migration time for existing installs). See lib/license.ts.
  trialStartedAt: text("trial_started_at"),
  // Latest date this install has ever observed. Entitlement checks reason about
  // max(system clock, this) so winding the clock back cannot renew a trial or
  // revive an expired key. Ratchet, not a lock — see lib/license.ts#effectiveToday.
  clockHighWaterMark: text("clock_high_water_mark"),
  selectedAccountId: integer("selected_account_id").notNull().default(0), // 0 = all accounts
  updatedAt: text("updated_at").notNull().default(now),
});

// ---------------------------------------------------------------------------
// ipos — IPO applications (primary market). P&L derived from applied/listing/exit.
// ---------------------------------------------------------------------------
export const ipos = sqliteTable("ipos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id").notNull().default(1),
  name: text("name").notNull(),
  broker: text("broker"),
  exchange: text("exchange").notNull().default("NSE"),
  board: text("board").notNull().default("mainboard"), // mainboard | sme (NSE Emerge / BSE SME)
  category: text("category"), // retail | shni | bhni | employee | shareholder
  discountPerShare: real("discount_per_share").notNull().default(0), // employee/shareholder/retail discount
  appliedPrice: real("applied_price").notNull().default(0), // per share (cut-off / issue price)
  lotSize: integer("lot_size").notNull().default(1),
  lotsApplied: integer("lots_applied").notNull().default(1),
  allotted: integer("allotted", { mode: "boolean" }).notNull().default(false),
  allottedQty: real("allotted_qty").notNull().default(0), // shares allotted
  listingPrice: real("listing_price"),
  exitPrice: real("exit_price"),
  appliedDate: text("applied_date"),
  allotmentDate: text("allotment_date"), // acquisition date — starts the tax holding period
  listingDate: text("listing_date"),
  exitDate: text("exit_date"),
  notes: text("notes"),
  /**
   * The holding this allotment became, when the two have been linked.
   *
   * IPO shares are credited without ever appearing as a buy, so the resulting
   * position arrives with no cost basis and no mark. The IPO record holds both
   * facts, and once linked it is the SOURCE OF TRUTH for them — saving the IPO
   * writes the basis and the mark onto the trade. Null means an ordinary
   * application with no holding attached yet.
   */
  tradeId: integer("trade_id"),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
});

// ---------------------------------------------------------------------------
// restricted_securities — SEBI/exchange surveillance list (IND-8). Offline-first:
// the user pastes/imports the daily list (NSE F&O ban, ASM/GSM, circuit bands).
// The engine flags held/open positions against it.
// ---------------------------------------------------------------------------
export const restrictedSecurities = sqliteTable(
  "restricted_securities",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    symbol: text("symbol").notNull(), // underlying / scrip (upper-cased)
    category: text("category").notNull(), // fno_ban | asm | gsm | esm | circuit | other
    stage: text("stage"), // e.g. "ASM Stage II", "GSM Stage 4", "Long-term"
    note: text("note"),
    asOfDate: text("as_of_date").notNull(), // ISO date of the published list
    source: text("source"), // NSE | BSE | manual
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    index("restricted_symbol_idx").on(t.symbol),
    index("restricted_category_idx").on(t.category),
  ],
);

// ---------------------------------------------------------------------------
// ledger_entries — cash & fund-flow ledger (P0.2). Money stored as INTEGER PAISE
// (P0.1). Available capital is derived: opening (settings) + Σ signed amounts.
// ---------------------------------------------------------------------------
export const ledgerEntries = sqliteTable(
  "ledger_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id").notNull().default(1),
    date: text("date").notNull(), // ISO date
    bucket: text("bucket").notNull().default(""), // equity | active | ""
    type: text("type").notNull(), // deposit | withdrawal | charge | realised_pnl | mtf_interest | interest | dividend | dividend_tds | adjustment
    amountPaise: integer("amount_paise").notNull().default(0), // signed
    refTradeId: integer("ref_trade_id"),
    symbol: text("symbol"), // canonical ticker — set on dividend/dividend_tds entries for per-company TDS aggregation
    note: text("note"),
    source: text("source").notNull().default("manual"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("ledger_bucket_idx").on(t.bucket), index("ledger_date_idx").on(t.date)],
);

// ---------------------------------------------------------------------------
// audit_log — append-only change history (P0.3). Every trade/config/capital/ledger
// mutation records who/what/when with a before/after snapshot. Never updated/deleted.
// ---------------------------------------------------------------------------
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: text("ts").notNull().default(now), // ISO datetime
    entity: text("entity").notNull(), // trade | charge_config | risk_config | settings | capital | ledger | restriction
    entityId: integer("entity_id"),
    action: text("action").notNull(), // create | update | delete | close | override
    summary: text("summary"),
    beforeJson: text("before_json", { mode: "json" }).$type<Record<string, unknown> | null>(),
    afterJson: text("after_json", { mode: "json" }).$type<Record<string, unknown> | null>(),
    source: text("source").notNull().default("ui"),
  },
  (t) => [index("audit_ts_idx").on(t.ts), index("audit_entity_idx").on(t.entity)],
);

// ---------------------------------------------------------------------------
// symbol_aliases — map a broker scrip name (e.g. "ADANI TOTAL GAS LIMITED") to the
// canonical NSE/BSE ticker ("ATGL"). Lets bhavcopy auto-MTM and the surveillance
// ban/ASM lists (which use tickers) match positions stored under full broker names.
// ---------------------------------------------------------------------------
export const symbolAliases = sqliteTable(
  "symbol_aliases",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    alias: text("alias").notNull(), // broker/full name (upper-cased)
    ticker: text("ticker").notNull(), // canonical exchange symbol (upper-cased)
    isin: text("isin"),
    note: text("note"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("symbol_alias_uq").on(t.alias)],
);

// ---------------------------------------------------------------------------
// benchmark_prices — index series (e.g. NIFTY 50) for alpha/beta vs the market
// (P1.1). Offline-first: the user pastes the daily closes. Unique per symbol+date.
// `close` is an index level (points), not money, so it stays REAL.
// ---------------------------------------------------------------------------
export const benchmarkPrices = sqliteTable(
  "benchmark_prices",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    symbol: text("symbol").notNull().default("NIFTY"), // upper-cased index name
    date: text("date").notNull(), // ISO date
    close: real("close").notNull(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("benchmark_symbol_date_uq").on(t.symbol, t.date),
    index("benchmark_symbol_idx").on(t.symbol),
  ],
);

// ---------------------------------------------------------------------------
// instruments — security master (P1.3): symbol ↔ ISIN ↔ sector ↔ lot_size ↔ expiry.
// Offline-first: the user pastes/imports it. Powers sector concentration, lot
// sizing and (later) Greeks/VaR. Unique per symbol (canonical upper-cased ticker).
// ---------------------------------------------------------------------------
export const instruments = sqliteTable(
  "instruments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    symbol: text("symbol").notNull(), // canonical ticker (upper-cased)
    name: text("name"), // full company / contract name
    isin: text("isin"),
    sector: text("sector"), // GICS-ish sector / industry label
    lotSize: integer("lot_size"), // derivatives lot size
    expiry: text("expiry"), // ISO date (derivatives)
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("instruments_symbol_uq").on(t.symbol), index("instruments_sector_idx").on(t.sector)],
);

// ---------------------------------------------------------------------------
// instrument_indices — NSE thematic index memberships (symbol × index name).
// Reference data, not account data: populated from the bundled NSE index map
// or from uploaded ind_*_list.csv constituent files, and refreshed by simply
// loading again (upserts on the unique pair). Powers edge-by-theme analytics
// and correlated-bet detection. A symbol legitimately appears many times —
// IRCTC sits in nine indices — which is exactly the signal.
// ---------------------------------------------------------------------------
export const instrumentIndices = sqliteTable(
  "instrument_indices",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    symbol: text("symbol").notNull(), // canonical ticker (upper-cased)
    indexName: text("index_name").notNull(), // e.g. "Nifty India Railways PSU"
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("instrument_indices_pair_uq").on(t.symbol, t.indexName),
    index("instrument_indices_symbol_idx").on(t.symbol),
  ],
);

// ---------------------------------------------------------------------------
// price_history — EOD OHLC series (P1.3) built from bhavcopy. One row per
// symbol+date. Feeds auto-MTM, performance/benchmark series and (later) VaR.
// ---------------------------------------------------------------------------
export const priceHistory = sqliteTable(
  "price_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    symbol: text("symbol").notNull(), // upper-cased
    date: text("date").notNull(), // ISO date
    open: real("open"),
    high: real("high"),
    low: real("low"),
    close: real("close").notNull(),
    volume: real("volume"),
    source: text("source").notNull().default("bhavcopy"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("price_history_symbol_date_uq").on(t.symbol, t.date),
    index("price_history_date_idx").on(t.date),
  ],
);

// ---------------------------------------------------------------------------
// corporate_actions — split/bonus/dividend events (IND-13, V1 slice). Applying
// a split/bonus scales open positions' qty + every price level (avg cost, SL,
// TSL, target) so invested value and ₹ stop-distance are preserved; applying a
// dividend posts a ledger entry per currently-open matching position.
// appliedAt is set once, preventing double-application of the same event.
// ---------------------------------------------------------------------------
export const corporateActions = sqliteTable(
  "corporate_actions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    symbol: text("symbol").notNull(), // canonical ticker (upper-cased)
    type: text("type").notNull(), // split | bonus | dividend
    exDate: text("ex_date").notNull(), // ISO date
    fromUnits: real("from_units"), // split/bonus ratio "from" side (e.g. 1 in "1:5")
    toUnits: real("to_units"), // split/bonus ratio "to" side (e.g. 5 in "1:5")
    dividendPerShare: real("dividend_per_share"), // ₹ per share (dividend only)
    note: text("note"),
    appliedAt: text("applied_at"), // ISO datetime; null = not yet applied
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("corporate_actions_symbol_idx").on(t.symbol), index("corporate_actions_ex_date_idx").on(t.exDate)],
);

// ---------------------------------------------------------------------------
// mtf_margins — per-stock MTF own-margin overrides (broker × symbol).
// Reference data: the bundled snapshot in lib/data/mtf-margins.json is the
// baseline; rows here come from user-uploaded broker files and win over the
// bundle. marginPct is the TRADER'S OWN contribution % — the broker funds
// the remainder. Never account-scoped (a margin rate isn't a trade).
// ---------------------------------------------------------------------------
export const mtfMargins = sqliteTable(
  "mtf_margins",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    broker: text("broker").notNull(),
    symbol: text("symbol").notNull(), // canonical ticker (upper-cased)
    marginPct: real("margin_pct").notNull(),
    isin: text("isin"),
    asOf: text("as_of").notNull(), // ISO date the uploaded list was published/captured
    source: text("source").notNull(), // e.g. "upload: zerodha.json"
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("mtf_margins_pair_uq").on(t.broker, t.symbol), index("mtf_margins_broker_idx").on(t.broker)],
);

// ---------------------------------------------------------------------------
// playbooks — named setups with rule checklists (P2.4 behavioral journaling).
// Trades link via trades.playbook_id; per-playbook expectancy rolls up on the
// Discipline page. Archiving hides a playbook from pickers without orphaning
// the trades already tagged with it.
// ---------------------------------------------------------------------------
export const playbooks = sqliteTable("playbooks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  description: text("description"),
  rules: text("rules", { mode: "json" }).$type<string[]>().notNull().default([]),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
});

// ---------------------------------------------------------------------------
// margin_config — editable margin-rate approximation table (P1.2 margin slice).
// One row per BROKER × segment: % of notional blocked as margin (SPAN+exposure
// approx for derivatives; leverage haircut for intraday/MTF; 100% for delivery).
// Broker-specific because real leverage varies by broker (Dhan/Groww ~4x = 25%
// own-margin, Zerodha up to 5x = 20%) — a single flat rate across brokers
// understated/overstated funded-amount depending which broker you're on.
// The margin gauge on /risk is still an ESTIMATE — brokers' real SPAN files
// (and per-STOCK VaR margin) differ further.
// ---------------------------------------------------------------------------
export const marginConfig = sqliteTable(
  "margin_config",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    broker: text("broker").notNull(),
    segment: text("segment").notNull(),
    marginPct: real("margin_pct").notNull(), // e.g. 12 = 12% of notional
    note: text("note"),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("margin_config_broker_segment_uq").on(t.broker, t.segment)],
);

// ---------------------------------------------------------------------------
// trade_attachments — chart screenshots / images attached to a trade (P2.4).
// Bytes live on disk under <data-dir>/attachments/ (NOT in the DB and NOT in
// the JSON backup — the backup screen states this); rows here are the index.
// ---------------------------------------------------------------------------
export const tradeAttachments = sqliteTable(
  "trade_attachments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tradeId: integer("trade_id").notNull(),
    fileName: text("file_name").notNull(), // original upload name (display)
    storedName: text("stored_name").notNull(), // random name on disk
    mime: text("mime").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("trade_attachments_trade_idx").on(t.tradeId)],
);

// ---------------------------------------------------------------------------
// broker_connections — API credentials for broker auto-import (P2.1). Stored
// PLAINTEXT in the local single-user DB (stated in the UI); Kite access tokens
// expire daily and must be re-pasted. One row per broker.
// ---------------------------------------------------------------------------
export const brokerConnections = sqliteTable(
  "broker_connections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id").notNull().default(1),
    broker: text("broker").notNull(), // zerodha | dhan | angelone | …
    apiKey: text("api_key").notNull(),
    accessToken: text("access_token").notNull(),
    /**
     * Broker-specific extra credentials as ONE vault-encrypted JSON blob
     * (Angel One: { clientCode, pin, totpSecret }). A blob rather than
     * columns because each broker's shape differs and every field in it is a
     * secret anyway — one venc: envelope covers them all. Redacted from
     * backups with the other credential columns.
     */
    authJson: text("auth_json"),
    lastPullAt: text("last_pull_at"), // ISO datetime of the last successful pull
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("broker_connections_account_broker_uq").on(t.accountId, t.broker)],
);

// ---------------------------------------------------------------------------
// accounts — first-class local portfolios. Existing journals migrate to id=1.
// ---------------------------------------------------------------------------
export const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  broker: text("broker"),
  accountRef: text("account_ref"),
  taxIdentity: text("tax_identity"),
  equityCapital: real("equity_capital"),
  activeCapital: real("active_capital"),
  /** Realised P&L already compounded into THIS account's capital. Lives here,
   *  not on settings: a global marker made compounding in one account mark
   *  every other account's P&L as rolled in (migration 0044). */
  pnlRolledIn: real("pnl_rolled_in").notNull().default(0),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
}, (t) => [uniqueIndex("accounts_name_uq").on(t.name)]);

// ---------------------------------------------------------------------------
// trading_sessions — deterministic pre-market plan -> post-market review.
// ---------------------------------------------------------------------------
export const tradingSessions = sqliteTable("trading_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id").notNull().default(1),
  sessionDate: text("session_date").notNull(),
  market: text("market").notNull().default("NSE"),
  plannedSymbols: text("planned_symbols", { mode: "json" }).$type<string[]>().notNull().default([]),
  plannedPlaybookIds: text("planned_playbook_ids", { mode: "json" }).$type<number[]>().notNull().default([]),
  maxTrades: integer("max_trades"),
  maxLoss: moneyPaise("max_loss_paise"),
  cutoffTime: text("cutoff_time"),
  thesis: text("thesis"),
  status: text("status").notNull().default("planned"), // planned | reviewed
  reviewNotes: text("review_notes"),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
}, (t) => [
  uniqueIndex("trading_sessions_account_date_uq").on(t.accountId, t.sessionDate),
  index("trading_sessions_date_idx").on(t.sessionDate),
]);

// ---------------------------------------------------------------------------
// settings_baseline — "My Default Settings". One row; captured on first run,
// replaced only by an explicit save. Payload shape and the preference/state
// split live in lib/domain/settings-baseline.ts.
// ---------------------------------------------------------------------------
export const settingsBaseline = sqliteTable("settings_baseline", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  capturedAt: text("captured_at").notNull().default(now),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
});

// ---------------------------------------------------------------------------
// panel_dismissals — dismiss-with-memory for advisory panels. A dismissal is
// keyed on a FINGERPRINT of the situation it was shown for (see
// lib/domain/dismissals.ts): hidden while the facts are unchanged, returns the
// moment they move. Pruned of stale rows on read.
// ---------------------------------------------------------------------------
export const panelDismissals = sqliteTable("panel_dismissals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id").notNull().default(1),
  panel: text("panel").notNull(),
  fingerprint: text("fingerprint").notNull(),
  dismissedAt: text("dismissed_at").notNull().default(now),
}, (t) => [uniqueIndex("panel_dismissals_uq").on(t.accountId, t.panel, t.fingerprint)]);

// ---------------------------------------------------------------------------
// regulatory_rule_packs — dated, attributable rule/config payloads.
// ---------------------------------------------------------------------------
export const regulatoryRulePacks = sqliteTable("regulatory_rule_packs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  code: text("code").notNull(),
  category: text("category").notNull(),
  version: text("version").notNull(),
  effectiveFrom: text("effective_from").notNull(),
  effectiveTo: text("effective_to"),
  title: text("title").notNull(),
  sourceTitle: text("source_title").notNull(),
  sourceUrl: text("source_url").notNull(),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  reviewedAt: text("reviewed_at"),
  createdAt: text("created_at").notNull().default(now),
}, (t) => [
  uniqueIndex("regulatory_rule_pack_code_version_uq").on(t.code, t.version),
  index("regulatory_rule_pack_effective_idx").on(t.effectiveFrom),
]);

// Type exports
export type Trade = typeof trades.$inferSelect;
export type Playbook = typeof playbooks.$inferSelect;
export type NewTrade = typeof trades.$inferInsert;
export type ChargeConfigRow = typeof chargeConfig.$inferSelect;
export type RiskConfigRow = typeof riskConfig.$inferSelect;
export type Settings = typeof settings.$inferSelect;
export type ImportBatch = typeof importBatches.$inferSelect;
export type ClassificationOverride = typeof classificationOverrides.$inferSelect;
export type CapitalSnapshot = typeof capitalSnapshots.$inferSelect;
export type MtmPrice = typeof mtmPrices.$inferSelect;
export type Ipo = typeof ipos.$inferSelect;
export type NewIpo = typeof ipos.$inferInsert;
export type RestrictedSecurity = typeof restrictedSecurities.$inferSelect;
export type NewRestrictedSecurity = typeof restrictedSecurities.$inferInsert;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type NewLedgerEntry = typeof ledgerEntries.$inferInsert;
export type AuditEntry = typeof auditLog.$inferSelect;
export type NewAuditEntry = typeof auditLog.$inferInsert;
export type SymbolAlias = typeof symbolAliases.$inferSelect;
export type NewSymbolAlias = typeof symbolAliases.$inferInsert;
export type BenchmarkPrice = typeof benchmarkPrices.$inferSelect;
export type NewBenchmarkPrice = typeof benchmarkPrices.$inferInsert;
export type Instrument = typeof instruments.$inferSelect;
export type NewInstrument = typeof instruments.$inferInsert;
export type PriceHistoryRow = typeof priceHistory.$inferSelect;
export type NewPriceHistoryRow = typeof priceHistory.$inferInsert;
export type CorporateAction = typeof corporateActions.$inferSelect;
export type NewCorporateAction = typeof corporateActions.$inferInsert;
export type MarginConfigRow = typeof marginConfig.$inferSelect;
export type TradeAttachment = typeof tradeAttachments.$inferSelect;
export type BrokerConnection = typeof brokerConnections.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type TradingSession = typeof tradingSessions.$inferSelect;
export type RegulatoryRulePack = typeof regulatoryRulePacks.$inferSelect;
