import "server-only";
import { asc, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { priceHistory, riskConfig } from "@/lib/db/schema";
import { deriveOpenPositions } from "@/lib/analytics/positions";
import { todayIstIso } from "@/lib/domain/trading-day";
import { portfolioHeat, sectorConcentration, type HeatRow } from "@/lib/live/heat";
import { computeStop, gateStop } from "@/lib/live/stop";
import { computeTrackerRow, DEFAULT_ATR_LENGTH } from "@/lib/live/tracker-row";
import type { Bar, LivePosition, Mark, Paise } from "@/lib/live/types";
import { getLiveFeedProvider } from "@/lib/quotes/registry";
import { quoteKeyId, type Exchange, type QuoteKey } from "@/lib/quotes/types";
import { getAccounts, getSelectedAccountId } from "@/lib/queries/accounts";
import { getBucketCapital } from "@/lib/queries/bucket-capital";
import { getSectorResolution } from "@/lib/queries/instruments";
import { getMtfMarginByBroker } from "@/lib/queries/margin";
import { getMtmMap } from "@/lib/queries/mtm";
import { getTrades } from "@/lib/queries/trades";
import type { BarsCap, DeskBar, DeskRow, FeedInfo, LiveDeskData } from "./desk-types";

/**
 * The Live Desk server loader — journal rows in, `LiveDeskData` out.
 *
 * ACCOUNT SCOPE (invariants 8 and 9). The single read is `getTrades()`, which
 * applies `getSelectedAccountId()`'s `accountId > 0 ? filter : all`. So the
 * desk shows ONE account when one is selected and EVERY account when the
 * selection is the aggregate 0 — the owner's Q19 ruling ("all accounts
 * aggregated, account filter in the header, account id on every row") is that
 * one line plus `accountId` riding on every row from `LivePosition` onward.
 * The desk writes nothing, so 0 stays a view and never reaches a write path.
 *
 * WHY IT LIVES UNDER `components/live/` rather than `lib/queries/`: this wave
 * owns `app/live/**` and `components/live/**` and nothing else, and a
 * cross-wave edit to `lib/queries/` is how two agents clobber one file. The
 * natural home is `lib/queries/live-desk.ts` and moving it there is a
 * one-import change — recorded rather than done quietly.
 *
 * UNITS (invariant 1). The journal hands out RUPEES at runtime (`moneyPaise`
 * converts on read, per-unit prices are REAL by design). Everything crossing
 * into `lib/live/` is converted to integer paise HERE, once, at this boundary.
 * Nothing below this file sees a rupee and nothing above it sees a paise
 * except through `desk-format.ts`.
 *
 * NULL IS A VALUE (invariant 6). No capital → `capitalP: null` → heat, % of
 * capital and every capital-relative figure come back null and the desk prints
 * a dash with the reason. There is no fallback capital figure anywhere here.
 *
 * ENTITLEMENT (owner ruling Q55, invariant 7). `/live` is a PARTIAL feature:
 * the journal's own record is free and R, risk at stop, heat, concentration and
 * the chart overlay are Pro. The client renders locked chips over those cells —
 * but hiding is not gating. Every one of those numbers used to be computed here
 * and shipped inside the RSC payload, where View Source reads it. So the
 * entitlement is a REQUIRED argument (a default is a leak the next call site
 * inherits by forgetting) and the Pro fields leave as `null`, the way
 * `lib/domain/lens-edge.ts` returns `edge: null` — null means NOT ENTITLED, and
 * every read site is forced to branch on it.
 */

/** Sessions of history fetched per symbol — enough for a 252-session 52w window. */
export const DESK_HISTORY_SESSIONS = 260;

/** Sessions of OHLC shipped to the client for the expanded chart. */
export const DESK_CHART_BARS = 120;

/** Distinct symbols whose OHLC is shipped. Beyond this the chart states the cap. */
export const DESK_CHART_SYMBOLS = 60;

/** Closes shipped per row for the inline sparkline. 30 is the cell's width. */
export const SPARK_SESSIONS = 30;

/** NSE cash equity ticks in 5 paise; a non-cash row disables tick rounding. */
const CASH_TICK_PAISE = 5;

const toPaise = (rupees: number): Paise => Math.round(rupees * 100);
const toPaiseOrNull = (v: number | null | undefined): Paise | null =>
  v === null || v === undefined ? null : Math.round(v * 100);

/**
 * `qty × avgPrice`, converted to paise and rounded ONCE (invariant 1).
 *
 * `avgPrice` is a per-unit LEVEL and stays REAL in the journal because rounding
 * it corrupts `qty × price`. `toPaise(avgPrice)` first and multiply after is
 * exactly that corruption: 1,000 shares at ₹123.456 come out ₹4 short of the
 * journal's own figure (`lib/analytics/positions.ts` rounds the product).
 */
const investedPaise = (qty: number, avgPrice: number): Paise => Math.round(qty * avgPrice * 100);

/** DB exchange text → the quote key's exchange. Unknown text stays NSE-shaped. */
function asExchange(raw: string): Exchange {
  const v = (raw ?? "").trim().toUpperCase();
  return v === "BSE" || v === "NFO" || v === "BFO" || v === "MCX" || v === "CDS" ? (v as Exchange) : "NSE";
}

/**
 * Ascending OHLCV history for the symbols on the desk, in paise.
 *
 * Reads `price_history` directly rather than `getBarsMap()` because that
 * projection drops `open` and `volume` — with them the desk's RVOL column is
 * permanently null and the chart has no candles. Same table, same order, one
 * `inArray` query, no new WHERE: the cost of the wider projection is two more
 * columns per row, and the alternative is fabricating an open (invariant 6).
 */
function readBars(symbols: string[]): Map<string, Bar[]> {
  const out = new Map<string, Bar[]>();
  const wanted = [...new Set(symbols.map((s) => s.trim().toUpperCase()))].filter(Boolean);
  if (wanted.length === 0) return out;
  const rows = db
    .select({
      symbol: priceHistory.symbol,
      date: priceHistory.date,
      open: priceHistory.open,
      high: priceHistory.high,
      low: priceHistory.low,
      close: priceHistory.close,
      volume: priceHistory.volume,
    })
    .from(priceHistory)
    .where(inArray(priceHistory.symbol, wanted))
    .orderBy(asc(priceHistory.symbol), asc(priceHistory.date))
    .all();
  for (const r of rows) {
    const key = r.symbol.toUpperCase();
    const arr = out.get(key) ?? [];
    arr.push({
      date: r.date,
      openP: toPaiseOrNull(r.open),
      highP: toPaiseOrNull(r.high),
      lowP: toPaiseOrNull(r.low),
      closeP: toPaise(r.close),
      volume: r.volume ?? null,
    });
    out.set(key, arr);
  }
  // Trim from the FRONT: the desk's windows (ATR, RVOL, 52w) all look back
  // from today, so the oldest bars are the ones nothing reads.
  for (const [k, arr] of out) if (arr.length > DESK_HISTORY_SESSIONS) out.set(k, arr.slice(-DESK_HISTORY_SESSIONS));
  return out;
}

/**
 * The bars the chart panel is allowed to draw.
 *
 * No shape change — `DeskBar` IS `lib/live/types.ts` `Bar` — only a filter: a
 * bar with no open/high/low cannot be drawn as a candle, and squaring it off
 * into a doji that never traded would invent a session (invariant 6).
 */
function toDeskBars(bars: readonly Bar[]): DeskBar[] {
  const out: DeskBar[] = [];
  for (const b of bars) {
    if (b.openP === null || b.highP === null || b.lowP === null) continue;
    out.push(b);
  }
  return out;
}

/**
 * Load the desk.
 *
 * Async because the quote provider's `snapshot()` is — the EOD provider that
 * ships in v4.0 does no network I/O at all, and the same call site serves a
 * streaming provider in v4.1 without changing shape.
 */
export async function loadLiveDesk(entitlement: { pro: boolean }): Promise<LiveDeskData> {
  const today = todayIstIso();
  const trades = getTrades();
  const mtm = getMtmMap();
  const positions = deriveOpenPositions(trades, mtm, today, getMtfMarginByBroker());

  const byId = new Map(trades.map((t) => [t.id, t]));
  const accountNames = new Map(getAccounts().map((a) => [a.id, a.name]));
  const sectors = getSectorResolution();
  const capital = getBucketCapital();
  const equityCapitalP = capital.equityCapital > 0 ? toPaise(capital.equityCapital) : null;
  const activeCapitalP = capital.activeCapital > 0 ? toPaise(capital.activeCapital) : null;
  const totalCapitalP = capital.totalCapital > 0 ? toPaise(capital.totalCapital) : null;

  // risk_config: the global row is the desk's setting. A missing row, or a null
  // risk_pct_ppm inside it, is the "risk not set" state — never a default 2%.
  const risk = db.select().from(riskConfig).all().find((r) => r.scope === "global") ?? null;
  const riskPpm = risk?.riskPctPpm ?? null;
  const atrLength = risk?.stopAtrLen ?? DEFAULT_ATR_LENGTH;

  const barsBySymbol = readBars(positions.map((p) => p.symbol));

  // ── Marks ────────────────────────────────────────────────────────────────
  // The provider is the seam W2 replaces; the desk asks it for a snapshot and
  // falls back to what is already stored, so the tracker still renders with the
  // provider layer absent.
  //
  // THE STORED SELECTION IS RESOLVED, exactly as `app/api/live/feed/route.ts`
  // resolves it. `getQuoteProvider()` with no argument ignores
  // `settings.live_feed_provider` and always built the end-of-day provider, so
  // a user who had chosen "My typed marks — Nothing is fetched, ever" still had
  // the desk read the bhavcopy behind their choice, while the Settings card
  // showed the choice as saved.
  const provider = await getLiveFeedProvider();
  const keys: QuoteKey[] = positions.map((p) => ({
    symbol: p.symbol,
    exchange: asExchange(p.exchange),
    tradingsymbol: p.tradingsymbol,
  }));
  let quotes = new Map<string, { ltp: number; staleness: Mark["staleness"]; asOf: string }>();
  let health: { ok: boolean; reason?: string } = { ok: true };
  try {
    const snap = await provider.snapshot(keys);
    quotes = new Map([...snap].map(([k, q]) => [k, { ltp: q.ltp, staleness: q.staleness, asOf: q.asOf }]));
    health = await provider.health();
  } catch (e) {
    // A provider that throws must not take the journal's own record with it.
    health = { ok: false, reason: e instanceof Error ? e.message : "The quote provider could not be read." };
  }

  const rows: DeskRow[] = [];
  let newestAsOf: string | null = null;

  for (const [i, p] of positions.entries()) {
    const t = byId.get(p.id);
    const isShort = t ? t.sellQty > t.buyQty : false;
    const sector = sectors.get(p.symbol.toUpperCase()) ?? null;
    const bars = barsBySymbol.get(p.symbol.toUpperCase()) ?? [];

    const position: LivePosition = {
      id: p.id,
      accountId: t?.accountId ?? 0,
      symbol: p.symbol,
      tradingsymbol: p.tradingsymbol,
      segment: p.segment,
      instrumentType: t?.instrumentType ?? null,
      side: isShort ? "short" : "long",
      qty: p.qty,
      // A LEVEL, for display only. Every money figure is built from
      // `investedP` below, which multiplies the REAL average.
      avgEntryP: toPaise(p.avgPrice),
      investedP: investedPaise(p.qty, p.avgPrice),
      entryDate: (isShort ? t?.sellDate : t?.buyDate) ?? null,
      slPlannedP: toPaiseOrNull(t?.slPlanned),
      trailingSlP: toPaiseOrNull(t?.trailingSl),
      targetPlannedP: toPaiseOrNull(t?.targetPlanned),
      // riskAmount is a ₹ AMOUNT column (paise at rest, rupees at runtime) and
      // is R FROZEN AT FIRST ENTRY (invariant 4). Null stays null: open-R is
      // then null too, never re-derived from today's stop.
      riskAmountP: toPaiseOrNull(t?.riskAmount ?? null),
      lotSize: t?.lotSize ?? null,
      sector: sector?.sector ?? null,
      sectorTier: sector?.tier ?? null,
    };

    // `keys[i]` is this position's own quote key — the two arrays are built
    // from `positions` in one order and are never filtered apart.
    const quoted = quotes.get(quoteKeyId(keys[i]));
    const storedMark = mtm.get(p.symbol.toUpperCase()) ?? mtm.get(p.tradingsymbol.toUpperCase()) ?? null;
    const mark: Mark = quoted
      ? { markP: quoted.ltp, staleness: quoted.staleness, asOf: quoted.asOf }
      : storedMark !== null
        ? // `mtm_prices` has NO source column, and `persist-mark.ts` writes feed
          // marks into the same table the manual MTM editor writes to. The
          // provenance of this row is therefore UNKNOWN, so the badge says
          // "Stored mark" (`desk-copy.ts` `stalenessLabel`) and not "Manual
          // mark" — the staleness key stays "manual" because that is the
          // `Staleness` union's name for it in `lib/quotes/types.ts`.
          { markP: toPaise(storedMark), staleness: "manual", asOf: null }
        : t?.closingPrice != null
          ? { markP: toPaise(t.closingPrice), staleness: "eod", asOf: null }
          : { markP: null, staleness: null, asOf: null };
    if (mark.asOf && (newestAsOf === null || mark.asOf > newestAsOf)) newestAsOf = mark.asOf;

    const capitalP = p.bucket === "active" ? activeCapitalP : equityCapitalP;
    const row = computeTrackerRow(position, mark, { today, capitalP, bars, atrLength });

    // The stop TREE (owner ruling Q33: manual → structure → ATR → percent). The
    // recorded level is the manual branch; with no risk percentage the result is
    // `{kind:"risk-not-set"}` and the row routes to the Sizing Lab rather than
    // printing a level the user never chose.
    const stop = computeStop(
      {
        side: position.side,
        entryP: position.avgEntryP,
        tickP: p.segment.startsWith("eq_") ? CASH_TICK_PAISE : 0,
        lotSize: position.lotSize ?? 1,
        manualStopP: row.effectiveStopP,
        atrP3: row.atrP3,
      },
      {
        riskPpm,
        capitalP,
        stopMethod: (risk?.stopMethod as "manual" | "structure" | "atr" | "percent" | null) ?? null,
        atrMultPermille: risk?.stopAtrMultPermille ?? null,
        defaultPctPpm: risk?.stopDefaultPctPpm ?? null,
        deployCapPpm: risk?.deployCapPpm ?? null,
      },
    );

    // The paywall boundary is HERE, on the way onto the wire, and it is a
    // whole-field null rather than a 0 or an omitted key: `desk-format.ts`
    // renders null as the em dash and the client renders <ProLock> instead,
    // so the two states stay distinguishable in the type as well as on screen.
    const gated = entitlement.pro
      ? row
      : {
          ...row,
          riskAtStopP: null,
          riskAmountP: null,
          openRPpm: null,
          pctOfCapital: { ppm: null, denominator: null },
        };

    rows.push({
      ...gated,
      accountName: accountNames.get(position.accountId) ?? null,
      bucket: p.bucket,
      broker: p.broker,
      isin: t?.isin ?? null,
      entryDate: position.entryDate,
      lotSize: position.lotSize,
      mtf: p.isMtf
        ? {
            fundedP: toPaise(p.fundedAmount),
            ownCapitalP: toPaise(p.ownCapital),
            accruedInterestP: toPaise(p.accruedInterest),
          }
        : null,
      // The SAME boundary as the four scalars above, and for the same reason:
      // `stop` is an OBJECT carrying `qty`, `riskBudgetP`, `deployedP` and
      // `riskAtStopP`, so shipping it verbatim handed a free reader the very
      // risk-at-stop figure the row two lines up had just nulled.
      stop: entitlement.pro ? stop : gateStop(stop),
      spark: bars.slice(-SPARK_SESSIONS).map((b) => b.closeP),
    });
  }

  // ── Heat and concentration ───────────────────────────────────────────────
  // Both take the SAME reduced rows, so the strip and the sector table can
  // never disagree about which positions were counted.
  const heatRows: HeatRow[] = rows.map((r) => ({
    id: r.id,
    riskAtStopP: r.riskAtStopP,
    investedP: r.investedP,
    sector: r.sector,
    sectorTier: r.sectorTier,
  }));
  // Both are Pro (Q55), so an unlicensed payload carries neither — not an
  // empty decoy, which would read as "your book has no exposure".
  const heat = entitlement.pro ? portfolioHeat(heatRows, totalCapitalP, risk?.heatCeilingPpm ?? null) : null;
  const concentration = entitlement.pro ? sectorConcentration(heatRows) : null;

  // ── Chart payload, capped and stated ─────────────────────────────────────
  const chartSymbols = [...new Set(rows.map((r) => r.symbol.toUpperCase()))];
  const shipped = chartSymbols.slice(0, DESK_CHART_SYMBOLS);
  const barsOut: Record<string, DeskBar[]> = {};
  let trimmed = chartSymbols.length > shipped.length;
  for (const s of shipped) {
    const all = toDeskBars(barsBySymbol.get(s) ?? []);
    if (all.length > DESK_CHART_BARS) trimmed = true;
    barsOut[s] = all.slice(-DESK_CHART_BARS);
  }
  const barsCap: BarsCap = { sessions: DESK_CHART_BARS, symbols: DESK_CHART_SYMBOLS, trimmed };

  const feed: FeedInfo = {
    providerId: provider.capabilities.id,
    label: provider.capabilities.label,
    streaming: provider.capabilities.streaming,
    staleness: provider.capabilities.staleness,
    ok: health.ok,
    reason: health.reason ?? null,
    asOf: newestAsOf,
  };

  return {
    rows,
    heat,
    concentration,
    accounts: getAccounts().map((a) => ({ id: a.id, name: a.name })),
    selectedAccountId: getSelectedAccountId(),
    feed,
    riskNotSet: riskPpm === null || riskPpm <= 0,
    atrLength,
    barsBySymbol: barsOut,
    barsCap,
    today,
  };
}
