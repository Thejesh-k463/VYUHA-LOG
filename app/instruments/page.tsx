import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { InstrumentManager } from "@/components/system/instrument-manager";
import { ResultsDateEditor } from "@/components/instruments/results-date-editor";
import { getInstruments } from "@/lib/queries/instruments";
import { getPriceHistoryMeta } from "@/lib/queries/price-history";
import nseIndexMap from "@/lib/data/nse-index-map.json";
import { ETF_LIST_AS_OF, ETF_LIST_COUNT, ETF_LIST_SHA256 } from "@/lib/engine/etf-class";
import {
  CALENDAR_AS_OF,
  CALENDAR_COVERS_THROUGH,
  CALENDAR_PROVENANCE,
  CALENDAR_SOURCES_SHA256,
  CAS_MEMBER_COUNT,
} from "@/lib/domain/market-calendar";
import { EmptyState } from "@/components/ui/empty-state";
import { UNIVERSE, UNIVERSE_AS_OF } from "@/lib/analytics/stock-universe";
import { getMapDigests } from "@/lib/queries/atlas";

export const dynamic = "force-dynamic";

export default function InstrumentsPage() {
  const rows = getInstruments();
  const withSector = rows.filter((r) => r.sector).length;
  const ph = getPriceHistoryMeta();
  const calendarPrimary = CALENDAR_PROVENANCE.filter((p) => p.sourceKind === "primary").length;
  const calendarSecondary = CALENDAR_PROVENANCE.filter((p) => p.sourceKind === "secondary").length;
  // Row 10 (v4.6.0 W2): every classification snapshot says how old it is AND which copy it is. The digest is
  // the sha256 of the map's canonical JSON as the app loaded it (lib/queries/atlas.ts digestMap), the same
  // figure the Atlas prints — not of the file on disk, whose line endings differ between checkouts.
  const digests = new Map(getMapDigests().map((d) => [d.file, d]));
  const indexDigest = digests.get("lib/data/nse-index-map.json");
  const universeDigest = digests.get("lib/data/stock-universe.json");
  const u = UNIVERSE;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

  return (
    <>
      <PageHeader
        title="Instruments master"
        description="Security master — symbol, sector, lot size, ISIN. Powers sector concentration and lot-aware sizing."
        actions={<Badge variant="secondary">{rows.length} instruments · {withSector} with sector</Badge>}
      />
      <div className="space-y-5 p-6">
        <Card>
          <CardHeader>
            <CardTitle>Instruments</CardTitle>
          </CardHeader>
          <CardContent>
            <InstrumentManager rows={rows} nseMapAsOf={(nseIndexMap as { asOf: string }).asOf} />
            {/*
              Owner ruling T4 (2026-09-22): the bundled ETF list is refreshed
              MANUALLY, on the owner's machine, once per MINOR release — so the
              app must say how old it is AND which file it was built from (the
              still-open half of Q52, now discharged for this snapshot). Both
              come off the JSON itself, never a literal here.
            */}
            <p className="mt-3 text-[0.6875rem] leading-relaxed text-muted-foreground">
              Bundled <b>NSE ETF list</b>: {ETF_LIST_COUNT.toLocaleString("en-IN")} ETFs, snapshot as of{" "}
              <b>{ETF_LIST_AS_OF || "—"}</b>. It decides whether a unit is equity-oriented (STT on the sale only) or a
              gold / silver / debt / global ETF (no STT) — nothing else about a trade. Refreshed manually, once per
              minor release.{" "}
              {ETF_LIST_SHA256 ? (
                <>sha256 <span className="break-all font-mono">{ETF_LIST_SHA256}</span></>
              ) : null}
            </p>
            {/*
              v4.6.0 W1 (spec §1, rule 5): the bundled MARKET CALENDAR says how old it
              is, how far it reaches, which files it was built from and which rows
              rest on a research citation rather than a file the owner saved.
            */}
            <p className="mt-2 text-[0.6875rem] leading-relaxed text-muted-foreground" data-testid="market-calendar-provenance">
              Bundled <b>market calendar</b>: session hours, the closing auction, holidays and special sessions, as of{" "}
              <b>{CALENDAR_AS_OF || "—"}</b>, covering through <b>{CALENDAR_COVERS_THROUGH || "—"}</b> ({CAS_MEMBER_COUNT}{" "}F&amp;O
              stocks in the closing auction). Built from {calendarPrimary} exchange/SEBI file{calendarPrimary === 1 ? "" : "s"}
              {calendarSecondary > 0 ? (
                <>
                  ; {calendarSecondary} part{calendarSecondary === 1 ? "" : "s"} (
                  {CALENDAR_PROVENANCE.filter((p) => p.sourceKind === "secondary").map((p) => p.ref.split(" — ")[0]).join(", ")}) rest on a
                  cited source, not a saved file
                </>
              ) : null}
              . Refreshed manually, once per minor release.{" "}
              {CALENDAR_SOURCES_SHA256 ? (
                <>sources sha256 <span className="break-all font-mono">{CALENDAR_SOURCES_SHA256}</span></>
              ) : null}
            </p>
            {/*
              v4.6.0 W2 (rulings U1-U4, row 10): the bundled STOCK UNIVERSE and the NSE index map, each with its
              as-of and sha256. The universe paragraph is also its Data Quality report (R3 section 5): what it
              could not classify, where the exchanges disagree, and why a band is blank (U3).
            */}
            <p className="mt-2 text-[0.6875rem] leading-relaxed text-muted-foreground" data-testid="stock-universe-provenance">
              Bundled <b>stock universe</b>:{" "}
              {u ? (
                <>
                  {u.dq.classified.toLocaleString("en-IN")} of {u.dq.equity.toLocaleString("en-IN")} listed equities
                  ({pct(u.dq.coverage)}) carry the exchanges&apos; own industry classification (NSE Indices structure,
                  July 2023), as of <b>{UNIVERSE_AS_OF || "—"}</b>
                  {u.dq.disagreements > 0 ? <>; NSE and BSE disagree on {u.dq.disagreements}, and NSE&apos;s label is used</> : null}.
                  Cap band = AMFI&apos;s half-yearly list for the period ended <b>{u.cap.periodEnd ?? "—"}</b> (large{" "}
                  {u.dq.bands.large}, mid {u.dq.bands.mid}, small {u.dq.bands.small.toLocaleString("en-IN")}); no band for{" "}
                  {Object.entries(u.dq.capUnmatched)
                    .map(([reason, count]) => `${count.toLocaleString("en-IN")} (${u.cap.reasons[reason] ?? reason})`)
                    .join(", ")}
                  . Your own sector tags always win. Refreshed manually, once per minor release.{" "}
                  {universeDigest ? (
                    <>sha256 <span className="break-all font-mono">{universeDigest.sha256}</span></>
                  ) : null}
                </>
              ) : (
                <>not bundled in this build — sectors come from the older sector map and the NSE index map only.</>
              )}
            </p>
            <p className="mt-2 text-[0.6875rem] leading-relaxed text-muted-foreground" data-testid="index-map-provenance">
              Bundled <b>NSE index map</b> (sectoral and thematic index membership, and the Nifty size-index lens): as of{" "}
              <b>{indexDigest?.asOf ?? "—"}</b>. Refreshed manually, once per minor release.{" "}
              {indexDigest ? (
                <>sha256 <span className="break-all font-mono">{indexDigest.sha256}</span></>
              ) : null}
            </p>
          </CardContent>
        </Card>

        {/* Q-9 / migration 0068. Its own card because the control belongs in
            the manager's table above and that file was outside this wave's
            file set — see the component header. */}
        <Card>
          <CardHeader>
            <CardTitle>Results dates</CardTitle>
          </CardHeader>
          <CardContent>
            <ResultsDateEditor rows={rows} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Price history (EOD)</CardTitle>
          </CardHeader>
          <CardContent className={ph.rows > 0 ? "text-sm text-muted-foreground" : undefined}>
            {ph.rows > 0 ? (
              <p>
                {ph.rows.toLocaleString("en-IN")} OHLC bars across {ph.symbols.toLocaleString("en-IN")} symbols
                {ph.lastDate ? `, latest ${ph.lastDate}` : ""}. Built automatically from each bhavcopy you import on{" "}
                <span className="text-foreground">Portfolio Risk → Auto-MTM from bhavcopy</span>.
              </p>
            ) : (
              <EmptyState
                variant="chart"
                title="No price history yet"
                hint={<>Import an NSE/BSE bhavcopy on <span className="text-foreground">Portfolio Risk → Auto-MTM
                  from bhavcopy</span> — each import saves the day&apos;s OHLC here, building the series for performance, benchmarking
                  and (later) VaR.</>}
              />
            )}
          </CardContent>
        </Card>

        <p className="text-[0.6875rem] text-muted-foreground">
          Sector tags drive the <strong>sector concentration</strong> panel on Portfolio Risk — they reveal a concentrated
          sector bet that the per-symbol allocation can hide (e.g. several small bank positions = one large Financials
          exposure). Paste your own list — the desktop app fetches nothing to build it.
        </p>
      </div>
    </>
  );
}
