"use client";

/**
 * R26 (v4.3.0; owner ruling R10 half b) — open positions whose closing trade
 * the book stored as a row of its own, and the one button that joins them.
 *
 * v4.2.0 wrote a SELL of a held lot as its own open row, so the position still
 * reads open and the sale reads as a second position. With auto-close off for
 * 4.3.0 this card is the remedy: "Close with the recorded sale" closes the lot
 * at the sale row's own price and quantity, and removes the sale row
 * (recoverable from Deleted items). Nothing is typed — except, when the sale
 * row states no date, the date: it is pre-filled with the day the row was
 * pulled (IST) and the user accepts or edits it before the write, because a
 * close date sets the charge rates, the holding period and MTF interest.
 *
 * A partial pair (quantities differ, or one sale allocated across several
 * lots — W2-DQ P1) and a sale carrying the user's own journal entries get no
 * button — they are stated, and the partial one links to the manual close.
 * A STAGED lot (W2-FIXD2 — e.g. a holding bought in two fills on one day) is
 * listed with no button and links to Trades, where its ladder books the exit:
 * the join writes no exit leg, and the server refuses it (STAGED).
 * R2-DQ N7/N8 — an AMBIGUOUS pair (a closed lot in the book entered on or
 * before the sale may already have taken it) is listed for review with no
 * button and a link to Trades; the server refuses it (AMBIGUOUS). N10 — a sale
 * recorded in several fills is stated as such, with a link to Trades (FILLS).
 * Neither the staged nor the partial copy promises where the recorded sale is
 * listed afterwards: that depends on the rest of the book.
 * The server re-derives every pair before it writes.
 *
 * W2-DQ P2 — the manual close leaves the recorded sale rows in the journal,
 * open and with no lot. Those rows (the `stale_sale` warning) are listed in
 * the same card, with a link to the trades table and NO action here.
 *
 * The write is a route handler + `fetch` + `router.refresh()`, never a server
 * action (AGENTS.md). Focus returns to the button that opened the dialog.
 * No state is synced in an effect: opening the dialog sets its fields in the
 * click handler.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toaster";
import { num } from "@/lib/format";
import { serializeTradesQuery } from "@/lib/domain/trades-query";
import { LEGACY_SHORT_PAIR_NOTE, staleAmbiguousNote } from "@/lib/analytics/data-quality";

/** Structurally `StaleOpenView` (lib/queries/data-quality.ts), restated for the client. */
export interface StaleLotFixPair {
  lotId: number;
  saleId: number;
  symbol: string;
  tradingsymbol: string;
  side: "long" | "short";
  lotQty: number;
  lotPrice: number;
  lotDate: string;
  saleQty: number;
  /** The part of the sale allocated to this lot (oldest lot first). */
  matchedQty: number;
  salePrice: number;
  saleDate: string;
  saleDateStated: boolean;
  oneClick: boolean;
  /** The lot is a staged position (W2-FIXD2): listed, closed on its own ladder. */
  staged: boolean;
  /** R2-DQ N7/N8 — a closed lot in the book may already have taken the sale: review only. */
  ambiguous: boolean;
  closedLotIds: number[];
  /** R2-DQ N10 — the sale was recorded in several fills. */
  saleStaged: boolean;
  /** v4.6.0 W6 (D5) — a pre-4.6 import's two rows of one overnight F&O short. */
  legacyShort: boolean;
  blocked: string | null;
}

/** Structurally `StaleSaleRow` (lib/analytics/data-quality.ts), restated for the client. */
export interface StaleLotFixSale {
  saleId: number;
  symbol: string;
  tradingsymbol: string;
  side: "long" | "short";
  saleQty: number;
  salePrice: number;
  saleDate: string;
  saleDateStated: boolean;
  closedLotIds: number[];
}

const what = (p: { side: "long" | "short" }) => (p.side === "long" ? "sale" : "purchase");

export function StaleLotFix({ pairs, sales = [] }: { pairs: StaleLotFixPair[]; sales?: StaleLotFixSale[] }) {
  const router = useRouter();
  const openerRef = React.useRef<HTMLButtonElement | null>(null);
  const [target, setTarget] = React.useState<StaleLotFixPair | null>(null);
  const [date, setDate] = React.useState("");
  // True once the user has accepted the date: at once when the sale row states
  // its own, and only by ticking or editing it when the date is the pull day.
  const [dateAccepted, setDateAccepted] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  function open(p: StaleLotFixPair, opener: HTMLButtonElement) {
    openerRef.current = opener;
    setDate(p.saleDate);
    setDateAccepted(p.saleDateStated);
    setTarget(p);
  }

  async function run(p: StaleLotFixPair, exitDate: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/data-quality/close-stale", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lotId: p.lotId, saleId: p.saleId, exitDate }),
      });
      const json = (await res.json()) as { ok?: boolean; message?: string };
      setTarget(null);
      if (json.ok) toast.success(json.message ?? "Closed.");
      else toast.error(json.message ?? "Nothing was changed.");
      router.refresh();
    } catch {
      toast.error("Nothing was changed. Reload the page and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (pairs.length === 0 && sales.length === 0) return null;

  return (
    <Card className="p-0" id="stale-open">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="size-4" />
          Open positions with their closing trade stored beside them
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 p-5 pt-0">
        {pairs.map((p) => (
          <div key={`${p.lotId}:${p.saleId}`} className="rounded-md border border-border p-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium">{p.tradingsymbol}</p>
              <Badge variant="outline">{p.side}</Badge>
              <span className="text-muted-foreground">
                open {num(p.lotQty, 0)} @ {num(p.lotPrice)} since {p.lotDate} · recorded {what(p)} {num(p.saleQty, 0)} @{" "}
                {num(p.salePrice)}
                {p.matchedQty !== p.saleQty ? ` (${num(p.matchedQty, 0)} of it against this position)` : ""} ·{" "}
                {p.saleDateStated ? p.saleDate : `pulled ${p.saleDate}, no date stated`}
              </span>
            </div>
            {p.legacyShort && (
              <p className="mt-2 text-muted-foreground" data-stale-legacy-short="">
                {LEGACY_SHORT_PAIR_NOTE}
              </p>
            )}
            {p.ambiguous ? (
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between" data-stale-review="">
                <p className="text-muted-foreground">{staleAmbiguousNote(p)}</p>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/trades${serializeTradesQuery({ symbol: p.symbol })}`}>Open in Trades</Link>
                </Button>
              </div>
            ) : p.blocked ? (
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between" data-stale-blocked="">
                <p className="text-muted-foreground">{p.blocked}</p>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/trades${serializeTradesQuery({ symbol: p.symbol, view: "open" })}`}>Open in Trades</Link>
                </Button>
              </div>
            ) : p.staged ? (
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between" data-stale-staged="">
                <p className="text-muted-foreground">
                  This is a staged position built from more than one fill, so it is not joined with the recorded {what(p)}{" "}
                  in one step. Its exit is booked on its own ladder in Trades, which prices each tranche and keeps R at the
                  first entry. That exit does not change the recorded {what(p)} row, which stays in the journal as a row of
                  its own.
                </p>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/trades${serializeTradesQuery({ symbol: p.symbol, view: "open" })}`}>Open in Trades</Link>
                </Button>
              </div>
            ) : p.oneClick ? (
              <div className="mt-2">
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={(e) => open(p, e.currentTarget)}>
                  {p.side === "long" ? "Close with the recorded sale" : "Close with the recorded purchase"}
                </Button>
              </div>
            ) : (
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-muted-foreground">
                  The recorded {what(p)} is {num(p.saleQty, 0)} and the position holds {num(p.lotQty, 0)}, so they are not
                  joined in one step. The manual close records the price you enter; it does not change the recorded{" "}
                  {what(p)} row, which stays in the journal as a row of its own.
                </p>
                <Button asChild size="sm" variant="outline">
                  <Link href="/risk">Open the manual close</Link>
                </Button>
              </div>
            )}
          </div>
        ))}
        {sales.length > 0 && (
          <div className="space-y-2 pt-2" data-stale-sales="">
            <p className="text-xs font-medium">Closing trades with no open position left to close</p>
            {sales.map((s) => (
              <div key={`sale:${s.saleId}`} className="rounded-md border border-border p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{s.tradingsymbol}</p>
                  <Badge variant="outline">{what(s)}</Badge>
                  <span className="text-muted-foreground">
                    recorded {what(s)} {num(s.saleQty, 0)} @ {num(s.salePrice)} ·{" "}
                    {s.saleDateStated ? s.saleDate : `pulled ${s.saleDate}, no date stated`}
                  </span>
                </div>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-muted-foreground">
                    This row is still open on its own. The position in {s.tradingsymbol} entered on or before it (trade{" "}
                    {s.closedLotIds.map((id) => `#${id}`).join(", ")}) is already closed, so no open position is left for it to
                    close. It is listed here and not changed.
                  </p>
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/trades${serializeTradesQuery({ symbol: s.symbol, view: "open" })}`}>Open in Trades</Link>
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog
        open={target !== null}
        onOpenChange={(v) => {
          if (!v && !busy) setTarget(null);
        }}
      >
        <DialogContent
          className="max-w-md"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            openerRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              Close {target?.tradingsymbol} with the recorded {target ? what(target) : "sale"}
            </DialogTitle>
            <DialogDescription>
              {target
                ? `${num(target.lotQty, 0)} ${target.tradingsymbol} open since ${target.lotDate} at ${num(target.lotPrice)} ` +
                  `${target.side === "long" ? "closes" : "is covered"} at the recorded ${what(target)}'s price, ${num(target.salePrice)}, ` +
                  `for its ${num(target.saleQty, 0)}. Both rows' stored charges are kept. The ${what(target)} row is then removed — ` +
                  "recoverable from Backup & Restore → Deleted items."
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="stale-exit-date">Date of the {target ? what(target) : "sale"}</Label>
            <Input
              id="stale-exit-date"
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setDateAccepted(true);
              }}
            />
            {target && !target.saleDateStated && (
              <>
                <p className="text-xs text-muted-foreground">
                  The {what(target)} row states no date; {target.saleDate} is the day it was pulled (IST). The close date sets
                  the charge rates, the holding period and any MTF interest, so it is confirmed here rather than assumed.
                </p>
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={dateAccepted} onChange={(e) => setDateAccepted(e.target.checked)} />
                  This is the date of the {what(target)}
                </label>
              </>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={busy || target === null || !date || !dateAccepted}
              onClick={() => {
                if (target) void run(target, date);
              }}
            >
              {busy ? "Closing…" : target?.side === "short" ? "Close with the recorded purchase" : "Close with the recorded sale"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
