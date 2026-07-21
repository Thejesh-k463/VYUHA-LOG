"use client";

import * as React from "react";
import { useActionState } from "react";
import {
  addEntryLegAction,
  addExitLegAction,
  deleteLegAction,
  applyStopAllAction,
  enableStagedAction,
  type ActionState,
} from "@/app/trades/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { inr } from "@/lib/format";
import { Layers, Plus, Minus, Trash2, TriangleAlert, Info, ShieldAlert, Target } from "lucide-react";
import type { Trade } from "@/lib/db/schema";
import type { StagedView } from "@/lib/queries/staged";

const today = () => new Date().toISOString().slice(0, 10);

function pnlClass(n: number) {
  return n > 0 ? "text-profit" : n < 0 ? "text-loss" : "";
}

/**
 * Quantity for a "book 25/50/100%" shortcut.
 *
 * Rounds DOWN to a whole unit whenever the open quantity is itself whole —
 * you cannot sell 762.5 shares, and offering it as a one-click default would
 * put an unfillable number into the journal. Genuinely fractional positions
 * (some commodity contracts) keep their precision.
 */
function fractionOf(openQty: number, f: number): number {
  const raw = openQty * f;
  if (f === 1) return openQty; // "All" must close the position exactly
  return Number.isInteger(openQty) ? Math.floor(raw) : Math.round(raw * 10000) / 10000;
}

function WarningRow({ level, message }: { level: string; message: string }) {
  const Icon = level === "action" ? ShieldAlert : level === "caution" ? TriangleAlert : Info;
  const tone =
    level === "action"
      ? "border-loss/45 text-loss"
      : level === "caution"
        ? "border-warning/45 text-warning"
        : "border-border text-muted-foreground";
  return (
    <div className={`flex items-start gap-2 rounded-lg border-l-2 bg-background/30 px-3 py-2 text-xs ${tone}`}>
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

/** One stat in the position header. */
function Stat({ label, value, cls, hint }: { label: string; value: string; cls?: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-background/30 p-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 font-mono text-sm tabular-nums ${cls ?? ""}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

/**
 * The staged-position workspace: the entry ladder, the money it adds up to,
 * and the two actions that change it (add another entry, book part of it).
 *
 * Every number rendered here comes from the server's replay of the ladder —
 * nothing is recomputed client-side, so what you see is what was booked.
 */
export function StagedPanel({ trade, onChanged }: { trade: Trade; onChanged?: () => void }) {
  const [view, setView] = React.useState<StagedView | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [addOpen, setAddOpen] = React.useState(false);
  const [exitOpen, setExitOpen] = React.useState(false);
  const [stopOpen, setStopOpen] = React.useState(false);

  // No setState before the await: the panel starts in its loading state and
  // only leaves it once the ladder actually arrives, so nothing renders twice.
  const load = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/trades/legs?tradeId=${trade.id}`, { cache: "no-store" });
      const json = await res.json();
      setView(json.view ?? null);
    } finally {
      setLoading(false);
    }
  }, [trade.id]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const refresh = React.useCallback(() => {
    void load();
    onChanged?.();
  }, [load, onChanged]);

  if (loading) {
    return <div className="py-8 text-center text-xs text-muted-foreground">Loading the ladder…</div>;
  }

  if (!view) return <EnableStaged trade={trade} onDone={refresh} />;

  const { position: p, mark, legs, direction } = view;
  const isLong = direction === "long";

  return (
    <div className="space-y-4">
      {/* ── Position summary ───────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        <Stat
          label="Open qty"
          value={`${p.openQty}`}
          hint={`${p.totalEntryQty} in · ${p.totalExitQty} out`}
        />
        <Stat
          label="Avg cost"
          value={p.avgOpenPrice != null ? `₹${p.avgOpenPrice}` : "—"}
          hint={p.entryCount > 1 ? `blended over ${p.entryCount} entries` : "single entry"}
        />
        <Stat label="Invested" value={inr(p.invested, { decimals: 0 })} />
        <Stat
          label="Realised"
          value={inr(p.realisedNet, { decimals: 0 })}
          cls={pnlClass(p.realisedNet)}
          hint={p.exitCount > 0 ? `${p.exitCount} exit${p.exitCount > 1 ? "s" : ""} · ${inr(p.realisedCharges, { decimals: 0 })} charges` : "nothing booked yet"}
        />
        <Stat
          label="Unrealised"
          value={p.openQty > 0 ? inr(mark.unrealised, { decimals: 0 }) : "—"}
          cls={pnlClass(mark.unrealised)}
          hint={view.markPrice != null ? `marked @ ₹${view.markPrice}` : "no mark set"}
        />
        <Stat
          label="Initial risk (1R)"
          value={p.initialRisk != null ? inr(p.initialRisk, { decimals: 0 }) : "—"}
          hint="frozen at the first entry"
        />
        <Stat
          label="Realised R"
          value={p.realisedR != null ? `${p.realisedR >= 0 ? "+" : ""}${p.realisedR}R` : "—"}
          cls={p.realisedR != null ? pnlClass(p.realisedR) : ""}
        />
        <Stat
          label="If all stops hit"
          value={mark.lossIfAllStopsHit != null ? inr(-mark.lossIfAllStopsHit, { decimals: 0 }) : "—"}
          cls={mark.lossIfAllStopsHit != null ? pnlClass(-mark.lossIfAllStopsHit) : ""}
          hint={mark.unstoppedQty > 0 ? `${mark.unstoppedQty} qty unstopped` : "from your cost basis"}
        />
      </div>

      {p.warnings.length > 0 && (
        <div className="space-y-1.5">
          {p.warnings.map((w, i) => (
            <WarningRow key={i} level={w.level} message={w.message} />
          ))}
        </div>
      )}

      {/* ── Actions ────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setAddOpen(true)} disabled={!trade.isOpen && p.openQty === 0}>
          <Plus className="size-3.5" /> Add entry
        </Button>
        <Button size="sm" variant="outline" onClick={() => setExitOpen(true)} disabled={p.openQty <= 0}>
          <Minus className="size-3.5" /> Book exit
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setStopOpen(true)} disabled={p.openTranches.length === 0}>
          <Target className="size-3.5" /> Set stop on all open
        </Button>
      </div>

      {/* ── The ladder ─────────────────────────────────────────────────── */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[720px] text-xs">
          <thead className="bg-card-hover text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">#</th>
              <th className="px-3 py-2 text-left">Fill</th>
              <th className="px-3 py-2 text-left">Date</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">Price</th>
              <th className="px-3 py-2 text-right">Stop</th>
              <th className="px-3 py-2 text-right">Open</th>
              <th className="px-3 py-2 text-right">Charges</th>
              <th className="px-3 py-2 text-right">Realised</th>
              <th className="px-3 py-2 text-right">R</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {legs.map((leg) => {
              const tranche = p.openTranches.find((t) => t.legId === leg.id);
              const fill = p.fills.find((f) => f.legId === leg.id);
              const isEntry = leg.kind === "entry";
              const stop = leg.trailingSl ?? leg.slPlanned;
              return (
                <tr key={leg.id} className="hover:bg-card-hover/50">
                  <td className="px-3 py-2 text-muted-foreground">{leg.seq}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                        isEntry ? "bg-primary/12 text-primary" : "bg-warning/12 text-warning"
                      }`}
                    >
                      {isEntry ? (isLong ? "BUY" : "SELL") : isLong ? "SELL" : "BUY"}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-muted-foreground">
                    {leg.tradeDate}
                    {leg.tradeTime ? ` ${leg.tradeTime}` : ""}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{leg.qty}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">₹{leg.price}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {isEntry ? (
                      stop != null ? (
                        <span className={leg.trailingSl != null ? "text-primary" : ""}>
                          ₹{stop}
                          {leg.trailingSl != null && <span className="ml-1 text-[9px] text-muted-foreground">TSL</span>}
                        </span>
                      ) : (
                        <span className="text-loss">none</span>
                      )
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {isEntry ? (tranche ? tranche.openQty : <span className="text-muted-foreground">closed</span>) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-warning">
                    {leg.chargesTotal ? inr(leg.chargesTotal, { decimals: 0 }) : "—"}
                  </td>
                  <td className={`px-3 py-2 text-right font-mono tabular-nums ${fill ? pnlClass(fill.netPnl) : ""}`}>
                    {fill ? inr(fill.netPnl, { decimals: 0 }) : "—"}
                  </td>
                  <td className={`px-3 py-2 text-right font-mono tabular-nums ${fill?.rContribution != null ? pnlClass(fill.rContribution) : ""}`}>
                    {fill?.rContribution != null ? `${fill.rContribution >= 0 ? "+" : ""}${fill.rContribution}R` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <DeleteLeg legId={leg.id} tradeId={trade.id} onDone={refresh} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {p.fills.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          Exits are priced against the blended average cost at the time of the fill, and quantity is
          retired oldest-tranche-first — so the surviving tranche keeps its own stop.
        </p>
      )}

      <AddEntryDialog trade={trade} open={addOpen} onOpenChange={setAddOpen} onDone={refresh} isLong={isLong} />
      <BookExitDialog
        trade={trade}
        open={exitOpen}
        onOpenChange={setExitOpen}
        onDone={refresh}
        openQty={p.openQty}
        avgCost={p.avgOpenPrice}
        isLong={isLong}
      />
      <StopAllDialog trade={trade} open={stopOpen} onOpenChange={setStopOpen} onDone={refresh} count={p.openTranches.length} />
    </div>
  );
}

/** Shown when a trade has no ladder yet. */
function EnableStaged({ trade, onDone }: { trade: Trade; onDone: () => void }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(enableStagedAction, { ok: false, message: "" });
  // Depend on the STATE OBJECT, not on state.ok. Each server action returns a
  // fresh object, so this fires on every submit — keying off `state.ok` alone
  // meant a second successful add never re-triggered (true → true is not a
  // change) and the dialog stayed open with the form already cleared.
  React.useEffect(() => {
    if (state.ok) onDone();
  }, [state, onDone]);

  return (
    <form action={formAction} className="rounded-lg border border-dashed border-border p-6 text-center">
      <input type="hidden" name="tradeId" value={trade.id} />
      <Layers className="mx-auto size-7 text-muted-foreground" />
      <h4 className="mt-3 text-sm font-semibold">Build this position in tranches</h4>
      <p className="mx-auto mt-1.5 max-w-md text-xs text-muted-foreground">
        Turn on staged mode to add more entries as the trade proves itself, give each tranche its own
        stop, and book partial exits. Your existing quantity and price become the first entry —
        nothing about the trade changes, and every number stays exactly where it is.
      </p>
      <Button type="submit" size="sm" className="mt-4" disabled={pending}>
        {pending ? "Enabling…" : "Enable staged mode"}
      </Button>
      {state.message && !state.ok && <p className="mt-2 text-xs text-loss">{state.message}</p>}
    </form>
  );
}

function DeleteLeg({ legId, tradeId, onDone }: { legId: number; tradeId: number; onDone: () => void }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(deleteLegAction, { ok: false, message: "" });
  // Depend on the STATE OBJECT, not on state.ok. Each server action returns a
  // fresh object, so this fires on every submit — keying off `state.ok` alone
  // meant a second successful add never re-triggered (true → true is not a
  // change) and the dialog stayed open with the form already cleared.
  React.useEffect(() => {
    if (state.ok) onDone();
  }, [state, onDone]);
  return (
    <form action={formAction} className="inline">
      <input type="hidden" name="legId" value={legId} />
      <input type="hidden" name="tradeId" value={tradeId} />
      <Button
        type="submit"
        size="icon"
        variant="ghost"
        className="size-6 text-muted-foreground hover:text-loss"
        title={state.message || "Remove this fill"}
        disabled={pending}
      >
        <Trash2 className="size-3" />
      </Button>
    </form>
  );
}

function AddEntryDialog({
  trade, open, onOpenChange, onDone, isLong,
}: {
  trade: Trade; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void; isLong: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(addEntryLegAction, { ok: false, message: "" });
  // Depend on the STATE OBJECT, not on state.ok. Each server action returns a
  // fresh object, so this fires on every submit — keying off `state.ok` alone
  // meant a second successful add never re-triggered (true → true is not a
  // change) and the dialog stayed open with the form already cleared.
  React.useEffect(() => {
    if (state.ok) {
      onOpenChange(false);
      onDone();
    }
  }, [state, onOpenChange, onDone]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add to {trade.symbol}</DialogTitle>
          <DialogDescription>
            Another {isLong ? "buy" : "sell"} tranche. Give it its own stop — adding without raising
            the stop on your earlier tranches increases the total you stand to lose.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="tradeId" value={trade.id} />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="se-qty">Quantity</Label>
              <Input id="se-qty" name="qty" type="number" step="any" min="0" required />
            </div>
            <div>
              <Label htmlFor="se-price">Price</Label>
              <Input id="se-price" name="price" type="number" step="any" min="0" required />
            </div>
            <div>
              <Label htmlFor="se-date">Date</Label>
              <Input id="se-date" name="tradeDate" type="date" defaultValue={today()} required />
            </div>
            <div>
              <Label htmlFor="se-time">Time (optional)</Label>
              <Input id="se-time" name="tradeTime" type="time" />
            </div>
            <div>
              <Label htmlFor="se-sl">Stop for this tranche</Label>
              <Input id="se-sl" name="slPlanned" type="number" step="any" min="0" />
            </div>
            <div>
              <Label htmlFor="se-target">Target (optional)</Label>
              <Input id="se-target" name="targetPlanned" type="number" step="any" min="0" />
            </div>
          </div>
          <div>
            <Label htmlFor="se-note">Why this add? (optional)</Label>
            <Input id="se-note" name="note" placeholder="e.g. broke out of the flag on volume" />
          </div>
          {state.message && (
            <p className={`text-xs ${state.ok ? "text-profit" : "text-loss"}`}>{state.message}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={pending}>{pending ? "Adding…" : "Add entry"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BookExitDialog({
  trade, open, onOpenChange, onDone, openQty, avgCost, isLong,
}: {
  trade: Trade; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void;
  openQty: number; avgCost: number | null; isLong: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(addExitLegAction, { ok: false, message: "" });
  const [qty, setQty] = React.useState("");
  const [price, setPrice] = React.useState("");

  // Depend on the STATE OBJECT, not on state.ok. Each server action returns a
  // fresh object, so this fires on every submit — keying off `state.ok` alone
  // meant a second successful add never re-triggered (true → true is not a
  // change) and the dialog stayed open with the form already cleared.
  React.useEffect(() => {
    if (state.ok) {
      onOpenChange(false);
      onDone();
    }
  }, [state, onOpenChange, onDone]);

  const q = Number(qty) || 0;
  const px = Number(price) || 0;
  const gross = avgCost != null && q > 0 && px > 0 ? (isLong ? px - avgCost : avgCost - px) * q : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Book an exit — {trade.symbol}</DialogTitle>
          <DialogDescription>
            {openQty} open at an average cost of {avgCost != null ? `₹${avgCost}` : "—"}. Exit part of
            it and the rest keeps running with its own stops.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="tradeId" value={trade.id} />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="sx-qty">Quantity to exit</Label>
              <Input
                id="sx-qty" name="qty" type="number" step="any" min="0" max={openQty} required
                value={qty} onChange={(e) => setQty(e.target.value)}
              />
              <div className="mt-1 flex gap-1">
                {[0.25, 0.5, 1].map((f) => (
                  <button
                    key={f}
                    type="button"
                    className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-primary/50 hover:text-primary"
                    onClick={() => setQty(String(fractionOf(openQty, f)))}
                  >
                    {f === 1 ? "All" : `${f * 100}%`}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <Label htmlFor="sx-price">Exit price</Label>
              <Input
                id="sx-price" name="price" type="number" step="any" min="0" required
                value={price} onChange={(e) => setPrice(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="sx-date">Date</Label>
              <Input id="sx-date" name="tradeDate" type="date" defaultValue={today()} required />
            </div>
            <div>
              <Label htmlFor="sx-time">Time (optional)</Label>
              <Input id="sx-time" name="tradeTime" type="time" />
            </div>
          </div>

          {gross != null && (
            <div className="rounded-lg border border-border bg-background/30 p-3 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Gross on this exit</span>
                <span className={`font-mono tabular-nums ${pnlClass(gross)}`}>{inr(gross, { decimals: 0 })}</span>
              </div>
              <p className="mt-1.5 text-[10px] text-muted-foreground">
                Priced against the blended average, before charges. The exact charge is computed on
                this fill when you book it.
              </p>
            </div>
          )}

          <div>
            <Label htmlFor="sx-note">Note (optional)</Label>
            <Input id="sx-note" name="note" placeholder="e.g. booked half at the first target" />
          </div>
          {state.message && (
            <p className={`text-xs ${state.ok ? "text-profit" : "text-loss"}`}>{state.message}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={pending}>{pending ? "Booking…" : "Book exit"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function StopAllDialog({
  trade, open, onOpenChange, onDone, count,
}: {
  trade: Trade; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void; count: number;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(applyStopAllAction, { ok: false, message: "" });
  // Depend on the STATE OBJECT, not on state.ok. Each server action returns a
  // fresh object, so this fires on every submit — keying off `state.ok` alone
  // meant a second successful add never re-triggered (true → true is not a
  // change) and the dialog stayed open with the form already cleared.
  React.useEffect(() => {
    if (state.ok) {
      onOpenChange(false);
      onDone();
    }
  }, [state, onOpenChange, onDone]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Set one stop across {count} open tranche{count === 1 ? "" : "s"}</DialogTitle>
          <DialogDescription>
            Writes the same stop to every tranche still open. Tranches you have already exited are
            left untouched — rewriting those would falsify what you actually did.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="tradeId" value={trade.id} />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="sa-tsl">Trailing stop</Label>
              <Input id="sa-tsl" name="trailingSl" type="number" step="any" min="0" />
            </div>
            <div>
              <Label htmlFor="sa-sl">Original stop</Label>
              <Input id="sa-sl" name="slPlanned" type="number" step="any" min="0" />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Leave a field blank to clear that stop on every open tranche.
          </p>
          {state.message && (
            <p className={`text-xs ${state.ok ? "text-profit" : "text-loss"}`}>{state.message}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={pending}>{pending ? "Applying…" : "Apply to all open"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
