"use client";

/**
 * "Delete by…" — choosing WHAT to delete, before confirming it.
 *
 * `lib/domain/delete-scope.ts` has understood these scopes since the delete
 * engine was written; until now only row-selection could reach them. This is
 * the chooser, and it is deliberately not the confirmation: picking a scope
 * shows a live count, and committing hands the RESOLVED ids to
 * `DeleteTradesDialog`, which is the one place a delete is confirmed. Two
 * dialogs, one confirmation — so there is exactly one screen in the app that
 * can start a deletion, and it always shows the true blast radius.
 *
 * ── Why the count updates as you type ───────────────────────────────────────
 *
 * A date range is the scope most likely to be wrong, and it is wrong silently:
 * "1 April to 30 June" reads fine and quietly includes a quarter you meant to
 * keep. The count and the P&L move as the dates change, so the mistake is
 * visible before the confirm dialog is ever opened.
 *
 * ── What is not offered ─────────────────────────────────────────────────────
 *
 * No "delete everything", and no per-account scope. Wiping the journal is what
 * Backup & Restore is for, and the aggregate "All accounts" view can never
 * receive a write (invariant 9). Both omissions are deliberate.
 */

import * as React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import {
  resolveDeleteScope, manualBatches, brokerGroups, segmentGroups,
  type DeletableTrade, type DeleteScope, type DeletePreview, type DateBasis,
} from "@/lib/domain/delete-scope";
import { BROKER_LABELS, SEGMENT_LABELS, type Broker, type Segment } from "@/lib/domain/constants";
import { inr } from "@/lib/format";
import { Trash2 } from "lucide-react";

type ScopeKind = "dateRange" | "filter" | "manualDay" | "broker" | "segment";

const KINDS: { value: ScopeKind; label: string; hint: string }[] = [
  { value: "dateRange", label: "A date range", hint: "Trades whose entry or exit falls inside the range." },
  { value: "filter", label: "Everything this view is showing", hint: "Exactly the rows the table has on screen, after every filter." },
  { value: "manualDay", label: "One day's hand-entered trades", hint: "Typed in on that day. Trades imported the same day are not touched." },
  { value: "broker", label: "One broker", hint: "Every trade placed at that broker, in this account." },
  { value: "segment", label: "One trade type", hint: "Every trade in that segment, in this account." },
];

export function DeleteScopeDialog({
  candidates,
  viewIds,
  viewLabel,
  open,
  onOpenChange,
  onCommit,
}: {
  /** The whole account-scoped book — NOT the filtered rows. A date-range
   *  delete must be able to reach a trade the current filter is hiding, or the
   *  count is a lie about what the range contains. */
  candidates: DeletableTrade[];
  /** Ids the table is currently showing, for the "this view" scope. */
  viewIds: number[];
  viewLabel: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCommit: (preview: DeletePreview, reason: string) => void;
}) {
  const [kind, setKind] = React.useState<ScopeKind>("dateRange");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [basis, setBasis] = React.useState<DateBasis>("either");
  const [day, setDay] = React.useState("");
  const [broker, setBroker] = React.useState("");
  const [segment, setSegment] = React.useState("");

  const manualDays = React.useMemo(() => manualBatches(candidates), [candidates]);
  const brokers = React.useMemo(() => brokerGroups(candidates), [candidates]);
  const segments = React.useMemo(() => segmentGroups(candidates), [candidates]);

  const scope: DeleteScope | null = React.useMemo(() => {
    switch (kind) {
      case "dateRange":
        // Both ends required, and the wrong way round is not silently swapped:
        // a reversed range is a mistake, and quietly "fixing" it would delete
        // a span the user never described.
        return from && to && from <= to ? { kind: "dateRange", from, to, basis } : null;
      case "filter":
        return viewIds.length > 0 ? { kind: "filter", ids: viewIds, label: viewLabel } : null;
      case "manualDay":
        return day ? { kind: "manualDay", date: day } : null;
      case "broker":
        return broker ? { kind: "broker", broker } : null;
      case "segment":
        return segment ? { kind: "segment", segment } : null;
    }
  }, [kind, from, to, basis, viewIds, viewLabel, day, broker, segment]);

  const preview = React.useMemo(
    () => (scope ? resolveDeleteScope(candidates, scope) : null),
    [scope, candidates],
  );

  const reason = React.useMemo(() => {
    switch (kind) {
      case "dateRange": return `deleted by date range ${from} → ${to} (${basis})`;
      case "filter": return `deleted from the trades view — ${viewLabel}`;
      case "manualDay": return `deleted hand-entered trades from ${day}`;
      case "broker": return `deleted every ${broker} trade`;
      case "segment": return `deleted every ${segment} trade`;
    }
  }, [kind, from, to, basis, viewLabel, day, broker, segment]);

  const active = KINDS.find((k) => k.value === kind)!;
  const reversed = kind === "dateRange" && !!from && !!to && from > to;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="size-4 text-loss" /> Delete by…
          </DialogTitle>
          <DialogDescription>Pick what to remove. Nothing is deleted until you confirm on the next screen.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-xs">
          <div>
            <Label htmlFor="scope-kind">Scope</Label>
            <Select id="scope-kind" value={kind} onChange={(e) => setKind(e.target.value as ScopeKind)} className="mt-1 h-8 w-full">
              {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </Select>
            <p className="mt-1 text-muted-foreground">{active.hint}</p>
          </div>

          {kind === "dateRange" && (
            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label htmlFor="scope-from">From</Label>
                <Input id="scope-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 h-8" />
              </div>
              <div>
                <Label htmlFor="scope-to">To</Label>
                <Input id="scope-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 h-8" />
              </div>
              <div>
                <Label htmlFor="scope-basis">Match on</Label>
                <Select id="scope-basis" value={basis} onChange={(e) => setBasis(e.target.value as DateBasis)} className="mt-1 h-8">
                  <option value="either">Entry or exit</option>
                  <option value="entry">Entry date</option>
                  <option value="exit">Exit date</option>
                </Select>
              </div>
            </div>
          )}

          {kind === "manualDay" && (
            <div>
              <Label htmlFor="scope-day">Day</Label>
              <Select id="scope-day" value={day} onChange={(e) => setDay(e.target.value)} className="mt-1 h-8 w-full">
                <option value="">Choose a day…</option>
                {manualDays.map((g) => (
                  <option key={g.key} value={g.scope.kind === "manualDay" ? g.scope.date : ""}>
                    {g.label} ({g.count})
                  </option>
                ))}
              </Select>
              {manualDays.length === 0 && <p className="mt-1 text-muted-foreground">Nothing in this account was entered by hand.</p>}
            </div>
          )}

          {kind === "broker" && (
            <div>
              <Label htmlFor="scope-broker">Broker</Label>
              <Select id="scope-broker" value={broker} onChange={(e) => setBroker(e.target.value)} className="mt-1 h-8 w-full">
                <option value="">Choose a broker…</option>
                {brokers.map((g) => (
                  <option key={g.key} value={g.label}>
                    {BROKER_LABELS[g.label as Broker] ?? g.label} ({g.count})
                  </option>
                ))}
              </Select>
            </div>
          )}

          {kind === "segment" && (
            <div>
              <Label htmlFor="scope-segment">Trade type</Label>
              <Select id="scope-segment" value={segment} onChange={(e) => setSegment(e.target.value)} className="mt-1 h-8 w-full">
                <option value="">Choose a type…</option>
                {segments.map((g) => (
                  <option key={g.key} value={g.label}>
                    {SEGMENT_LABELS[g.label as Segment] ?? g.label} ({g.count})
                  </option>
                ))}
              </Select>
            </div>
          )}

          {/* The live count. This is the whole reason the chooser is a separate
              step — a wrong range is visible here, before the confirm screen. */}
          <div className="rounded-md border border-border p-2.5">
            {reversed ? (
              <span className="text-warning">The end date is before the start date.</span>
            ) : !preview ? (
              <span className="text-muted-foreground">Choose a scope to see what it matches.</span>
            ) : preview.empty ? (
              <span className="text-muted-foreground">Nothing matches — there is nothing to delete.</span>
            ) : (
              <>
                <span>
                  <b>{preview.count}</b> trade{preview.count === 1 ? "" : "s"} · {preview.open} open · net{" "}
                  <span className={preview.netPnl >= 0 ? "text-profit" : "text-loss"}>{inr(preview.netPnl, { decimals: 0 })}</span>
                </span>
                <span className="mt-1 block text-muted-foreground">
                  {preview.symbols.join(", ")}
                  {preview.symbolCount > preview.symbols.length && ` +${preview.symbolCount - preview.symbols.length} more`}
                  {preview.earliest && preview.latest && ` · ${preview.earliest} → ${preview.latest}`}
                </span>
              </>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!preview || preview.empty}
            onClick={() => preview && onCommit(preview, reason)}
          >
            Review {preview && !preview.empty ? preview.count : ""} trade{preview?.count === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
