import { RISK_LIST_CAP, CappedNote } from "@/components/ui/capped-note";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { num, signOf } from "@/lib/format";
import type { PortfolioGreeks } from "@/lib/analytics/greeks";

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card-hover/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

// R8 at a NON-percentage site. A Greek is a signed QUANTITY, not a percentage,
// so there is no rupee figure beside it to borrow a sign from — but the
// zero-unsigned half of the ruling still applies: a net delta of 0 is flat, not
// a long. So the sign comes from `signOf()` and the magnitude from `num()`,
// which keeps the en-IN grouping the deleted local `signed` relied on
// (`num()` prints its own "-", hence Math.abs on the magnitude).

export function GreeksPanel({ greeks, latestVix }: { greeks: PortfolioGreeks; latestVix?: number | null }) {
  return (
    <Card className="p-0">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>Option Greeks</CardTitle>
        <div className="flex items-center gap-2">
          {latestVix != null && <Badge variant="outline">India VIX {latestVix}</Badge>}
          <Badge variant="secondary">{greeks.count} option{greeks.count === 1 ? "" : "s"} priced</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="Net delta"
            value={`${signOf(greeks.delta)}${num(Math.abs(greeks.delta), 0)}`}
            tone={greeks.delta >= 0 ? "text-profit" : "text-loss"}
          />
          <Stat label="Net gamma" value={num(greeks.gamma, 4)} />
          <Stat
            label="Theta / day"
            value={`${signOf(greeks.thetaPerDay)}${num(Math.abs(greeks.thetaPerDay), 0)}`}
            tone={greeks.thetaPerDay >= 0 ? "text-profit" : "text-loss"}
          />
          <Stat label="Vega (per 1% IV)" value={`${signOf(greeks.vega)}${num(Math.abs(greeks.vega), 0)}`} />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-y border-border text-left text-muted-foreground">
                <th className="px-2.5 py-2 font-medium">Symbol</th>
                <th className="px-2 py-2 text-right font-medium">IV used</th>
                <th className="px-2 py-2 text-right font-medium">Delta</th>
                <th className="px-2 py-2 text-right font-medium">Gamma</th>
                <th className="px-2 py-2 text-right font-medium">Theta/day</th>
                <th className="px-2 py-2 text-right font-medium">Vega</th>
              </tr>
            </thead>
            <tbody>
              {greeks.positions.slice(0, RISK_LIST_CAP).map((g) => (
                <tr key={g.id} className="border-b border-rule">
                  <td className="px-2.5 py-1.5 font-medium">{g.symbol}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                    {g.ivPct}%
                    {g.ivSource === "market" && <span className="ml-1 text-[10px] text-warning">VIX</span>}
                    {g.ivSource === "default" && <span className="ml-1 text-[10px] text-warning">est.</span>}
                  </td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${g.delta >= 0 ? "text-profit" : "text-loss"}`}>{signOf(g.delta)}{num(Math.abs(g.delta), 0)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{num(g.gamma, 4)}</td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${g.thetaPerDay >= 0 ? "text-profit" : "text-loss"}`}>{signOf(g.thetaPerDay)}{num(Math.abs(g.thetaPerDay), 0)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{signOf(g.vega)}{num(Math.abs(g.vega), 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <CappedNote total={greeks.positions.length} noun="priced options" />
        </div>

        <p className="text-[0.6875rem] text-muted-foreground">
          Black-Scholes estimates from the underlying spot (bhavcopy/manual MTM) — index options and
          NSE stock options are European-style, exercised only at expiry, so Black-Scholes needs no
          early-exercise adjustment for either. IV falls back in three tiers: what you set on a position
          (Portfolio Risk → edit a position → &ldquo;Implied vol %&rdquo;), else the latest India VIX close
          (marked &ldquo;VIX&rdquo; — paste it below), else a flat 20% estimate (marked &ldquo;est.&rdquo;) if no
          VIX is loaded either. India VIX is a NIFTY-index vol proxy, not the real IV of a specific stock option —
          set the real per-position IV for accuracy where it matters.
          {greeks.skipped > 0 && ` ${greeks.skipped} option${greeks.skipped === 1 ? "" : "s"} skipped — no underlying spot on record.`}
        </p>
      </CardContent>
    </Card>
  );
}
