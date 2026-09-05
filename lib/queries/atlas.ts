import "server-only";
import { createHash } from "node:crypto";
import { asc, desc, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db";
import { atlasDaily, atlasMetric, atlasStaleness, priceHistory } from "@/lib/db/schema";
import {
  checksumInput,
  computeAtlasDaily,
  computeGroupReturns,
  groupBySector,
  symbolReturnPpm,
  toSeries,
  volumeExpansionPpm,
  HIGH_LOW_LOOKBACK,
  ROTATION_CAVEAT,
  SPEC_VERSION,
  type AtlasPayload,
  type Bar,
  type GroupingResult,
  type IsoDate,
  type SectorRef,
  type Series,
} from "@/lib/atlas";
import { getCapBandMap, getSectorResolution, getSymbolsByIsin, type CapBand } from "@/lib/queries/instruments";
import { getEntitlement } from "@/lib/queries/license";
import { getTrackerTrades } from "@/lib/queries/trades";
import {
  hasBackfillConsent,
  readBackfillProgress,
  BACKFILL_DEFAULT_DAYS,
  BACKFILL_RATE_LIMIT_MS,
  type BackfillProgress,
} from "@/lib/jobs/bhavcopy-backfill";

/**
 * lib/queries/atlas — the server wrapper around the PURE `lib/atlas` library.
 *
 * The split is invariant 2: every formula lives in `lib/atlas` with no DB and
 * no clock, and this file is the only place that reads `price_history`,
 * resolves sectors, hashes, stamps the time and writes the cache tables.
 *
 * WHAT IS AND IS NOT COMPUTED HERE (research answers Q42/Q42b): only the
 * TRANSPARENT daily core. No proprietary widget is computed on this machine —
 * the owner's formulas would be readable in the bundle the moment they were —
 * so nothing in this file scores, ranks by a hidden rule, or claims parity
 * with anything. Every number it publishes carries its own denominator.
 *
 * CACHING RULE: `atlas_daily.input_checksum` is sha256 over the exact bars fed
 * to the library. Same bars ⇒ same checksum ⇒ the stored snapshot IS the
 * answer and nothing recomputes. A new bhavcopy (or a backfill) changes the
 * bars, changes the checksum, and the next read recomputes once. That is the
 * whole invalidation policy; there is no timer.
 *
 * ACCOUNT SCOPE: market breadth is a property of the MARKET, so the snapshot
 * carries no `account_id` (see the 0065 schema header). The one account-scoped
 * read is "My names", which goes through `getTrackerTrades()` and therefore
 * through `getSelectedAccountId()` (invariant 8). Nothing here writes to a
 * book, so invariant 9 has no surface.
 */

/**
 * How many sessions of bars to read. 252 (the 52-week window) plus a 200-day
 * SMA needs 252; the extra 148 is head-room so the deepest metric is never
 * short because the window clipped it, and it bounds a full-market read at
 * roughly 400 × ~2,000 rows rather than "everything ever imported".
 */
export const ATLAS_LOOKBACK_SESSIONS = HIGH_LOW_LOOKBACK + 148;

/** Below this many sessions the cohort tab stays dark (Q51/Q53). */
export const COHORT_MIN_SESSIONS = 21;

export const NO_CHARTINK_LINE =
  "Computed from your stored end-of-day bhavcopy. No Chartink data is used.";

/**
 * The second footer line, and the one that decides what this screen IS. Breadth
 * and rotation are the numbers a recommendation would be built on, so the
 * screen that prints them has to say, on the screen, that it is not making one.
 */
export const NOT_ADVICE_LINE = "Vyuha computes; it does not advise.";

const sha256 = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex");

/**
 * Index and index-like rows are not equities and must not sit in a breadth
 * denominator. NSE's cash file publishes index rows with spaces in the ticker
 * ("NIFTY 50", "INDIA VIX"); a real equity ticker has none. ETFs are left IN
 * deliberately: they are traded equities on the cash book, they advance and
 * decline like one, and inventing a name-pattern for them would exclude real
 * companies whose ticker happens to end in the same letters.
 */
export function isEquitySymbol(symbol: string): boolean {
  return !/\s/.test(symbol);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The newest `ATLAS_LOOKBACK_SESSIONS` sessions of bars, ascending. */
export function readUniverseBars(lookback = ATLAS_LOOKBACK_SESSIONS): Bar[] {
  const dates = db
    .selectDistinct({ date: priceHistory.date })
    .from(priceHistory)
    .orderBy(desc(priceHistory.date))
    .limit(lookback)
    .all();
  if (dates.length === 0) return [];
  const cutoff = dates[dates.length - 1].date;
  return db
    .select({
      symbol: priceHistory.symbol,
      date: priceHistory.date,
      high: priceHistory.high,
      low: priceHistory.low,
      close: priceHistory.close,
      volume: priceHistory.volume,
    })
    .from(priceHistory)
    .where(gte(priceHistory.date, cutoff))
    .orderBy(asc(priceHistory.symbol), asc(priceHistory.date))
    .all();
}

/** How many distinct sessions `price_history` holds at all. */
export function storedSessionCount(): number {
  return db.selectDistinct({ date: priceHistory.date }).from(priceHistory).all().length;
}

export interface StoredSnapshot {
  asOf: IsoDate;
  generatedAt: string;
  specVersion: string;
  sourceMode: string;
  inputChecksum: string;
  universeIncluded: number;
  universeExcluded: number;
  anchorCoverage: number;
  anchorCoveragePpm: number | null;
  payload: AtlasPayload | null;
}

/** The latest cached snapshot, or `null` when Atlas has never been computed. */
export function getStoredSnapshot(): StoredSnapshot | null {
  const row = db.select().from(atlasDaily).orderBy(desc(atlasDaily.asOf)).limit(1).all()[0];
  if (!row) return null;
  let payload: AtlasPayload | null = null;
  try {
    payload = row.payloadJson ? (JSON.parse(row.payloadJson) as AtlasPayload) : null;
  } catch {
    payload = null; // a corrupt blob is a missing snapshot, never a half-read one
  }
  return {
    asOf: row.asOf,
    generatedAt: row.generatedAt,
    specVersion: row.specVersion,
    sourceMode: row.sourceMode,
    inputChecksum: row.inputChecksum,
    universeIncluded: row.universeIncluded,
    universeExcluded: row.universeExcluded,
    anchorCoverage: row.anchorCoverage,
    anchorCoveragePpm: row.anchorCoveragePpm,
    payload,
  };
}

// ---------------------------------------------------------------------------
// Compute + persist
// ---------------------------------------------------------------------------

export interface RefreshResult {
  recomputed: boolean;
  reason: "checksum_unchanged" | "no_bars" | "computed" | "forced";
  snapshot: StoredSnapshot | null;
}

/**
 * Recompute the snapshot IF the bars changed, then persist it.
 *
 * `force` re-runs the maths even when the checksum matches — the only use is a
 * spec-version change, where the formula set moved under an unchanged input.
 */
export function refreshAtlasSnapshot(opts: { force?: boolean; now?: Date } = {}): RefreshResult {
  const bars = readUniverseBars();
  if (bars.length === 0) {
    return { recomputed: false, reason: "no_bars", snapshot: getStoredSnapshot() };
  }

  const checksum = sha256(checksumInput(bars));
  const stored = getStoredSnapshot();
  if (!opts.force && stored && stored.inputChecksum === checksum && stored.specVersion === SPEC_VERSION) {
    return { recomputed: false, reason: "checksum_unchanged", snapshot: stored };
  }

  const sectors = getSectorResolution();
  const sectorOf = (symbol: string): SectorRef | null => {
    const hit = sectors.get(symbol.toUpperCase());
    return hit ? { sector: hit.sector, tier: hit.tier, source: hit.source } : null;
  };

  const result = computeAtlasDaily(bars, sectorOf, {
    generatedAt: (opts.now ?? new Date()).toISOString(),
    sha256,
    sourceMode: "bhavcopy_local",
    isEligible: isEquitySymbol,
  });

  if (!result.daily) {
    // Not one usable bar on any anchor — an empty screen, not a zeroed one.
    return { recomputed: false, reason: "no_bars", snapshot: stored };
  }
  const daily = result.daily;

  db.transaction((tx) => {
    tx.insert(atlasDaily)
      .values({
        asOf: daily.as_of,
        generatedAt: daily.generated_at,
        specVersion: daily.spec_version,
        sourceMode: daily.source_mode,
        inputChecksum: daily.input_checksum,
        universeIncluded: daily.universe_included,
        universeExcluded: daily.universe_excluded,
        anchorCoverage: daily.anchor_coverage,
        anchorCoveragePpm: daily.anchor_coverage_ppm,
        payloadJson: daily.payload_json,
      })
      .onConflictDoUpdate({
        target: atlasDaily.asOf,
        set: {
          generatedAt: daily.generated_at,
          specVersion: daily.spec_version,
          sourceMode: daily.source_mode,
          inputChecksum: daily.input_checksum,
          universeIncluded: daily.universe_included,
          universeExcluded: daily.universe_excluded,
          anchorCoverage: daily.anchor_coverage,
          anchorCoveragePpm: daily.anchor_coverage_ppm,
          payloadJson: daily.payload_json,
        },
      })
      .run();

    // Long-form rows are REPLACED wholesale for the session: a metric that
    // stopped being computable must disappear, not linger at its old value.
    tx.delete(atlasMetric).where(eq(atlasMetric.asOf, daily.as_of)).run();
    for (const m of result.metrics) {
      tx.insert(atlasMetric)
        .values({
          asOf: m.as_of,
          metric: m.metric,
          groupKind: m.group_kind,
          groupName: m.group_name,
          valuePpm: m.value_ppm,
          numerator: m.numerator,
          denominator: m.denominator,
          coveragePpm: m.coverage_ppm,
          insufficientHistory: m.insufficient_history,
        })
        .run();
    }

    tx.delete(atlasStaleness).where(eq(atlasStaleness.asOf, daily.as_of)).run();
    for (const s of result.staleness) {
      tx.insert(atlasStaleness)
        .values({
          asOf: s.as_of,
          symbol: s.symbol,
          reason: s.reason,
          lastSeenDate: s.last_seen_date,
          sessionsBehind: s.sessions_behind,
        })
        .run();
    }
  });

  return { recomputed: true, reason: opts.force ? "forced" : "computed", snapshot: getStoredSnapshot() };
}

// ---------------------------------------------------------------------------
// Cap bands (Q47) — SEBI-style buckets from INDEX MEMBERSHIP, or nothing.
// ---------------------------------------------------------------------------

/**
 * The four SEBI-style buckets, in size order, with the label the UI prints.
 *
 * The band itself is NOT decided here. `getCapBandMap()` reads it off the
 * bundled NSE index map, where it was written by the build-time script from
 * NSE's own Nifty 100 / Midcap 150 / Smallcap 250 / Microcap 250 constituent
 * lists (research answers Q46/Q47). Vyuha does not derive a band from a market
 * cap it computed itself: it has no share-count source, and a bucket built on
 * a guessed denominator is exactly what invariant 6 forbids.
 */
export const CAP_BAND_LABELS: { band: CapBand; label: string }[] = [
  { band: "large", label: "Large cap" },
  { band: "mid", label: "Mid cap" },
  { band: "small", label: "Small cap" },
  { band: "micro", label: "Micro cap" },
];

/**
 * Q49, and the standing rule from Q50. The bundled map carries ONE pair of
 * dates for the whole file, so a band is today's membership applied to today's
 * move. It is never backdated, and the screen has to say so — a bucket that
 * looks point-in-time and is not would quietly rewrite history every time NSE
 * rebalances.
 */
export const CAP_BAND_CLASSIFICATION_NOTE =
  "Current classification, not point-in-time: each name sits in the band its index membership puts it in today, " +
  "and the band is not backdated to the session being measured.";

export interface CapBandRow {
  band: CapBand;
  label: string;
  members: number;
  advancing: number | null;
  declining: number | null;
  advancePpm: number | null;
  denominator: number;
}

export interface CapBandView {
  available: boolean;
  /** Why the tab is empty, in the user's words. Never a bare zero. */
  reason: string;
  rows: CapBandRow[];
  asOf: IsoDate | null;
  /** Printed above the table whenever there IS a table (Q49). */
  classificationNote: string;
  /** Symbols in the universe that no band claims — stated, never bucketed. */
  unclassified: number;
}

/**
 * Cap bands for the stored universe, from the bundled size-index membership.
 *
 * TWO DIFFERENT EMPTIES, SAID DIFFERENTLY. "No rows" is a fact about a table
 * and it has two causes here, which are not the same problem for the user:
 * the bundled map may carry no `capBand` at all (it did until the map rebuild
 * of Q46 landed), or the map may classify companies this database cannot name
 * because no instrument dump has been imported yet. Collapsing both into one
 * "no data" line would send the user to fix the wrong thing.
 *
 * The join is by ISIN because `getCapBandMap()` is keyed by ISIN — a ticker is
 * not an identity, NSE reuses one across a rename — and `instruments` is what
 * turns an ISIN back into the symbol `price_history` stores.
 */
export function getCapBands(series: Series[], asOf: IsoDate | null): CapBandView {
  const bandByIsin = getCapBandMap();
  const symbolByIsin = getSymbolsByIsin([...bandByIsin.keys()]);
  const bandOf = new Map<string, CapBand>();
  for (const [isin, band] of bandByIsin) {
    const symbol = symbolByIsin.get(isin);
    if (symbol) bandOf.set(symbol.toUpperCase(), band);
  }

  const empty = (reason: string): CapBandView => ({
    available: false,
    reason,
    rows: [],
    asOf,
    classificationNote: CAP_BAND_CLASSIFICATION_NOTE,
    unclassified: series.length,
  });

  if (bandByIsin.size === 0) {
    return empty(
      "No size-index data yet. The bundled NSE index map carries the sectoral and thematic indices but no " +
        "size index (Nifty 100 / Midcap 150 / Smallcap 250 / Microcap 250), so there is nothing to bucket by. " +
        "Size-index data arrives with the map rebuild; Vyuha will not guess a cap band from a market cap it " +
        "cannot compute.",
    );
  }
  if (bandOf.size === 0) {
    return empty(
      `The bundled map classifies ${bandByIsin.size.toLocaleString("en-IN")} companies by size, but this ` +
        "database holds no instrument list to match those ISINs to ticker symbols — import an instrument file " +
        "and the bands appear.",
    );
  }

  const rows = new Map<CapBand, { members: number; adv: number; dec: number; unch: number }>();
  let unclassified = 0;
  for (const s of series) {
    const band = bandOf.get(s.symbol);
    if (!band) {
      unclassified++;
      continue;
    }
    const cur = rows.get(band) ?? { members: 0, adv: 0, dec: 0, unch: 0 };
    cur.members++;
    const n = s.bars.length;
    if (n >= 2) {
      const move = s.bars[n - 1].close - s.bars[n - 2].close;
      if (move > 0) cur.adv++;
      else if (move < 0) cur.dec++;
      else cur.unch++;
    }
    rows.set(band, cur);
  }

  return {
    available: true,
    reason: "",
    asOf,
    classificationNote: CAP_BAND_CLASSIFICATION_NOTE,
    unclassified,
    rows: CAP_BAND_LABELS.map(({ band, label }) => {
      const r = rows.get(band) ?? { members: 0, adv: 0, dec: 0, unch: 0 };
      const denominator = r.adv + r.dec + r.unch;
      return {
        band,
        label,
        members: r.members,
        advancing: denominator > 0 ? r.adv : null,
        declining: denominator > 0 ? r.dec : null,
        advancePpm: denominator > 0 ? Math.round((r.adv * 1_000_000) / denominator) : null,
        denominator,
      };
    }).filter((r) => r.members > 0),
  };
}

// ---------------------------------------------------------------------------
// My names (Q53) — the first attribution: stock pick, or sector ride?
// ---------------------------------------------------------------------------

export interface MyNameRow {
  symbol: string;
  sector: string | null;
  tier: string | null;
  /** Integer ppm, and `null` when the window has no depth for this symbol. */
  stock1wPpm: number | null;
  cohort1wPpm: number | null;
  diff1wPpm: number | null;
  stock1mPpm: number | null;
  cohort1mPpm: number | null;
  diff1mPpm: number | null;
  cohortSize: number;
}

export interface MyNamesView {
  enabled: boolean;
  reason: string;
  rows: MyNameRow[];
  sessions: number;
}

const ATTRIBUTION_WINDOWS = [
  { key: "1w" as const, sessions: 5 },
  { key: "1m" as const, sessions: 21 },
];

/**
 * Per open position: its own return, its sector cohort's equal-weighted return,
 * and the DIFFERENCE — "did the pick work, or did the sector carry it?".
 *
 * Dark until `COHORT_MIN_SESSIONS` sessions exist, because a 1-month figure
 * computed over four sessions is not a 1-month figure. The cohort mean is the
 * library's own `computeGroupReturns`, so the row on this tab and the row on
 * the Sectors tab are the same arithmetic and cannot disagree.
 */
export function getMyNames(series: Series[], grouping: GroupingResult, sessions: number): MyNamesView {
  if (sessions < COHORT_MIN_SESSIONS) {
    return {
      enabled: false,
      sessions,
      rows: [],
      reason: `Needs ${COHORT_MIN_SESSIONS} sessions of stored bars to compare a name against its sector; you have ${sessions}. Run the backfill to enable it.`,
    };
  }

  const held = new Set(
    getTrackerTrades()
      .filter((t) => t.isOpen && t.instrumentType === "equity")
      .map((t) => t.symbol.toUpperCase()),
  );
  if (held.size === 0) {
    return { enabled: true, sessions, rows: [], reason: "No open equity positions to attribute." };
  }

  const bySymbol = new Map(series.map((s) => [s.symbol, s]));
  const sectorOfSymbol = new Map<string, { sector: string; tier?: string }>();
  const cohortSize = new Map<string, number>();
  for (const g of grouping.groups) {
    cohortSize.set(g.group, g.members.length);
    for (const m of g.members) sectorOfSymbol.set(m.symbol, { sector: g.group });
  }

  const cohortPpm = new Map<string, Map<string, number | null>>();
  for (const w of ATTRIBUTION_WINDOWS) {
    const perGroup = new Map<string, number | null>();
    for (const row of computeGroupReturns(grouping, w)) perGroup.set(row.group, row.metric.value_ppm);
    cohortPpm.set(w.key, perGroup);
  }

  const rows: MyNameRow[] = [];
  for (const symbol of [...held].sort()) {
    const s = bySymbol.get(symbol);
    const sector = sectorOfSymbol.get(symbol)?.sector ?? null;
    const stock1w = s ? symbolReturnPpm(s, 5) : null;
    const stock1m = s ? symbolReturnPpm(s, 21) : null;
    const cohort1w = sector ? (cohortPpm.get("1w")?.get(sector) ?? null) : null;
    const cohort1m = sector ? (cohortPpm.get("1m")?.get(sector) ?? null) : null;
    rows.push({
      symbol,
      sector,
      tier: null,
      stock1wPpm: stock1w,
      cohort1wPpm: cohort1w,
      diff1wPpm: stock1w !== null && cohort1w !== null ? stock1w - cohort1w : null,
      stock1mPpm: stock1m,
      cohort1mPpm: cohort1m,
      diff1mPpm: stock1m !== null && cohort1m !== null ? stock1m - cohort1m : null,
      cohortSize: sector ? (cohortSize.get(sector) ?? 0) : 0,
    });
  }
  return { enabled: true, sessions, rows, reason: "" };
}

// ---------------------------------------------------------------------------
// Volume-expansion leaders (A7, the list beside the median).
// ---------------------------------------------------------------------------

export interface VolumeLeader {
  symbol: string;
  /** Latest volume over the mean of the PRIOR 20 sessions, integer ppm. */
  expansionPpm: number;
}

/**
 * The n symbols whose latest volume is furthest above their own 20-session
 * baseline. Uses the library's own `volumeExpansionPpm`, so the leader list
 * and the median tile beside it cannot be computed two different ways.
 *
 * A leader board is a RANKING, not a denominator: it says nothing about how
 * many symbols were eligible, which is why the tile next to it still carries
 * the count that was ranked.
 */
export function getVolumeLeaders(series: Series[], n = 5): VolumeLeader[] {
  const rows: VolumeLeader[] = [];
  for (const s of series) {
    const ppm = volumeExpansionPpm(s);
    if (ppm !== null) rows.push({ symbol: s.symbol, expansionPpm: ppm });
  }
  rows.sort((a, b) => b.expansionPpm - a.expansionPpm || (a.symbol < b.symbol ? -1 : 1));
  return rows.slice(0, n);
}

// ---------------------------------------------------------------------------
// The one read the page makes.
// ---------------------------------------------------------------------------

export interface AtlasView {
  snapshot: StoredSnapshot | null;
  payload: AtlasPayload | null;
  sessions: number;
  capBands: CapBandView;
  myNames: MyNamesView;
  volumeLeaders: VolumeLeader[];
  backfill: BackfillProgress;
  backfillConsented: boolean;
  backfillDefaultDays: number;
  backfillRateLimitMs: number;
  rotationCaveat: string;
  provenanceLine: string;
  notAdviceLine: string;
  specVersion: string;
}

/** Everything `/atlas` renders, computed on demand and cached by checksum. */
export function getAtlasView(): AtlasView {
  const refreshed = refreshAtlasSnapshot();
  const snapshot = refreshed.snapshot;
  const bars = readUniverseBars();
  const series = toSeries(bars).filter((s) => isEquitySymbol(s.symbol));

  const sectors = getSectorResolution();
  const grouping = groupBySector(series, (symbol) => {
    const hit = sectors.get(symbol.toUpperCase());
    return hit ? { sector: hit.sector, tier: hit.tier, source: hit.source } : null;
  });

  const sessions = storedSessionCount();
  return {
    snapshot,
    payload: snapshot?.payload ?? null,
    sessions,
    capBands: getCapBands(series, snapshot?.asOf ?? null),
    myNames: getMyNames(series, grouping, sessions),
    volumeLeaders: getVolumeLeaders(series),
    backfill: readBackfillProgress(),
    backfillConsented: hasBackfillConsent(),
    backfillDefaultDays: BACKFILL_DEFAULT_DAYS,
    backfillRateLimitMs: BACKFILL_RATE_LIMIT_MS,
    rotationCaveat: ROTATION_CAVEAT,
    provenanceLine: NO_CHARTINK_LINE,
    notAdviceLine: NOT_ADVICE_LINE,
    specVersion: SPEC_VERSION,
  };
}

// ---------------------------------------------------------------------------
// The page loader (Q55/Q57).
// ---------------------------------------------------------------------------

export interface AtlasPageData {
  /** True when the visitor gets the STATIC preview instead of the real panel. */
  preview: boolean;
  /** The entitlement that decided it — surfaced so the page never re-reads it. */
  entitlementState: string;
  /** `null` in preview mode: nothing is computed for a screen nobody can read. */
  view: AtlasView | null;
}

/**
 * What `/atlas` loads. ONE read, and it decides the Pro question FIRST.
 *
 * Q55 puts Atlas in Pro and Q57 says the tab is locked with a static preview
 * and never hidden — so a free copy gets a screen that shows what Atlas is and
 * no market numbers. The order matters for more than copy: computing breadth
 * across ~2,000 symbols for a visitor who cannot see the result would be a
 * full-market recompute spent on a locked door.
 *
 * The lock is `pro` (licensed OR in trial), not `state === "licensed"`: a trial
 * is Pro while it lasts, and `<ProGate>` in the page draws the banner, the
 * countdown or the upsell panel around whichever body this returns.
 */
export function getAtlasPageData(): AtlasPageData {
  const ent = getEntitlement();
  if (!ent.pro) return { preview: true, entitlementState: ent.state, view: null };
  return { preview: false, entitlementState: ent.state, view: getAtlasView() };
}
