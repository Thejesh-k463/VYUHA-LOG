"use client";

/**
 * Open holdings with no mark price.
 *
 * A position with no mark has **no unrealised result** — so it appears in
 * neither "in gain" nor "in loss", and contributes nothing to the risk cockpit.
 * There are only two honest ways out: set a mark, or explain where the shares
 * came from.
 *
 * The second is the common case for **IPO allotments**, which are credited
 * without ever appearing as a buy. Those holdings arrive missing BOTH facts —
 * cost and mark — and the IPO section is where the trader actually knows them.
 * So this offers to create the IPO record and link the two, after which saving
 * the IPO supplies both and the holding rejoins every statistic.
 */

import { useActionState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { pushTradeToIpoAction } from "@/app/trades/actions";
import { inr } from "@/lib/format";
import { Sparkles, TriangleAlert, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export interface UnmarkedHolding {
  id: number;
  symbol: string;
  buyQty: number;
  buyValue: number;
  buyDate: string | null;
  acquisition: string | null;
  /** Set once an IPO record points at this holding. */
  ipoId: number | null;
}

function Row({ h }: { h: UnmarkedHolding }) {
  const [state, action, pending] = useActionState(pushTradeToIpoAction, { ok: false, message: "" });
  const linked = h.ipoId != null || state.ok;
  const noBasis = h.buyValue <= 0;

  return (
    <div className="space-y-1.5 rounded-md border border-border/60 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-sm font-medium">
          {h.symbol}
          {h.acquisition === "ipo" && <Badge variant="secondary" className="ml-2 text-[10px]">IPO</Badge>}
        </div>
        <div className="font-mono text-xs tabular-nums text-muted-foreground">
          {h.buyQty} held
          {noBasis ? " · no cost on record" : ` · ${inr(h.buyValue, { decimals: 0 })} invested`}
          {h.buyDate ? ` · since ${h.buyDate}` : ""}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {noBasis ? (
          <>
            This holding has <b>neither a cost nor a mark</b>, so it can be neither valued nor scored. That is
            what an IPO allotment looks like in a tradebook — the shares were credited, never bought.
          </>
        ) : (
          <>
            The purchase is on record — what is missing is a <b>current price</b> to value it at today.
            Without one there is no unrealised result to show. Enter a recent close on{" "}
            <a className="underline" href="/risk">Portfolio Risk</a>, or record where the shares came from.
          </>
        )}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {linked ? (
          <a href="/ipos" className="text-xs underline">
            Open IPOs to enter the issue price →
          </a>
        ) : (
          <form action={action}>
            <input type="hidden" name="tradeId" value={h.id} />
            <Button type="submit" size="sm" variant="outline" disabled={pending}>
              <Sparkles className="mr-1.5 size-3.5" />
              {pending ? "Creating…" : "This came from an IPO"}
            </Button>
          </form>
        )}
        <a href="/risk" className="text-xs text-muted-foreground underline">
          or enter a current price to value it
        </a>
      </div>

      {state.message && (
        <p className={`text-[11px] ${state.ok ? "text-profit" : "text-loss"}`}>{state.message}</p>
      )}
    </div>
  );
}

function DismissButton({ fingerprint }: { fingerprint: string }) {
  // Dismiss-with-memory: hides this panel for THIS set of holdings. Any change
  // to the set — a new unmarked holding, one resolved — brings it back.
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm" variant="ghost" className="text-muted-foreground" disabled={busy}
      title="Hide until these holdings change"
      onClick={() => {
        setBusy(true);
        fetch("/api/dismissals", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "dismiss", panel: "unmarked-holdings", fingerprint }),
        }).then(() => router.refresh()).finally(() => setBusy(false));
      }}
    >
      <X className="mr-1 size-3.5" /> {busy ? "Hiding…" : "Dismiss"}
    </Button>
  );
}

export function UnmarkedHoldingsPanel({ holdings, fingerprint }: { holdings: UnmarkedHolding[]; fingerprint?: string }) {
  if (holdings.length === 0) return null;

  const noBasis = holdings.filter((h) => h.buyValue <= 0).length;

  return (
    <Card className="border-warning/40">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
          <TriangleAlert className="size-4 text-warning" />
          {holdings.length} open holding{holdings.length === 1 ? "" : "s"} with no current price to value {holdings.length === 1 ? "it" : "them"} at
          </span>
          {fingerprint && <DismissButton fingerprint={fingerprint} />}
        </CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          A <b>current (mark) price</b> is how an open holding is valued today — it is a separate fact from the
          purchase price, which these may well have. Without one there is <b>no unrealised result</b>, so these
          appear under <b>Open</b> but in neither
          &ldquo;in gain&rdquo; nor &ldquo;in loss&rdquo; — Vyuha will not read a missing price as breakeven.
          {noBasis > 0 && (
            <>
              {" "}
              <b className="text-warning">{noBasis}</b> of them {noBasis === 1 ? "has" : "have"} no cost on
              record either, which is the signature of an <b>IPO allotment</b>: shares credited on allotment
              never appear as a buy in any tradebook.
            </>
          )}
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {holdings.map((h) => (
          <Row key={h.id} h={h} />
        ))}
        <p className="text-[11px] text-muted-foreground">
          Pushing a holding to IPOs creates a linked record. Entering the <b>issue price</b> there supplies the
          cost basis, and a <b>listing price</b> gives the holding its mark — at which point it rejoins win
          rate, expectancy, Return on Margin and the gain/loss views. The IPO record stays the source of truth
          for those two numbers, so they can never drift apart.
        </p>
      </CardContent>
    </Card>
  );
}
