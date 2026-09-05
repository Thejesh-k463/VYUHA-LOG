"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MetricTile, ppmToPct } from "./metric-tile";
import { Sparkline } from "./sparkline";
import { BackfillPanel } from "./backfill-panel";
import type { AtlasView } from "@/lib/queries/atlas";

/**
 * The Atlas panel — five tabs, one screen (06a §3).
 *
 * WHAT THIS SHIPS AND WHAT IT DOES NOT (research answers Q42/Q42b): the
 * TRANSPARENT daily core only. Every figure here is a published definition
 * computed from the user's own stored bhavcopy bars, and every one of them
 * renders with its denominator. There is no proprietary score, no hidden
 * filter, no Chartink data and no parity claim — the owner's own widgets are a
 * separate, signed, opt-in feed and are not computed on this machine.
 *
 * The panel is a CLIENT component only because five tabs need a selected tab;
 * every number arrives already computed from the server page.
 */

const TABS = [
  { key: "market", label: "Market" },
  { key: "sectors", label: "Sectors" },
  { key: "cap", label: "Cap bands" },
  { key: "mine", label: "My names" },
  { key: "coverage", label: "Coverage" },
] as const;

const n = (x: number | null | undefined) => (x == null ? "—" : x.toLocaleString("en-IN"));

export function AtlasPanel({ view }: { view: AtlasView }) {
  const { payload, snapshot } = view;

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
          </CardContent>
        </Card>
        <BackfillPanel
          initialProgress={view.backfill}
          consented={view.backfillConsented}
          defaultDays={view.backfillDefaultDays}
          rateLimitMs={view.backfillRateLimitMs}
        />
        <AtlasFooter view={view} />
      </div>
    );
  }

  const pulse = payload.market_pulse;
  const ledger = payload.ledger;
  const history = payload.history;
  const shortfallFor = (metric: string) => ledger.shortfalls.find((s) => s.metric === metric)?.line ?? null;

  return (
    <div className="space-y-4">
      {/* HEADER — the provenance line is part of the screen, not a footnote. */}
      <Card>
        <CardContent className="space-y-1 p-4 text-xs">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-base font-semibold tracking-tight text-foreground">Market Atlas</span>
            <span className="tabular-nums text-muted-foreground">
              as of {payload.as_of} · anchor = {ledger.anchor.policy}
            </span>
          </div>
          <div className="tabular-nums text-muted-foreground">
            {n(ledger.anchor.coverage)} of {n(ledger.anchor.total)} symbols on the anchor (
            {ppmToPct(ledger.anchor.coverage_ppm, 1)}) · spec {payload.spec_version} · sha{" "}
            {payload.input_checksum.slice(0, 8)}… · computed {payload.generated_at.slice(0, 19).replace("T", " ")}
          </div>
          <div className="text-muted-foreground">{view.provenanceLine}</div>
        </CardContent>
      </Card>

      <Tabs defaultValue="market">
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* ── TAB 1 · MARKET ────────────────────────────────────────────── */}
        <TabsContent value="market" className="space-y-4 pt-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                Regime — {payload.regime.regime}
                {payload.regime.reason ? ` (${payload.regime.reason.replace(/_/g, " ")})` : ""}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              {/* The thresholds and the substituted rule, printed. A named
                  state whose rule is not on the screen is a score, and a score
                  is exactly what this feature refuses to be. The <details> is
                  shut by default and holds the RULE; the line above it holds
                  the numbers that were put through the rule today, so the card
                  is readable at a glance and auditable in one click. */}
              <p className="text-muted-foreground">{payload.regime.formula}</p>
              <details className="rounded-md border border-border bg-card/40 p-2">
                <summary className="cursor-pointer text-muted-foreground">
                  How this state is decided — the full rule
                </summary>
                <div className="mt-2 space-y-1 text-muted-foreground">
                  <p className="tabular-nums">
                    Expansion needs above-SMA50 ≥ {ppmToPct(payload.regime.thresholds.expansionAboveSma50Ppm, 0)}{" "}
                    AND net high−low &gt; {n(payload.regime.thresholds.expansionNetHighLow)}. Contraction needs
                    above-SMA50 ≤ {ppmToPct(payload.regime.thresholds.contractionAboveSma50Ppm, 0)} OR net high−low
                    &lt; {n(payload.regime.thresholds.contractionNetHighLow)}. Anything else with both inputs
                    present is Neutral; a missing input is Unknown, never a guess.
                  </p>
                  <p className="tabular-nums">
                    Yours today: above-SMA50 {ppmToPct(payload.regime.inputs.aboveSma50Ppm, 1)}, net high−low{" "}
                    {n(payload.regime.inputs.netHighLow)}.
                  </p>
                  <p>
                    It is a NAME for two published numbers, not a forecast and not a signal. Both numbers are on
                    this card with their denominators; if you disagree with the thresholds, the numbers are still
                    yours to read.
                  </p>
                </div>
              </details>
              <div className="grid gap-2 sm:grid-cols-2">
                <MetricTile
                  label="Above SMA50"
                  valuePpm={payload.regime.inputs.aboveSma50Ppm}
                  numerator={pulse.moving_average_breadth[50]?.metric.numerator}
                  denominator={pulse.moving_average_breadth[50]?.metric.denominator}
                  coveragePpm={pulse.moving_average_breadth[50]?.metric.coverage_ppm}
                  shortfall={shortfallFor("above_sma50_pct_ppm")}
                />
                <MetricTile
                  label="Net new high − new low"
                  value={payload.regime.inputs.netHighLow}
                  denominator={pulse.new_high_low.netHighLow.denominator}
                  coveragePpm={pulse.new_high_low.netHighLow.coverage_ppm}
                  shortfall={shortfallFor("new_high_pct_ppm")}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
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
              />
              <MetricTile
                label="Unchanged"
                valuePpm={pulse.breadth.unchanged.value_ppm}
                numerator={pulse.breadth.counts.unchanged}
                denominator={pulse.breadth.unchanged.denominator}
                coveragePpm={pulse.breadth.unchanged.coverage_ppm}
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
              />
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
              {view.volumeLeaders.length === 0 ? (
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

        {/* ── TAB 2 · SECTORS ───────────────────────────────────────────── */}
        <TabsContent value="sectors" className="space-y-4 pt-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                Sector rotation · {payload.rotation.window.key} ({payload.rotation.window.sessions} session
                {payload.rotation.window.sessions === 1 ? "" : "s"})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-xs">
              {/* Q49, verbatim: the sector map carries ONE clock, so a rotation
                  row is today's classification applied to today's move — it is
                  not a point-in-time history and must never read as one. */}
              <p className="rounded-md border border-accent/30 bg-accent/5 p-2 text-muted-foreground">
                {view.rotationCaveat} The sector map has a single as-of date and no per-row effective date, so
                these groupings are today&rsquo;s and are not backdated.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-left tabular-nums">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Sector</th>
                      <th className="py-1 pr-3 font-medium">Move</th>
                      <th className="py-1 pr-3 font-medium">Breadth</th>
                      <th className="py-1 pr-3 font-medium">Members</th>
                      <th className="py-1 pr-3 font-medium">Measured</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payload.rotation.sectors.map((row) => {
                      const breadth = payload.rotation.breadth.find((b) => b.group === row.group);
                      return (
                        <tr key={row.group} className="border-t border-border/60">
                          <td className="py-1 pr-3 text-foreground">{row.group}</td>
                          <td className="py-1 pr-3">{ppmToPct(row.metric.value_ppm, 2)}</td>
                          <td className="py-1 pr-3">{ppmToPct(breadth?.advancing.value_ppm ?? null, 0)}</td>
                          <td className="py-1 pr-3">{n(row.members)}</td>
                          <td className="py-1 pr-3 text-muted-foreground">
                            {n(row.constituents)} of {n(row.members)}
                            {row.corporateActionExcluded.length > 0
                              ? ` · ${row.corporateActionExcluded.length} held out (price gap)`
                              : ""}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-muted-foreground">
                {n(payload.classification.groups)} groups · classification coverage{" "}
                {ppmToPct(payload.classification.classified.value_ppm, 1)} (
                {n(payload.classification.classified.numerator)} of {n(payload.classification.classified.denominator)}
                ) · {n(payload.classification.unclassified.length)} symbols carry no sector and are counted
                nowhere rather than dropped into &ldquo;Other&rdquo;.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── TAB 3 · CAP BANDS ─────────────────────────────────────────── */}
        <TabsContent value="cap" className="space-y-4 pt-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Cap bands</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-xs">
              {view.capBands.available ? (
                <>
                  {/* Q49/Q50: the band is today's membership, and the screen
                      says so above the table rather than in a tooltip. */}
                  <p className="rounded-md border border-accent/30 bg-accent/5 p-2 text-muted-foreground">
                    {view.capBands.classificationNote}
                  </p>
                  <table className="w-full text-left tabular-nums">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="py-1 pr-3 font-medium">Band</th>
                        <th className="py-1 pr-3 font-medium">Advancing</th>
                        <th className="py-1 pr-3 font-medium">Members</th>
                        <th className="py-1 pr-3 font-medium">Measured</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.capBands.rows.map((r) => (
                        <tr key={r.band} className="border-t border-border/60">
                          <td className="py-1 pr-3 text-foreground">{r.label}</td>
                          <td className="py-1 pr-3">{ppmToPct(r.advancePpm, 1)}</td>
                          <td className="py-1 pr-3">{n(r.members)}</td>
                          <td className="py-1 pr-3 text-muted-foreground">
                            {n(r.advancing)} of {n(r.denominator)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="text-muted-foreground">
                    {n(view.capBands.unclassified)} symbols in the stored universe sit in none of the four size
                    indices and are counted nowhere rather than pushed into the nearest band.
                  </p>
                </>
              ) : (
                <p className="text-muted-foreground">{view.capBands.reason}</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── TAB 4 · MY NAMES ──────────────────────────────────────────── */}
        <TabsContent value="mine" className="space-y-4 pt-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">My names — stock pick, or sector ride?</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-xs">
              {!view.myNames.enabled ? (
                <p className="text-muted-foreground">{view.myNames.reason}</p>
              ) : view.myNames.rows.length === 0 ? (
                <p className="text-muted-foreground">{view.myNames.reason}</p>
              ) : (
                <>
                  <p className="text-muted-foreground">
                    Each open equity position against the equal-weighted return of its own sector cohort over the
                    same window. The difference is the part the sector did not explain — not a claim about why.
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left tabular-nums">
                      <thead className="text-muted-foreground">
                        <tr>
                          <th className="py-1 pr-3 font-medium">Symbol</th>
                          <th className="py-1 pr-3 font-medium">Sector</th>
                          <th className="py-1 pr-3 font-medium">1w</th>
                          <th className="py-1 pr-3 font-medium">Cohort 1w</th>
                          <th className="py-1 pr-3 font-medium">Diff</th>
                          <th className="py-1 pr-3 font-medium">1m</th>
                          <th className="py-1 pr-3 font-medium">Cohort 1m</th>
                          <th className="py-1 pr-3 font-medium">Diff</th>
                          <th className="py-1 pr-3 font-medium">Cohort</th>
                        </tr>
                      </thead>
                      <tbody>
                        {view.myNames.rows.map((r) => (
                          <tr key={r.symbol} className="border-t border-border/60">
                            <td className="py-1 pr-3 text-foreground">{r.symbol}</td>
                            <td className="py-1 pr-3 text-muted-foreground">{r.sector ?? "unclassified"}</td>
                            <td className="py-1 pr-3">{ppmToPct(r.stock1wPpm, 2)}</td>
                            <td className="py-1 pr-3">{ppmToPct(r.cohort1wPpm, 2)}</td>
                            <td className="py-1 pr-3">{ppmToPct(r.diff1wPpm, 2)}</td>
                            <td className="py-1 pr-3">{ppmToPct(r.stock1mPpm, 2)}</td>
                            <td className="py-1 pr-3">{ppmToPct(r.cohort1mPpm, 2)}</td>
                            <td className="py-1 pr-3">{ppmToPct(r.diff1mPpm, 2)}</td>
                            <td className="py-1 pr-3 text-muted-foreground">{n(r.cohortSize)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── TAB 5 · COVERAGE ──────────────────────────────────────────── */}
        <TabsContent value="coverage" className="space-y-4 pt-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Coverage &amp; staleness ledger</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-xs">
              <div className="tabular-nums text-muted-foreground">
                as_of {ledger.as_of} · anchor {ledger.anchor.date} ({ledger.anchor.policy}) ·{" "}
                {n(ledger.anchor.coverage)} of {n(ledger.anchor.total)} valid ·{" "}
                {n(ledger.excluded_total)} excluded · spec {ledger.spec_version} · input_checksum{" "}
                {ledger.input_checksum}
              </div>

              <div>
                <div className="mb-1 font-medium text-foreground">Exclusions, by reason</div>
                {ledger.exclusions.length === 0 ? (
                  <p className="text-muted-foreground">Nothing was excluded.</p>
                ) : (
                  <ul className="space-y-0.5 tabular-nums text-muted-foreground">
                    {ledger.exclusions.map((e) => (
                      <li key={e.reason}>
                        {e.reason.replace(/_/g, " ")}: {n(e.count)}
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
                      {d.metric}: {n(d.denominator)} symbols · {ppmToPct(d.coverage_ppm, 1)} coverage ·{" "}
                      {n(d.insufficient_history)} short of history
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
            </CardContent>
          </Card>

          <BackfillPanel
            initialProgress={view.backfill}
            consented={view.backfillConsented}
            defaultDays={view.backfillDefaultDays}
            rateLimitMs={view.backfillRateLimitMs}
          />
        </TabsContent>
      </Tabs>

      <AtlasFooter view={view} />
    </div>
  );
}

/**
 * The two lines that end every Atlas screen, including the empty one.
 *
 * The first says where the numbers came from — the question a user of a market
 * panel asks first, and the one a scraped feed could not answer. The second
 * says what the screen is not: breadth and rotation are exactly the figures a
 * recommendation would be built on, so the page that prints them states, on
 * the page, that it is not making one.
 */
function AtlasFooter({ view }: { view: AtlasView }) {
  return (
    <p className="px-1 pb-2 text-[0.6875rem] leading-relaxed text-muted-foreground">
      {view.provenanceLine} {view.notAdviceLine}
    </p>
  );
}
