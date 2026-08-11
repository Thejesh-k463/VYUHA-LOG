"use client";

/**
 * The confirmation a bulk delete must pass through.
 *
 * The preview shown here IS the delete: the dialog receives the resolved ids
 * from lib/domain/delete-scope.ts and submits exactly those, so what the user
 * confirmed and what is removed are the same list by construction. Typing the
 * count is required above a threshold — a destructive action earns one extra
 * deliberate step, not a reflexive click.
 */

import * as React from "react";
import { useActionState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toaster";
import { deleteTradesAction, type ActionState } from "@/app/trades/actions";
import { inr } from "@/lib/format";
import { Trash2, TriangleAlert } from "lucide-react";
import type { DeletePreview } from "@/lib/domain/delete-scope";

/** Above this many trades, the count must be typed to enable the button. */
const TYPE_TO_CONFIRM_AT = 10;

export function DeleteTradesDialog({
  preview,
  reason,
  open,
  onOpenChange,
  onDone,
}: {
  preview: DeletePreview | null;
  /** Recorded in the audit log — why these were deleted. */
  reason: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone?: () => void;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(deleteTradesAction, { ok: false, message: "" });
  const [typed, setTyped] = React.useState("");

  React.useEffect(() => {
    if (state.ok) {
      onOpenChange(false);
      onDone?.();
    } else if (state.message) {
      toast.error(state.message);
    }
  }, [state, onOpenChange, onDone]);

  if (!preview || preview.empty) return null;

  const needsTyping = preview.count >= TYPE_TO_CONFIRM_AT;
  const confirmed = !needsTyping || typed.trim() === String(preview.count);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) setTyped(""); onOpenChange(v); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="size-4 text-loss" /> Delete {preview.label}?
          </DialogTitle>
          <DialogDescription>This is the exact set that will be removed — nothing is re-derived after you confirm.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-xs">
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Trades" value={String(preview.count)} />
            <Stat label="Open / closed" value={`${preview.open} / ${preview.closed}`} />
            <Stat label="Net P&L" value={inr(preview.netPnl, { decimals: 0 })} />
          </div>

          {preview.symbolCount > 0 && (
            <p className="text-muted-foreground">
              {preview.symbols.join(", ")}
              {preview.symbolCount > preview.symbols.length && ` +${preview.symbolCount - preview.symbols.length} more`}
              {preview.earliest && preview.latest && ` · ${preview.earliest} → ${preview.latest}`}
            </p>
          )}

          <ul className="space-y-1.5">
            {preview.warnings.map((w, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                <span>{w}</span>
              </li>
            ))}
          </ul>

          {needsTyping && (
            <div>
              <label className="mb-1 block font-medium" htmlFor="confirm-count">
                Type <b>{preview.count}</b> to confirm
              </label>
              <Input id="confirm-count" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={String(preview.count)} autoComplete="off" />
            </div>
          )}

        </div>

        <form action={formAction}>
          <input type="hidden" name="ids" value={preview.ids.join(",")} />
          <input type="hidden" name="reason" value={reason} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="destructive" disabled={pending || !confirmed}>
              {pending ? "Deleting…" : `Delete ${preview.count} trade${preview.count === 1 ? "" : "s"}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-mono text-sm tabular-nums">{value}</div>
    </div>
  );
}
