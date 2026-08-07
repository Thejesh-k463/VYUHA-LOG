import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { inr } from "@/lib/format";
import type { MtfDriftRow } from "@/lib/risk/mtf-drift";

/**
 * Startup MTF checks, rendered wherever the margin story lives:
 *  - snapshot staleness (margins move with exchange VAR revisions)
 *  - open MTF positions whose CURRENT own-margin requirement has drifted
 *    from what they were entered at (top-up risk).
 * Reports only — the journal is never rewritten to match today's rates.
 */
export function MtfDriftCard({
  drift,
  bundleAsOf,
  stale,
}: {
  drift: MtfDriftRow[];
  bundleAsOf: string;
  stale: boolean;
}) {
  if (drift.length === 0 && !stale) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          MTF margin check
          <Badge variant="secondary">list as of {bundleAsOf}</Badge>
          {stale && <Badge variant="warning">stale</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {stale && (
          <p className="text-xs text-warning">
            The bundled broker margin lists are more than 60 days old. Margins move with exchange VAR
            revisions — refresh from your broker&apos;s current list (Margin estimate → MTF stock lists)
            before trusting per-stock numbers.
          </p>
        )}
        {drift.length > 0 && (
          <>
            <p className="text-xs text-muted-foreground">
              Open MTF positions whose <b>current</b> own-margin requirement differs from what they were
              entered at. Your journal is unchanged — this is what your broker&apos;s latest list implies today.
            </p>
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-2.5 py-2 text-[0.6875rem] font-semibold uppercase tracking-[0.06em]">Position</th>
                    <th className="px-2 py-2 text-right text-[0.6875rem] font-semibold uppercase tracking-[0.06em]">Entered at</th>
                    <th className="px-2 py-2 text-right text-[0.6875rem] font-semibold uppercase tracking-[0.06em]">Current</th>
                    <th className="px-2 py-2 text-right text-[0.6875rem] font-semibold uppercase tracking-[0.06em]">Δ</th>
                    <th className="px-2 py-2 text-right text-[0.6875rem] font-semibold uppercase tracking-[0.06em]">Top-up if re-margined</th>
                  </tr>
                </thead>
                <tbody>
                  {drift.map((d) => (
                    <tr key={d.id} className="border-b border-rule">
                      <td className="px-2.5 py-1.5 font-medium">{d.symbol}<span className="ml-1.5 text-muted-foreground">{d.broker}</span></td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{d.storedOwnPct}%</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{d.currentPct}%</td>
                      <td className={`px-2 py-1.5 text-right tabular-nums ${d.deltaPct > 0 ? "text-warning" : "text-profit"}`}>
                        {d.deltaPct > 0 ? "+" : ""}{d.deltaPct} pts
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {d.topUpAtCurrent > 0 ? inr(d.topUpAtCurrent, { decimals: 0 }) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
