import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BROKER_LABELS } from "@/lib/domain/constants";
import type { MtfComparison } from "@/lib/analytics/mtf-compare";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";

const label = (b: string) => BROKER_LABELS[b as never] ?? b;

/**
 * MTF across every integrated broker — per-broker funding reality first
 * (approved vs actually funded is the honest gap), then the trader's own
 * symbols priced across all seven lists. Margin is the only axis in the
 * second table; the cost comparison above this section owns interest, plan
 * fees and DP — the footer says so rather than letting "best margin" read
 * as "cheapest broker".
 */
export function MtfBrokerSection({ cmp }: { cmp: MtfComparison }) {
  const mtfBrokers = cmp.brokers.filter((b) => b.coverage !== "no-mtf");
  const noMtf = cmp.brokers.filter((b) => b.coverage === "no-mtf");
  const shown = cmp.yourBook.slice(0, 40);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          MTF across your brokers
          <Badge variant="secondary">lists as of {cmp.asOf}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ── Per-broker funding reality ────────────────────────────────── */}
        <ReportTable>
          <ReportThead>
            <ReportTh>Broker</ReportTh>
            <ReportTh align="right">Approved scrips</ReportTh>
            <ReportTh align="right">Actually funded</ReportTh>
            <ReportTh align="right">Median margin</ReportTh>
            <ReportTh align="right">Best leverage</ReportTh>
          </ReportThead>
          <tbody>
            {mtfBrokers.map((b) => (
              <ReportTr key={b.broker}>
                <ReportTd className="font-medium">{label(b.broker)}</ReportTd>
                <ReportTd align="right">{b.approved.toLocaleString("en-IN")}</ReportTd>
                <ReportTd align="right">
                  {b.funded.toLocaleString("en-IN")}
                  {b.funded < b.approved && (
                    <span className="ml-1 text-[10px] text-warning" title="Approved for MTF but currently funded at ₹0 — full cash in practice.">
                      ({(b.approved - b.funded).toLocaleString("en-IN")} unfunded)
                    </span>
                  )}
                </ReportTd>
                <ReportTd align="right">{b.medianMarginPct != null ? `${b.medianMarginPct}%` : "—"}</ReportTd>
                <ReportTd align="right">{b.bestLeverage != null ? `${b.bestLeverage}x` : "—"}</ReportTd>
              </ReportTr>
            ))}
            {noMtf.map((b) => (
              <ReportTr key={b.broker} className="text-muted-foreground">
                <ReportTd className="font-medium">{label(b.broker)}</ReportTd>
                <ReportTd className="text-center" colSpan={4}>
                  does not provide MTF delivery — cash only
                </ReportTd>
              </ReportTr>
            ))}
          </tbody>
        </ReportTable>

        {/* ── Your symbols, priced across every list ────────────────────── */}
        {shown.length > 0 && (
          <>
            <p className="text-xs text-muted-foreground">
              The delivery/MTF symbols in <b>your journal</b>, margin-priced on every broker&apos;s current list —
              lowest own-margin highlighted. {cmp.yourBookTotal > shown.length && `Showing ${shown.length} of ${cmp.yourBookTotal}.`}
            </p>
            <ReportTable>
              <ReportThead>
                <ReportTh>Symbol</ReportTh>
                {mtfBrokers.map((b) => (
                  <ReportTh key={b.broker} align="right">{label(b.broker)}</ReportTh>
                ))}
                <ReportTh>Best</ReportTh>
              </ReportThead>
              <tbody>
                {shown.map((r) => (
                  <ReportTr key={r.symbol}>
                    <ReportTd className="font-medium">{r.symbol}</ReportTd>
                    {mtfBrokers.map((b) => {
                      const m = r.margins[b.broker];
                      const isBest = r.bestBroker === b.broker;
                      return (
                        <ReportTd key={b.broker} align="right" className={isBest ? "font-semibold text-profit" : m == null ? "text-muted-foreground/50" : ""}>
                          {m != null ? `${m}%` : "—"}
                        </ReportTd>
                      );
                    })}
                    <ReportTd>
                      {r.bestBroker
                        ? <span className="text-profit">{label(r.bestBroker)} @ {r.bestMarginPct}%</span>
                        : <span className="text-muted-foreground">no broker funds this</span>}
                    </ReportTd>
                  </ReportTr>
                ))}
              </tbody>
            </ReportTable>
          </>
        )}

        <p className="text-[0.6875rem] text-muted-foreground">
          Margin is the ONLY axis here — the lowest own-margin is the most leverage, not the lowest cost. Interest
          rates, plan fees and DP charges differ per broker and are priced in the cost comparison above. &ldquo;—&rdquo;
          means the broker doesn&apos;t fund that scrip today; lists move with exchange VAR revisions, so refresh via the
          MTF toolkit when the as-of date ages.
        </p>
      </CardContent>
    </Card>
  );
}
