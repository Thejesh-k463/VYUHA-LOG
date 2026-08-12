import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { buyUrlFor } from "@/lib/license";
import {
  PRICING,
  PRICING_AS_OF,
  formatInr,
  priceLabel,
  pricingIsStale,
} from "@/lib/domain/pricing";
import { Check, MessageCircle } from "lucide-react";

/**
 * The prices, rendered — one component for every surface that shows them.
 *
 * `compact` is a single row of chips for the upsell panel and the licence
 * card; the full variant is the /pricing page's three-card grid. Both read
 * `lib/domain/pricing.ts`, the single source of truth, and both carry the
 * "as of" line — an offline build cannot check for a price change, so the
 * date the numbers were true is part of the number.
 *
 * No "use client": server-renderable, and client-SAFE (license-card.tsx is a
 * client component and imports this) because the pricing module has zero
 * imports and buyUrlFor is pure string work.
 */

function AsOfCaption() {
  // A build older than the staleness window says so instead of quoting the
  // number as if it were live. The number itself never disappears — a hidden
  // price is the exact funnel leak this component exists to fix.
  const stale = pricingIsStale(PRICING_AS_OF, new Date());
  return (
    <p className="text-[0.6875rem] text-muted-foreground">
      {stale
        ? `This build is from ${PRICING_AS_OF} and cannot check for a price change — confirm the current price on WhatsApp before paying.`
        : `Prices as of ${PRICING_AS_OF}, in ₹. Confirmed on WhatsApp before any payment.`}
    </p>
  );
}

export function PricingTable({ compact }: { compact?: boolean }) {
  if (compact) {
    return (
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {PRICING.map((sku) => (
            <span
              key={sku.id}
              className={`inline-flex items-baseline gap-1.5 rounded-md border px-2.5 py-1 text-xs ${
                sku.featured ? "border-accent/40 bg-accent/5" : "border-border"
              }`}
            >
              <span className={sku.featured ? "font-medium text-accent" : "text-muted-foreground"}>{sku.name}</span>
              <span className="font-mono font-semibold tabular-nums">{priceLabel(sku)}</span>
              {sku.wasInr && <s className="text-[10px] text-muted-foreground">{formatInr(sku.wasInr)}</s>}
            </span>
          ))}
        </div>
        <AsOfCaption />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-4 md:grid-cols-3">
        {PRICING.map((sku) => (
          <Card key={sku.id} className={`flex flex-col p-5 ${sku.featured ? "border-accent/40" : ""}`}>
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">{sku.name}</div>
              {sku.featured && <Badge variant="secondary">Best value</Badge>}
            </div>
            <div className="mt-2 font-mono text-2xl font-bold tabular-nums">
              {priceLabel(sku)}
              {sku.wasInr && <s className="ml-2 text-sm font-normal text-muted-foreground">{formatInr(sku.wasInr)}</s>}
            </div>
            <div className="text-xs text-muted-foreground">{sku.blurb}</div>
            <ul className="mt-3 flex-1 space-y-1.5 text-xs">
              {sku.includes.map((line) => (
                <li key={line} className="flex items-start gap-1.5">
                  <Check className="mt-0.5 size-3.5 shrink-0 text-profit" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
            <Button size="sm" variant={sku.featured ? "default" : "outline"} className="mt-4" asChild>
              <a href={buyUrlFor(sku.id)} target="_blank" rel="noreferrer">
                <MessageCircle className="size-3.5" /> Get {sku.name}
              </a>
            </Button>
          </Card>
        ))}
      </div>
      <AsOfCaption />
    </div>
  );
}
