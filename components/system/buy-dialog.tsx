"use client";

import * as React from "react";
import { Copy, ExternalLink, MessageCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toaster";
import { buyMessageText, buyUrlFor, formatWhatsAppNumber } from "@/lib/license";
import { PRICING_AS_OF, priceLabel, skuById, type PricingSkuId } from "@/lib/domain/pricing";

/**
 * The buy step, as a dialog instead of a bare link.
 *
 * Every "Get Vyuha Pro" / "Get {plan}" / "Renew" CTA used to be a plain
 * new-tab anchor to wa.me. In the browser that opens WhatsApp; in the Tauri
 * desktop webview (WebView2, no opener/shell plugin) a new-tab anchor to an
 * external origin does NOTHING — the buyer
 * clicks Get and nothing happens, which reads as "the button is broken".
 *
 * So the dialog is the primary UX and works everywhere: the number, large and
 * copyable; the pre-filled message, copyable; and the wa.me link kept as the
 * secondary path for the browser case. No programmatic open attempt first — in
 * the webview it silently no-ops (or is denied), and a click that seems to do
 * nothing before the dialog appears is exactly the confusion being fixed.
 *
 * `trigger` is a ReactNode so a server component (pro-gate.tsx) can pass its
 * own <Button>/<button> across the boundary — an element, never a function.
 */
export function BuyDialog({ skuId, trigger }: { skuId?: PricingSkuId; trigger: React.ReactNode }) {
  const sku = skuId ? skuById(skuId) : null;
  const number = formatWhatsAppNumber();
  const message = buyMessageText(skuId);
  const url = buyUrlFor(skuId);

  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-md" data-testid="buy-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="size-4 text-accent" />
            {sku ? `Get Vyuha — ${sku.name}` : "Get Vyuha Pro"}
          </DialogTitle>
          <DialogDescription>
            {sku
              ? `${sku.name} · ${priceLabel(sku)} · price as of ${PRICING_AS_OF}`
              : `Annual or lifetime — prices as of ${PRICING_AS_OF}`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-md border border-border bg-background/40 p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              WhatsApp
            </div>
            <div className="mt-1 font-mono text-2xl font-bold tabular-nums tracking-wide" data-testid="buy-dialog-number">
              {number}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <CopyButton label="Copy number" value={number} done="Number copied." />
              <Button size="sm" variant="outline" asChild>
                {/* Secondary path — works in a browser, inert in the desktop
                    webview (see the header comment). Kept because in a browser
                    it is the fastest route, and it costs nothing. */}
                <a href={url} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-3.5" /> Open WhatsApp
                </a>
              </Button>
            </div>
          </div>

          <div className="rounded-md border border-border bg-background/40 p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Message to send
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm" data-testid="buy-dialog-message">{message}</p>
            <div className="mt-2">
              <CopyButton label="Copy message" value={message} done="Message copied." />
            </div>
          </div>

          <p className="text-[0.6875rem] text-muted-foreground">
            The desktop app makes no payment call of its own. Message us on WhatsApp and we
            confirm the price before any payment.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CopyButton({ label, value, done }: { label: string; value: string; done: string }) {
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={async () => {
        // The clipboard API is absent on plain-http origins in some engines
        // and can throw when the document is not focused; neither should
        // leave the buyer with a silent button — the value is on screen and
        // selectable, so say so.
        try {
          if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
          await navigator.clipboard.writeText(value);
          toast.success(done);
        } catch {
          toast.error("Couldn't reach the clipboard — select the text and copy it by hand.");
        }
      }}
    >
      <Copy className="size-3.5" /> {label}
    </Button>
  );
}
