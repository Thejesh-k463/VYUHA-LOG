import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { inr, num } from "@/lib/format";
import type { PortfolioVar, BetaExposure, StressResult } from "@/lib/risk/portfolio";

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card-hover/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${tone ?? ""}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

const pnl = (v: number) => (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground");
const signed = (v: number) => (v >= 0 ? "+" : "");

export function VarPanel({
  varResult,
  betaExp,
  stress,
  niftyDays,
}: {
  varResult: PortfolioVar | null;
  betaExp: BetaExposure | null;
  stress: StressResult[] | null;
  niftyDays: number; // NIFTY return days on record (0 = none loaded)
}) {
  return (
    <Card className="p-0">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>Value at Risk &amp; stress tests</CardTitle>
        {varResult ? (
          <Badge variant={varResult.coveragePct >= 90 ? "secondary" : "warning"}>
            {varResult.daysUsed} days · {varResult.coveragePct}% of exposure covered
          </Badge>
        ) : (
          <Badge variant="warning">needs price history</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {varResult ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="VaR 95% (1-day)" value={inr(varResult.var95, { decimals: 0 })} sub="worst day, 19 of 20" tone="text-warning" />
            <Stat label="CVaR 95%" value={inr(varResult.cvar95, { decimals: 0 })} sub="avg loss beyond VaR" tone="text-loss" />
            <Stat label="VaR 99%" value={inr(varResult.var99, { decimals: 0 })} sub="worst day, 99 of 100" tone="text-loss" />
            <Stat label="Parametric VaR 95%" value={inr(varResult.parametricVar95, { decimals: 0 })} sub={`normal, σ ${inr(varResult.sigmaDaily, { decimals: 0 })}/day`} />
            <Stat label="Exposure covered" value={`${varResult.coveragePct}%`} sub={varResult.uncoveredSymbols.length > 0 ? `no history: ${varResult.uncoveredSymbols.join(", ")}` : "all positions"} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            VaR resamples your open positions against each underlying&apos;s own daily history — none is on record
            yet (or under 30 overlapping days). Paste an NSE/BSE bhavcopy on this page (Auto-MTM panel) a few times,
            or load per-symbol closes, and this fills in.
          </p>
        )}

        {betaExp && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Net exposure" value={inr(betaExp.netExposure, { decimals: 0 })} tone={pnl(betaExp.netExposure)} sub="Σ delta-equivalent ₹" />
            <Stat
              label="Beta-weighted (NIFTY-eq)"
              value={inr(betaExp.betaWeightedExposure, { decimals: 0 })}
              tone={pnl(betaExp.betaWeightedExposure)}
              sub={niftyDays > 0 ? `β from ${niftyDays}d NIFTY overlap` : "no NIFTY history — β=1 for all"}
            />
            <Stat label="Gross exposure" value={inr(betaExp.grossExposure, { decimals: 0 })} sub="Σ |exposure|" />
            <Stat label="Real β coverage" value={`${betaExp.withBetaPct}%`} sub="rest falls back to β=1" />
          </div>
        )}

        {stress && stress.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-y border-border text-left text-muted-foreground">
                  <th className="px-2.5 py-2 font-medium">Scenario</th>
                  <th className="px-2 py-2 text-right font-medium">Delta P&L</th>
                  <th className="px-2 py-2 text-right font-medium">Gamma</th>
                  <th className="px-2 py-2 text-right font-medium">Vega</th>
                  <th className="px-2.5 py-2 text-right font-medium">Projected P&L</th>
                </tr>
              </thead>
              <tbody>
                {stress.map((s) => (
                  <tr key={s.scenario.label} className="border-b border-border/40">
                    <td className="px-2.5 py-1.5 font-medium">{s.scenario.label}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${pnl(s.deltaPnl)}`}>{signed(s.deltaPnl)}{num(s.deltaPnl, 0)}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${pnl(s.gammaPnl)}`}>{signed(s.gammaPnl)}{num(s.gammaPnl, 0)}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${pnl(s.vegaPnl)}`}>{signed(s.vegaPnl)}{num(s.vegaPnl, 0)}</td>
                    <td className={`px-2.5 py-1.5 text-right tabular-nums font-semibold ${pnl(s.pnl)}`}>{signed(s.pnl)}{num(s.pnl, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">
          Delta-normal model: each position enters as its delta-equivalent exposure to the underlying (options via
          the Greeks above), resampled against the underlying&apos;s OWN daily returns from local price history —
          historical VaR assumes tomorrow looks like the sampled past. Stress P&amp;L ≈ β·Δmarket + ½Γ(ΔS)² + V·ΔIV
          per position; gap risk, liquidity and margin calls are not modelled. Informational only.
        </p>
      </CardContent>
    </Card>
  );
}
