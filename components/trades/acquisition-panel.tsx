"use client";

import { useActionState, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/toaster";
import { setAcquisitionAction } from "@/app/trades/actions";
import { inr } from "@/lib/format";
import { Sparkles, TriangleAlert } from "lucide-react";

export interface PendingBasisTrade {
  id: number;
  symbol: string;
  sellQty: number;
  sellValue: number;
  sellDate: string | null;
  chargesTotal: number;
  acquisition: string | null;
  acquisitionPrice: number | null;
  /** Per-share cost recovered from the import file's own footer, if any. */
  suggestedPrice: number | null;
}

/**
 * What an unpriced sale does to Net P&L, said plainly. Invariant 6: a sale
 * with no cost books no gain — its Net P&L is minus its charges and nothing
 * else. The previous copy claimed the sale itself was "already counted",
 * which was false (only the charges are) and sent readers to reconcile a
 * number that could not reconcile. Pinned verbatim in
 * tests/acquisition-panel-copy.test.ts.
 */
export const PENDING_BASIS_NOTE =
  "Only the charges on these sales are in your Net P&L so far — the proceeds are not, because with no cost there is no gain to book. Set the cost below (the IPO issue price, or what you actually paid) and each sale's gain lands in Net P&L.";

const KINDS: { value: string; label: string; hint: string }[] = [
  { value: "ipo", label: "IPO allotment", hint: "Allotted in a public issue — basis is the issue price you paid" },
  { value: "bonus", label: "Bonus / split", hint: "Credited by a corporate action" },
  { value: "gift", label: "Transfer in / gift", hint: "Received by transfer, gift or inheritance" },
  { value: "unknown", label: "Bought earlier", hint: "An ordinary purchase from before this import window" },
];

function Row({ t }: { t: PendingBasisTrade }) {
  const [state, action, pending] = useActionState(setAcquisitionAction, { ok: false, message: "" });
  useEffect(() => {
    if (!state.message) return;
    if (state.ok) toast.success(state.message);
    else toast.error(state.message);
  }, [state]);
  const [kind, setKind] = useState(t.acquisition && t.acquisition !== "unknown" ? t.acquisition : "ipo");
  const [price, setPrice] = useState(
    t.acquisitionPrice != null ? String(t.acquisitionPrice) : t.suggestedPrice != null ? String(t.suggestedPrice) : "",
  );

  const qty = t.sellQty;
  const cost = Number(price) > 0 ? Number(price) * qty : 0;
  const preview = cost > 0 ? t.sellValue - cost - t.chargesTotal : null;

  return (
    <form action={action} className="space-y-2 rounded-md border border-border/60 p-3">
      <input type="hidden" name="tradeId" value={t.id} />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-sm font-medium">{t.symbol}</div>
        <div className="font-mono text-xs tabular-nums text-muted-foreground">
          sold {qty} for {inr(t.sellValue, { decimals: 0 })}
          {t.sellDate ? ` on ${t.sellDate}` : ""}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {KINDS.map((k) => (
          <button
            key={k.value}
            type="button"
            title={k.hint}
            onClick={() => setKind(k.value)}
            className={`rounded px-2 py-0.5 text-[0.6875rem] transition-colors ${
              kind === k.value ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>
      <input type="hidden" name="acquisition" value={kind} />

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">
          <span className="mb-0.5 block text-muted-foreground">Cost per share (₹)</span>
          <input
            name="acquisitionPrice"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            inputMode="decimal"
            placeholder="e.g. 598"
            className="w-32 rounded border border-border bg-background px-2 py-1 font-mono text-xs tabular-nums"
          />
        </label>
        <label className="text-xs">
          <span className="mb-0.5 block text-muted-foreground">Acquired on</span>
          <input
            name="acquisitionDate"
            type="date"
            className="rounded border border-border bg-background px-2 py-1 text-xs"
          />
        </label>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Set basis"}
        </Button>
      </div>

      {t.suggestedPrice != null && (
        <p className="flex items-start gap-1.5 text-[0.6875rem] text-accent">
          <Sparkles className="mt-0.5 size-3 shrink-0" />
          <span>
            Vyuha recovered <b>₹{t.suggestedPrice}</b> a share from the import file&apos;s own footer — the
            broker&apos;s gross P&amp;L includes this trade even though the rows do not, so the difference is
            its cost. Pre-filled, but check it against your contract note before saving.
          </span>
        </p>
      )}

      {preview != null && (
        <p className="text-[0.6875rem] text-muted-foreground">
          At {inr(Number(price), { decimals: 2 })} a share this becomes{" "}
          <b className={preview >= 0 ? "text-profit" : "text-loss"}>{inr(preview, { decimals: 0 })}</b> net
          after {inr(t.chargesTotal, { decimals: 0 })} of charges.
        </p>
      )}
    </form>
  );
}

/**
 * Trades the importer could not price.
 *
 * These are sales of stock acquired before the imported window — in Indian
 * retail, most often an IPO allotment, where shares are credited on allotment
 * and never appear as a buy in any tradebook.
 *
 * They are shown together and up front because leaving them unresolved has a
 * cost: with no purchase price, `sellValue - 0` reads as pure profit, so every
 * one of them would otherwise inflate win rate, expectancy and Return on
 * Margin at once.
 */
export function AcquisitionPanel({ trades }: { trades: PendingBasisTrade[] }) {
  if (trades.length === 0) return null;

  const proceeds = trades.reduce((s, t) => s + t.sellValue, 0);

  return (
    <Card className="border-warning/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TriangleAlert className="size-4 text-warning" />
          {trades.length} sale{trades.length === 1 ? "" : "s"} with no purchase on record
        </CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          These shares were sold inside your import window but bought before it, so the file contains no
          cost for them — very often an <b>IPO allotment</b>, which is credited without ever appearing as a
          buy. {inr(proceeds, { decimals: 0 })} of proceeds is involved.
          <br />
          {PENDING_BASIS_NOTE} Until then these are held{" "}
          <b>out of win rate, expectancy, profit factor and Return on Margin</b> — with no purchase price
          the arithmetic would read them as 100% winners.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {trades.map((t) => (
          <Row key={t.id} t={t} />
        ))}
      </CardContent>
    </Card>
  );
}

/** Compact marker for a resolved acquisition, shown inline on a trade row. */
export function AcquisitionBadge({ kind }: { kind: string }) {
  const label =
    kind === "ipo" ? "IPO" : kind === "bonus" ? "Bonus" : kind === "gift" ? "Gift" : "Pre-window";
  return (
    <Badge variant="secondary" className="text-[10px]">
      {label}
    </Badge>
  );
}
