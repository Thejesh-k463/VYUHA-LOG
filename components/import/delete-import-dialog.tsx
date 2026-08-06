"use client";

/**
 * Deleting an imported file. The question the dialog exists to ask: what about
 * the trades it created? "Also delete" removes both; "keep" removes only the
 * import record — the trades stay but lose their provenance link, which is why
 * this is asked rather than assumed.
 */

import * as React from "react";
import { useActionState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { deleteImportBatchAction, type ActionState } from "@/app/trades/actions";
import { Trash2, TriangleAlert } from "lucide-react";

export function DeleteImportDialog({
  batch,
  open,
  onOpenChange,
}: {
  batch: { id: number; fileName: string; tradeCount: number } | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(deleteImportBatchAction, { ok: false, message: "" });
  const [cascade, setCascade] = React.useState(true);

  React.useEffect(() => {
    if (state.ok) onOpenChange(false);
  }, [state, onOpenChange]);

  if (!batch) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="size-4 text-loss" /> Delete this import?
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">{batch.fileName}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-xs">
          {batch.tradeCount > 0 ? (
            <>
              <p>
                This import created <b>{batch.tradeCount}</b> trade{batch.tradeCount === 1 ? "" : "s"} that{" "}
                {batch.tradeCount === 1 ? "is" : "are"} still in your journal.
              </p>
              <label className="flex items-start gap-2 rounded-md border border-border p-2.5">
                <input type="radio" name="mode" checked={cascade} onChange={() => setCascade(true)} className="mt-0.5" />
                <span>
                  <b>Also delete those {batch.tradeCount} trade{batch.tradeCount === 1 ? "" : "s"}</b>
                  <br />
                  <span className="text-muted-foreground">Their journal notes, tags and chart attachments go with them. Restore from a backup is the only way back.</span>
                </span>
              </label>
              <label className="flex items-start gap-2 rounded-md border border-border p-2.5">
                <input type="radio" name="mode" checked={!cascade} onChange={() => setCascade(false)} className="mt-0.5" />
                <span>
                  <b>Keep the trades</b>
                  <br />
                  <span className="text-muted-foreground">Only the import record is removed. The trades stay, but they lose the link back to this file.</span>
                </span>
              </label>
            </>
          ) : (
            <p className="flex items-start gap-1.5">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
              No trades are linked to this import any more — only the record itself will be removed.
            </p>
          )}
          {state.message && !state.ok && <p className="text-loss">{state.message}</p>}
        </div>

        <form action={formAction} className="flex justify-end gap-2">
          <input type="hidden" name="batchId" value={batch.id} />
          <input type="hidden" name="cascade" value={cascade && batch.tradeCount > 0 ? "true" : "false"} />
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="destructive" disabled={pending}>
            {pending ? "Deleting…" : cascade && batch.tradeCount > 0 ? `Delete import + ${batch.tradeCount} trade${batch.tradeCount === 1 ? "" : "s"}` : "Delete import only"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
