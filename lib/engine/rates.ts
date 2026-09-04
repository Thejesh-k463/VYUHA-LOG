import { buildChargeConfigSeed } from "@/lib/db/seed-data";
import type { Broker, Exchange, Segment } from "@/lib/domain/constants";
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
