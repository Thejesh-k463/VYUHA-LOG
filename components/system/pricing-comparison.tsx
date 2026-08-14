import { Card } from "@/components/ui/card";
import {
  COMPARISON_AS_OF,
  COMPETITORS,
  VYUHA_ROW,
  WHY_VYUHA,
} from "@/lib/domain/pricing-comparison";
import { Check } from "lucide-react";

/**
 * The competitor comparison under the pricing cards. Server-renderable, no
 * "use client" — static data from lib/domain/pricing-comparison.ts, which
 * carries the sourcing rules (as-of date, † for third-party-sourced pricing,
 * "Not stated" over guesses). The table must stay inside its own horizontal
 * scroller — the page body never scrolls sideways.
 */
export function PricingComparison() {
  return (
    <div className="animate-fade-up space-y-4">
      <div>
        <h2 className="text-sm font-semibold">How Vyuha compares</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Public pricing of other trade journals, read on {COMPARISON_AS_OF}. Approximate ₹ conversions at ~₹88/USD.
          † pricing from third-party 2026 reviews where the official page was unreachable. &ldquo;Not stated&rdquo; means
          exactly that — we did not find the claim on their pages, not that the product lacks it.
        </p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[720px] text-xs">
          <thead>
            <tr className="border-b border-border bg-card text-left text-muted-foreground">
              <th className="px-3 py-2 font-medium">Product</th>
              <th className="px-3 py-2 font-medium">Cheapest paid tier</th>
              <th className="px-3 py-2 font-medium">Where your data lives</th>
              <th className="px-3 py-2 font-medium">Indian broker imports</th>
              <th className="px-3 py-2 font-medium">Indian statutory charges</th>
              <th className="px-3 py-2 font-medium">Limits</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border bg-accent/5 font-medium">
              <td className="px-3 py-2 text-accent">{VYUHA_ROW.name}</td>
              <td className="px-3 py-2 font-mono tabular-nums">{VYUHA_ROW.cheapestPaid}</td>
              <td className="px-3 py-2">{VYUHA_ROW.dataLocation}</td>
              <td className="px-3 py-2">{VYUHA_ROW.indianBrokers}</td>
              <td className="px-3 py-2">{VYUHA_ROW.chargesEngine}</td>
              <td className="px-3 py-2">{VYUHA_ROW.limits}</td>
            </tr>
            {COMPETITORS.map((row) => (
              <tr key={row.name} className="border-b border-border last:border-b-0">
                <td className="px-3 py-2">
                  {row.name}
                  {row.thirdParty && <sup className="text-muted-foreground">†</sup>}
                  <span className="ml-1.5 text-[10px] text-muted-foreground">{row.market}</span>
                </td>
                <td className="px-3 py-2 font-mono tabular-nums">{row.cheapestPaid}</td>
                <td className="px-3 py-2 text-muted-foreground">{row.dataLocation}</td>
                <td className="px-3 py-2 text-muted-foreground">{row.indianBrokers}</td>
                <td className="px-3 py-2 text-muted-foreground">{row.chargesEngine}</td>
                <td className="px-3 py-2 text-muted-foreground">{row.limits}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Card className="p-5">
        <h3 className="text-sm font-semibold">Why the numbers favour Lifetime</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Every line below is architecture or arithmetic — nothing here promises trading outcomes.
        </p>
        <ul className="mt-3 grid gap-3 text-xs md:grid-cols-2">
          {WHY_VYUHA.map((row) => (
            <li key={row.claim} className="flex items-start gap-1.5">
              <Check className="mt-0.5 size-3.5 shrink-0 text-profit" />
              <span>
                <span className="font-medium">{row.claim}.</span>{" "}
                <span className="text-muted-foreground">{row.detail}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[0.6875rem] text-muted-foreground">
          Lifetime also carries every future upgrade at no extra cost — exciting, useful features are on the
          roadmap.
        </p>
      </Card>
    </div>
  );
}
