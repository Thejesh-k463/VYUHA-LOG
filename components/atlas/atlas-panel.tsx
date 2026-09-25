"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useStoredValue, writeStored } from "@/components/layout/use-stored-value";
import type { AtlasPayload, GroupTableRow, RegimeResult, Statistic } from "@/lib/atlas";
import type { AtlasIndexView, AtlasView } from "@/lib/queries/atlas";
import { BackfillPanel } from "./backfill-panel";
import { CohortTable, EntryDayBreadthCard } from "./cohort-table";
import { fmtCount, MetricTile, ppmToPct, signedPct } from "./metric-tile";
import { NotComputedList } from "./not-computed-list";
import { ROTATION_LEVELS, RotationTable, STATISTICS, type RotationLevel } from "./rotation-table";
import { Sparkline } from "./sparkline";

/**
 * The Atlas panel v3 — five tabs, one screen (06a §3; v4.6.0 W5, owner rulings
 * AQ1 / AQ3 / AQ4 / AQ6 / AQ23 / AQ44 / AQ47).
 *
 * WHAT THIS SHIPS AND WHAT IT DOES NOT (research answers Q42/Q42b): the
 * TRANSPARENT daily core only. Every figure here is a published definition
 * computed from the user's own stored bhavcopy bars, every one renders with
 * its denominator, and every one prints its plain public formula on screen
 * (build prompt Q-5). There is no proprietary figure, no hidden filter, no
 * Chartink data and no parity claim: the owner's own widgets are not computed
 * on this machine, and no feed exists that would deliver them (Q-12). Tab 5
 * lists what is NOT computed, and why, in Vyuha's own words.
 *
 * STATE. Four per-machine preferences (AQ4) live in localStorage through
 * `use-stored-value.ts` under `{v:1,…}` envelopes: the tab, the rotation level,
 * the group statistic and the index filter. They are DERIVED from storage on
 * every render — the server snapshot is null, so the defaults paint first and
 * the stored choice lands after hydration (no setState in an effect).
 *
 * THE INDEX FILTER (AQ23 / A8) never touches the cache: a non-"All" choice
 * fetches `GET /api/atlas/view?index=` and renders the RETURNED payload; the
 * stored rows are never filtered here. Rank Δ, the cap/index band lenses, the
 * volume leaders and the cohort tab read the whole market's stored rows and
 * say so under a filter rather than pretending to be restricted.
 */

export const TABS = [
  { key: "market", label: "Market" },
  { key: "sectors", label: "Sectors" },
  { key: "cap", label: "Cap bands" },
  { key: "mine", label: "My names" },
  { key: "coverage", label: "Coverage" },
] as const;
type TabKey = (typeof TABS)[number]["key"];
const TAB_KEYS = TABS.map((t) => t.key) as readonly TabKey[];

/** localStorage keys (AQ4); every value is wrapped as `{v:1, <field>: …}`. */
export const STORED_KEYS = {
  tab: "vyuha-atlas-tab",
  level: "vyuha-atlas-level",
  statistic: "vyuha-atlas-statistic",
  index: "vyuha-atlas-index-filter",
} as const;
export const ALL_INDICES = "All";

/** The stored envelope's `field`, when it is one of `allowed`; else the default. A foreign shape is discarded, never half-read. */
export function readEnvelope<T extends string>(raw: string | null, field: string, allowed: readonly T[], fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as { v?: unknown } & Record<string, unknown>;
    if (parsed?.v !== 1) return fallback;
    const v = parsed[field];
    return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export function envelope(field: string, value: string): string {
  return JSON.stringify({ v: 1, [field]: value });
}

type RemoteView =
  | { index: string; state: "ok"; view: Extract<AtlasIndexView, { ok: true }> }
  | { index: string; state: "error"; message: string };

const EMPTY_GROUPS: AtlasPayload["groups"] = { sector: [], industry: [], cap: [], unclassified: { sector: 0, industry: 0, cap: 0 } };

export function AtlasPanel({ view, initialTab = "market" }: { view: AtlasView; initialTab?: TabKey }) {
  // ---- per-machine preferences, derived from storage (AQ4) -----------------
  // `initialTab` is only the fallback when nothing is stored (the page passes
  // none; a static render can ask for another tab). The stored choice wins.
  const tab = readEnvelope(useStoredValue(STORED_KEYS.tab), "tab", TAB_KEYS, initialTab);
  const level = readEnvelope(
    useStoredValue(STORED_KEYS.level),
    "level",
    ROTATION_LEVELS.map((l) => l.key),
    "sector" as RotationLevel,
  );
  const statistic = readEnvelope(
    useStoredValue(STORED_KEYS.statistic),
    "statistic",
    STATISTICS.map((s) => s.key),
    view.statistic as Statistic,
  );
  const indexOptions = React.useMemo(
    () => [ALL_INDICES, ...view.indexFilters.size, ...view.indexFilters.sectoral],
    [view.indexFilters.size, view.indexFilters.sectoral],
  );
  const indexFilter = readEnvelope(useStoredValue(STORED_KEYS.index), "index", indexOptions, ALL_INDICES);

  // ---- the index filter: a fetch, never a cache write (AQ23 / A8) ----------
  const [remote, setRemote] = React.useState<RemoteView | null>(null);
  React.useEffect(() => {
    if (indexFilter === ALL_INDICES) return;
    let alive = true;
    const ctrl = new AbortController();
    // The state writes below happen in the fetch's continuation, never
    // synchronously in the effect body (the pattern AGENTS.md bans).
    fetch(`/api/atlas/view?index=${encodeURIComponent(indexFilter)}`, { signal: ctrl.signal })
      .then(async (res) => {
        const body = (await res.json()) as (AtlasIndexView & { provenance?: string }) | { ok: false; message?: string };
        if (!alive) return;
        if (res.ok && body.ok) setRemote({ index: indexFilter, state: "ok", view: body });
        else setRemote({ index: indexFilter, state: "error", message: (body as { message?: string }).message ?? `Request failed (${res.status}).` });
      })
      .catch(() => {
        if (alive) setRemote({ index: indexFilter, state: "error", message: "Could not reach the app's own server." });
      });
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [indexFilter]);

  const filtered = indexFilter !== ALL_INDICES;
  const remoteForFilter = filtered && remote?.index === indexFilter ? remote : null;
  const loading = filtered && remoteForFilter === null;
  const active = remoteForFilter?.state === "ok" ? remoteForFilter.view : null;

  const setTab = (v: string) => writeStored(STORED_KEYS.tab, envelope("tab", v));
  const setLevel = (v: RotationLevel) => writeStored(STORED_KEYS.level, envelope("level", v));
  const setStatistic = (v: Statistic) => writeStored(STORED_KEYS.statistic, envelope("statistic", v));
  const setIndex = (v: string) => writeStored(STORED_KEYS.index, envelope("index", v));

  // Under a filter the RETURNED payload is what the tabs read; the stored one otherwise.
  const payload = active?.payload ?? view.payload;
  const snapshot = view.snapshot;

  const filterRow = (
    <div className="flex flex-wrap items-center gap-2" data-testid="atlas-index-filter">
      <label htmlFor="atlas-index-filter" className="text-muted-foreground">
        Restrict to
      </label>
      <Select
        id="atlas-index-filter"
        className="h-7 w-auto py-0 text-xs"
        value={indexFilter}
        onChange={(e) => setIndex(e.target.value)}
        aria-label="Index membership filter"
      >
        <option value={ALL_INDICES}>All symbols</option>
        <optgroup label="Size indices">
          {view.indexFilters.size.map((i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </optgroup>
        <optgroup label="Sectoral and thematic indices">
          {view.indexFilters.sectoral.map((i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </optgroup>
      </Select>
      <span className="text-muted-foreground" data-testid="atlas-filter-header" aria-live="polite">
        {!filtered
          ? "the whole stored universe"
          : loading
            ? `computing the ${indexFilter} view from your stored bars…`
            : remoteForFilter?.state === "error"
              ? remoteForFilter.message
              : active?.header}
      </span>
    </div>
  );

  if (!payload || !snapshot) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Nothing to compute yet</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs text-muted-foreground">
            <p>
              Atlas reads the end-of-day bhavcopy bars stored on this machine and there are none yet — so it
              shows nothing rather than a screen of zeros.
            </p>
            {filtered ? filterRow : null}
          </CardContent>
        </Card>
        <BackfillPanel
          initialProgress={view.backfill}
          consented={view.backfillConsented}
          defaultDays={view.backfillDefaultDays}
          rateLimitMs={view.backfillRateLimitMs}
          catchup={view.catchup}
        />
        <AtlasFooter view={view} />
      </div>
    );
  }

  const pulse = payload.market_pulse;
  const ledger = payload.ledger;
  const history = payload.history;
  const groups = payload.groups ?? EMPTY_GROUPS;
  const shortfallFor = (metric: string) => ledger.shortfalls.find((s) => s.metric === metric)?.line ?? null;
  const bandLabel = new Map(view.capBands.rows.map((r) => [r.band, r.label] as const));
  const labelOf = (band: string) => bandLabel.get(band) ?? `${band.charAt(0).toUpperCase()}${band.slice(1)} cap`;

  return (
    <div className="space-y-4" data-testid="atlas-panel" data-filtered={filtered ? "yes" : "no"}>
      {/* HEADER — the provenance line is part of the screen, not a footnote. */}
      <Card>
        <CardContent className="space-y-1 p-4 text-xs">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-base font-semibold tracking-tight text-foreground">Market Atlas</span>
            <span className="tabular-nums text-muted-foreground">
              as of {payload.as_of} · anchor = {ledger.anchor.policy}
            </span>
            {active ? <span className="tabular-nums text-foreground">{active.header}</span> : null}
          </div>
          <div className="tabular-nums text-muted-foreground">
            {fmtCount(ledger.anchor.coverage)} of {fmtCount(ledger.anchor.total)} symbols on the anchor (
            {ppmToPct(ledger.anchor.coverage_ppm, 1)}) · spec {payload.spec_version} · sha{" "}
            {payload.input_checksum.slice(0, 8)}… · computed {payload.generated_at.slice(0, 19).replace("T", " ")} ·
            group statistic: {payload.statistic ?? view.statistic}
          </div>
          <div className="text-muted-foreground">{view.provenanceLine}</div>
          {filterRow}
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key} data-testid={`atlas-tab-${t.key}`}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* ── TAB 1 · MARKET — regime → my names → sector RS → cap ladder → breadth (AQ1) ── */}
        <TabsContent value="market" className="space-y-4 pt-4">
          <RegimeCard regime={payload.regime} pulse={pulse} setting={view.regimeThresholds} shortfallFor={shortfallFor} />

          <Card data-testid="atlas-my-names-headline">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">My names</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <p className="text-muted-foreground">{myNamesHeadline(view.myNames)}</p>
              <button type="button" className="text-xs text-primary underline-offset-2 hover:underline" onClick={() => setTab("mine")}>
                Open the My names tab
              </button>
            </CardContent>
          </Card>

          <Card data-testid="atlas-sector-rs">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Sector relative strength — leaders and laggards</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <RsLeaders rows={groups.sector} minRank={view.groupMinRank} rs={payload.relative_strength ?? null} />
              <button type="button" className="text-xs text-primary underline-offset-2 hover:underline" onClick={() => setTab("sectors")}>
                Open the rotation table
              </button>
            </CardContent>
          </Card>

          <Card data-testid="atlas-cap-headline">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Cap bands (AMFI) — in brief</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              {groups.cap.length === 0 ? (
                <p className="text-muted-foreground">{view.capBands.reason || "No band figures for this view."}</p>
              ) : (
                <ul className="space-y-0.5 tabular-nums text-muted-foreground">
                  {groups.cap.map((r) => (
                    <li key={r.group}>
                      <span className="text-foreground">{labelOf(r.group)}</span> · {fmtCount(r.priced)} of {fmtCount(r.members)} priced · 1m median{" "}
                      {signedPct(r.returns["1m"]?.median.value_ppm ?? null)} · advancing {ppmToPct(r.breadth.advancing.value_ppm, 0)}
                    </li>
                  ))}
                </ul>
              )}
              <button type="button" className="text-xs text-primary underline-offset-2 hover:underline" onClick={() => setTab("cap")}>
                Open the cap-band ladder
              </button>
            </CardContent>
          </Card>

          <Card data-testid="atlas-breadth">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Breadth · {history.length} sessions plotted</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <MetricTile
                label="Advancing"
                valuePpm={pulse.breadth.advancing.value_ppm}
                numerator={pulse.breadth.counts.advancing}
                denominator={pulse.breadth.advancing.denominator}
                coveragePpm={pulse.breadth.advancing.coverage_ppm}
                formula="Today's close above yesterday's close. Denominator: symbols with two closes at the anchor."
              >
                <div className="mt-2">
                  <Sparkline label="advancing %" values={history.map((h) => h.advance_pct_ppm)} />
                </div>
              </MetricTile>
              <MetricTile
                label="Declining"
                valuePpm={pulse.breadth.declining.value_ppm}
                numerator={pulse.breadth.counts.declining}
                denominator={pulse.breadth.declining.denominator}
                coveragePpm={pulse.breadth.declining.coverage_ppm}
                formula="Today's close below yesterday's close. Same denominator as advancing."
              />
              <MetricTile
                label="Unchanged"
                valuePpm={pulse.breadth.unchanged.value_ppm}
                numerator={pulse.breadth.counts.unchanged}
                denominator={pulse.breadth.unchanged.denominator}
                coveragePpm={pulse.breadth.unchanged.coverage_ppm}
                formula="Today's close exactly equal to yesterday's. A symbol with only one close is counted nowhere, never here."
              />
              {[20, 50, 200].map((period) => {
                const sma = pulse.moving_average_breadth[period];
                return (
                  <MetricTile
                    key={period}
                    label={`Above SMA${period}`}
                    valuePpm={sma?.metric.value_ppm ?? null}
                    numerator={sma?.metric.numerator}
                    denominator={sma?.metric.denominator}
                    coveragePpm={sma?.metric.coverage_ppm}
                    shortfall={shortfallFor(`above_sma${period}_pct_ppm`)}
                    formula="Close strictly above the mean of the last N closes."
                  >
                    <div className="mt-2">
                      <Sparkline label={`above SMA${period}`} values={history.map((h) => h.above_sma_ppm[period] ?? null)} />
                    </div>
                  </MetricTile>
                );
              })}
              <MetricTile
                label={`New ${pulse.new_high_low.label} highs`}
                value={pulse.new_high_low.counts.highs}
                denominator={pulse.new_high_low.newHighs.denominator}
                coveragePpm={pulse.new_high_low.newHighs.coverage_ppm}
                shortfall={shortfallFor("new_high_pct_ppm")}
                formula={`Today's high at or above the highest high of the last ${pulse.new_high_low.windowSessions} sessions, today included. Needs 20 sessions to have an opinion at all.`}
              >
                <div className="mt-2">
                  <Sparkline label="net high-low" values={history.map((h) => h.net_high_low)} />
                </div>
              </MetricTile>
              <MetricTile
                label={`New ${pulse.new_high_low.label} lows`}
                value={pulse.new_high_low.counts.lows}
                denominator={pulse.new_high_low.newLows.denominator}
                coveragePpm={pulse.new_high_low.newLows.coverage_ppm}
                shortfall={shortfallFor("new_high_pct_ppm")}
                formula={`Today's low at or below the lowest low of the last ${pulse.new_high_low.windowSessions} sessions, today included. Same window and denominator as the highs.`}
              />
              {payload.rsi ? (
                <>
                  <MetricTile
                    label={`RSI${payload.rsi.thresholds.period} at or below ${payload.rsi.thresholds.low}`}
                    value={payload.rsi.low.value}
                    denominator={payload.rsi.low.denominator}
                    coveragePpm={payload.rsi.low.coverage_ppm}
                    shortfall={shortfallFor("rsi_low_count")}
                    formula={`Wilder's RSI over ${payload.rsi.thresholds.period} closes; a count of symbols at or below ${payload.rsi.thresholds.low}, over the symbols with ${payload.rsi.thresholds.period + 1} closes. The thresholds are constants, printed here.`}
                  />
                  <MetricTile
                    label={`RSI${payload.rsi.thresholds.period} at or above ${payload.rsi.thresholds.high}`}
                    value={payload.rsi.high.value}
                    denominator={payload.rsi.high.denominator}
                    coveragePpm={payload.rsi.high.coverage_ppm}
                    shortfall={shortfallFor("rsi_high_count")}
                    formula={`Same RSI and denominator; a count of symbols at or above ${payload.rsi.thresholds.high}.`}
                  />
                </>
              ) : null}
              {payload.volume_split ? (
                <MetricTile
                  label="Volume in advancers"
                  valuePpm={payload.volume_split.advancingShare.value_ppm}
                  numerator={payload.volume_split.advancingShare.numerator}
                  denominator={payload.volume_split.advancingShare.denominator}
                  coveragePpm={payload.volume_split.advancingShare.coverage_ppm}
                  formula="Σ volume of advancing symbols over Σ volume of advancing plus declining symbols, on the anchor session. Unchanged symbols and symbols without a volume are counted in neither."
                />
              ) : null}
              <MetricTile
                label="Median volume expansion"
                valuePpm={pulse.volume.medianExpansion.value_ppm}
                numerator={pulse.volume.medianExpansion.numerator}
                denominator={pulse.volume.medianExpansion.denominator}
                coveragePpm={pulse.volume.medianExpansion.coverage_ppm}
                shortfall={shortfallFor("volume_expansion_median_ppm")}
                formula={`Latest volume ÷ mean of the prior ${pulse.volume.baselineSessions} sessions (today excluded). 100% = flat.`}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Volume-expansion leaders</CardTitle>
            </CardHeader>
            <CardContent className="text-xs">
              {filtered ? (
                <p className="text-muted-foreground">Ranked over the whole stored universe; not shown under an index filter.</p>
              ) : view.volumeLeaders.length === 0 ? (
                <p className="text-muted-foreground">
                  Needs {pulse.volume.baselineSessions + 1} sessions of volume for any symbol to rank.
                </p>
              ) : (
                <ul className="space-y-1 tabular-nums">
                  {view.volumeLeaders.map((l) => (
                    <li key={l.symbol} className="flex justify-between gap-4">
                      <span className="text-foreground">{l.symbol}</span>
                      <span className="text-muted-foreground">{ppmToPct(l.expansionPpm, 0)} of its 20-session mean</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── TAB 2 · SECTORS — one rotation table, level + statistic toggles (AQ6 / AQ18) ── */}
        <TabsContent value="sectors" className="space-y-4 pt-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Rotation · {level === "sector" ? "sectors" : "industries"} · {statistic}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-xs">
              <RotationTable
                rows={groups[level]}
                level={level}
                onLevel={setLevel}
                statistic={statistic}
                onStatistic={setStatistic}
                rankDelta={filtered ? null : view.rankDeltas[level]}
                filtered={filtered}
                classification={payload.classification}
                unclassified={groups.unclassified[level]}
                spans={view.windowSpans}
                minRank={view.groupMinRank}
                rs={payload.relative_strength ?? null}
                caveat={view.rotationCaveat}
              />
              <MapProvenance digests={view.mapDigests} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── TAB 3 · CAP BANDS — AMFI's ladder (U2 / AQ8), Emerge named, the index lens beside it ── */}
        <TabsContent value="cap" className="space-y-4 pt-4">
          <Card data-testid="atlas-cap-bands">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Cap-band ladder (AMFI)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-xs">
              <p className="rounded-md border border-accent/30 bg-accent/5 p-2 text-muted-foreground">{view.capBands.classificationNote}</p>
              {groups.cap.length === 0 ? (
                <p className="text-muted-foreground">{view.capBands.reason || "No band carries a priced member in this view."}</p>
              ) : (
                <CapLadder rows={groups.cap} labelOf={labelOf} />
              )}
              <p className="text-muted-foreground">
                <span className="text-foreground">NSE Emerge</span>: SME — not ranked by AMFI, so it enters no band figure.{" "}
                {view.capBands.unclassifiedNote || `${fmtCount(groups.unclassified.cap)} symbols carry no AMFI band and are counted nowhere.`}
              </p>
            </CardContent>
          </Card>
          <BandCard
            title="Index membership (Nifty size indices)"
            band="Index"
            view={view.indexBands}
            testId="atlas-index-bands"
            note={filtered ? "This lens reads the whole stored universe and is not restricted by the index filter." : null}
          />
        </TabsContent>

        {/* ── TAB 4 · MY NAMES — the cohort table and the trades join (Q51, AQ21, AQ52) ── */}
        <TabsContent value="mine" className="space-y-4 pt-4">
          <Card data-testid="atlas-my-names">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">My names — stock pick, or cohort ride?</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-xs">
              {filtered ? (
                <p className="text-muted-foreground">Your positions are compared against the whole stored universe; the index filter does not apply here.</p>
              ) : null}
              <CohortTable myNames={view.myNames} />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-xs">
              <EntryDayBreadthCard view={view.entryDayBreadth} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── TAB 5 · COVERAGE — the ledger, the missing sessions, the backfill, the honesty list ── */}
        <TabsContent value="coverage" className="space-y-4 pt-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Coverage &amp; staleness ledger</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-xs">
              <div className="tabular-nums text-muted-foreground">
                as_of {ledger.as_of} · anchor {ledger.anchor.date} ({ledger.anchor.policy}) ·{" "}
                {fmtCount(ledger.anchor.coverage)} of {fmtCount(ledger.anchor.total)} valid ·{" "}
                {fmtCount(ledger.excluded_total)} excluded · spec {ledger.spec_version} · input_checksum{" "}
                {ledger.input_checksum}
              </div>
              <p className="tabular-nums text-muted-foreground" data-testid="atlas-catchup-line">
                {view.catchup.line}
                {view.catchup.automatic
                  ? ` With auto-MTM on, each app open also fetches up to ${view.catchup.perOpen} missing past sessions, ${view.catchup.rateLimitMs / 1000} s apart.`
                  : " Auto-MTM is off, so nothing is fetched on open; the backfill button below is the only download."}
              </p>

              <div>
                <div className="mb-1 font-medium text-foreground">Exclusions, by reason</div>
                {ledger.exclusions.length === 0 ? (
                  <p className="text-muted-foreground">Nothing was excluded.</p>
                ) : (
                  <ul className="space-y-0.5 tabular-nums text-muted-foreground">
                    {ledger.exclusions.map((e) => (
                      <li key={e.reason}>
                        {e.reason.replace(/_/g, " ")}: {fmtCount(e.count)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <div className="mb-1 font-medium text-foreground">Per-metric denominator</div>
                <ul className="space-y-0.5 tabular-nums text-muted-foreground">
                  {ledger.denominators.map((d) => (
                    <li key={d.metric}>
                      {d.metric}: {fmtCount(d.denominator)} symbols · {ppmToPct(d.coverage_ppm, 1)} coverage ·{" "}
                      {fmtCount(d.insufficient_history)} short of history
                    </li>
                  ))}
                </ul>
              </div>

              {ledger.shortfalls.length > 0 ? (
                <div>
                  <div className="mb-1 font-medium text-foreground">Depth shortfalls</div>
                  <ul className="space-y-0.5 text-muted-foreground">
                    {ledger.shortfalls.map((s) => (
                      <li key={s.metric}>
                        {s.metric}: {s.line}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <MapProvenance digests={view.mapDigests} />
            </CardContent>
          </Card>

          <BackfillPanel
            initialProgress={view.backfill}
            consented={view.backfillConsented}
            defaultDays={view.backfillDefaultDays}
            rateLimitMs={view.backfillRateLimitMs}
            catchup={view.catchup}
          />

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">What Atlas does not compute, and why</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-xs">
              <p className="text-muted-foreground">
                Atlas reads one end-of-day close and one daily volume per symbol from the bhavcopy. The families below
                need an input it does not have, or are deliberately not computed here. A greyed family is stated, never
                approximated.
              </p>
              <NotComputedList families={view.notComputed} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <AtlasFooter view={view} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 1 cards
// ---------------------------------------------------------------------------

/** The `unknown` reasons in words (AQ13 / A9) — the label never hides why it declined to vote. */
export function regimeReasonLine(r: RegimeResult, floorPpm: number): string | null {
  if (r.regime !== "unknown") return null;
  switch (r.reason) {
    case "missing_sma50":
      return "Unknown: the above-SMA50 input has no value yet, so the rule cannot run.";
    case "missing_net_high_low":
      return "Unknown: the net high−low input has no value yet, so the rule cannot run.";
    case "coverage_below_floor": {
      const parts = (r.belowFloor ?? []).map(
        (b) => `${b.input === "aboveSma50" ? "above-SMA50" : "net high−low"} covers ${ppmToPct(b.coverage_ppm, 0)} of the universe`,
      );
      return `Unknown: ${parts.length > 0 ? parts.join(" and ") : "an input"} — below the ${ppmToPct(r.coverageFloorPpm ?? floorPpm, 0)} coverage floor, so the label does not vote on it.`;
    }
    default:
      return "Unknown: an input is missing.";
  }
}

function RegimeCard({
  regime,
  pulse,
  setting,
  shortfallFor,
}: {
  regime: RegimeResult;
  pulse: AtlasPayload["market_pulse"];
  setting: AtlasView["regimeThresholds"];
  shortfallFor: (metric: string) => string | null;
}) {
  const t = regime.thresholds;
  const reason = regimeReasonLine(regime, setting.coverageFloorPpm);
  return (
    <Card data-testid="atlas-regime">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Regime — {regime.regime}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        {reason ? <p className="text-foreground">{reason}</p> : null}
        <p className="text-muted-foreground">{regime.formula}</p>
        {/* The thresholds, printed (AQ13): a named state whose rule is not on
            the screen would be a hidden figure, which this feature refuses to
            be. They are a SETTING now — edited under Settings → Preferences,
            re-read on every view, never recomputed into the stored rows. */}
        <p className="tabular-nums text-muted-foreground" data-testid="atlas-regime-thresholds">
          Thresholds {setting.isDefault ? "(the shipped defaults)" : "(edited in Settings)"}: expansion needs above-SMA50 ≥{" "}
          {ppmToPct(t.expansionAboveSma50Ppm, 0)} AND net high−low &gt; {fmtCount(t.expansionNetHighLow)}; contraction needs
          above-SMA50 ≤ {ppmToPct(t.contractionAboveSma50Ppm, 0)} OR net high−low &lt; {fmtCount(t.contractionNetHighLow)}.
          Anything else with both inputs present is neutral; a missing or under-covered input is unknown, never a guess.
          Change them under Settings → Preferences.
        </p>
        <p className="tabular-nums text-muted-foreground">
          Yours today: above-SMA50 {ppmToPct(regime.inputs.aboveSma50Ppm, 1)}, net high−low {fmtCount(regime.inputs.netHighLow)};
          advancing {ppmToPct(pulse.breadth.advancing.value_ppm, 1)} (shown, does not vote).
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          <MetricTile
            label="Above SMA50 · votes"
            valuePpm={regime.inputs.aboveSma50Ppm}
            numerator={pulse.moving_average_breadth[50]?.metric.numerator}
            denominator={pulse.moving_average_breadth[50]?.metric.denominator}
            coveragePpm={pulse.moving_average_breadth[50]?.metric.coverage_ppm}
            shortfall={shortfallFor("above_sma50_pct_ppm")}
            formula="Close strictly above the mean of the last 50 closes, over the symbols with 50 closes."
          />
          <MetricTile
            label="Net new high − new low · votes"
            value={regime.inputs.netHighLow}
            denominator={pulse.new_high_low.netHighLow.denominator}
            coveragePpm={pulse.new_high_low.netHighLow.coverage_ppm}
            shortfall={shortfallFor("new_high_pct_ppm")}
            formula={`New ${pulse.new_high_low.label} highs minus new ${pulse.new_high_low.label} lows, over the same denominator. A count, not a ratio.`}
          />
          <MetricTile
            label="Advancing · does not vote"
            valuePpm={pulse.breadth.advancing.value_ppm}
            numerator={pulse.breadth.counts.advancing}
            denominator={pulse.breadth.advancing.denominator}
            coveragePpm={pulse.breadth.advancing.coverage_ppm}
            formula="Today's close above yesterday's, over the symbols with two closes. Shown beside the rule (AQ14); it is not one of its inputs."
          />
        </div>
        <p className="text-muted-foreground">
          It is a NAME for two published numbers, not a forecast and not a signal. Both numbers are on this card with
          their denominators; if you disagree with the thresholds, change them — the numbers are still yours to read.
        </p>
      </CardContent>
    </Card>
  );
}

/** One sentence over the cohort rows — counts only, descriptive (AQ47). */
export function myNamesHeadline(m: AtlasView["myNames"]): string {
  if (!m.enabled || m.cohorts.length === 0) return m.reason;
  let above = 0;
  let below = 0;
  let flat = 0;
  let none = 0;
  for (const c of m.cohorts) {
    const d = c.windows["1m"]?.diff ?? null;
    if (d === null) none++;
    else if (d > 0) above++;
    else if (d < 0) below++;
    else flat++;
  }
  const parts = [
    `${m.cohorts.length} open equity name${m.cohorts.length === 1 ? "" : "s"}`,
    `${above} above its cohort's 1m median`,
    `${below} below`,
  ];
  if (flat > 0) parts.push(`${flat} level with it`);
  if (none > 0) parts.push(`${none} not comparable (thin cohort, price gap or no depth)`);
  return `${parts.join(" · ")}.`;
}

function RsLeaders({ rows, minRank, rs }: { rows: GroupTableRow[]; minRank: number; rs: AtlasPayload["relative_strength"] | null }) {
  const rankable = rows.filter((r) => r.rankable && r.rs.value_ppm !== null).sort((a, b) => b.rs.value_ppm! - a.rs.value_ppm!);
  const hidden = rows.length - rankable.length;
  if (rows.length === 0) return <p className="text-muted-foreground">No sector carries a priced member in this view.</p>;
  if (rankable.length === 0) {
    return (
      <p className="text-muted-foreground">
        No sector has {minRank} priced members yet, so none is ranked ({hidden} hidden).
        {rs ? ` RS over ${fmtCount(rs.eligible)} eligible of ${fmtCount(rs.priced)} priced.` : ""}
      </p>
    );
  }
  const leaders = rankable.slice(0, 3);
  const laggards = rankable.length > 3 ? rankable.slice(-3).reverse() : [];
  return (
    <div className="space-y-1 tabular-nums text-muted-foreground">
      <div>
        <span className="text-foreground">Leaders:</span>{" "}
        {leaders.map((r) => `${r.group} ${signedPct(r.rs.value_ppm)}`).join(" · ")}
      </div>
      {laggards.length > 0 ? (
        <div>
          <span className="text-foreground">Laggards:</span>{" "}
          {laggards.map((r) => `${r.group} ${signedPct(r.rs.value_ppm)}`).join(" · ")}
        </div>
      ) : null}
      <div>
        Median of members&rsquo; relative strength against the market median.{" "}
        {hidden > 0 ? `${hidden} sector${hidden === 1 ? "" : "s"} hidden (fewer than ${minRank} priced members). ` : ""}
        {rs ? `RS over ${fmtCount(rs.eligible)} eligible of ${fmtCount(rs.priced)} priced.` : ""}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 3 — the ladder
// ---------------------------------------------------------------------------

function CapLadder({ rows, labelOf }: { rows: GroupTableRow[]; labelOf: (band: string) => string }) {
  const order = ["large", "mid", "small"];
  const sorted = [...rows].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  const cell = (m: { value_ppm: number | null; reason?: string } | undefined, digits = 0) => (
    <td className="py-1 pr-3" title={m?.reason ? m.reason.replace(/_/g, " ") : undefined}>
      {ppmToPct(m?.value_ppm ?? null, digits)}
    </td>
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left tabular-nums" data-testid="atlas-cap-ladder">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1 pr-3 font-medium">Band</th>
            <th className="py-1 pr-3 font-medium">Priced</th>
            <th className="py-1 pr-3 font-medium">Advancing</th>
            <th className="py-1 pr-3 font-medium">1w</th>
            <th className="py-1 pr-3 font-medium">1m</th>
            <th className="py-1 pr-3 font-medium">3m</th>
            <th className="py-1 pr-3 font-medium">%&gt;SMA20</th>
            <th className="py-1 pr-3 font-medium">%&gt;SMA50</th>
            <th className="py-1 pr-3 font-medium">%&gt;SMA200</th>
            <th className="py-1 pr-3 font-medium">RSI extremes</th>
            <th className="py-1 pr-3 font-medium">NH / NL</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.group} className="border-t border-border/60" data-band={r.group}>
              <td className="py-1 pr-3 text-foreground">{labelOf(r.group)}</td>
              <td className="py-1 pr-3 text-muted-foreground">
                {fmtCount(r.priced)} of {fmtCount(r.members)}
              </td>
              {cell(r.breadth.advancing)}
              <td className="py-1 pr-3">{signedPct(r.returns["1w"]?.median.value_ppm ?? null)}</td>
              <td className="py-1 pr-3">{signedPct(r.returns["1m"]?.median.value_ppm ?? null)}</td>
              <td className="py-1 pr-3">{signedPct(r.returns["3m"]?.median.value_ppm ?? null)}</td>
              {cell(r.aboveSma[20])}
              {cell(r.aboveSma[50])}
              {cell(r.aboveSma[200])}
              <td className="py-1 pr-3" title={`RSI${r.rsiThresholds.period}: at or below ${r.rsiThresholds.low} / at or above ${r.rsiThresholds.high}, over ${fmtCount(r.rsiLow.denominator)} with an RSI`}>
                {fmtCount(r.rsiLow.value)} ≤{r.rsiThresholds.low} · {fmtCount(r.rsiHigh.value)} ≥{r.rsiThresholds.high}
              </td>
              <td className="py-1 pr-3" title={r.highLowLabel ? `new ${r.highLowLabel} highs / lows over ${fmtCount(r.newHighs.denominator)} with a window` : undefined}>
                {r.newHighs.denominator > 0 ? `${fmtCount(r.newHighs.numerator)} / ${fmtCount(r.newLows.numerator)}` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-muted-foreground">
        Rotation columns are the median of each priced member&rsquo;s own return; advancing and the %&gt;SMA columns are
        shares of the band&rsquo;s measurable members; RSI extremes and NH / NL are counts over the members with the
        history each needs. A name held out for an unreconciled price gap is counted in none of them.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/**
 * Q52 — WHICH copy of the classification maps produced the groupings above.
 *
 * The maps are refreshed by hand, once per minor release, so the as-of date
 * alone cannot tell two builds of the same dated snapshot apart. The digest
 * can: twelve hex on screen is enough to compare two machines at a glance, and
 * the full 64 sits in the title attribute for anyone who wants to check it
 * against the file. The strings arrive already computed — `lib/queries/atlas.ts`
 * hashes them server-side over the map's CANONICAL JSON as the app loaded it,
 * never over the file on disk, whose bytes carry the source formatting.
 */
function MapProvenance({ digests }: { digests: AtlasView["mapDigests"] }) {
  if (digests.length === 0) return null;
  return (
    <p className="tabular-nums text-muted-foreground">
      {digests.map((d, i) => (
        <span
          key={d.file}
          title={`${d.file} · sha256 ${d.sha256} — of the map's canonical JSON, as the app loaded it, not of the file on disk`}
        >
          {i > 0 ? " · " : ""}
          {d.label} sha256 {d.sha256.slice(0, 12)} · as of {d.asOf ?? "—"}
        </span>
      ))}
    </p>
  );
}

/** The Nifty size-index lens (Q47): same shape as a band table, different meaning, never labelled a cap band. */
function BandCard({
  title,
  band,
  view: v,
  testId,
  note,
}: {
  title: string;
  band: string;
  view: AtlasView["indexBands"];
  testId: string;
  note: string | null;
}) {
  return (
    <Card data-testid={testId}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {note ? <p className="text-muted-foreground">{note}</p> : null}
        {v.available ? (
          <>
            <p className="rounded-md border border-accent/30 bg-accent/5 p-2 text-muted-foreground">{v.classificationNote}</p>
            <table className="w-full text-left tabular-nums">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">{band}</th>
                  <th className="py-1 pr-3 font-medium">Advancing</th>
                  <th className="py-1 pr-3 font-medium">Members</th>
                  <th className="py-1 pr-3 font-medium">Measured</th>
                </tr>
              </thead>
              <tbody>
                {v.rows.map((r) => (
                  <tr key={r.band} className="border-t border-border/60">
                    <td className="py-1 pr-3 text-foreground">{r.label}</td>
                    <td className="py-1 pr-3">{ppmToPct(r.advancePpm, 1)}</td>
                    <td className="py-1 pr-3">{fmtCount(r.members)}</td>
                    <td className="py-1 pr-3 text-muted-foreground">
                      {fmtCount(r.advancing)} of {fmtCount(r.denominator)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-muted-foreground">{v.unclassifiedNote}</p>
          </>
        ) : (
          <p className="text-muted-foreground">{v.reason}</p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The two lines that end every Atlas screen, including the empty one: where
 * the numbers came from, and what the screen is not — breadth and rotation are
 * exactly the figures a recommendation would be built on, so the page that
 * prints them states, on the page, that it is not making one.
 */
function AtlasFooter({ view }: { view: AtlasView }) {
  return (
    <p className="px-1 pb-2 text-[0.6875rem] leading-relaxed text-muted-foreground">
      {view.provenanceLine} {view.notAdviceLine}
    </p>
  );
}
