import "server-only";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { atlasDaily, atlasMetric, atlasStaleness, instruments, priceHistory, settings } from "@/lib/db/schema";
import { bundledIsinBySymbol } from "@/lib/import/isin-symbol";
import {
  alignToAnchor,
  buildGapMap,
  checksumInput,
  classifyRegime,
  computeAtlasDaily,
  computeCohorts,
  isDefaultRegimeThresholds,
  modalAnchor,
  parseRegimeThresholds,
  rankByValue,
  rankDelta,
  rankDeltaShortfallLine,
  sessionCalendar,
  sessionSpan,
  toSeries,
  volumeExpansionPpm,
  windowGapLine,
  COHORT_WINDOWS,
  COVERAGE_FLOOR_PPM,
  DEFAULT_REGIME_THRESHOLDS,
  DEFAULT_STATISTIC,
  GROUP_MIN_RANK,
  HIGH_LOW_LOOKBACK,
  NOT_COMPUTED,
  RETURN_WINDOWS,
  ROTATION_CAVEAT,
  SPEC_VERSION,
  type AtlasPayload,
  type Bar,
  type CaGap,
  type ClassificationRef,
  type CohortRow,
  type CohortWindowKey,
  type IsoDate,
  type NotComputedFamily,
  type RegimeThresholds,
  type ReturnWindowKey,
  type SectorRef,
  type Series,
  type SessionSpan,
  type Statistic,
} from "@/lib/atlas";
import {
  getCapBandMap,
  getClassificationResolution,
  getIndexBandMap,
  getIndexMembershipMap,
  getSectorResolution,
  getSymbolsByIsin,
  type CapBand,
  type IndexBand,
} from "@/lib/queries/instruments";
import nseIndexMapJson from "@/lib/data/nse-index-map.json";
import sectorMapJson from "@/lib/data/sector-map.json";
import stockUniverseJson from "@/lib/data/stock-universe.json";
import { dayOf } from "@/lib/domain/trading-day";
import { getEntitlement } from "@/lib/queries/license";
import { getTrackerTrades } from "@/lib/queries/trades";
import {
  hasBackfillConsent,
  readBackfillProgress,
  BACKFILL_DEFAULT_DAYS,
  BACKFILL_RATE_LIMIT_MS,
  type BackfillProgress,
} from "@/lib/jobs/bhavcopy-backfill";
import { catchupStatus, type CatchupStatus } from "@/lib/jobs/bhavcopy-catchup";
import { entryDateOf, exitDateOf } from "@/lib/domain/side";

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

// ---------------------------------------------------------------------------
// The bundled classification maps, digested (Q52)
// ---------------------------------------------------------------------------

/**
 * Q52: the sector/index maps are refreshed manually, once per minor release,
 * so the screen has to say WHICH copy it grouped by — `asOf` alone cannot
 * distinguish two builds of the same dated snapshot, and a hand-edited map
 * carries the same date as the one it was edited from.
 *
 * The digest is taken here, SERVER-SIDE, because `node:crypto` may not reach a
 * client component; `AtlasPanel` receives finished strings as props. It is
 * taken over the CANONICAL JSON BYTES of the object the runtime actually
 * loaded (`JSON.stringify` of the imported module), not over a re-read of the
 * file from disk — a packaged build may not have the source tree beside it,
 * and the bytes the code grouped by are the only ones worth pinning.
 */
export interface MapDigest {
  /** The bundled file the digest covers, repo-relative. */
  file: string;
  label: string;
  /** Full sha256, 64 hex, over the file's canonical JSON bytes. */
  sha256: string;
  /** The map's own single clock, or null when the file carries none. */
  asOf: string | null;
}

/**
 * EVERY bundled file the Sectors and Cap bands tabs read: the sector chain in
 * `getSectorResolution()` reads the stock universe first (v4.6.0 W2), the ISIN
 * taxonomy for what the universe leaves blank and NSE's index map for the rest;
 * the universe also carries AMFI's cap band and the index map the size-index
 * membership lens. A digest of one of them would pin part of what those tabs print.
 */
const MAP_SOURCES: readonly { file: string; label: string; json: unknown }[] = [
  { file: "lib/data/stock-universe.json", label: "Stock universe", json: stockUniverseJson },
  { file: "lib/data/sector-map.json", label: "Sector map", json: sectorMapJson },
  { file: "lib/data/nse-index-map.json", label: "NSE index map", json: nseIndexMapJson },
];

/** sha256 over one map's canonical JSON bytes. Exported so a test can recompute it. */
export function digestMap(json: unknown): string {
  return sha256(JSON.stringify(json));
}

let mapDigestCache: MapDigest[] | null = null;

/**
 * Digested ONCE per process and memoised — the two files are ~470 KB of JSON
 * and neither can change without a new build, so hashing them on every request
 * would buy nothing.
 */
export function getMapDigests(): MapDigest[] {
  if (mapDigestCache === null) {
    mapDigestCache = MAP_SOURCES.map((m) => {
      const asOf = (m.json as { asOf?: unknown }).asOf;
      return {
        file: m.file,
        label: m.label,
        sha256: digestMap(m.json),
        asOf: typeof asOf === "string" && asOf.length > 0 ? asOf : null,
      };
    });
  }
  // A fresh array of fresh objects: a caller that mutates the result cannot
  // poison the memo for the rest of the process.
  return mapDigestCache.map((d) => ({ ...d }));
}

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

export interface VerifiedSnapshot {
  /** The stored snapshot ONLY when its checksum still matches the stored bars. */
  snapshot: StoredSnapshot | null;
  /** True when a snapshot exists but describes bars this database no longer has. */
  stale: boolean;
}

/**
 * The stored snapshot, CHECKED against the bars actually in the database.
 *
 * Migration 0065's header is the rule: "on a mismatch the snapshot is stale
 * EVIDENCE — something that was true of inputs we no longer have — and never
 * re-served as data". `getStoredSnapshot()` is the raw row and cannot know
 * that; every reader that PUBLISHES a figure goes through this instead.
 *
 * It hashes the bars and compares — it does not recompute. A read must never
 * be able to start a 2,000-symbol recompute (that is what POST /api/atlas is
 * for), so a mismatch reports itself as stale rather than quietly fixing it.
 */
export function getVerifiedSnapshot(): VerifiedSnapshot {
  const stored = getStoredSnapshot();
  if (!stored) return { snapshot: null, stale: false };
  const bars = readUniverseBars();
  if (bars.length === 0) return { snapshot: null, stale: true };
  const checksum = sha256(checksumInput(bars));
  if (stored.inputChecksum !== checksum || stored.specVersion !== SPEC_VERSION) {
    return { snapshot: null, stale: true };
  }
  return { snapshot: withCurrentRegime(stored), stale: false };
}

// ---------------------------------------------------------------------------
// Regime thresholds (v4.6.0 W5, AQ13) — a SETTING, read here; the label is
// re-derived at read time (design review A3).
// ---------------------------------------------------------------------------

export interface RegimeThresholdSetting {
  thresholds: RegimeThresholds;
  /** True when the column is NULL or equals the shipped defaults. */
  isDefault: boolean;
  coverageFloorPpm: number;
}

/** The stored thresholds, or the defaults for NULL / alien / corrupt. Defensive: a pre-0076 database reads as defaults. */
export function getRegimeThresholdSetting(): RegimeThresholdSetting {
  let stored: RegimeThresholds | null = null;
  try {
    const row = db.select({ json: settings.atlasRegimeThresholds }).from(settings).orderBy(asc(settings.id)).limit(1).all()[0];
    stored = parseRegimeThresholds(row?.json ?? null);
  } catch {
    stored = null;
  }
  const thresholds = stored ?? DEFAULT_REGIME_THRESHOLDS;
  return { thresholds, isDefault: isDefaultRegimeThresholds(thresholds), coverageFloorPpm: COVERAGE_FLOOR_PPM };
}

export function getRegimeThresholds(): RegimeThresholds {
  return getRegimeThresholdSetting().thresholds;
}

/**
 * A3: the stored payload's `regime` was computed with the thresholds of ITS
 * run; the screen must show the label under the CURRENT thresholds, and the
 * page and GET /api/atlas must agree. `classifyRegime` is pure and the payload
 * carries both inputs with their coverage, so the label is re-derived here —
 * never recomputed, never persisted. A payload with no pulse is returned as is.
 */
export function withCurrentRegime(s: StoredSnapshot): StoredSnapshot {
  const p = s.payload;
  if (!p?.market_pulse) return s;
  const sma50 = p.market_pulse.moving_average_breadth?.[50]?.metric ?? null;
  const net = p.market_pulse.new_high_low?.netHighLow ?? null;
  const regime = classifyRegime(
    { aboveSma50: sma50, netHighLow: net },
    getRegimeThresholds(),
    p.regime?.coverageFloorPpm ?? COVERAGE_FLOOR_PPM,
  );
  return { ...s, payload: { ...p, regime } };
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

  const result = computeAtlasDaily(bars, sectorOfFn(), {
    generatedAt: (opts.now ?? new Date()).toISOString(),
    sha256,
    sourceMode: "bhavcopy_local",
    isEligible: isEquitySymbol,
    // v4.6.0 W5: the levels-aware chain, AMFI's band, the stored thresholds.
    classificationOf: classificationOfFn(),
    capBandOf: capBandOfFn(),
    regimeThresholds: getRegimeThresholds(),
    statistic: DEFAULT_STATISTIC,
  });

  if (!result.daily) {
    // Not one usable bar on any anchor — an empty screen, not a zeroed one.
    return { recomputed: false, reason: "no_bars", snapshot: stored };
  }
  const daily = result.daily;

  db.transaction((tx) => {
    // ANYTHING NEWER THAN THIS ANCHOR IS GONE. The anchor can move BACKWARDS —
    // restoring an older backup replaces `price_history` wholesale — and
    // `getStoredSnapshot()` reads max(as_of), so a surviving later row would be
    // served forever in place of the one just computed, recomputing on every
    // render and never winning. A row for a session the current bars cannot
    // produce is stale evidence (0065's header), so it is deleted rather than
    // left to out-rank today's answer.
    tx.delete(atlasStaleness).where(gt(atlasStaleness.asOf, daily.as_of)).run();
    tx.delete(atlasMetric).where(gt(atlasMetric.asOf, daily.as_of)).run();
    tx.delete(atlasDaily).where(gt(atlasDaily.asOf, daily.as_of)).run();

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
// The three lookups the compute is handed (reference data, not account data).
// ---------------------------------------------------------------------------

/** The sector chain as a lookup — unchanged since v4.0. */
function sectorOfFn(): (symbol: string) => SectorRef | null {
  const sectors = getSectorResolution();
  return (symbol) => {
    const hit = sectors.get(symbol.toUpperCase());
    return hit ? { sector: hit.sector, tier: hit.tier, source: hit.source } : null;
  };
}

/** The levels-aware chain (W5, AQ21) as a lookup. */
export function classificationOfFn(): (symbol: string) => ClassificationRef | null {
  const res = getClassificationResolution();
  return (symbol) => {
    const hit = res.get(symbol.toUpperCase());
    return hit ? { macro: hit.macro, sector: hit.sector, industry: hit.industry, basic: hit.basic, tier: hit.tier, source: hit.source } : null;
  };
}

/**
 * AMFI's band per SYMBOL (ruling U2). A ticker is not an identity, so the
 * symbol is resolved to ONE ISIN first and the band is read off that ISIN:
 *
 *   1. the user's instruments row for the symbol, when it states an ISIN (the
 *      user wins — the sector chain's rule);
 *   2. else the bundled listing's owner of the ticker (`bundledIsinBySymbol`:
 *      NSE > Emerge > BSE, the ranking lib/analytics/instruments.ts uses).
 *
 * v4.6.0 fix wave (audit OBS, design review A8): this used to walk EVERY banded
 * ISIN back to a symbol through the instruments table alone, so a fresh install
 * (0 instrument rows) had sectors but no cap band at all. Resolving per symbol —
 * never ISIN → symbol over the whole band list — also keeps a BSE-only company
 * that shares a ticker (SEL, MAL…) from lending the NSE owner its band.
 * Null when the resolved ISIN is unbanded (Emerge, a post-period listing, an ETF).
 */
export function capBandOfFn(): (symbol: string) => string | null {
  const bands = getCapBandMap();
  const userIsin = new Map<string, string>();
  for (const r of db.select({ symbol: instruments.symbol, isin: instruments.isin }).from(instruments).all()) {
    const symbol = String(r.symbol ?? "").trim().toUpperCase();
    const isin = String(r.isin ?? "").trim().toUpperCase();
    if (symbol && isin && !userIsin.has(symbol)) userIsin.set(symbol, isin);
  }
  return (symbol) => {
    const key = String(symbol ?? "").trim().toUpperCase();
    if (!key) return null;
    const isin = userIsin.get(key) ?? bundledIsinBySymbol(key);
    return isin ? bands.get(isin)?.band ?? null : null;
  };
}

// ---------------------------------------------------------------------------
// Cap bands — AMFI's categorisation (ruling U2), and Nifty size-index
// membership as a SEPARATE lens (Q47). Never one presented as the other.
// ---------------------------------------------------------------------------

/**
 * THE cap band (owner ruling U2, v4.6.0 W2), with the label the UI prints.
 *
 * The band is NOT decided here. `getCapBandMap()` reads AMFI's half-yearly
 * categorisation (SEBI circular 6 Oct 2017: rank 1–100 large, 101–250 mid, the
 * rest small) off the bundled stock universe. Vyuha does not derive a band from
 * a market cap it computed itself: a bucket built on a guessed denominator is
 * exactly what invariant 6 forbids.
 */
export const CAP_BAND_LABELS: { band: CapBand; label: string }[] = [
  { band: "large", label: "Large cap" },
  { band: "mid", label: "Mid cap" },
  { band: "small", label: "Small cap" },
];

/**
 * The index-membership lens (Q47): which Nifty SIZE index a name sits in. It
 * disagreed with AMFI on 37 of 826 names when measured (research R3 §0.6) —
 * two different definitions — so it is labelled as membership, never as a cap
 * band, and "micro" lives only here.
 */
export const INDEX_BAND_LABELS: { band: IndexBand; label: string }[] = [
  { band: "large", label: "Nifty 100" },
  { band: "mid", label: "Nifty Midcap 150" },
  { band: "small", label: "Nifty Smallcap 250" },
  { band: "micro", label: "Nifty Microcap 250" },
];

/**
 * Q49, and the standing rule from Q50. The bundled list carries ONE period for
 * the whole file, so a band is today's classification applied to today's move.
 * It is never backdated, and the screen has to say so — a bucket that looks
 * point-in-time and is not would quietly rewrite history every time AMFI
 * re-ranks or NSE rebalances.
 */
export const CAP_BAND_CLASSIFICATION_NOTE =
  "Current classification, not point-in-time: each name sits in the band AMFI's latest half-yearly list puts it in " +
  "(SEBI's large / mid / small cap ranking), and the band is not backdated to the session being measured.";

export const INDEX_BAND_CLASSIFICATION_NOTE =
  "Index membership, not a cap band: each name sits in the Nifty size index that lists it today (a name in two " +
  "takes the larger), and the membership is not backdated to the session being measured.";

export interface CapBandRow {
  band: string;
  label: string;
  members: number;
  advancing: number | null;
  declining: number | null;
  advancePpm: number | null;
  denominator: number;
}

export interface CapBandView {
  available: boolean;
  /** Why the table is empty, in the user's words. Never a bare zero. */
  reason: string;
  rows: CapBandRow[];
  asOf: IsoDate | null;
  /** Printed above the table whenever there IS a table (Q49). */
  classificationNote: string;
  /** Symbols in the universe that no band claims — stated, never bucketed. */
  unclassified: number;
  /** The sentence under the table that says what `unclassified` counts. */
  unclassifiedNote: string;
}

/**
 * One band table over the stored universe.
 *
 * TWO DIFFERENT EMPTIES, SAID DIFFERENTLY. "No rows" is a fact about a table
 * and it has two causes here, which are not the same problem for the user:
 * the bundled source may carry no bands at all, or it may classify companies
 * this database cannot name because no instrument dump has been imported yet.
 * Collapsing both into one "no data" line would send the user to fix the wrong
 * thing.
 *
 * The join is by ISIN — a ticker is not an identity, NSE reuses one across a
 * rename — and `instruments` is what turns an ISIN back into the symbol
 * `price_history` stores.
 */
function bandView(
  series: Series[],
  asOf: IsoDate | null,
  bandByIsin: Map<string, string>,
  labels: { band: string; label: string }[],
  text: { note: string; noSource: string; noun: string; unclassified: (n: string) => string },
): CapBandView {
  const symbolByIsin = getSymbolsByIsin([...bandByIsin.keys()]);
  const bandOf = new Map<string, string>();
  for (const [isin, band] of bandByIsin) {
    const symbol = symbolByIsin.get(isin);
    if (symbol) bandOf.set(symbol.toUpperCase(), band);
  }

  const empty = (reason: string): CapBandView => ({
    available: false,
    reason,
    rows: [],
    asOf,
    classificationNote: text.note,
    unclassified: series.length,
    unclassifiedNote: "",
  });

  if (bandByIsin.size === 0) return empty(text.noSource);
  if (bandOf.size === 0) {
    return empty(
      `The bundled ${text.noun} classifies ${bandByIsin.size.toLocaleString("en-IN")} companies by size, but this ` +
        "database holds no instrument list to match those ISINs to ticker symbols — import an instrument file " +
        "and the bands appear.",
    );
  }

  const rows = new Map<string, { members: number; adv: number; dec: number; unch: number }>();
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
    classificationNote: text.note,
    unclassified,
    unclassifiedNote: text.unclassified(unclassified.toLocaleString("en-IN")),
    rows: labels.map(({ band, label }) => {
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

/** Cap bands for the stored universe — AMFI's (ruling U2). */
export function getCapBands(series: Series[], asOf: IsoDate | null): CapBandView {
  const bands = new Map<string, string>();
  let periodEnd: string | null = null;
  for (const [isin, info] of getCapBandMap()) {
    bands.set(isin, info.band);
    periodEnd ??= info.asOf;
  }
  return bandView(series, asOf, bands, CAP_BAND_LABELS, {
    // The view's asOf is the PRICE snapshot's date; the list's own period is a different clock and is named here.
    note: periodEnd ? `${CAP_BAND_CLASSIFICATION_NOTE} AMFI's list: the six months ended ${periodEnd}.` : CAP_BAND_CLASSIFICATION_NOTE,
    noun: "stock universe",
    noSource:
      "No cap-band data yet. The bundled stock universe carries no AMFI categorisation, so there is nothing to " +
      "bucket by. Vyuha will not guess a cap band from a market cap it cannot compute.",
    unclassified: (n) =>
      `${n} symbols in the stored universe carry no AMFI band — NSE Emerge (SME — not ranked by AMFI), listings ` +
      "after AMFI's averaging period, ETFs and anything AMFI does not list — and are counted nowhere rather than " +
      "pushed into the nearest band.",
  });
}

/** Nifty size-index membership for the stored universe — the separate lens (Q47). */
export function getIndexBands(series: Series[], asOf: IsoDate | null): CapBandView {
  return bandView(series, asOf, getIndexBandMap(), INDEX_BAND_LABELS, {
    note: INDEX_BAND_CLASSIFICATION_NOTE,
    noun: "NSE index map",
    noSource:
      "No size-index data yet. The bundled NSE index map carries the sectoral and thematic indices but no size " +
      "index (Nifty 100 / Midcap 150 / Smallcap 250 / Microcap 250), so there is no membership to show.",
    unclassified: (n) =>
      `${n} symbols in the stored universe sit in none of the four size indices and are counted nowhere rather ` +
      "than pushed into the nearest one.",
  });
}

// ---------------------------------------------------------------------------
// My names (Q53) — the first attribution: stock pick, or sector ride?
// ---------------------------------------------------------------------------

/**
 * Q51 #5 (W5 phase 2): the legacy `MyNameRow` projection (`sector`, a bare
 * `cohortSize`, a never-populated `tier`) is GONE — the panel reads `cohorts`,
 * whose rows state the level used, "n of m priced" and the rank in cohort.
 */
export interface MyNamesView {
  enabled: boolean;
  reason: string;
  /** The W5 rows: level used, "n of m priced", rank in cohort, CA exclusion, descriptive verdict. */
  cohorts: CohortRow[];
  sessions: number;
  statistic: Statistic;
  floors: { minPriced: number; minCoveragePpm: number };
  /** Held symbols the guard excluded in any window — the same set the rotation excludes. */
  excludedSymbols: string[];
  /** Q51 A1 / #7: per window, the real stored span and its gap line ("your 1m window has 4 missing sessions"). */
  spans: Record<CohortWindowKey, (SessionSpan & { gapLine: string | null }) | null>;
}

export interface MyNamesDeps {
  /** The ONE gap map (design review A5). Built over `aligned` when absent. */
  gapsBySymbol?: Map<string, CaGap[]>;
  resolve?: (symbol: string) => ClassificationRef | null;
  statistic?: Statistic;
}

/**
 * Per open equity position: its own return, its cohort's return under the
 * group statistic (median, AQ18), and the DIFFERENCE — "did the pick work, or
 * did the group carry it?". The cohort is the INDUSTRY, falling up to the
 * SECTOR when too thin (AQ21/AQ26), decided once per symbol on the 1m window
 * (A4). All of it runs on the ALIGNED universe with the same gap map the
 * rotation uses (A5), through the pure `computeCohorts`.
 *
 * Dark until `COHORT_MIN_SESSIONS` sessions exist, because a 1-month figure
 * computed over four sessions is not a 1-month figure (copy pinned in
 * tests/atlas-copy.test.ts). The journal read is `getTrackerTrades()`, which
 * is `getSelectedAccountId()`-scoped (invariant 8).
 */
export function getMyNames(aligned: Series[], sessions: number, deps: MyNamesDeps = {}): MyNamesView {
  const statistic = deps.statistic ?? DEFAULT_STATISTIC;
  const empty = (enabled: boolean, reason: string): MyNamesView => ({
    enabled,
    sessions,
    cohorts: [],
    reason,
    statistic,
    floors: { minPriced: 0, minCoveragePpm: 0 },
    excludedSymbols: [],
    spans: { "1w": null, "1m": null },
  });
  if (sessions < COHORT_MIN_SESSIONS) {
    return empty(
      false,
      `Needs ${COHORT_MIN_SESSIONS} sessions of stored bars to compare a name against its sector; you have ${sessions}. Run the backfill to enable it.`,
    );
  }

  const held = [
    ...new Set(
      getTrackerTrades()
        .filter((t) => t.isOpen && t.instrumentType === "equity")
        .map((t) => t.symbol.toUpperCase()),
    ),
  ];
  if (held.length === 0) return empty(true, "No open equity positions to attribute.");

  const resolve = deps.resolve ?? classificationOfFn();
  const gaps = deps.gapsBySymbol ?? buildGapMap(aligned);
  const result = computeCohorts(aligned, held, resolve, gaps, { statistic });

  const stored = sessionCalendar(aligned);
  const spans = {} as MyNamesView["spans"];
  for (const w of COHORT_WINDOWS) {
    const span = sessionSpan(stored, w.sessions);
    spans[w.key] = span ? { ...span, gapLine: windowGapLine(w.key, span.missing) } : null;
  }

  return {
    enabled: true,
    sessions,
    cohorts: result.rows,
    reason: "",
    statistic,
    floors: result.floors,
    excludedSymbols: result.excludedSymbols,
    spans,
  };
}

// ---------------------------------------------------------------------------
// Rank Δ (AQ9, design review A1) — read from stored rows of ONE spec_version.
// ---------------------------------------------------------------------------

export type RankKind = "sector" | "industry" | "cap";
export type RankWindowKey = Exclude<ReturnWindowKey, "1d">;

export interface RankDeltaWindow {
  key: RankWindowKey;
  /** Daily snapshots the window needs under this formula set. */
  need: number;
  /** Daily snapshots that exist under this formula set, up to the anchor. */
  have: number;
  /** The snapshot the past rank was read from, or null while short. */
  pastAsOf: IsoDate | null;
  /** group → past rank − current rank (positive = climbed); null = not ranked then. Empty while short. */
  delta: Record<string, number | null>;
  /** The A1 sentence while short; null once the snapshots exist. */
  shortfall: string | null;
}

export interface RankDeltaView {
  kind: RankKind;
  asOf: IsoDate | null;
  /** Today's rank per group over `group_rs_ppm`, groups with ≥ GROUP_MIN_RANK eligible members only. */
  rank: Record<string, number>;
  hiddenBelowFloor: number;
  windows: RankDeltaWindow[];
  minRank: number;
}

/** `group → rank` from the stored `group_rs_ppm` rows of one session, AQ26 floor applied. */
function storedRsRanks(asOf: IsoDate, kind: RankKind): { rank: Map<string, number>; hidden: number } {
  const rows = db
    .select({ group: atlasMetric.groupName, value: atlasMetric.valuePpm, denominator: atlasMetric.denominator })
    .from(atlasMetric)
    .innerJoin(atlasDaily, eq(atlasMetric.asOf, atlasDaily.asOf))
    .where(
      and(
        eq(atlasMetric.asOf, asOf),
        eq(atlasMetric.metric, "group_rs_ppm"),
        eq(atlasMetric.groupKind, kind),
        // A1: only rows a snapshot of THIS formula set wrote. A 1.0.0 row for
        // an earlier session survives the bump and must never enter a 2.0.0 Δ.
        eq(atlasDaily.specVersion, SPEC_VERSION),
      ),
    )
    .all();
  let hidden = 0;
  const ranked: { group: string; value: number | null }[] = [];
  for (const r of rows) {
    if (r.value === null || (r.denominator ?? 0) < GROUP_MIN_RANK) {
      if (r.value !== null) hidden++;
      continue;
    }
    ranked.push({ group: r.group, value: r.value });
  }
  return { rank: rankByValue(ranked), hidden };
}

/**
 * Rank Δ for one group kind at the anchor. The denominator is DAILY SNAPSHOTS
 * under this `spec_version` (one `atlas_daily` row per day Atlas was opened
 * with new bars), never stored sessions — a backfill adds sessions but writes
 * no snapshots, so the copy says which one is short.
 */
export function getRankDeltas(asOf: IsoDate | null, kind: RankKind): RankDeltaView {
  const windows = RETURN_WINDOWS.filter((w): w is { key: RankWindowKey; sessions: number } => w.key !== "1d");
  if (!asOf) {
    return {
      kind,
      asOf: null,
      rank: {},
      hiddenBelowFloor: 0,
      minRank: GROUP_MIN_RANK,
      windows: windows.map((w) => ({ key: w.key, need: w.sessions, have: 0, pastAsOf: null, delta: {}, shortfall: rankDeltaShortfallLine(0, w.sessions) })),
    };
  }
  const snapshots = db
    .select({ asOf: atlasDaily.asOf })
    .from(atlasDaily)
    .where(and(eq(atlasDaily.specVersion, SPEC_VERSION), lte(atlasDaily.asOf, asOf)))
    .orderBy(desc(atlasDaily.asOf))
    .all()
    .map((r) => r.asOf);
  const today = storedRsRanks(asOf, kind);
  const out: RankDeltaWindow[] = [];
  for (const w of windows) {
    const need = w.sessions;
    const have = snapshots.length;
    if (have < need) {
      out.push({ key: w.key, need, have, pastAsOf: null, delta: {}, shortfall: rankDeltaShortfallLine(have, need) });
      continue;
    }
    const pastAsOf = snapshots[need - 1];
    const past = storedRsRanks(pastAsOf, kind).rank;
    out.push({ key: w.key, need, have, pastAsOf, delta: Object.fromEntries(rankDelta(today.rank, past)), shortfall: null });
  }
  return { kind, asOf, rank: Object.fromEntries(today.rank), hiddenBelowFloor: today.hidden, windows: out, minRank: GROUP_MIN_RANK };
}

// ---------------------------------------------------------------------------
// The trades join (AQ52 Option B point 3, design review A7): breadth on the
// days these positions were opened. Descriptive; no verb about the future.
// ---------------------------------------------------------------------------

export interface EntryDayBreadth {
  /** Distinct entry dates asked about. */
  entryDays: number;
  /** Entry dates with a stored same-spec figure or a replay entry. */
  withFigure: number;
  /** Entry dates with neither — counted in `entryDays` and NAMED here (A7). */
  outsideReplay: number;
  aboveSma50MeanPpm: number | null;
  advanceMeanPpm: number | null;
  sentence: string;
}

export interface EntryDayBreadthView {
  open: EntryDayBreadth;
  closedWinners: EntryDayBreadth;
  closedLosers: EntryDayBreadth;
  replaySessions: number;
  source: string;
}

function meanPpm(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function pctOf(ppm: number | null): string {
  return ppm === null ? "—" : `${(ppm / 10_000).toFixed(1)}%`;
}

/** Same-spec stored market rows for the given sessions: date → { above_sma50, advance }. */
function storedMarketFigures(dates: string[]): Map<string, { above: number | null; adv: number | null }> {
  const out = new Map<string, { above: number | null; adv: number | null }>();
  if (dates.length === 0) return out;
  const rows = db
    .select({ asOf: atlasMetric.asOf, metric: atlasMetric.metric, value: atlasMetric.valuePpm })
    .from(atlasMetric)
    .innerJoin(atlasDaily, eq(atlasMetric.asOf, atlasDaily.asOf))
    .where(
      and(
        inArray(atlasMetric.asOf, dates),
        eq(atlasMetric.groupKind, "market"),
        inArray(atlasMetric.metric, ["above_sma50_pct_ppm", "advance_pct_ppm"]),
        eq(atlasDaily.specVersion, SPEC_VERSION),
      ),
    )
    .all();
  for (const r of rows) {
    const cur = out.get(r.asOf) ?? { above: null, adv: null };
    if (r.metric === "above_sma50_pct_ppm") cur.above = r.value;
    else cur.adv = r.value;
    out.set(r.asOf, cur);
  }
  return out;
}

function breadthOnDays(
  label: string,
  dates: string[],
  history: Map<string, { above: number | null; adv: number | null }>,
  stored: Map<string, { above: number | null; adv: number | null }>,
  replaySessions: number,
): EntryDayBreadth {
  const distinct = [...new Set(dates)].sort();
  const above: number[] = [];
  const adv: number[] = [];
  let withFigure = 0;
  for (const d of distinct) {
    const h = stored.get(d) ?? history.get(d);
    if (!h || (h.above === null && h.adv === null)) continue;
    withFigure++;
    if (h.above !== null) above.push(h.above);
    if (h.adv !== null) adv.push(h.adv);
  }
  const outsideReplay = distinct.length - withFigure;
  const aboveMean = meanPpm(above);
  const advMean = meanPpm(adv);
  let sentence: string;
  if (distinct.length === 0) sentence = `No ${label} to look up.`;
  else if (withFigure === 0) sentence = `None of the ${distinct.length} ${label} fall inside the ${replaySessions}-session replay or a stored snapshot under this formula set.`;
  else {
    sentence =
      `On ${withFigure} of ${distinct.length} ${label}, ${pctOf(aboveMean)} of the market was above its SMA50 and ` +
      `${pctOf(advMean)} advanced` +
      (outsideReplay > 0 ? `; ${outsideReplay} ${outsideReplay === 1 ? "entry day falls" : "entry days fall"} outside the ${replaySessions}-session replay.` : ".");
  }
  return { entryDays: distinct.length, withFigure, outsideReplay, aboveSma50MeanPpm: aboveMean, advanceMeanPpm: advMean, sentence };
}

/**
 * Breadth on the sessions the journal's positions were opened: the %>SMA50 and
 * advance share of THAT session, from a stored same-spec market row or from the
 * payload's price-only replay (never a replayed sector row — Q49). The journal
 * read is `getTrackerTrades()`: `getSelectedAccountId()`-scoped (invariant 8).
 */
export function getEntryDayBreadth(payload: AtlasPayload | null): EntryDayBreadthView {
  const history = new Map<string, { above: number | null; adv: number | null }>();
  for (const h of payload?.history ?? []) history.set(h.as_of, { above: h.above_sma_ppm?.[50] ?? null, adv: h.advance_pct_ppm });
  const replaySessions = payload?.history?.length ?? 0;
  const trades = getTrackerTrades().filter((t) => t.instrumentType === "equity");
  const entryOf = (t: { buyDate: string | null; sellDate: string | null; buyQty: number; sellQty: number; side?: string | null }) =>
    dayOf(entryDateOf(t) ?? exitDateOf(t));
  const open: string[] = [];
  const winners: string[] = [];
  const losers: string[] = [];
  for (const t of trades) {
    const d = entryOf(t);
    if (!d) continue;
    if (t.isOpen) open.push(d);
    else if (t.netPnl > 0) winners.push(d);
    else if (t.netPnl < 0) losers.push(d);
  }
  const stored = storedMarketFigures([...new Set([...open, ...winners, ...losers])]);
  return {
    open: breadthOnDays("entry days", open, history, stored, replaySessions),
    closedWinners: breadthOnDays("entry days of closed winners", winners, history, stored, replaySessions),
    closedLosers: breadthOnDays("entry days of closed losers", losers, history, stored, replaySessions),
    replaySessions,
    source: "Stored market rows under this formula set first, then the price-only replay; never a replayed sector row.",
  };
}

// ---------------------------------------------------------------------------
// The index-membership FILTER (AQ23, design review A8): in memory, never cached.
// ---------------------------------------------------------------------------

interface IndexMapShape {
  sizeIndices?: Record<string, { symbols?: unknown[] }>;
  symbols?: Record<string, { indices?: string[] }>;
}

export interface IndexFilters {
  size: string[];
  sectoral: string[];
}

/** The filters the bundled index map exposes: the size lists, then the sectoral/thematic names. */
export function listIndexFilters(): IndexFilters {
  const map = nseIndexMapJson as unknown as IndexMapShape;
  const size = Object.keys(map.sizeIndices ?? {}).sort();
  const sectoral = new Set<string>();
  for (const v of Object.values(map.symbols ?? {})) for (const i of v.indices ?? []) sectoral.add(i);
  return { size, sectoral: [...sectoral].sort() };
}

/** Members of one index by SYMBOL: the bundled map first, `instrument_indices` only as a fallback (A8). */
export function indexMembers(name: string): Set<string> | null {
  const map = nseIndexMapJson as unknown as IndexMapShape;
  const size = map.sizeIndices?.[name];
  if (size?.symbols) {
    const out = new Set<string>();
    for (const s of size.symbols) {
      const sym = typeof s === "string" ? s : (s as { symbol?: string })?.symbol;
      if (sym) out.add(sym.toUpperCase());
    }
    return out;
  }
  const out = new Set<string>();
  for (const [sym, v] of Object.entries(map.symbols ?? {})) if (v.indices?.includes(name)) out.add(sym.toUpperCase());
  if (out.size > 0) return out;
  for (const [sym, names] of getIndexMembershipMap()) if (names.includes(name)) out.add(sym.toUpperCase());
  return out.size > 0 ? out : null;
}

export type AtlasIndexView =
  | {
      ok: true;
      index: string;
      /** Index members the map lists. */
      members: number;
      /** Members with a bar on the anchor. */
      priced: number;
      header: string;
      payload: AtlasPayload | null;
      statistic: Statistic;
      specVersion: string;
    }
  | { ok: false; message: string };

/**
 * The market restricted to one index, computed IN MEMORY over the same bars
 * and NEVER persisted (A8). The header states the restriction with its own
 * denominator: "restricted to Nifty 500 (487 of 500 priced)".
 */
export function getAtlasIndexView(name: string): AtlasIndexView {
  const members = indexMembers(name);
  if (!members) return { ok: false, message: `No index named "${name}" in the bundled index map or your instrument lists.` };
  const bars = readUniverseBars().filter((b) => members.has(b.symbol.toUpperCase()));
  const result = computeAtlasDaily(bars, sectorOfFn(), {
    generatedAt: new Date().toISOString(),
    sha256,
    sourceMode: "bhavcopy_local",
    isEligible: isEquitySymbol,
    classificationOf: classificationOfFn(),
    capBandOf: capBandOfFn(),
    regimeThresholds: getRegimeThresholds(),
    statistic: DEFAULT_STATISTIC,
  });
  const priced = result.alignment.coverage;
  return {
    ok: true,
    index: name,
    members: members.size,
    priced,
    header: `restricted to ${name} (${priced.toLocaleString("en-IN")} of ${members.size.toLocaleString("en-IN")} priced)`,
    payload: result.payload,
    statistic: DEFAULT_STATISTIC,
    specVersion: SPEC_VERSION,
  };
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
  /** The Nifty size-index membership lens (Q47) — never labelled a cap band (U2). */
  indexBands: CapBandView;
  myNames: MyNamesView;
  volumeLeaders: VolumeLeader[];
  backfill: BackfillProgress;
  backfillConsented: boolean;
  backfillDefaultDays: number;
  backfillRateLimitMs: number;
  rotationCaveat: string;
  /** Q52 — the bundled classification maps, each with its digest and its clock. */
  mapDigests: MapDigest[];
  provenanceLine: string;
  notAdviceLine: string;
  specVersion: string;
  // ---- v4.6.0 W5 ---------------------------------------------------------
  /** The group statistic the persisted `groups.*.returns[w].median` rows carry (AQ18); the mean sits beside it. */
  statistic: Statistic;
  /** Rank Δ per group kind, read from same-spec snapshots (A1), with the shortfall while short. */
  rankDeltas: Record<RankKind, RankDeltaView>;
  /** Breadth on the days the journal's positions were opened (A7). */
  entryDayBreadth: EntryDayBreadthView;
  /** The stored regime thresholds (AQ13) and whether they are the defaults. */
  regimeThresholds: RegimeThresholdSetting;
  /** AQ44: below this coverage a tile prints its coverage instead of its value. */
  coverageFloorPpm: number;
  /** AQ26: the leaderboard floor, so the table can state the hidden count. */
  groupMinRank: number;
  /** AQ23: the filters `GET /api/atlas/view?index=` accepts. */
  indexFilters: IndexFilters;
  /** Q51 A1: what the 252-day window is missing, and whether a catch-up runs on open. */
  catchup: CatchupStatus;
  /** AQ10/AQ11: what Atlas does not compute, and why. */
  notComputed: readonly NotComputedFamily[];
  /**
   * Q51 #7: per return window, the real stored span and its calendar gap
   * ("1m = 21 stored sessions, 12 Jul → 15 Sep (3 missing)"). Computed HERE over
   * the aligned universe's session calendar, never client-side; null while the
   * store does not reach the window.
   */
  windowSpans: Record<RankWindowKey, (SessionSpan & { gapLine: string | null }) | null>;
}

/** The sparse-history spans for the rendered return windows (Q51 #7). */
export function windowSpansFor(aligned: Series[]): AtlasView["windowSpans"] {
  const stored = sessionCalendar(aligned);
  const out = {} as AtlasView["windowSpans"];
  for (const w of RETURN_WINDOWS) {
    if (w.key === "1d") continue;
    const span = sessionSpan(stored, w.sessions);
    out[w.key] = span ? { ...span, gapLine: windowGapLine(w.key, span.missing) } : null;
  }
  return out;
}

/** Everything `/atlas` renders, computed on demand and cached by checksum. */
export function getAtlasView(): AtlasView {
  const refreshed = refreshAtlasSnapshot();
  const snapshot = refreshed.snapshot ? withCurrentRegime(refreshed.snapshot) : null;
  const bars = readUniverseBars();
  const series = toSeries(bars).filter((s) => isEquitySymbol(s.symbol));

  // A5: the cohort, the RS and the trades join run on the ALIGNED universe with
  // the ONE gap map — the same alignment and guard the daily compute applied.
  const aligned = alignToAnchor(series, modalAnchor(series)).aligned;
  const gapsBySymbol = buildGapMap(aligned);

  const sessions = storedSessionCount();
  const payload = snapshot?.payload ?? null;
  const asOf = snapshot?.asOf ?? null;
  return {
    snapshot,
    payload,
    sessions,
    capBands: getCapBands(series, asOf),
    indexBands: getIndexBands(series, asOf),
    myNames: getMyNames(aligned, sessions, { gapsBySymbol }),
    volumeLeaders: getVolumeLeaders(series),
    backfill: readBackfillProgress(),
    backfillConsented: hasBackfillConsent(),
    backfillDefaultDays: BACKFILL_DEFAULT_DAYS,
    backfillRateLimitMs: BACKFILL_RATE_LIMIT_MS,
    rotationCaveat: ROTATION_CAVEAT,
    mapDigests: getMapDigests(),
    provenanceLine: NO_CHARTINK_LINE,
    notAdviceLine: NOT_ADVICE_LINE,
    specVersion: SPEC_VERSION,
    statistic: payload?.statistic ?? DEFAULT_STATISTIC,
    rankDeltas: {
      sector: getRankDeltas(asOf, "sector"),
      industry: getRankDeltas(asOf, "industry"),
      cap: getRankDeltas(asOf, "cap"),
    },
    entryDayBreadth: getEntryDayBreadth(payload),
    regimeThresholds: getRegimeThresholdSetting(),
    coverageFloorPpm: COVERAGE_FLOOR_PPM,
    groupMinRank: GROUP_MIN_RANK,
    indexFilters: listIndexFilters(),
    catchup: catchupStatus(),
    notComputed: NOT_COMPUTED,
    windowSpans: windowSpansFor(aligned),
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
