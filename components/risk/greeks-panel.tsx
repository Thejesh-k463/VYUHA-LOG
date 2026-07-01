import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { num } from "@/lib/format";
import type { PortfolioGreeks } from "@/lib/analytics/greeks";

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card-hover/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

const signed = (v: number) => (v >= 0 ? "+" : "");

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
            value={`${signed(greeks.delta)}${num(greeks.delta, 0)}`}
            tone={greeks.delta >= 0 ? "text-profit" : "text-loss"}
          />
          <Stat label="Net gamma" value={num(greeks.gamma, 4)} />
          <Stat
            label="Theta / day"
            value={`${signed(greeks.thetaPerDay)}${num(greeks.thetaPerDay, 0)}`}
            tone={greeks.thetaPerDay >= 0 ? "text-profit" : "text-loss"}
          />
          <Stat label="Vega (per 1% IV)" value={`${signed(greeks.vega)}${num(greeks.vega, 0)}`} />
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
              {greeks.positions.map((g) => (
                <tr key={g.id} className="border-b border-border/40">
                  <td className="px-2.5 py-1.5 font-medium">{g.symbol}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                    {g.ivPct}%
                    {g.ivSource === "market" && <span className="ml-1 text-[10px] text-warning">VIX</span>}
                    {g.ivSource === "default" && <span className="ml-1 text-[10px] text-warning">est.</span>}
                  </td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${g.delta >= 0 ? "text-profit" : "text-loss"}`}>{signed(g.delta)}{num(g.delta, 0)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{num(g.gamma, 4)}</td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${g.thetaPerDay >= 0 ? "text-profit" : "text-loss"}`}>{signed(g.thetaPerDay)}{num(g.thetaPerDay, 0)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{signed(g.vega)}{num(g.vega, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-[11px] text-muted-foreground">
          Black-Scholes estimates from the underlying spot (bhavcopy/manual MTM) — Indian index options are
          European-style (exact), stock options are American-style (Black-Scholes is the standard retail
          approximation, ignoring early-exercise value). IV falls back in three tiers: what you set on a position
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
