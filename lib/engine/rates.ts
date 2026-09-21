import { buildChargeConfigSeed } from "@/lib/db/seed-data";
import { BROKERS, type Broker, type Exchange, type Segment } from "@/lib/domain/constants";
import { mtfRateFor } from "./charges";
import type { ChargeRates } from "./types";

/**
 * Rate lookup, EFFECTIVE-DATED.
 *
 * ── Why the date argument exists ──────────────────────────────────────────
 *
 * Until v3.2.0 this map held exactly one rate row per
 * (broker, plan, segment, exchange) and `findRates` took no date, so a trade
 * from any year was priced at whatever that row held TODAY. Statutory rates
 * change; a book spanning a change was priced wholly at the newer regime.
 * The Pro screen that actually RE-PRICES is `/reports/broker-compare`.
 * `/reports/charges` accumulates the `chargesTotal` stored at commit time
 * (`lib/analytics/charges-report.ts`), so effective dating reaches it only
 * through what future imports write — stated precisely because an earlier
 * draft of this comment overclaimed it.
 *
 * So a key now holds a list of dated EPOCHS and the caller must say which date
 * it is pricing. The date is a required parameter, deliberately: making it
 * optional would have let every existing call site keep the old behaviour
 * silently, which is the bug.
 *
 * Windows are inclusive-from / exclusive-to, so adjacent epochs abut without
 * overlapping and a boundary date belongs to exactly one epoch.
 *
 * ── What it refuses to do ─────────────────────────────────────────────────
 *
 * If no epoch covers the date, this THROWS rather than falling back to the
 * nearest one. A silently-substituted rate is a wrong number wearing the same
 * typeface as a right one (invariant 6). In practice it cannot happen for
 * existing data: migration 0050 stamps every pre-existing row `1970-01-01`
 * with an open end, so each key already covers all of history.
 */

export type RatesMap = Map<string, ChargeRates[]>;

/**
 * Which date prices a position — decided ONCE, here, rather than eleven times
 * at eleven call sites.
 *
 * The sell date wins when there is one: STT (on the sell side for delivery and
 * intraday equity) and DP charges both fall there, so it is the leg that
 * dominates the bill. An open position has only a buy date. A position with
 * neither is un-priceable by date and falls back to `fallback`, which callers
 * set to the day they are pricing.
 *
 * A position that SPANS an epoch boundary is therefore priced wholly at the
 * epoch its sell date lands in. That is a stated approximation: `computeCharges`
 * takes one rate set for both sides. NOTE: the staged engine does NOT resolve
 * per leg either — `lib/queries/staged.ts` makes ONE `findRates` call for the
 * whole ladder at `ctx.asOf`; `legChargeShapes` decides which CHARGES apply per
 * leg, not which RATES. Recorded in DECISIONS 2026-08-30.
 */
export function pricingDate(
  t: { sellDate?: string | null; buyDate?: string | null },
  fallback: string,
): string {
  return isoDate(t.sellDate) ?? isoDate(t.buyDate) ?? fallback;
}

/**
 * Coerce a date to ISO `YYYY-MM-DD`, or null if it is not a usable date.
 *
 * This has to handle BOTH conventions, because `buildRow` prices a trade
 * BEFORE `normalizeDate` runs at insert time — so a Groww row still says
 * `06-05-2026` here. Comparing that string against an ISO window silently
 * matched nothing and made `findRates` refuse a perfectly valid trade
 * (caught by the Groww import test, not by review).
 *
 * Ambiguity is resolved the way Indian broker exports actually behave: a
 * four-digit leading group is ISO, anything else is day-first.
 */
function isoDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = String(s).trim();
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = t.match(/^(\d{2})[-/](\d{2})[-/](\d{4})/);
  if (dmy) {
    // Validate before composing. An American `12-25-2026` would otherwise become
    // "2026-25-12" — not a date, but lexically larger than every real date that
    // year, so `covers()` would silently resolve it to the NEWEST epoch. A
    // refusal (null → the caller's fallback) is the honest answer.
    const [, d, m] = dmy;
    if (Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > 31) return null;
    return `${dmy[3]}-${m}-${d}`;
  }
  return null;
}

function key(broker: string, plan: string, segment: string, exchange: string) {
  return `${broker}|${plan}|${segment}|${exchange}`;
}

/**
 * A commodity contract can be LISTED off MCX — the real Dhan Global
 * Transaction Report carries `OPT CRUDEOIL 09 Jun 2026 8000 PE` on NSE, and
 * NSE does list crude options. `charge_config` prices commodity segments at
 * MCX only, so the venue the broker states used to have to be thrown away to
 * make the row priceable, which put a wrong exchange on the user's own record.
 *
 * Instead the record keeps the stated venue and the LOOKUP falls back: price
 * at MCX, record at NSE. Nothing is hard-coded — the MCX row of
 * `charge_config` is what prices it, so an operator edit still governs
 * (invariant 3). The fallback applies ONLY to commodity segments and ONLY
 * when the stated exchange has no commodity row of its own; the day one is
 * added, it wins.
 */
const COMMODITY_FALLBACK: Exchange = "MCX";

function isCommoditySegment(segment: Segment): boolean {
  return segment.startsWith("commodity");
}

/** The exchange whose `charge_config` rows would actually price this key. */
export function pricingExchange(
  map: RatesMap,
  broker: Broker,
  segment: Segment,
  exchange: Exchange,
  plan = "default",
): Exchange {
  const direct = map.get(key(broker, plan, segment, exchange));
  if (direct && direct.length > 0) return exchange;
  if (isCommoditySegment(segment) && exchange !== COMMODITY_FALLBACK) {
    const fb = map.get(key(broker, plan, segment, COMMODITY_FALLBACK));
    if (fb && fb.length > 0) return COMMODITY_FALLBACK;
  }
  return exchange;
}

/** ISO `YYYY-MM-DD` compares correctly as a string; no Date object needed. */
function covers(r: ChargeRates, onDate: string): boolean {
  const from = r.effectiveFrom ?? "1970-01-01";
  if (onDate < from) return false;
  const to = r.effectiveTo ?? null;
  return to == null || onDate < to;
}

/**
 * Insert a row into an epoch list, keeping it sorted NEWEST FIRST.
 *
 * Newest-first matters: the overwhelmingly common lookup is "today", and the
 * first element then answers it without scanning the history.
 */
export function addEpoch(map: RatesMap, r: ChargeRates): void {
  const k = key(r.broker, r.plan, r.segment, r.exchange);
  const list = map.get(k);
  if (!list) {
    map.set(k, [r]);
    return;
  }
  list.push(r);
  list.sort((a, b) => (b.effectiveFrom ?? "").localeCompare(a.effectiveFrom ?? ""));
}

/**
 * Build a `RatesMap` from loose rows — the shape a test fixture or a seed
 * naturally has. Rows without an `effectiveFrom` cover all of history, which is
 * what a fixture that does not care about epochs means.
 */
export function ratesMapOf(rows: Iterable<ChargeRates>): RatesMap {
  const map: RatesMap = new Map();
  for (const r of rows) addEpoch(map, r);
  return map;
}

/** Build an in-memory rate lookup from the canonical seed (pure — no DB). */
export function seedRatesMap(): RatesMap {
  const map: RatesMap = new Map();
  for (const r of buildChargeConfigSeed()) addEpoch(map, { ...r });
  return map;
}

/**
 * Every epoch on file for one key, newest first. Empty when the key is unknown.
 * Exposed so a UI can SHOW the rate history rather than assert one rate.
 */
export function epochsFor(
  map: RatesMap,
  broker: Broker,
  segment: Segment,
  exchange: Exchange,
  plan = "default",
): ChargeRates[] {
  return map.get(key(broker, plan, segment, exchange)) ?? [];
}

/** One epoch's slice of a holding period. */
export interface EpochSpan {
  rates: ChargeRates;
  /** Inclusive start of the slice, `YYYY-MM-DD`. */
  from: string;
  /** Exclusive end of the slice, `YYYY-MM-DD`. */
  to: string;
  /** Calendar days in the slice. Spans always sum to the whole period. */
  days: number;
}

/** Whole calendar days between two ISO dates. Both are date-only, so UTC is exact. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}

/**
 * Split a holding period into the rate epochs that actually governed it.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * MTF interest accrues DAILY over a period that can straddle a rate change.
 * Pricing the whole period at today's rate silently restates interest the user
 * already accrued under the old one — and because the accrual job writes
 * `chargesTotal` and `netPnl` back to the trade, that is a stored P&L changing
 * with no prompt and no audit entry. DECISIONS 2026-08-30 decision 6 forbids
 * exactly that, and an adversarial review found the job doing it anyway.
 *
 * Spans are returned oldest-first and their `days` ALWAYS sum to
 * `daysBetween(from, to)`, so a single open-ended epoch yields one span and
 * arithmetic identical to the un-segmented version. That is deliberate: the
 * common case must not change at all.
 *
 * Refuses (throws) when the period is not fully covered, for the same reason
 * `findRates` does — a gap silently priced at a neighbouring rate is a wrong
 * number that looks exactly like a right one.
 */
export function epochSpans(
  map: RatesMap,
  broker: Broker,
  segment: Segment,
  exchange: Exchange,
  from: string,
  to: string,
  plan = "default",
): EpochSpan[] {
  if (to <= from) return [];
  const list = map.get(key(broker, plan, segment, exchange));
  if (!list || list.length === 0) {
    throw new Error(`No charge_config for ${broker} / ${plan} / ${segment} / ${exchange}`);
  }
  // Oldest-first for the walk; the stored list is newest-first.
  const asc = [...list].sort((a, b) =>
    (a.effectiveFrom ?? "1970-01-01").localeCompare(b.effectiveFrom ?? "1970-01-01"),
  );

  const spans: EpochSpan[] = [];
  let cursor = from;
  for (const r of asc) {
    const eFrom = r.effectiveFrom ?? "1970-01-01";
    const eTo = r.effectiveTo ?? null;
    if (eTo != null && eTo <= cursor) continue; // epoch ended before we get there
    if (eFrom > cursor) break; // gap — caught below
    const end = eTo == null ? to : (eTo < to ? eTo : to);
    if (end > cursor) {
      spans.push({ rates: r, from: cursor, to: end, days: daysBetween(cursor, end) });
      cursor = end;
    }
    if (cursor >= to) break;
  }

  if (cursor < to) {
    const windows = asc
      .map((r) => `${r.effectiveFrom ?? "1970-01-01"}→${r.effectiveTo ?? "open"}`)
      .join(", ");
    throw new Error(
      `No charge_config epoch covers ${cursor}..${to} for ${broker} / ${plan} / ${segment} / ${exchange}. On file: ${windows}`,
    );
  }
  return spans;
}

/**
 * The STATUTORY columns of charge_config for a (segment, exchange, date), with
 * no broker in the picture — for a charge that names no broker (an IPO exit
 * with no broker recorded, R36).
 *
 * STT/CTT, exchange txn, IPFT, SEBI, stamp and GST are levied by statute or by
 * the exchange, so every broker's row for a key carries the same values
 * (DECISIONS 2026-08-12, the futExitSttPct precedent). The row is still picked
 * DETERMINISTICALLY, never by map insertion order (which follows the DB's row
 * order and so moves under an edit): among the rows whose window covers the
 * date, the "default" plan first, then the broker's position in `BROKERS`
 * (a broker outside that list sorts after it, by name), then the plan name.
 *
 * Returns a COPY — the map is never mutated — with every broker-set column
 * neutralised: brokerage, DP, MTF interest, pledge and subscription are zero.
 * A broker's DP tariff is not statute, so a brokerless charge carries none;
 * borrowing the first broker's DP was considered and rejected.
 *
 * No commodity venue fallback applies here (that one is per broker key, see
 * `pricingExchange`). Throws when no row covers the date, as `findRates` does.
 */
export function statutoryRatesFor(
  map: RatesMap,
  segment: Segment,
  exchange: Exchange,
  onDate: string,
): ChargeRates {
  const order = (b: string) => {
    const i = (BROKERS as readonly string[]).indexOf(b);
    return i < 0 ? BROKERS.length : i;
  };
  const hits: ChargeRates[] = [];
  for (const list of map.values()) {
    for (const r of list) {
      if (r.segment === segment && r.exchange === exchange && covers(r, onDate)) hits.push(r);
    }
  }
  if (hits.length === 0) {
    throw new Error(`No charge_config for any broker / ${segment} / ${exchange} covering ${onDate}`);
  }
  hits.sort(
    (a, b) =>
      (a.plan === "default" ? 0 : 1) - (b.plan === "default" ? 0 : 1) ||
      order(a.broker) - order(b.broker) ||
      a.broker.localeCompare(b.broker) ||
      a.plan.localeCompare(b.plan),
  );
  return {
    ...hits[0],
    planLabel: null,
    subscriptionMonthly: 0,
    brokerageFlat: null,
    brokeragePct: 0,
    brokerageCap: null,
    brokerageFloor: 0,
    dpCharge: 0,
    dpPct: 0,
    dpGstApplicable: false,
    dpMinValue: 0,
    mtfInterestAnnual: 0,
    mtfRateUnknown: false,
    mtfTiers: null,
    pledgeCharge: 0,
    unpledgeCharge: 0,
  };
}

// ---------------------------------------------------------------------------
// PLANS — which pricing plan an ACCOUNT is on, and from when (v4.5.0 wave U)
// ---------------------------------------------------------------------------

/**
 * The account facts a plan resolves from. Deliberately structural, not the
 * Drizzle row type: this module is pure (invariant 2) and must stay importable
 * from a test fixture that has no database.
 */
export interface PlanAccount {
  /** The broker this account is with. Free text, nullable (schema.ts accounts). */
  broker?: string | null;
  /** The plan key in charge_config, e.g. "plus". Null = the user stated none. */
  brokerPlan?: string | null;
  /** `YYYY-MM-DD` the plan started. Blank/null = "always" (owner ruling U1). */
  brokerPlanFrom?: string | null;
}

const normBroker = (b: string | null | undefined): string => (b ?? "").trim().toLowerCase();

/** Every plan key on file for a broker, "default" first. Empty for an unknown broker. */
export function plansFor(map: RatesMap, broker: string): string[] {
  const b = normBroker(broker);
  const seen = new Set<string>();
  for (const k of map.keys()) {
    const [kb, plan] = k.split("|");
    if (kb === b) seen.add(plan);
  }
  const out = [...seen];
  out.sort((x, y) => (x === "default" ? -1 : y === "default" ? 1 : x.localeCompare(y)));
  return out;
}

/** True when `charge_config` holds at least one row for this (broker, plan). */
function mapHasPlan(map: RatesMap, broker: string, plan: string): boolean {
  const prefix = `${normBroker(broker)}|${plan}|`;
  for (const k of map.keys()) if (k.startsWith(prefix)) return true;
  return false;
}

/**
 * WHICH PLAN PRICES THIS TRADE — the one rule, pure and total.
 *
 * The plan is an attribute of the ACCOUNT's relationship with ONE broker, not
 * of a trade, so it applies only when all four things hold:
 *
 *   1. the account states a plan at all (null = the user never said, so Basic);
 *   2. the account's broker IS the broker of the trade being priced — an
 *      "upstox/plus" account holding a Zerodha row must not ask charge_config
 *      for `zerodha | plus`, which would THROW and abort a whole import
 *      (design review item 2);
 *   3. `charge_config` actually holds that (broker, plan) — a plan name left
 *      behind by an older build, or a row the user deleted, prices at default
 *      rather than throwing;
 *   4. the date being priced is on/after `brokerPlanFrom`. Blank = always,
 *      which is the owner's own answer for Upstox (U1, "Plus, whole history").
 *
 * Anything else is "default". It NEVER throws: a mismatch is an ordinary fact
 * about a book, not an error.
 */
export function resolvePlan(
  account: PlanAccount | null | undefined,
  tradeBroker: string | null | undefined,
  onDate: string,
  map: RatesMap,
): string {
  const plan = (account?.brokerPlan ?? "").trim();
  if (!plan || plan === "default") return "default";
  const broker = normBroker(account?.broker);
  if (!broker || broker !== normBroker(tradeBroker)) return "default";
  if (!mapHasPlan(map, broker, plan)) return "default";
  const from = (account?.brokerPlanFrom ?? "").trim();
  if (from && (isoDate(onDate) ?? onDate) < from) return "default";
  return plan;
}

/**
 * The plan for a trade priced in a VIEW rather than in one account — the three
 * read-only estimate surfaces (/equity breakeven, /targets/equity, /sizing-lab)
 * price positions that carry no account id of their own.
 *
 * Unanimity or nothing: in a single-account view that is simply that account's
 * plan; in the All-accounts view every account on that broker must resolve to
 * the SAME plan, otherwise "default". Two accounts on one broker under two
 * plans have no single honest answer, and inventing one is invariant 6.
 */
export function resolvePlanAcross(
  accountsInView: readonly PlanAccount[],
  tradeBroker: string | null | undefined,
  onDate: string,
  map: RatesMap,
): string {
  const plans = new Set<string>();
  for (const a of accountsInView) {
    if (normBroker(a.broker) !== normBroker(tradeBroker)) continue;
    plans.add(resolvePlan(a, tradeBroker, onDate, map));
  }
  return plans.size === 1 ? [...plans][0] : "default";
}

/** One slice of a holding period priced under a single plan. */
export interface PlanSpan {
  plan: string;
  /** Inclusive start, `YYYY-MM-DD`. */
  from: string;
  /** Exclusive end, `YYYY-MM-DD`. */
  to: string;
}

/**
 * Split a holding period at `brokerPlanFrom`, so MTF interest already accrued
 * under Basic is never restated at Plus's rate.
 *
 * Same contract as `epochSpans`: oldest first, the slices tile [from, to)
 * exactly, and a period that never crosses the plan boundary yields ONE span —
 * so the common case computes precisely as it did before this existed.
 * DECISIONS 2026-08-30 decision 6: a stored P&L never moves silently.
 */
export function planSpans(
  account: PlanAccount | null | undefined,
  tradeBroker: string | null | undefined,
  from: string,
  to: string,
  map: RatesMap,
): PlanSpan[] {
  if (to <= from) return [];
  const atStart = resolvePlan(account, tradeBroker, from, map);
  const atEnd = resolvePlan(account, tradeBroker, to, map);
  if (atStart === atEnd) return [{ plan: atStart, from, to }];
  const cut = (account?.brokerPlanFrom ?? "").trim();
  if (!cut || cut <= from || cut >= to) return [{ plan: atEnd, from, to }];
  return [
    { plan: atStart, from, to: cut },
    { plan: atEnd, from: cut, to },
  ];
}

/**
 * Interest accrued on one MTF position between two dates — PER PLAN span and
 * then per RATE epoch (v4.5.0 wave U). Pure: the accrual job and the account
 * editor's "N open MTF rows re-accrue: was X, will be Y" preview both read it,
 * so the figure shown before a plan is set is the figure that gets written.
 *
 * Pricing the whole holding period at today's plan would restate interest the
 * user already accrued under the old one, and the job writes `chargesTotal`
 * and `netPnl` back — a stored P&L moving with no prompt and no audit row,
 * which DECISIONS 2026-08-30 decision 6 forbids. `planSpans` tiles the period
 * exactly, so a book on no plan accrues precisely as it did before this
 * existed. Throws exactly where `epochSpans` does (a period no rate epoch
 * covers); callers leave the row alone rather than invent a rate.
 */
export function mtfInterestOver(
  map: RatesMap,
  t: { broker: string; exchange: string },
  funded: number,
  account: PlanAccount | null | undefined,
  from: string,
  to: string,
): number {
  let acc = 0;
  for (const p of planSpans(account, t.broker, from, to, map)) {
    const spans = epochSpans(map, t.broker as Broker, "eq_mtf", t.exchange as Exchange, p.from, p.to, p.plan);
    for (const s of spans) acc += (funded * mtfRateFor(funded, s.rates) * s.days) / 365;
  }
  return Math.round(acc * 100) / 100;
}

/**
 * THE pricing entry point every product call site uses (design review item 1).
 *
 * It is `findRates` plus the plan, and it exists so that the plan (and, from
 * wave 3a, the ETF overlay) is applied in ONE place rather than at twelve call
 * sites — eleven of which would eventually miss it.
 *
 * ── SEAM FOR WAVE 3a: THE ETF STT OVERLAY ─────────────────────────────────
 * An ETF is taxed at a different STT rate from an ordinary share while sharing
 * the same segment, so wave 3a overlays `sttPct` on the row returned below —
 * gated on `t.segment` being one of `eq_delivery | eq_intraday | eq_mtf`
 * BEFORE any symbol/ISIN lookup, and returning a COPY (the map is never
 * mutated), exactly as `statutoryRatesFor` does. `t.isin` and `t.symbol` are
 * accepted here for that lookup and are deliberately unused today. Do NOT put
 * the overlay in a call site: the other eleven would miss it.
 */
export function ratesForTrade(
  map: RatesMap,
  t: {
    broker: Broker;
    segment: Segment;
    exchange: Exchange;
    /** For the wave 3a ETF lookup. Unused today. */
    isin?: string | null;
    /** For the wave 3a ETF lookup. Unused today. */
    symbol?: string | null;
  },
  onDate: string,
  plan = "default",
): ChargeRates {
  return findRates(map, t.broker, t.segment, t.exchange, onDate, plan);
}

export function findRates(
  map: RatesMap,
  broker: Broker,
  segment: Segment,
  exchange: Exchange,
  /**
   * The date being priced, `YYYY-MM-DD`. Required — see the header.
   *
   * A position that SPANS an epoch boundary is priced at one epoch, because
   * `computeCharges` takes a single rate set for both sides. Callers pass the
   * date of the leg that dominates the charge (the sell date, where there is
   * one: STT and DP both fall there). That is a stated approximation, not an
   * oversight — and note the staged engine does not resolve per leg either.
   */
  onDate: string,
  /** Which pricing plan. Defaults to the free tier most accounts are on. */
  plan = "default",
): ChargeRates {
  // Commodity contracts listed off MCX are priced at MCX — see pricingExchange.
  const venue = pricingExchange(map, broker, segment, exchange, plan);
  const list = map.get(key(broker, plan, segment, venue));
  if (!list || list.length === 0) {
    throw new Error(
      `No charge_config for ${broker} / ${plan} / ${segment} / ${exchange}`,
    );
  }
  const hit = list.find((r) => covers(r, onDate));
  if (!hit) {
    const windows = list
      .map((r) => `${r.effectiveFrom ?? "1970-01-01"}→${r.effectiveTo ?? "open"}`)
      .join(", ");
    throw new Error(
      `No charge_config epoch covers ${onDate} for ${broker} / ${plan} / ${segment} / ${venue}. On file: ${windows}`,
    );
  }
  return hit;
}
