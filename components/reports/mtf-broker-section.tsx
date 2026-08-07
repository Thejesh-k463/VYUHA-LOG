import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BROKER_LABELS } from "@/lib/domain/constants";
import type { MtfComparison } from "@/lib/analytics/mtf-compare";

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
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-2.5 py-2 text-[0.6875rem] font-semibold uppercase tracking-[0.06em]">Broker</th>
                <th className="px-2 py-2 text-right text-[0.6875rem] font-semibold uppercase tracking-[0.06em]">Approved scrips</th>
                <th className="px-2 py-2 text-right text-[0.6875rem] font-semibold uppercase tracking-[0.06em]">Actually funded</th>
                <th className="px-2 py-2 text-right text-[0.6875rem] font-semibold uppercase tracking-[0.06em]">Median margin</th>
                <th className="px-2 py-2 text-right text-[0.6875rem] font-semibold uppercase tracking-[0.06em]">Best leverage</th>
              </tr>
            </thead>
            <tbody>
              {mtfBrokers.map((b) => (
                <tr key={b.broker} className="border-b border-rule">
                  <td className="px-2.5 py-1.5 font-medium">{label(b.broker)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{b.approved.toLocaleString("en-IN")}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {b.funded.toLocaleString("en-IN")}
                    {b.funded < b.approved && (
                      <span className="ml-1 text-[10px] text-warning" title="Approved for MTF but currently funded at ₹0 — full cash in practice.">
                        ({(b.approved - b.funded).toLocaleString("en-IN")} unfunded)
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{b.medianMarginPct != null ? `${b.medianMarginPct}%` : "—"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{b.bestLeverage != null ? `${b.bestLeverage}x` : "—"}</td>
                </tr>
              ))}
              {noMtf.map((b) => (
                <tr key={b.broker} className="border-b border-rule text-muted-foreground">
                  <td className="px-2.5 py-1.5 font-medium">{label(b.broker)}</td>
                  <td className="px-2 py-1.5 text-center" colSpan={4}>
                    does not provide MTF delivery — cash only
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ── Your symbols, priced across every list ────────────────────── */}
        {shown.length > 0 && (
          <>
            <p className="text-xs text-muted-foreground">
              The delivery/MTF symbols in <b>your journal</b>, margin-priced on every broker&apos;s current list —
              lowest own-margin highlighted. {cmp.yourBookTotal > shown.length && `Showing ${shown.length} of ${cmp.yourBookTotal}.`}
            </p>
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-2.5 py-2 text-[0.6875rem] font-semibold uppercase tracking-[0.06em]">Symbol</th>
                    {mtfBrokers.map((b) => (
                      <th key={b.broker} className="px-2 py-2 text-right text-[0.6875rem] font-semibold uppercase tracking-[0.06em]">{label(b.broker)}</th>
                    ))}
                    <th className="px-2.5 py-2 text-[0.6875rem] font-semibold uppercase tracking-[0.06em]">Best</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.symbol} className="border-b border-rule">
                      <td className="px-2.5 py-1.5 font-medium">{r.symbol}</td>
                      {mtfBrokers.map((b) => {
                        const m = r.margins[b.broker];
                        const isBest = r.bestBroker === b.broker;
                        return (
                          <td key={b.broker} className={`px-2 py-1.5 text-right tabular-nums ${isBest ? "font-semibold text-profit" : m == null ? "text-muted-foreground/50" : ""}`}>
                            {m != null ? `${m}%` : "—"}
                          </td>
                        );
                      })}
                      <td className="px-2.5 py-1.5">
                        {r.bestBroker
                          ? <span className="text-profit">{label(r.bestBroker)} @ {r.bestMarginPct}%</span>
                          : <span className="text-muted-foreground">no broker funds this</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <p className="text-[11px] text-muted-foreground">
          Margin is the ONLY axis here — the lowest own-margin is the most leverage, not the lowest cost. Interest
          rates, plan fees and DP charges differ per broker and are priced in the cost comparison above. &ldquo;—&rdquo;
          means the broker doesn&apos;t fund that scrip today; lists move with exchange VAR revisions, so refresh via the
          MTF toolkit when the as-of date ages.
        </p>
      </CardContent>
    </Card>
  );
}
