"use client";

/**
 * R7 — the moneyness reference, inline on the row.
 *
 * The expiry panel used to print a dead `spot?` badge and a footer sentence
 * pointing at the bulk-MTM box further down the page: the one number that
 * decides whether an option devolves into share delivery was three scrolls and
 * a paste away from the row that needed it. This is the same number, typed
 * where it is read.
 *
 * WHAT IT WRITES, AND WHERE. The underlying's CASH price, under the
 * UNDERLYING's symbol (`trades.symbol`), through the one typed-mark door
 * (`writeTypedMark()` in lib/queries/mtm.ts, reached here through
 * `POST /api/risk/spot`). It can never write a contract key: `mtm_prices` rows
 * for options and futures are keyed `OPT …`/`FUT …`, a premium stored under the
 * underlying would delete the cash mark every share position reads, and
 * `spotMarkPayload()` throws rather than build such a body (v4.2 contract
 * rules, and the same refusal `writeTypedMark`'s doc-comment describes). The
 * route refuses it a second time, on its own side of the wire.
 *
 * WHY A ROUTE AND NOT A SERVER ACTION. AGENTS.md: an editor write is a route
 * handler + client `fetch` + `router.refresh()`. A server action revalidates
 * the route it was called from and REMOUNTS the sibling client components — on
 * /risk that is the cockpit, whose open row and dialog state would reset every
 * time someone typed a spot, with nothing on screen to explain it. The first
 * cut of this chip took the bulk-MTM action (`saveMtmPrices`) as a prop for
 * want of a route; `app/api/risk/spot/route.ts` is that route.
 *
 * The refresh is a PARAMETER of `submitSpotMark`, not a hook call inside it:
 * the write is then testable end to end against a `fetch` spy and a refresh
 * spy, without a renderer. This file stays DB-free either way, which is
 * load-bearing — `components/risk/expiry-obligations.tsx` imports it and two
 * seam-test files import THAT statically, before `openTempDb()` sets
 * `VYUHA_DB_PATH`.
 *
 * NOTHING PURE LIVES HERE, AND NOTHING PURE IS RE-EXPORTED. `SpotRef`,
 * `UNKNOWN_SPOT`, `SPOT_SOURCE_LABEL`, `isContractKey`, `resolveSpotRef` and
 * `spotChipLabel` are in `lib/risk/spot-ref.ts`. They were here once, and
 * `app/risk/page.tsx` imported `resolveSpotRef` from this `"use client"` module
 * and CALLED it during the server render: Next's flight loader rewrites every
 * export of a client module reached from the server layer into a
 * `registerClientReference` stub that THROWS, so /risk threw at request time
 * for any book with an open F&O position — under a green vitest run and a
 * green `next build`, neither of which sees the loader's output.
 * `tests/client-value-imports.test.ts` now fails on that shape repo-wide.
 *
 * NO `useEffect` HERE, and nothing derived stored in state: the current mark and
 * its source are props, and the draft text is the only state (AGENTS.md — a
 * `setState` in an effect keyed on other state is what broke the Trades filter).
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toaster";
import {
  isContractKey,
  isIsoDay,
  spotChipLabel,
  type DatedPrice,
  type SpotCloseNotice,
  type SpotRef,
} from "@/lib/risk/spot-ref";

/** The one door this chip writes a mark through. */
export const SPOT_MARK_ENDPOINT = "/api/risk/spot";
/** R13 — "Keep my mark": a `spot-close-diff` dismissal, never a mark write. */
export const SPOT_KEEP_MARK_ENDPOINT = "/api/risk/spot/dismiss";

export interface SpotMarkBody {
  /** The UNDERLYING's symbol, upper-cased. */
  symbol: string;
  /** RUPEES per unit. */
  price: number;
  /** R13 only — "Use official close" dates the mark on the CLOSE's own day. */
  asOfDate?: string;
}

/**
 * The ONE body the route reads: the underlying and a price, nothing else.
 *
 * Price only — no SL, no TSL, no target. The bulk-MTM door rewrites stops
 * across every matching open position when a line carries them, and a moneyness
 * chip must never touch a stop. No `asOf` for a mark entered here: the route
 * dates it `todayIstIso()`, and a date this chip invented would outrank every
 * real day for as long as the book exists. The ONE date it ever carries is an
 * official close's own day, for "Use official close" (R13) — a day on record,
 * not an invented one, and the route refuses any day after today.
 */
export function spotMarkPayload(symbol: string, price: number, asOfDate?: string): SpotMarkBody {
  const key = symbol.trim().toUpperCase();
  if (!key) throw new Error("A spot mark needs the underlying's symbol.");
  if (isContractKey(key)) {
    throw new Error(
      `${key} is a contract key — a spot mark belongs to the underlying's symbol, never OPT …/FUT …`,
    );
  }
  if (!Number.isFinite(price) || price <= 0) {
    throw new RangeError(`A mark is a price above zero; got ${String(price)}.`);
  }
  if (asOfDate === undefined) return { symbol: key, price };
  if (!isIsoDay(asOfDate)) throw new RangeError(`A mark's date is YYYY-MM-DD; got ${String(asOfDate)}.`);
  return { symbol: key, price, asOfDate };
}

export interface SpotMarkResult {
  ok: boolean;
  message: string;
  updated: number;
}

/**
 * Hand ONE underlying's spot to the typed-mark route, exactly once, and then
 * make the server re-read.
 *
 * `refresh` is `router.refresh` from the caller. It runs ONLY on a stored mark:
 * a refused write changed nothing on the server, and re-rendering the page over
 * it would just redraw the same numbers under a "failed" toast.
 */
export async function submitSpotMark(
  symbol: string,
  price: number,
  refresh: () => void,
  asOfDate?: string,
): Promise<SpotMarkResult> {
  const body = spotMarkPayload(symbol, price, asOfDate); // throws before the network is touched
  const res = await fetch(SPOT_MARK_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as Partial<SpotMarkResult> | null;
  if (!res.ok || !data?.ok) {
    return { ok: false, message: data?.message || "The mark was not stored.", updated: 0 };
  }
  refresh();
  return { ok: true, message: data.message ?? "", updated: data.updated ?? 0 };
}

/**
 * R13 — "Keep my mark": POST the close the row showed to the dismissal route,
 * then re-read. The route builds the fingerprint from that close, so a newer or
 * corrected close brings the notice back. Like `submitSpotMark`, `refresh` runs
 * only when the route stored the dismissal.
 */
export async function submitKeepMark(
  symbol: string,
  close: DatedPrice,
  refresh: () => void,
): Promise<{ ok: boolean; message: string }> {
  const key = symbol.trim().toUpperCase();
  if (!key || isContractKey(key)) throw new Error("Keeping a mark needs the underlying's symbol.");
  const res = await fetch(SPOT_KEEP_MARK_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol: key, closeAsOf: close.asOf, closePrice: close.price }),
  });
  const data = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
  if (!res.ok || !data?.ok) return { ok: false, message: data?.message || "The choice was not stored." };
  refresh();
  return { ok: true, message: data.message ?? "" };
}

function sourceTitle(spot: SpotRef, symbol: string): string {
  const dated = spot.asOf ? ` (${spot.asOf})` : "";
  if (spot.source === "mark") {
    return `Mark on record for ${symbol}${dated} — a stored mark takes precedence over the end-of-day close.`;
  }
  if (spot.source === "eod") {
    return `End-of-day close for ${symbol} on record${dated} — a stored mark takes precedence.`;
  }
  return `No cash price for ${symbol} on record. Enter it here to resolve this option's moneyness.`;
}

/**
 * The chip: what the moneyness rests on, and a click to change it. With a
 * `closeNotice` (R13) the row also states the newer official close, and the
 * open editor offers "Use official close" / "Keep my mark".
 */
export function SpotMarkEditor({
  symbol,
  spot,
  closeNotice,
}: {
  symbol: string;
  spot: SpotRef;
  closeNotice?: SpotCloseNotice | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const label = spotChipLabel(spot);
  const title = sourceTitle(spot, symbol);

  /**
   * U-2 — WHERE THE KEYBOARD GOES WHEN THE EDITOR CLOSES.
   *
   * Save, Cancel and Escape all unmount the `<Input>` and remount the chip
   * `<button>`. Focus then falls to `<body>`: a keyboard user is returned to
   * the top of the document and has to tab the whole obligations table again,
   * and a screen reader announces nothing at all. So every close path sets
   * `restoreFocus`, and the chip's own ref callback — which runs the instant
   * the button is back in the DOM, after the state flip — consumes it.
   *
   * A ref, not state (it renders nothing) and NOT a `useEffect` keyed on
   * `editing`: this file derives rather than syncs (AGENTS.md, and the header
   * above).
   */
  const restoreFocus = React.useRef(false);
  const chipRef = React.useRef<HTMLButtonElement | null>(null);

  const attachChip = (el: HTMLButtonElement | null) => {
    chipRef.current = el;
    if (el && restoreFocus.current) {
      restoreFocus.current = false;
      el.focus();
    }
  };

  /** The ONE way out of the editor — see `restoreFocus` above. */
  function closeEditor() {
    restoreFocus.current = true;
    setEditing(false);
  }

  async function save() {
    const price = Number(draft.trim());
    if (!Number.isFinite(price) || price <= 0) {
      toast.error("A mark is a price above zero.");
      return;
    }
    setBusy(true);
    try {
      // Route handler + `router.refresh()` — this app's rule for an editor
      // write. The refresh is what re-reads the resolved moneyness on THIS row.
      const res = await submitSpotMark(symbol, price, () => router.refresh());
      if (res.ok) {
        closeEditor();
        setDraft("");
        toast.success(`${symbol} spot stored.`);
      } else {
        toast.error(res.message || "The mark was not stored.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The mark was not stored.");
    } finally {
      setBusy(false);
    }
  }

  /** R13 "Use official close": the SAME door as Save, with the close's value
   *  and the close's own day — the mark and the close then agree. */
  async function applyOfficialClose(close: DatedPrice) {
    setBusy(true);
    try {
      const res = await submitSpotMark(symbol, close.price, () => router.refresh(), close.asOf);
      if (res.ok) {
        closeEditor();
        setDraft("");
        toast.success(`${symbol} mark set to the ${close.asOf} close.`);
      } else {
        toast.error(res.message || "The mark was not stored.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The mark was not stored.");
    } finally {
      setBusy(false);
    }
  }

  /** R13 "Keep my mark": remembered against THIS close only. */
  async function keepMark(close: DatedPrice) {
    setBusy(true);
    try {
      const res = await submitKeepMark(symbol, close, () => router.refresh());
      if (res.ok) {
        closeEditor();
        toast.success(`${symbol} mark kept.`);
      } else {
        toast.error(res.message || "The choice was not stored.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The choice was not stored.");
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    const chip = (
      <Badge variant={spot.source === "none" ? "outline" : "secondary"} title={title}>
        {label}
      </Badge>
    );
    const button = (
      <button
        ref={attachChip}
        type="button"
        onClick={() => {
          setDraft(spot.value == null ? "" : String(spot.value));
          setEditing(true);
        }}
        className="cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Underlying spot for ${symbol}`}
      >
        {chip}
      </button>
    );
    if (!closeNotice) return button;
    return (
      <div className="flex flex-col items-start gap-0.5">
        {button}
        <span className="text-[10px] text-warning">{closeNotice.text}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex items-center gap-1">
        <Input
          autoFocus
          inputMode="decimal"
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
            if (e.key === "Escape") closeEditor();
          }}
          placeholder={`${symbol} spot`}
          aria-label={`Underlying spot for ${symbol}`}
          className="h-7 w-24 px-2 text-xs"
        />
        <Button type="button" size="sm" className="h-7 px-2 text-[11px]" disabled={busy} onClick={() => void save()}>
          Save
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-[11px]"
          disabled={busy}
          onClick={() => closeEditor()}
        >
          Cancel
        </Button>
      </div>
      {closeNotice ? (
        <div className="flex flex-wrap items-center gap-1 text-[10px] text-warning">
          <span>{closeNotice.text}</span>
          <Button
            type="button"
            size="sm"
            className="h-6 px-2 text-[11px]"
            disabled={busy}
            onClick={() => void applyOfficialClose(closeNotice.close)}
          >
            Use official close
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
            disabled={busy}
            onClick={() => void keepMark(closeNotice.close)}
          >
            Keep my mark
          </Button>
        </div>
      ) : null}
    </div>
  );
}
