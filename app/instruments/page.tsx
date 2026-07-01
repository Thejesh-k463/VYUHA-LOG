import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { InstrumentManager } from "@/components/system/instrument-manager";
import { getInstruments } from "@/lib/queries/instruments";
import { getPriceHistoryMeta } from "@/lib/queries/price-history";

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
            <InstrumentManager rows={rows} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Price history (EOD)</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {ph.rows > 0 ? (
              <p>
                {ph.rows.toLocaleString("en-IN")} OHLC bars across {ph.symbols.toLocaleString("en-IN")} symbols
                {ph.lastDate ? `, latest ${ph.lastDate}` : ""}. Built automatically from each bhavcopy you import on{" "}
                <span className="text-foreground">Portfolio Risk → Auto-MTM from bhavcopy</span>.
              </p>
            ) : (
              <p>
                No price history yet. Import an NSE/BSE bhavcopy on <span className="text-foreground">Portfolio Risk → Auto-MTM
                from bhavcopy</span> — each import saves the day&apos;s OHLC here, building the series for performance, benchmarking
                and (later) VaR.
              </p>
            )}
          </CardContent>
        </Card>

        <p className="text-[11px] text-muted-foreground">
          Sector tags drive the <strong>sector concentration</strong> panel on Portfolio Risk — they reveal a concentrated
          sector bet that the per-symbol allocation can hide (e.g. several small bank positions = one large Financials
          exposure). Offline-first: paste your own list; nothing leaves the device.
        </p>
      </div>
    </>
  );
}
