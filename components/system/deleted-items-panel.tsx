"use client";

/**
 * Deleted items — the other half of the delete story.
 *
 * Every delete writes a snapshot of exactly the rows it removed (lib/trash.ts).
 * This lists them and puts them back. Two pieces of copy here are load-bearing
 * and should not be softened:
 *
 *   - restoring can PARTIALLY succeed, when a trade has come back by another
 *     route (a re-import) since the delete. The panel reports what was skipped
 *     rather than showing a clean tick over an incomplete restore;
 *   - purging is the point of no return, and is the only place in the app that
 *     says so without qualification.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/toaster";
import { EmptyState } from "@/components/ui/empty-state";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { inr, fmtDate, signedClass } from "@/lib/format";
import type { TrashSummary } from "@/lib/trash-format";
import { Undo2, Trash2, TriangleAlert } from "lucide-react";

function kb(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function DeletedItemsPanel({ snapshots }: { snapshots: TrashSummary[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [purging, setPurging] = React.useState<TrashSummary | null>(null);

  async function call(action: "restore" | "purge", id: string) {
    setBusy(id);
    try {
      const res = await fetch("/api/trash", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, id }),
      });
      const data = await res.json();
      if (data.ok) toast.success(data.message);
      else toast.error(data.message ?? "That did not work.");
      router.refresh();
    } catch (e) {
      toast.error(`Could not reach the app — ${e instanceof Error ? e.message : "unknown error"}.`);
    } finally {
      setBusy(null);
      setPurging(null);
    }
  }

  if (snapshots.length === 0) {
    return (
      <EmptyState
        variant="journal"
        title="Nothing deleted yet"
        hint="When you delete trades, a snapshot of exactly what was removed is saved here so you can put it back."
      />
    );
  }

  const totalBytes = snapshots.reduce((s, x) => s + x.sizeBytes, 0);

  return (
    <>
      <ReportTable>
        <ReportThead>
          <ReportTh>Deleted</ReportTh>
          <ReportTh>What went</ReportTh>
          <ReportTh align="right">Trades</ReportTh>
          <ReportTh align="right">Net P&amp;L</ReportTh>
          <ReportTh align="right">Size</ReportTh>
          <ReportTh aria-label="Actions" />
        </ReportThead>
        <tbody>
          {snapshots.map((s) => (
            <ReportTr key={s.id}>
              <ReportTd muted>{fmtDate(s.deletedAt)}</ReportTd>
              <ReportTd>
                <span>{s.reason}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {s.symbols.join(", ")}
                  {s.symbolCount > s.symbols.length && ` +${s.symbolCount - s.symbols.length} more`}
                  {s.earliest && s.latest && ` · ${s.earliest} → ${s.latest}`}
                  {s.attachments > 0 && ` · ${s.attachments} attachment${s.attachments === 1 ? "" : "s"}`}
                </span>
              </ReportTd>
              <ReportTd align="right">{s.trades}</ReportTd>
              <ReportTd align="right" className={signedClass(s.netPnl)}>{inr(s.netPnl, { decimals: 0 })}</ReportTd>
              <ReportTd align="right" muted>{kb(s.sizeBytes)}</ReportTd>
              <ReportTd className="text-right">
                <div className="flex items-center justify-end gap-1">
                  <Button size="sm" variant="ghost" disabled={busy === s.id} onClick={() => call("restore", s.id)} title="Put these trades back">
                    <Undo2 className="size-3.5" /> {busy === s.id ? "Working…" : "Restore"}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy === s.id} onClick={() => setPurging(s)} title="Delete this snapshot for good">
                    <Trash2 className="size-3.5 text-loss" />
                  </Button>
                </div>
              </ReportTd>
            </ReportTr>
          ))}
        </tbody>
      </ReportTable>

      <p className="mt-2 text-[0.6875rem] text-muted-foreground">
        {snapshots.length} snapshot{snapshots.length === 1 ? "" : "s"} taking {kb(totalBytes)}. Snapshots are never removed
        automatically — a scheduled job quietly destroying the last copy of deleted work is worse than a folder that grows.
        They sit beside the database, so they survive a restore and are not carried inside a backup file.
      </p>

      <Dialog open={purging != null} onOpenChange={(v) => !v && setPurging(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-4 text-loss" /> Remove this snapshot for good?
            </DialogTitle>
            <DialogDescription>{purging?.reason}</DialogDescription>
          </DialogHeader>
          <p className="text-xs">
            {purging?.trades} trade{purging?.trades === 1 ? "" : "s"} and {purging?.attachments ?? 0} attachment
            {purging?.attachments === 1 ? "" : "s"} will stop being recoverable. This is the only copy — after this, only a
            backup file taken before the delete can bring them back.
          </p>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setPurging(null)}>Cancel</Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy != null}
              onClick={() => purging && call("purge", purging.id)}
            >
              {busy ? "Removing…" : "Remove permanently"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Count for the section header — kept next to the panel that renders it. */
export function DeletedItemsBadge({ snapshots }: { snapshots: TrashSummary[] }) {
  const trades = snapshots.reduce((s, x) => s + x.trades, 0);
  return <Badge variant="secondary">{trades} recoverable</Badge>;
}
