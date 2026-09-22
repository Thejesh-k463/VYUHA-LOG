import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { InstrumentManager } from "@/components/system/instrument-manager";
import { ResultsDateEditor } from "@/components/instruments/results-date-editor";
import { getInstruments } from "@/lib/queries/instruments";
import { getPriceHistoryMeta } from "@/lib/queries/price-history";
import nseIndexMap from "@/lib/data/nse-index-map.json";
import { ETF_LIST_AS_OF, ETF_LIST_COUNT, ETF_LIST_SHA256 } from "@/lib/engine/etf-class";
import { EmptyState } from "@/components/ui/empty-state";

export const dynamic = "force-dynamic";

export default function InstrumentsPage() {
  const rows = getInstruments();
  const withSector = rows.filter((r) => r.sector).length;
  const ph = getPriceHistoryMeta();

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
