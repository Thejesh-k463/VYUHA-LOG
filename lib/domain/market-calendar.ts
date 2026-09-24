/**
 * THE MARKET CALENDAR — one effective-dated answer to "is the market open, which
 * session is this, and when does the day's official close exist?" (v4.6.0 W1,
 * owner rulings K1–K3, 2026-09-24). PURE (invariant 2): no DB, no React, no
 * clock — every function takes the date or the instant.
 *
 * ── Why it exists ─────────────────────────────────────────────────────────
 *
 * SEBI's Closing Auction Session went live on 2026-08-03 (circular
 * SEBI/HO/47/11/11(3)2025-MRD-POD2/I/2765/2026) and nothing in the repo knew
 * for 52 days (LEDGER L-1): an F&O stock stops continuous trading at 15:15 and
 * its close is struck in an auction that ends 15:35; equity derivatives trade to
 * 15:40; a cash post-close runs 15:50–16:00. The app saved the day's mark from
 * 15:30 and filed every fill after 15:30 as "outside the session". Twenty-one
 * call sites each held their own copy of 15:30 (research R4 Part 2).
 *
 * ── Where the facts come from ─────────────────────────────────────────────
 *
 * `lib/data/market-calendar.json`, built by `scripts/build-market-calendar.mjs`
 * from the files the OWNER downloaded (never fetched; the app contacts no host).
 * Every session row names its source and the build refuses when an anchor
 * phrase is missing from it. Never hand-edit the JSON; re-run the script.
 *
 * ── Five rules (R4 Part 3) ────────────────────────────────────────────────
 *
 * 1. Rows are looked up by the date being ASKED ABOUT — a 2026-07-31 fill by
 *    the pre-CAS row, a 2026-08-04 fill by the CAS row. No bare "15:30" elsewhere
 *    (`tests/market-calendar.test.ts` scans the tree for one).
 * 2. The instrument class matters: a CAS stock (an F&O underlying on that date),
 *    another equity, a derivative, a commodity. Membership is known only from
 *    the F&O list's own date onward; before it (from CAS's start) it is
 *    UNKNOWN, and the answer says so rather than guessing (`casMembership`).
 * 3. Marks wait for the official close (K3): CAS stocks from 15:36, other
 *    equities from 15:31, derivatives from 15:45 — the close plus
 *    `MARK_MARGIN_MIN`, derived, never typed at a call site.
 * 4. Special sessions are trading days (Budget Sunday 2026-02-01, Muhurat
 *    2026-11-08). A special session whose hours are not bundled has NO session
 *    row — callers get null and refuse, never a guessed hour.
 * 5. Coverage is visible: past `coversThrough` a weekday is a trading day but
 *    NOT VERIFIED (session decision, DECISIONS 2026-09-24) and Data Quality warns
 *    from 60 days before.
 *
 * `toIst` / `todayIstIso` stay in `lib/domain/trading-day.ts` — the ONE IST.
 */

import calendar from "@/lib/data/market-calendar.json";
import { toIst, todayIstIso, istWallClockIso } from "@/lib/domain/trading-day";

/* ─────────────────────────────── types ─────────────────────────────── */

export type Market = "NSE_CM" | "BSE_CM" | "NSE_FO" | "BSE_FO" | "MCX";
export type InstrumentClass = "cas_stock" | "equity" | "derivative" | "commodity";
/** A cash stock whose CAS membership on the date cannot be known (rule 2). */
export type SessionClass = InstrumentClass | "cash_unknown";
export type CasMembership = "cas" | "not-cas" | "unknown";
export type PhaseKey =
  | "preopen"
  | "continuous"
  | "cas_reference"
  | "cas_entry"
  | "cas_match"
  | "transition"
  | "postclose"
  | "fno_extension";
/** The coarse phase the spec names (W1): what a screen says. */
export type Phase = "preopen" | "normal" | "cas" | "fno-extension" | "postclose" | "closed";

export interface SessionPhase {
  key: PhaseKey;
  from: string;
  to: string;
}

export interface SessionRow {
  market: Market;
  class: InstrumentClass | "*";
  effectiveFrom: string | null;
  effectiveTo: string | null;
  source: string;
  sourceKind: "primary" | "supporting" | "secondary";
  phases: SessionPhase[];
  officialCloseAt: string;
  closeMethod: string;
}

interface Holiday {
  date: string;
  name: string;
  markets: string[];
}

interface SpecialSession {
  date: string;
  kind: string;
  name: string;
  markets: string[];
  timings: string | null;
}

export interface ProvenanceRow {
  id: string;
  item: number | string;
  sourceKind: "primary" | "supporting" | "secondary";
  ref: string;
  file?: string;
  sha256?: string;
}

interface CalendarFile {
  asOf?: string;
  capturedAt?: string;
  coversThrough?: string;
  sourcesSha256?: string;
  provenance?: ProvenanceRow[];
  sessions?: SessionRow[];
  holidays?: Holiday[];
  specialSessions?: SpecialSession[];
  casMembers?: { asOf?: string; effectiveFrom?: string; symbols?: string[] };
}

// An EMPTY snapshot must never throw (spec §1): every read below defaults, and
// a missing row answers null — which every caller treats as "unknown", never as
// "open". An ABSENT file fails the BUILD (a static import), loudly, by design.
const CAL = calendar as unknown as CalendarFile;
const SESSIONS: readonly SessionRow[] = CAL.sessions ?? [];
const HOLIDAYS: readonly Holiday[] = CAL.holidays ?? [];
const SPECIALS: readonly SpecialSession[] = CAL.specialSessions ?? [];
const CAS_SET: ReadonlySet<string> = new Set((CAL.casMembers?.symbols ?? []).map((s) => s.toUpperCase()));

export const CALENDAR_AS_OF: string = CAL.asOf ?? "";
export const CALENDAR_CAPTURED_AT: string = CAL.capturedAt ?? "";
/** The last date the bundled holiday list covers. Past it, weekdays are UNVERIFIED sessions. */
export const CALENDAR_COVERS_THROUGH: string = CAL.coversThrough ?? "";
/** The first date the holiday list covers (the list is one calendar year). */
export const CALENDAR_COVERS_FROM: string = CALENDAR_COVERS_THROUGH ? `${CALENDAR_COVERS_THROUGH.slice(0, 4)}-01-01` : "";
/** The year the holiday list covers (the name the pre-v4.6.0 year guard used). */
export const NSE_HOLIDAY_YEAR: number = CALENDAR_COVERS_THROUGH ? Number(CALENDAR_COVERS_THROUGH.slice(0, 4)) : 0;
/** sha256 over every source file's sha256 — the digest /instruments shows. */
export const CALENDAR_SOURCES_SHA256: string = CAL.sourcesSha256 ?? "";
export const CALENDAR_PROVENANCE: readonly ProvenanceRow[] = CAL.provenance ?? [];
/** The day SEBI's CAS began in the cash segment. */
export const CAS_EFFECTIVE_FROM: string = CAL.casMembers?.effectiveFrom ?? "";
/** The date of the F&O underlyings snapshot; CAS membership is known from here on. */
export const CAS_MEMBERS_AS_OF: string = CAL.casMembers?.asOf ?? "";
export const CAS_MEMBER_COUNT: number = CAS_SET.size;

/**
 * K3 (owner, 2026-09-24): how long after the official close a mark may be
 * taken — one minute for cash (15:31 / 15:36), five for derivatives (15:45).
 * The ONLY place these margins are written.
 */
export const MARK_MARGIN_MIN: Readonly<Record<"cash" | "derivative" | "commodity", number>> = {
  cash: 1,
  derivative: 5,
  commodity: 5,
};

/** Data Quality starts warning this many days before `coversThrough` (rule 5). */
export const COVERAGE_WARN_DAYS = 60;

/* ─────────────────────────────── helpers ────────────────────────────── */

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A date after every row starts: "the rules in force now", for date-free questions. */
const LATEST = "9999-12-31";

/** Minutes past midnight for "HH:MM", or null. */
export function minutesOf(hhmm: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  return h <= 23 && mm <= 59 ? h * 60 + mm : null;
}

/** "HH:MM" for minutes past midnight. */
export function hhmmOf(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** The IST date and minutes-past-midnight of an instant. */
export function istClock(now: Date): { date: string; minutes: number; weekday: number } {
  const ist = toIst(now);
  return { date: todayIstIso(now), minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes(), weekday: ist.getUTCDay() };
}

const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const shiftDay = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const inRange = (iso: string, r: { effectiveFrom: string | null; effectiveTo: string | null }) =>
  (r.effectiveFrom == null || iso >= r.effectiveFrom) && (r.effectiveTo == null || iso <= r.effectiveTo);

/** Is this date inside the year the holiday list covers? */
export function isCovered(isoDate: string): boolean {
  return !!CALENDAR_COVERS_THROUGH && isoDate >= CALENDAR_COVERS_FROM && isoDate <= CALENDAR_COVERS_THROUGH;
}

/* ─────────────────────────────── days ───────────────────────────────── */

export function specialSessionOn(isoDate: string, market: Market = "NSE_CM"): SpecialSession | null {
  return SPECIALS.find((s) => s.date === isoDate && s.markets.includes(market)) ?? null;
}

/** The listed holiday on this date for this market (weekend holidays included), or null. */
export function holidayOn(isoDate: string, market: Market = "NSE_CM"): Holiday | null {
  if (!isCovered(isoDate)) return null;
  return HOLIDAYS.find((h) => h.date === isoDate && h.markets.includes(market)) ?? null;
}

export interface DayStatus {
  trading: boolean;
  /** False when the answer is the weekday rule past the bundled list (rule 5). */
  verified: boolean;
  reason: "session" | "special" | "weekend" | "holiday" | "unverified" | "invalid";
  /** The holiday's or special session's name. */
  name: string | null;
}

/**
 * Is this a trading day on this market, and how sure is the answer?
 *
 * Order matters: a special session beats the holiday list (Muhurat 2026-11-08 is
 * LISTED as a holiday and traded anyway) and the weekend; a listed holiday beats
 * the weekday rule; a weekday outside the covered year is a session but NOT
 * verified. MCX holidays are not bundled, so an MCX weekday is never verified.
 */
export function tradingDayStatus(isoDate: string, market: Market = "NSE_CM"): DayStatus {
  if (!ISO_RE.test(isoDate) || Number.isNaN(dow(isoDate))) return { trading: false, verified: false, reason: "invalid", name: null };
  const special = specialSessionOn(isoDate, market);
  if (special) return { trading: true, verified: true, reason: "special", name: special.name };
  const holiday = holidayOn(isoDate, market);
  if (holiday) return { trading: false, verified: true, reason: "holiday", name: holiday.name };
  const d = dow(isoDate);
  if (d === 0 || d === 6) return { trading: false, verified: true, reason: "weekend", name: null };
  if (market === "MCX" || !isCovered(isoDate)) return { trading: true, verified: false, reason: "unverified", name: null };
  return { trading: true, verified: true, reason: "session", name: null };
}

/** Takes an ISO date (India's day) or an instant (converted through `todayIstIso`). */
export function isTradingDay(when: Date | string, market: Market = "NSE_CM"): boolean {
  return tradingDayStatus(typeof when === "string" ? when : todayIstIso(when), market).trading;
}

/** The NSE cash-market answer — the name every caller used before v4.6.0. */
export function isTradingDayIst(when: Date | string): boolean {
  return isTradingDay(when, "NSE_CM");
}

/**
 * Is this ISO date a listed NSE cash-market TRADING holiday? Only inside the
 * covered year — an uncovered year is UNKNOWN, never a holiday. CLEARING
 * holidays are not here and must never be added (the market is OPEN on them).
 */
export function isExchangeHoliday(isoDate: string): boolean {
  return ISO_RE.test(isoDate) && holidayOn(isoDate, "NSE_CM") != null;
}

export function exchangeHolidayName(isoDate: string): string | null {
  return ISO_RE.test(isoDate) ? (holidayOn(isoDate, "NSE_CM")?.name ?? null) : null;
}

/**
 * The trading day before an ISO date on this market — holidays skipped, special
 * sessions visited (R4 #11: the old walk-back went INTO holidays and past
 * Sunday sessions). Walks at most 30 days; a stale list cannot loop it.
 */
export function previousTradingDay(isoDate: string, market: Market = "NSE_CM"): string {
  let d = shiftDay(isoDate, -1);
  for (let i = 0; i < 30 && !isTradingDay(d, market); i++) d = shiftDay(d, -1);
  return d;
}

/**
 * The bhavcopy date worth fetching "now": today (IST) once it is a trading day
 * and the EOD file is reliably published (~19:00 IST), else the previous
 * trading day. A file can still be absent for reasons no calendar knows (late
 * publication, a blocked network) — the callers keep their missing-file walk.
 */
export function latestBhavcopyDate(now: Date, publishHourIst = 19): string {
  const { date, minutes } = istClock(now);
  if (!isTradingDay(date) || minutes < publishHourIst * 60) return previousTradingDay(date);
  return date;
}

/**
 * NSE cash-market sessions in `year`: weekdays minus the listed weekday
 * holidays — ONLY for the covered year (2026 → 245: 261 weekdays − 16).
 * Special sessions are NOT counted: they are not the weekday session the
 * annualisation convention means (R4 rule 4 — counting them needs an owner
 * ruling). Any other year → null: unknown, not a guess.
 */
export function nseTradingDaysInYear(year: number): number | null {
  if (!CALENDAR_COVERS_THROUGH || year !== Number(CALENDAR_COVERS_THROUGH.slice(0, 4))) return null;
  let weekdays = 0;
  for (let d = new Date(Date.UTC(year, 0, 1)); d.getUTCFullYear() === year; d.setUTCDate(d.getUTCDate() + 1)) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) weekdays++;
  }
  const weekdayHolidays = HOLIDAYS.filter(
    (h) => h.markets.includes("NSE_CM") && Number(h.date.slice(0, 4)) === year && ![0, 6].includes(dow(h.date)),
  ).length;
  return weekdays - weekdayHolidays;
}

/** Trading days per year used to ANNUALISE daily figures, and where the number came from. */
export interface AnnualisationBasis {
  days: number;
  source: "nse-calendar" | "convention";
  year: number;
}

/**
 * The annualisation basis for the year of `iso` (v4.4.0 D4): the bundled NSE
 * calendar's session count when it covers that year, else the 252 convention —
 * LABELLED as such (`annualisationNote`), never silent. CAGR and Calmar use
 * calendar days ÷ 365 and never read this.
 */
export function annualisationBasis(iso: string): AnnualisationBasis {
  const parsed = Number(iso.slice(0, 4));
  const year = Number.isInteger(parsed) && parsed > 1900 ? parsed : Number(todayIstIso().slice(0, 4));
  const days = nseTradingDaysInYear(year);
  return days == null ? { days: 252, source: "convention", year } : { days, source: "nse-calendar", year };
}

/** The one sentence a page prints beside an annualised figure. */
export function annualisationNote(b: AnnualisationBasis): string {
  return b.source === "nse-calendar"
    ? `${b.days} trading days (NSE ${b.year} calendar)`
    : `${b.days} trading days (convention — ${b.year} is not in the bundled calendar)`;
}

/* ───────────────────────── membership and class ────────────────────── */

/**
 * Is this cash stock in the Closing Auction Session on this date? CAS applies
 * to "stocks in the cash segment on which derivative contracts are available"
 * (SEBI para 4.1.1) — the F&O underlyings list. Before CAS began: never. From
 * the list's own date: known. In between: UNKNOWN (spec W1, rule 2).
 */
export function casMembership(symbol: string, isoDate: string): CasMembership {
  if (!CAS_EFFECTIVE_FROM || isoDate < CAS_EFFECTIVE_FROM) return "not-cas";
  if (!CAS_MEMBERS_AS_OF || isoDate < CAS_MEMBERS_AS_OF) return "unknown";
  return CAS_SET.has(symbol.trim().toUpperCase()) ? "cas" : "not-cas";
}

/**
 * The calendar market for a stored exchange (+ segment). NSE/BSE with a
 * derivative segment is their F&O market; NFO/BFO always are. CDS and anything
 * unknown → null (no session is modelled for it).
 */
export function marketOf(exchange: string | null | undefined, segment?: string | null): Market | null {
  const ex = String(exchange ?? "").trim().toUpperCase();
  const seg = String(segment ?? "").trim().toLowerCase();
  const derivative = seg === "future" || seg.endsWith("_option") || seg.endsWith("_future");
  if (seg.startsWith("commodity_") || ex === "MCX") return "MCX";
  if (ex === "NFO" || (ex === "NSE" && derivative)) return "NSE_FO";
  if (ex === "BFO" || (ex === "BSE" && derivative)) return "BSE_FO";
  if (ex === "NSE") return "NSE_CM";
  if (ex === "BSE") return "BSE_CM";
  return null;
}

/** The session class of an instrument on a date. */
export function classOf(market: Market, symbol: string | null | undefined, isoDate: string): SessionClass {
  if (market === "NSE_FO" || market === "BSE_FO") return "derivative";
  if (market === "MCX") return "commodity";
  const m = symbol ? casMembership(symbol, isoDate) : isoDate < CAS_EFFECTIVE_FROM ? "not-cas" : "unknown";
  return m === "cas" ? "cas_stock" : m === "not-cas" ? "equity" : "cash_unknown";
}

/* ─────────────────────────────── sessions ───────────────────────────── */

/**
 * The session row in force on a date. Null when the day is not a trading day,
 * when it is a special session whose hours are not bundled (Muhurat), or when
 * no row covers it. A `cash_unknown` stock gets the CAS row: its close is the
 * LATER one, which is the safe side for every "has the close happened" question.
 */
export function sessionFor(isoDate: string, market: Market, cls: SessionClass): SessionRow | null {
  if (!isTradingDay(isoDate, market)) return null;
  const special = specialSessionOn(isoDate, market);
  if (special && special.timings !== "normal") return null;
  const want: InstrumentClass = cls === "cash_unknown" ? "cas_stock" : cls;
  return (
    SESSIONS.find((r) => r.market === market && (r.class === want || r.class === "*") && inRange(isoDate, r)) ?? null
  );
}

const COARSE: Record<PhaseKey, Phase> = {
  preopen: "preopen",
  continuous: "normal",
  cas_reference: "cas",
  cas_entry: "cas",
  cas_match: "cas",
  transition: "closed",
  postclose: "postclose",
  fno_extension: "fno-extension",
};

export interface PhaseAnswer {
  date: string;
  phase: Phase;
  key: PhaseKey | null;
  tradingDay: boolean;
  verified: boolean;
}

/** Which phase an instant falls in, on this market, for this class. Half-open [from, to). */
export function phaseAt(now: Date, market: Market, cls: SessionClass): PhaseAnswer {
  const { date, minutes } = istClock(now);
  const status = tradingDayStatus(date, market);
  const row = sessionFor(date, market, cls);
  const hit = row?.phases.find((p) => minutes >= minutesOf(p.from)! && minutes < minutesOf(p.to)!) ?? null;
  return {
    date,
    phase: hit ? COARSE[hit.key] : "closed",
    key: hit?.key ?? null,
    tradingDay: status.trading,
    verified: status.verified,
  };
}

/** Is this market taking orders in continuous trading, the auction or the F&O extension? */
export function isOpen(now: Date, market: Market, cls: SessionClass): boolean {
  const p = phaseAt(now, market, cls).phase;
  return p === "normal" || p === "cas" || p === "fno-extension";
}

/**
 * THE headline "is the market open" — NSE cash continuous trading OR NSE equity
 * derivatives: 09:15–15:40 since 2026-08-03 (09:15–15:30 before). What the
 * sidebar dot and the Live Desk clock show; one answer, so they cannot disagree.
 */
export function isMarketOpen(now: Date): boolean {
  return isOpen(now, "NSE_CM", "equity") || isOpen(now, "NSE_FO", "derivative");
}

/** "HH:MM" when the day's official close EXISTS (15:35 CAS, 15:30 other, 15:40 F&O). */
export function officialCloseAt(isoDate: string, market: Market, cls: SessionClass): string | null {
  return sessionFor(isoDate, market, cls)?.officialCloseAt ?? null;
}

const marginFor = (market: Market): number =>
  market === "MCX" ? MARK_MARGIN_MIN.commodity : market.endsWith("_FO") ? MARK_MARGIN_MIN.derivative : MARK_MARGIN_MIN.cash;

/**
 * K3: minutes past IST midnight from which a mark may be persisted as the day's
 * close — the official close plus `MARK_MARGIN_MIN`. Null when the day has no
 * known session (holiday, weekend, a special session without bundled hours):
 * callers REFUSE on null.
 */
export function officialCloseAvailableAt(isoDate: string, market: Market, cls: SessionClass): number | null {
  const close = minutesOf(officialCloseAt(isoDate, market, cls));
  return close == null ? null : close + marginFor(market);
}

/**
 * The mark minute of the row IN FORCE on a date (null = the rules in force now),
 * whether or not that date trades — for a DEFAULT a setting shows, not a gate.
 */
export function markMinuteInForce(market: Market, cls: InstrumentClass, isoDate: string | null = null): number | null {
  const d = isoDate && ISO_RE.test(isoDate) ? isoDate : LATEST;
  const row = SESSIONS.find((r) => r.market === market && (r.class === cls || r.class === "*") && inRange(d, r));
  const close = minutesOf(row?.officialCloseAt);
  return close == null ? null : close + marginFor(market);
}

/** The instant the official close was struck, as an ISO string with the IST offset. */
export function closeInstantIso(isoDate: string, market: Market, cls: SessionClass): string | null {
  const at = officialCloseAt(isoDate, market, cls);
  return at ? istWallClockIso(isoDate, at) : null;
}

/**
 * The window a streaming provider may run in on a date: from the earliest
 * pre-open of NSE cash / F&O to the LAST mark-availability instant of the day
 * (F&O close + margin: 15:45 since 2026-08-03). Null on a non-trading day or a
 * special session without bundled hours. Derived (R4 rule 3), never typed.
 */
export function liveWindowOn(isoDate: string): { startMin: number; endMin: number } | null {
  const rows = [
    sessionFor(isoDate, "NSE_CM", "cas_stock"),
    sessionFor(isoDate, "NSE_CM", "equity"),
    sessionFor(isoDate, "NSE_FO", "derivative"),
  ].filter((r): r is SessionRow => r != null);
  if (rows.length === 0) return null;
  const startMin = Math.min(...rows.map((r) => minutesOf(r.phases[0]?.from) ?? Number.POSITIVE_INFINITY));
  const ends = [
    officialCloseAvailableAt(isoDate, "NSE_CM", "cas_stock"),
    officialCloseAvailableAt(isoDate, "NSE_CM", "equity"),
    officialCloseAvailableAt(isoDate, "NSE_FO", "derivative"),
  ].filter((n): n is number => n != null);
  return Number.isFinite(startMin) && ends.length ? { startMin, endMin: Math.max(...ends) } : null;
}

/**
 * When an open desk should reconnect once so the close door writes the day's
 * CASH marks: the latest cash mark-availability minute (15:36 since CAS — a CAS
 * stock's close; a non-CAS stock's 15:31 has passed by then). Derivatives are
 * never persisted as marks (`isCashKey`), so they do not move this.
 */
export function cashMarkMinute(isoDate: string): number | null {
  const ends = [officialCloseAvailableAt(isoDate, "NSE_CM", "cas_stock"), officialCloseAvailableAt(isoDate, "NSE_CM", "equity")].filter(
    (n): n is number => n != null,
  );
  return ends.length ? Math.max(...ends) : null;
}

/* ───────────────────────── analytics session bands ────────────────────── */

export interface TradingBands {
  /** The pre-open call auction (fills stamped 09:00–09:14). */
  preopen: { from: string; to: string };
  /** When continuous trading ends for a non-CAS stock and (before CAS) everyone. */
  continuousEnd: string;
  /**
   * From CAS's start: the UNION band after continuous trading — CAS prints
   * (F&O stocks, 15:30–15:35) and the F&O extension (to 15:40). It claims
   * neither CAS nor non-CAS, because a fill row does not always say which (rule 2).
   */
  auction: { from: string; to: string } | null;
  /** The cash post-close session (15:50–16:00 since CAS). */
  postclose: { from: string; to: string } | null;
}

/**
 * The exchange boundaries the analytics session bands are cut from, for a
 * date (null = the rules in force now, for labels). Built from the rows, so a
 * 2026-07-31 fill and a 2026-08-04 fill are bucketed by their own day's rules.
 */
export function tradingBandsOn(isoDate: string | null): TradingBands {
  const d = isoDate && ISO_RE.test(isoDate) ? isoDate : LATEST;
  const row = (market: Market, cls: InstrumentClass) =>
    SESSIONS.find((r) => r.market === market && (r.class === cls || r.class === "*") && inRange(d, r)) ?? null;
  const eq = row("NSE_CM", "equity");
  const cas = row("NSE_CM", "cas_stock");
  const fo = row("NSE_FO", "derivative");
  const phase = (r: SessionRow | null, k: PhaseKey) => r?.phases.find((p) => p.key === k) ?? null;
  const pre = phase(eq, "preopen");
  const cont = phase(eq, "continuous");
  const match = cas && cas.class === "cas_stock" ? phase(cas, "cas_match") : null;
  const ext = phase(fo, "fno_extension");
  const post = phase(eq, "postclose");
  return {
    preopen: { from: pre?.from ?? "09:00", to: pre?.to ?? cont?.from ?? "09:15" },
    continuousEnd: cont?.to ?? eq?.officialCloseAt ?? "15:30",
    auction: match ? { from: match.from, to: ext?.to ?? match.to } : null,
    postclose: post ? { from: post.from, to: post.to } : null,
  };
}

/* ──────────────────────────────── coverage ────────────────────────────── */

export interface CalendarCoverage {
  coversThrough: string;
  /** Days from `today` to `coversThrough` (negative once passed). */
  daysLeft: number | null;
  state: "ok" | "expiring" | "expired" | "absent";
}

/** Rule 5: how long the bundled calendar has left, from `today` (an IST ISO date). */
export function calendarCoverage(today: string): CalendarCoverage {
  if (!CALENDAR_COVERS_THROUGH || !ISO_RE.test(today)) {
    return { coversThrough: CALENDAR_COVERS_THROUGH, daysLeft: null, state: "absent" };
  }
  const daysLeft = Math.round(
    (Date.parse(`${CALENDAR_COVERS_THROUGH}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
  const state = daysLeft < 0 ? "expired" : daysLeft <= COVERAGE_WARN_DAYS ? "expiring" : "ok";
  return { coversThrough: CALENDAR_COVERS_THROUGH, daysLeft, state };
}
