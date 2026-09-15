import { RISK_LIST_CAP, CappedNote } from "@/components/ui/capped-note";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { inr, signedNumber } from "@/lib/format";
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
  unpriced = 0,
}: {
  drift: MtfDriftRow[];
  bundleAsOf: string;
  stale: boolean;
  /** Open MTF positions the check could not compare because the journal never
   *  resolved what the broker funded (`unpricedMtfPositions`). Named here
   *  rather than priced at 100% own margin — see L2[1] in lib/risk/mtf-drift.ts.
   *  Optional so an older call site keeps compiling. */
  unpriced?: number;
}) {
  if (drift.length === 0 && unpriced === 0 && !stale) return null;

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
        {unpriced > 0 && (
          <p className="text-xs text-muted-foreground">
            {unpriced} open MTF {unpriced === 1 ? "position is" : "positions are"} not priced — this journal holds no
            broker-funded amount for {unpriced === 1 ? "it" : "them"}, so there is no entry margin to compare
            today&apos;s requirement against and {unpriced === 1 ? "it is" : "they are"} left out of the table below.
            Record what you put in on the trade (Edit → Own capital used) to include {unpriced === 1 ? "it" : "them"}.
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
                  {drift.slice(0, RISK_LIST_CAP).map((d) => (
                    <tr key={d.id} className="border-b border-rule">
                      <td className="px-2.5 py-1.5 font-medium">{d.symbol}<span className="ml-1.5 text-muted-foreground">{d.broker}</span></td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{d.storedOwnPct}%</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{d.currentPct}%</td>
                      <td className={`px-2 py-1.5 text-right tabular-nums ${d.deltaPct > 0 ? "text-warning" : "text-profit"}`}>
                        {/* R8 at a NON-percentage site: this is a percentage-POINT delta with no
                            rupee figure stating the same fact (the top-up column is a different
                            one), so it keeps its OWN sign — signedNumber, zero unsigned. */}
                        {signedNumber(d.deltaPct)} pts
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {d.topUpAtCurrent > 0 ? inr(d.topUpAtCurrent, { decimals: 0 }) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <CappedNote total={drift.length} noun="drifted positions" />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
