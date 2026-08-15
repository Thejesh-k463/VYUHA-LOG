import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { BuyDialog } from "@/components/system/buy-dialog";
import {
  PRICING,
  PRICING_AS_OF,
  formatInr,
  offerPct,
  priceLabel,
  pricingIsStale,
  type PricingSku,
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
 * imports. The dialogs it composes (BuyDialog, the compact pill's detail
 * popup) are client components used uncontrolled — no state or callbacks
 * cross the boundary, only elements and plain SKU data.
 *
 * The CTA is a BuyDialog, not a `target="_blank"` anchor: in the Tauri
 * desktop webview an external anchor does nothing at all (see buy-dialog.tsx).
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

/**
 * One plan's card body — badge, price/anchor, blurb, includes, CTA. Used by
 * the full grid AND by the compact pill's popup, so the two can never drift.
 * `titleAs` lets the popup make the name its accessible dialog title.
 */
export function SkuCardBody({ sku, titleAs = "div" }: { sku: PricingSku; titleAs?: "div" | "dialog-title" }) {
  const name = titleAs === "dialog-title"
    ? <DialogTitle className="text-sm font-semibold">{sku.name}</DialogTitle>
    : <div className="text-sm font-semibold">{sku.name}</div>;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        {name}
        <div className="flex items-center gap-1.5">
          {offerPct(sku) != null && (
            <span className="animate-badge-pop inline-flex items-center rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent-foreground">
              Launch offer · {offerPct(sku)}% off
            </span>
          )}
          {sku.featured && <Badge variant="secondary">Best value</Badge>}
        </div>
      </div>
      <div className="mt-2 font-mono text-2xl font-bold tabular-nums">
        {priceLabel(sku)}
        {sku.wasInr && <s className="ml-2 text-sm font-normal text-muted-foreground">{formatInr(sku.wasInr)}</s>}
      </div>
      <div className="text-xs text-muted-foreground">{sku.blurb}</div>
      {sku.wasInr && (
        <div className="mt-1 text-[0.6875rem] font-medium text-accent">
          Save {formatInr(sku.wasInr - sku.amountInr)} at launch pricing — for a limited period.
        </div>
      )}
      <ul className="mt-3 flex-1 space-y-1.5 text-xs">
        {sku.includes.map((line) => (
          <li key={line} className="flex items-start gap-1.5">
            <Check className="mt-0.5 size-3.5 shrink-0 text-profit" />
            <span>{line}</span>
          </li>
        ))}
      </ul>
      <BuyDialog
        skuId={sku.id}
        trigger={
          <Button size="sm" variant={sku.featured ? "default" : "outline"} className="mt-4">
            <MessageCircle className="size-3.5" /> Get {sku.name}
          </Button>
        }
      />
    </>
  );
}

export function PricingTable({ compact }: { compact?: boolean }) {
  if (compact) {
    return (
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {PRICING.map((sku) => (
            // Each pill opens THAT plan's card — the same body the /pricing
            // grid renders, minus the comparison. Until 2026-08-15 the pills
            // were inert spans and "what do I get for it?" had no answer
            // short of leaving the screen.
            <Dialog key={sku.id}>
              <DialogTrigger asChild>
                <button
                  type="button"
                  aria-label={`Show plan details: ${sku.name}`}
                  title="Show plan details"
                  className={`inline-flex cursor-pointer items-baseline gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    sku.featured ? "border-accent/40 bg-accent/5 hover:bg-accent/10" : "border-border"
                  }`}
                >
                  <span className={sku.featured ? "font-medium text-accent" : "text-muted-foreground"}>{sku.name}</span>
                  <span className="font-mono font-semibold tabular-nums">{priceLabel(sku)}</span>
                  {sku.wasInr && <s className="text-[10px] text-muted-foreground">{formatInr(sku.wasInr)}</s>}
                  {offerPct(sku) != null && (
                    <span className="text-[10px] font-semibold text-accent">−{offerPct(sku)}%</span>
                  )}
                </button>
              </DialogTrigger>
              <DialogContent className="max-w-md" aria-describedby={undefined}>
                <div className="flex flex-col pr-6">
                  <SkuCardBody sku={sku} titleAs="dialog-title" />
                </div>
                <AsOfCaption />
              </DialogContent>
            </Dialog>
          ))}
        </div>
        <AsOfCaption />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-4 md:grid-cols-2">
        {PRICING.map((sku) => (
          <Card
            key={sku.id}
            className={`animate-fade-up flex flex-col p-5 ${sku.featured ? "border-accent/40" : ""}`}
          >
            <SkuCardBody sku={sku} />
          </Card>
        ))}
      </div>
      <AsOfCaption />
    </div>
  );
}
