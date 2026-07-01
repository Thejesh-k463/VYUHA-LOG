import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PayoffChart } from "@/components/reports/payoff-chart";
import { getTrades } from "@/lib/queries/trades";
import { getSpotMap } from "@/lib/queries/mtm";
import { buildStrategies, type PositionedLeg } from "@/lib/analytics/strategies";
import { inr } from "@/lib/format";

export const dynamic = "force-dynamic";

export default function StrategiesPage() {
  const trades = getTrades();
  const spot = getSpotMap();

  const legs: PositionedLeg[] = trades
    .filter((t) => t.isOpen && t.instrumentType === "option" && t.strike != null && (t.optionType === "CE" || t.optionType === "PE"))
    .map((t) => {
      const side: "long" | "short" = t.buyQty >= t.sellQty ? "long" : "short";
      const qty = Math.abs(t.buyQty - t.sellQty) || Math.max(t.buyQty, t.sellQty);
      return {
        symbol: t.symbol,
        expiry: t.expiry,
        optionType: t.optionType as "CE" | "PE",
        strike: t.strike as number,
        side,
        qty,
        premium: side === "long" ? t.avgBuyPrice : t.avgSellPrice,
      };
    });

  const groups = buildStrategies(legs);

  const amt = (v: number | null, unboundedLabel: string) => (v == null ? unboundedLabel : inr(v, { decimals: 0 }));

  return (
    <>
      <PageHeader
        title="Option strategies"
        description="Your open option legs grouped into strategies, with the exact expiry payoff."
        actions={<Badge variant="secondary">{groups.length} {groups.length === 1 ? "strategy" : "strategies"}</Badge>}
      />
      <div className="space-y-5 p-6">
        {groups.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">
              No open option positions. Add option legs (Trades → Open trade) on the same underlying and expiry to see
              the strategy and its payoff curve.
            </CardContent>
          </Card>
        ) : (
          groups.map((g) => {
            const s = spot.get(g.symbol.toUpperCase()) ?? null;
            return (
              <Card key={g.key} className="p-0">
                <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 border-b border-border">
                  <div className="flex items-center gap-2">
                    <CardTitle>{g.symbol}</CardTitle>
                    <Badge variant="default">{g.name}</Badge>
                    <Badge variant={g.isCredit ? "profit" : "secondary"}>{g.isCredit ? "net credit" : "net debit"}</Badge>
                    {g.expiry ? <span className="text-xs text-muted-foreground">exp {g.expiry}</span> : null}
                  </div>
                  <div className="text-xs text-muted-foreground">{g.legs.length} legs</div>
                </CardHeader>
                <CardContent className="grid gap-4 p-4 lg:grid-cols-[1fr_1.4fr]">
                  {/* Legs + metrics */}
                  <div className="space-y-3">
                    <div className="space-y-1">
                      {g.legs.map((l, i) => (
                        <div key={i} className="flex items-center justify-between rounded-md border border-border bg-card-hover/30 px-2.5 py-1.5 text-xs">
                          <span className="inline-flex items-center gap-1.5">
                            <Badge variant={l.side === "long" ? "profit" : "loss"}>{l.side === "long" ? "Long" : "Short"}</Badge>
                            <span className="tabular-nums">{l.qty} × {l.strike} {l.optionType}</span>
                          </span>
                          <span className="tabular-nums text-muted-foreground">@ {inr(l.premium, { decimals: 2 })}</span>
                        </div>
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <Metric label="Net premium" value={`${g.isCredit ? "+" : ""}${inr(g.netPremium, { decimals: 0 })}`} tone={g.isCredit ? "text-profit" : "text-loss"} />
                      <Metric label="Breakeven(s)" value={g.breakevens.length ? g.breakevens.map((b) => Math.round(b)).join(" / ") : "—"} />
                      <Metric label="Max profit" value={amt(g.maxProfit, "Unlimited")} tone="text-profit" />
                      <Metric label="Max loss" value={amt(g.maxLoss, "Unlimited")} tone="text-loss" />
                    </div>
                  </div>
                  {/* Payoff diagram */}
                  <div>
                    <PayoffChart data={g.payoff} breakevens={g.breakevens} spot={s} />
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
        <p className="text-[11px] text-muted-foreground">
          Payoff is the exact value at expiry (intrinsic only) from your entry premiums — no pricing model needed. Max
          profit/loss marked &ldquo;Unlimited&rdquo; have an uncapped naked option leg. Short legs are read from
          sell-to-open positions. Black-Scholes Greeks (delta/gamma/theta/vega) are computed on{" "}
          <span className="text-foreground">Portfolio Risk</span> from the underlying spot and an estimated/entered IV.
        </p>
      </div>
    </>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-md border border-border bg-card-hover/30 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 font-semibold tabular-nums ${tone ?? ""}`}>{value}</div>
    </div>
  );
}
