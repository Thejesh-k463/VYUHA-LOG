"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DialogHeader, DialogTitle, DialogDescription, DialogClose, DialogFooter } from "@/components/ui/dialog";
import { inrCompact, num } from "@/lib/format";
import { toast } from "@/components/ui/toaster";

/**
 * The stop / target editor for ONE open position — the body of a `<Dialog>`
 * (the caller owns the `<Dialog>` / `<DialogContent>` wrapper and its open state).
 *
 * EXTRACTED from `components/risk/risk-cockpit-client.tsx` in v4.7.0 wave C4
 * (D11) so the `/live` Positions card can open the same editor. `/risk` passes
 * `invested` and `mark` and keeps the same five fields and the same toasts
 * (its body follows the changed-fields rule below, like every caller's).
 *
 * THE SAVE PATH (AGENTS.md): route handler + client `fetch`, then the caller's
 * `onDone` runs `router.refresh()` — never a server action, which would refresh
 * the route itself and remount sibling client components.
 *
 * Without `mark` the dialog edits ONLY the three levels, and the body carries
 * ONLY those keys: `app/api/positions/risk/route.ts` writes only the fields
 * present, so a levels-only save can neither type a mark nor clear an IV.
 *
 * Since the C4 fix wave (fix 3) the body carries only the fields the user
 * CHANGED (`changedFields`), on both callers, and an untouched Save posts
 * nothing — it closes through `onDone`.
 *
 * Every value here is RUPEES (per-unit LEVELS, invariant 1) — what the route
 * reads. A paise caller divides by 100 once, at its own boundary.
 */
export interface RiskEditDialogProps {
  tradeId: number;
  symbol: string;
  /** Per-unit average entry, rupees. */
  avgEntry: number;
  openQty: number;
  originalSl: number | null;
  trailingSl: number | null;
  target: number | null;
  /** Runs after a successful save — the caller closes the dialog and calls `router.refresh()`. */
  onDone: () => void;
  /** `/risk` only: the invested value shown in the description. */
  invested?: number;
  /** `/risk` only: the MTM field and (for an option) the IV field, sent when changed. */
  mark?: { mtm: number; impliedVol?: number | null; optionType?: string | null };
}

/**
 * The POST body: `tradeId` plus ONLY the fields whose text differs from the text
 * the dialog opened with; null when nothing changed (C4 fix 3).
 *
 * WHY: a caller that holds levels as paise (the `/live` card) pre-fills a stored
 * REAL 1450.125 as "1450.13", so re-posting an untouched field rounded a level
 * the user never typed (invariant 1: prices stay REAL). The route writes only the
 * keys present, so an unsent field keeps its stored value exactly. A field the
 * user cleared is sent as "" (the route's "clear"), because "" differs from the
 * pre-filled text.
 */
export type RiskEditBody = { tradeId: number } & Record<string, string | number>;

export function changedFields(current: RiskEditBody, initial: Readonly<Record<string, string>>): RiskEditBody | null {
  const body: RiskEditBody = { tradeId: current.tradeId };
  let changed = false;
  for (const [k, v] of Object.entries(current)) {
    if (k === "tradeId" || v === initial[k]) continue;
    body[k] = v;
    changed = true;
  }
  return changed ? body : null;
}

export function RiskEditDialog({
  tradeId,
  symbol,
  avgEntry,
  openQty,
  originalSl: originalSl0,
  trailingSl: trailingSl0,
  target: target0,
  onDone,
  invested,
  mark,
}: RiskEditDialogProps) {
  // The texts the fields OPENED with — what a save diffs against (fixed at mount;
  // the callers key the dialog by trade, so a new trade is a new mount).
  const [initial] = React.useState(() => ({
    originalSl: originalSl0 == null ? "" : String(originalSl0),
    trailingSl: trailingSl0 == null ? "" : String(trailingSl0),
    target: target0 == null ? "" : String(target0),
    mtmPrice: mark ? String(mark.mtm) : "",
    impliedVol: mark?.impliedVol == null ? "" : String(mark.impliedVol),
  }));
  const [originalSl, setOriginalSl] = React.useState(initial.originalSl);
  const [trailingSl, setTrailingSl] = React.useState(initial.trailingSl);
  const [target, setTarget] = React.useState(initial.target);
  const [mtmPrice, setMtmPrice] = React.useState(initial.mtmPrice);
  const [impliedVol, setImpliedVol] = React.useState(initial.impliedVol);
  const [pending, setPending] = React.useState(false);

  async function save() {
    const all: RiskEditBody = mark
      ? { tradeId, originalSl, trailingSl, target, mtmPrice, impliedVol }
      : { tradeId, originalSl, trailingSl, target };
    const body = changedFields(all, initial);
    // Nothing changed: no request, no write — just close (the caller's onDone).
    if (body === null) {
      onDone();
      return;
    }
    setPending(true);
    try {
      const res = await fetch("/api/positions/risk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.ok) {
        // The route says when it kept the stops but not the price (a premium
        // typed on an option/future is not stored under the underlying); that
        // sentence must reach the screen, not just the HTTP body.
        const msg = typeof json.message === "string" && json.message !== "Saved." ? json.message : "Risk inputs saved.";
        toast.success(msg);
        onDone();
      } else {
        toast.error(json.message ?? "Failed");
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{symbol} — risk inputs</DialogTitle>
        <DialogDescription>
          Entry {num(avgEntry, 2)} · {num(openQty, 0)} qty{invested !== undefined && <> · invested {inrCompact(invested)}</>}
        </DialogDescription>
      </DialogHeader>
      <div className="grid grid-cols-2 gap-3">
        <Fld label="Original SL"><Input type="number" step="any" value={originalSl} onChange={(e) => setOriginalSl(e.target.value)} /></Fld>
        <Fld label="Trailing SL (TSL)"><Input type="number" step="any" value={trailingSl} onChange={(e) => setTrailingSl(e.target.value)} /></Fld>
        <Fld label="Target"><Input type="number" step="any" value={target} onChange={(e) => setTarget(e.target.value)} /></Fld>
        {mark && (
          <Fld label="Current price (MTM)"><Input type="number" step="any" value={mtmPrice} onChange={(e) => setMtmPrice(e.target.value)} /></Fld>
        )}
        {mark?.optionType && (
          <Fld label="Implied vol % (for Greeks)">
            <Input type="number" step="any" value={impliedVol} onChange={(e) => setImpliedVol(e.target.value)} placeholder="e.g. 15 — blank = 20% default" />
          </Fld>
        )}
      </div>
      <DialogFooter>
        <DialogClose asChild><Button type="button" variant="ghost">Cancel</Button></DialogClose>
        <Button type="button" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
      </DialogFooter>
    </>
  );
}

function Fld({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
