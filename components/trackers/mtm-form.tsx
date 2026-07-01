"use client";

import { useActionState } from "react";
import { saveMtmPrices, type MtmState } from "@/app/equity/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle2, AlertCircle } from "lucide-react";

export function MtmForm() {
  const [state, action, pending] = useActionState<MtmState, FormData>(saveMtmPrices, { ok: false, message: "", updated: 0 });
  const today = new Date().toISOString().slice(0, 10);
  return (
    <form action={action} className="space-y-2">
      <div className="flex items-center gap-2">
        <Label className="text-xs">As of</Label>
        <Input name="asOf" type="date" defaultValue={today} className="h-8 w-36" />
      </div>
      <textarea
        name="prices"
        rows={5}
        placeholder={"One position per line:  SYMBOL  price  [SL]  [TSL]  [target]\nRELIANCE 1380.5 1350 1365 1450\nADANI TOTAL GAS LIMITED, 724.35, 705, 715, 760\nNIFTY,23450"}
        className="w-full rounded-md border border-border bg-input p-2 text-xs font-mono tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <p className="text-[10px] text-muted-foreground">
        Price required; SL / TSL / target optional (space- or comma-separated). Stops update every open position matching the symbol and recompute risk.
      </p>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Update MTM"}</Button>
        {state.message && (
          <span className={`flex items-center gap-1.5 text-xs ${state.ok ? "text-profit" : "text-loss"}`}>
            {state.ok ? <CheckCircle2 className="size-3.5" /> : <AlertCircle className="size-3.5" />}
            {state.message}
          </span>
        )}
      </div>
    </form>
  );
}
