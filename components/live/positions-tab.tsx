"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useStoredValue, writeStored } from "@/components/layout/use-stored-value";
import { ProLock } from "@/components/system/pro-lock";
import { ShowMore, WINDOW_STEP, useRowWindow } from "@/components/ui/show-more";
import { istParts } from "@/lib/live/market-hours";
import { daysToResults } from "@/lib/live/results-date";
import {
  cohortConcentration,
  headerTotals,
  nearStop,
  riskLensSummary,
  sinceClose,
  staleCount,
  stepsToShow,
  stopChip,
  stopState,
  upcoming,
  windowLimit,
  type CohortLevel,
  type RiskLensSummary,
} from "@/lib/live/positions-view";
import { DESK_COPY, EM_DASH, POSITIONS_COPY, SCOPE_COPY, lockedInAtStop, resultsChip } from "./desk-copy";
import * as fmt from "./desk-format";
import { deskAction, isTypingTarget, nextIndex } from "./desk-keys";
import type { DeskRow, LiveDeskData } from "./desk-types";
import { PositionCard, span, zonePoints } from "./position-card";

/**
 * The `/live` POSITIONS tab — artboards Blend 1 (the ledger), Ideas A 1–9 and
 * the collapsed Risk lens of Ideas B (v4.7.0 wave C4, design C4-DESIGN-2026-10-04).
 *
 * SAME DATA AS THE CHARTS TAB: `TrackerClient` owns the one stream consumer and
 * hands this component the ticked rows plus its account / symbol filter. This
 * file reads no stream and fetches nothing.
 *
 * FREE / PRO (Q55, ruling P6): positions, marks, P&L, levels, partials and
 * every chip are free. Size (% of capital), on-capital P&L, R, risk at stop,
 * heat, cohort concentration and the Risk lens render `<ProLock/>` — never a
 * fabricated empty (invariant 6) and never a page gate (invariant 7).
 *
 * KEYBOARD (D2): this tab's own window listener, mounted only while the tab is
 * (Radix unmounts an inactive panel). j / k move the focus; Enter or a click
 * opens the card; Esc closes it; j / k with the card open move the focus
 * behind it AND swap the card to that row. The focused row is an IDENTITY
 * (`focusId`), never an index, exactly as on the Charts tab (F5).
 *
 * NO setState IN AN EFFECT KEYED ON STATE: the order, the focused row, the
 * card's row, the cohort view and every total are derived at render.
 *
 * THE LEDGER IS A WINDOW (v4.8.0 P1): "largest N + Show more", the pattern
 * `/risk` uses for the same book (`components/ui/show-more.tsx`). A 3,460-row
 * book was 3,460 `<tr>` in the document and 3,460 row renders per tick. The
 * order is deployed-₹ descending, so the first `WINDOW_STEP` rows ARE the
 * largest positions; only that slice is mapped to rows and the note under the
 * table says how many are held back. EVERYTHING ELSE reads the full filtered
 * book (`order`): the three header bars, the stale count, the Risk lens, the
 * cohort panel, the footer and the `<tfoot>` Book row.
 *   - A book of `WINDOW_STEP` rows or fewer renders exactly as it did.
 *   - j / k move over the BOOK, not the window: stepping past the last shown
 *     row widens the window (never a dead key), and the scroll waits for the
 *     row to exist.
 *   - The focused row and the row whose card is open are always inside the
 *     window — DERIVED (`windowLimit`), not synced: a filter cleared under a
 *     focused row leaves it 900 places down, and the window follows it there.
 *   - `PositionRow` is `React.memo` over primitives, the row and two stable
 *     callbacks, so a tick re-renders the rows whose quote moved
 *     (`applyTicks` returns an unticked row by identity) and no others.
 */

/**
 * Scope labels (C4 fix wave, fixes 1 and 2): which DENOMINATOR a figure is of.
 * A row's Size is of its own capital BUCKET; the Book row's is of TOTAL
 * capital; heat is always the WHOLE book's, while the lens's shares are of the
 * rows in view. Kept here rather than in `desk-copy.ts` only because that file
 * was outside the fix wave's file set — it belongs in `POSITIONS_COPY`.
 */
export { SCOPE_COPY };

/** `{v:1, …}` envelopes (AGENTS.md localStorage convention). */
export const DENSITY_KEY = "vyuha-live-positions-density";
export const LENS_KEY = "vyuha-live-risk-lens";
export const COHORT_KEY = "vyuha-live-cohort-level";

/**
 * The noun `<ShowMore>` puts after "Showing N of M" — it also says WHICH N.
 * Here, like `SCOPE_COPY` once was, only because `desk-copy.ts` is outside the
 * P1 file set; it belongs in `POSITIONS_COPY`.
 */
export const WINDOW_NOUN = "positions, largest deployed first";

function readEnvelope(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v !== null && typeof v === "object" && (v as { v?: unknown }).v === 1 ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The Positions tab's rows, in its order: the desk's account / symbol filter,
 * then DEPLOYED rupees descending. Not the Charts tab's P&L sort — `investedP`
 * does not move on a tick, so the focused row does not jump under the user.
 */
export function positionsOrder(
  rows: readonly DeskRow[],
  view: { accountFilter: number | null; query: string },
): DeskRow[] {
  const q = view.query.trim().toUpperCase();
  return rows
    .filter(
      (r) =>
        (view.accountFilter === null || r.accountId === view.accountFilter) &&
        (q === "" || r.symbol.toUpperCase().includes(q) || r.tradingsymbol.toUpperCase().includes(q)),
    )
    .sort((a, b) => b.investedP - a.investedP || a.symbol.localeCompare(b.symbol) || a.id - b.id);
}

/**
 * Where j (`down`) or k lands, as an index into the BOOK (`total` rows), given
 * that only the first `shownCount` are rendered (v4.8.0 P1).
 *
 * It is `desk-keys.ts`'s `nextIndex` over the book, so `j` on the last shown
 * row lands on the first hidden one and the window follows. The one exception
 * is `k` with nothing focused, which `nextIndex` answers with the LAST row:
 * here that is the last row SHOWN — one stray key must not mount 3,460 rows.
 * In a book the window already holds, the two are the same row.
 */
export function nextFocusIndex(focusIdx: number, shownCount: number, total: number, down: boolean): number {
  return nextIndex(focusIdx, focusIdx < 0 && !down ? shownCount : total, down ? 1 : -1);
}

/** ppm of `num` over `den`, or null. */
function ppmOf(num: number | null, den: number | null): number | null {
  if (num === null || den === null || !(den > 0)) return null;
  return Math.trunc((num * 1_000_000) / den);
}

/** "today" / "tomorrow" / "9 Sep · in 6 days" — a date on the book, from `today`. */
function whenText(date: string, today: string): string {
  const d = daysToResults(date, today);
  if (d === null) return fmt.shortDate(date);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  return `${fmt.shortDate(date)} · in ${d} days`;
}

const pctBar = (ppm: number | null, ofPpm = 1_000_000): number =>
  ppm === null || !(ofPpm > 0) ? 0 : Math.max(0, Math.min(100, (ppm / ofPpm) * 100));

export function PositionsTab({
  rows,
  accountFilter,
  query,
  data,
  pro,
  linkLabel,
  now,
  onOpenChart,
  onLab,
}: {
  rows: readonly DeskRow[];
  accountFilter: number | null;
  query: string;
  data: LiveDeskData;
  pro: boolean;
  /** The feed strip's connection line, or null for a provider that does not stream. */
  linkLabel: string | null;
  now: Date | null;
  onOpenChart: (row: DeskRow) => void;
  onLab: (row: DeskRow) => void;
}) {
  const { heat } = data;
  const order = React.useMemo(() => positionsOrder(rows, { accountFilter, query }), [rows, accountFilter, query]);

  const [focusId, setFocusId] = React.useState<number | null>(null);
  const [cardId, setCardId] = React.useState<number | null>(null);
  const [editOpen, setEditOpen] = React.useState(false);

  const focusIdx = focusId === null ? -1 : order.findIndex((r) => r.id === focusId);
  const focused = focusIdx >= 0 ? order[focusIdx] : null;
  const cardIdx = cardId === null ? -1 : order.findIndex((r) => r.id === cardId);
  const cardRow = cardIdx >= 0 ? order[cardIdx] : null;

  // ── the row window (v4.8.0 P1) ───────────────────────────────────────────
  // `asked` is what the user has asked for so far (the hook's own high-water
  // mark, in whole steps). `shown` widens it — at render, never in an effect —
  // to hold the focused row and the open card's row. `order` stays the book.
  const { visible: asked, showMore } = useRowWindow(order);
  const shownCount = windowLimit(asked.length, order.length, Math.max(focusIdx, cardIdx), WINDOW_STEP);
  const shown = shownCount === asked.length ? asked : order.slice(0, shownCount);
  const hidden = order.length - shown.length;
  /** Raise the hook's mark to at least `target` rows, so the window does not shrink back when the focus leaves. */
  const askFor = React.useCallback(
    (target: number) => {
      for (let i = stepsToShow(asked.length, target, WINDOW_STEP); i > 0; i--) showMore();
    },
    [asked.length, showMore],
  );
  /** A row j / k moved to before it was rendered — scrolled to once the window holds it. */
  const pendingScroll = React.useRef<number | null>(null);
  React.useEffect(() => {
    const index = pendingScroll.current;
    if (index === null) return;
    pendingScroll.current = null;
    document.querySelector(`[data-pos-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [shown.length]);

  const openRow = React.useCallback((id: number) => {
    setFocusId(id);
    setCardId(id);
  }, []);

  // ── stored chrome (useStoredValue: server snapshot null → defaults) ───────
  const compact = readEnvelope(useStoredValue(DENSITY_KEY))?.compact === true;
  const lensOpen = readEnvelope(useStoredValue(LENS_KEY))?.open === true;
  const cohortLevel: CohortLevel = readEnvelope(useStoredValue(COHORT_KEY))?.level === "sector" ? "sector" : "industry";

  // ── derived, never stored ────────────────────────────────────────────────
  const totals = headerTotals(order, heat);
  const stale = staleCount(order);
  const lens = riskLensSummary(order, heat);
  const cohort = cohortConcentration(order, cohortLevel);
  const shareById = new Map(lens.ranked.map((r) => [r.id, r.heatSharePpm]));
  const noStopRows = order.filter((r) => stopState(r) === null);
  const qtySum = order.reduce((s, r) => s + r.qty, 0);
  // A filter narrows the rows but not `heat` (the whole book's) — say so wherever both show.
  const filtered = order.length !== rows.length;

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // The nested Edit-levels dialog owns every key while it is open — its Esc
      // closes IT, not the card behind it.
      if (editOpen) return;
      const el = e.target as HTMLElement | null;
      const typing = isTypingTarget(el?.tagName, el?.isContentEditable ?? false);
      const action = deskAction(e, typing);
      if (action === null) return;
      if (action === "escape") {
        setCardId(null);
        return;
      }
      if (action === "row-down" || action === "row-up") {
        e.preventDefault();
        // The move is over the BOOK (`order`), not the window.
        const next = nextFocusIndex(focusIdx, shown.length, order.length, action === "row-down");
        const id = next >= 0 ? (order[next]?.id ?? null) : null;
        setFocusId(id);
        // j / k with the card open: the card follows the focus (D2).
        if (cardId !== null && id !== null) setCardId(id);
        if (next < 0) return;
        if (next < shown.length) {
          document.querySelector(`[data-pos-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
        } else {
          // Past the window's edge: the new focus widens it at the next render
          // (`windowLimit`), `askFor` makes that width the user's own so it
          // stays when the focus moves back, and the scroll waits for the row
          // to be in the document — never `scrollIntoView` on a missing node.
          askFor(next + 1);
          pendingScroll.current = next;
        }
        return;
      }
      if (action === "expand") {
        // A focused button or link answers Enter with its own click.
        if (el && (el.tagName === "BUTTON" || el.tagName === "A")) return;
        if (focused === null) return;
        e.preventDefault();
        setCardId(focused.id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, focusIdx, focused, cardId, editOpen, shown.length, askFor]);

  const capitalP = heat?.capitalP ?? null;
  const deployCapPpm = data.positions.deployCapPpm;

  return (
    <div className="flex flex-col gap-6 pt-4" data-testid="live-positions">
      {/* ── header: feed · clock · stale | cohort concentration (D4/D5) ──── */}
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="flex flex-col gap-1">
          <p className="text-[11px] uppercase tracking-[0.16em] text-primary">{DESK_COPY.title}</p>
          <p className="text-2xl font-bold uppercase leading-none tracking-tight">{POSITIONS_COPY.tabPositions}</p>
          <p className="text-[13px] text-muted-foreground" data-testid="positions-feed-line">
            {linkLabel ?? data.feed.label}
            {" · "}
            <span className="font-mono tabular-nums">{now === null ? EM_DASH : `${istParts(now).hhmm} ${DESK_COPY.marketClock}`}</span>
            {" · "}
            <span className={stale.stale > 0 ? "text-warning" : undefined}>
              {stale.stale > 0 ? POSITIONS_COPY.staleMarks(stale.stale) : POSITIONS_COPY.noStaleMarks}
            </span>
          </p>
        </div>
        <CohortPanel pro={pro} level={cohortLevel} cohort={cohort} />
      </div>

      <div className="h-0.5 bg-foreground/80" aria-hidden />

      {/* ── the three header bars (D5) ──────────────────────────────────── */}
      <div className="grid gap-8 md:grid-cols-3">
        <div className="flex flex-col gap-2.5">
          <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{POSITIONS_COPY.deployedTitle}</p>
          <p className="flex flex-wrap items-baseline gap-3">
            {pro ? (
              <>
                <span className="font-mono text-3xl font-semibold tabular-nums">{fmt.pct(totals.deployedPpm)}</span>
                <span className="font-mono text-[13px] tabular-nums text-muted-foreground">{fmt.money(totals.deployedP)}</span>
              </>
            ) : (
              <>
                <span className="font-mono text-3xl font-semibold tabular-nums">{fmt.money(totals.deployedP)}</span>
                <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
                  {POSITIONS_COPY.ofCapitalLocked} <ProLock />
                </span>
              </>
            )}
          </p>
          {pro && (
            <>
              <div className="relative h-1 rounded-full bg-muted/20">
                <div className="h-1 rounded-full bg-foreground" style={{ width: `${pctBar(totals.deployedPpm)}%` }} />
                {deployCapPpm !== null && deployCapPpm > 0 && (
                  <div className="absolute -top-1 h-3 w-0.5 bg-gold" style={{ left: `${pctBar(deployCapPpm)}%` }} />
                )}
              </div>
              <p className="text-[12px] text-muted-foreground">
                {deployCapPpm !== null && deployCapPpm > 0
                  ? POSITIONS_COPY.deployCapNote(
                      fmt.pct(deployCapPpm),
                      fmt.money(capitalP === null ? null : Math.floor((capitalP * deployCapPpm) / 1_000_000)),
                    )
                  : POSITIONS_COPY.deployCapUnset}
              </p>
            </>
          )}
        </div>

        <div className="flex flex-col gap-2.5">
          <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
            {POSITIONS_COPY.heatTitle}
            {filtered && pro && heat !== null && ` · ${SCOPE_COPY.wholeBook}`}
          </p>
          {!pro || heat === null ? (
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <ProLock /> {POSITIONS_COPY.heatLocked}
            </p>
          ) : (
            <>
              <p className="flex flex-wrap items-baseline gap-3">
                <span className="font-mono text-3xl font-semibold tabular-nums">{fmt.pct(heat.heatPpm)}</span>
                <span className="font-mono text-[13px] tabular-nums text-loss">{fmt.money(heat.openRiskP)}</span>
              </p>
              <div className="relative h-1 rounded-full bg-muted/20">
                <div
                  className="h-1 rounded-full bg-loss"
                  style={{ width: `${pctBar(heat.heatPpm, heat.ceilingPpm ?? 1_000_000)}%` }}
                />
              </div>
              <p className="text-[12px] text-muted-foreground">
                {heat.capitalP === null
                  ? DESK_COPY.heatNoCapital
                  : heat.ceilingPpm !== null
                    ? POSITIONS_COPY.heatCeilingNote(
                        fmt.pct(heat.ceilingPpm),
                        fmt.money(Math.floor((heat.capitalP * heat.ceilingPpm) / 1_000_000)),
                      )
                    : POSITIONS_COPY.heatNoCeiling}
                {" · "}
                {lockedInAtStop(fmt.money(heat.lockedInProfitP))}
              </p>
            </>
          )}
        </div>

        <div className="flex flex-col gap-2.5">
          <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{POSITIONS_COPY.unrealisedTitle}</p>
          <p className="flex flex-wrap items-baseline gap-3">
            {pro ? (
              <>
                <span className={`font-mono text-3xl font-semibold tabular-nums ${fmt.pnlClass(totals.unrealisedOnCapitalPpm)}`}>
                  {fmt.signedPct(totals.unrealisedOnCapitalPpm)}
                </span>
                <span className={`font-mono text-[13px] tabular-nums ${fmt.pnlClass(totals.unrealisedP)}`}>
                  {fmt.signedMoney(totals.unrealisedP)}
                </span>
              </>
            ) : (
              <>
                <span className={`font-mono text-3xl font-semibold tabular-nums ${fmt.pnlClass(totals.unrealisedP)}`}>
                  {fmt.signedMoney(totals.unrealisedP)}
                </span>
                <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
                  {POSITIONS_COPY.colOnCapital.toLowerCase()} <ProLock />
                </span>
              </>
            )}
          </p>
          <div className="relative h-1 rounded-full bg-muted/20">
            {totals.unrealisedP !== null && totals.deployedP > 0 && (
              <div
                className={`absolute h-1 rounded-full ${totals.unrealisedP >= 0 ? "bg-profit" : "bg-loss"}`}
                style={{
                  left: totals.unrealisedP >= 0 ? "50%" : `${50 - Math.min(Math.abs(totals.unrealisedP) / totals.deployedP, 1) * 50}%`,
                  width: `${Math.min(Math.abs(totals.unrealisedP) / totals.deployedP, 1) * 50}%`,
                }}
              />
            )}
            <div className="absolute -top-1 left-1/2 h-3 w-0.5 bg-muted-foreground" />
          </div>
          <p className="text-[12px] text-muted-foreground">
            {POSITIONS_COPY.beforeCharges}
            {totals.realisedPartialPpm !== null && ` · ${POSITIONS_COPY.realisedOnPartials(fmt.signedPct(totals.realisedPartialPpm))}`}
            {totals.unmarked > 0 && ` · ${POSITIONS_COPY.unmarked(totals.unmarked)}`}
          </p>
        </div>
      </div>

      {/* ── the Risk lens (Ideas B) — Pro, collapsed by default (D8) ────── */}
      <RiskLens pro={pro} open={lensOpen} lens={lens} order={order} data={data} cohortLevel={cohortLevel} filtered={filtered} />

      {/* ── density toggle (D7) ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12px] text-muted-foreground">{POSITIONS_COPY.keyboardHelp}</p>
        <button
          type="button"
          aria-pressed={compact}
          onClick={() => writeStored(DENSITY_KEY, JSON.stringify({ v: 1, compact: !compact }))}
          className={`rounded-[var(--radius-pill)] border px-3 py-1 text-[12px] ${compact ? "border-primary/40 bg-primary/[0.07] text-primary" : "border-border text-muted-foreground"}`}
        >
          {POSITIONS_COPY.compact}
        </button>
      </div>

      {/* ── the ledger (Blend 1) ────────────────────────────────────────── */}
      <div role="region" aria-label={POSITIONS_COPY.regionLabel} tabIndex={0} className="overflow-x-auto">
        <table className="w-full border-collapse text-[14px]">
          <thead>
            <tr className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              <th scope="col" className="pb-2.5 text-left font-medium">{POSITIONS_COPY.colTicker}</th>
              <th scope="col" className="pb-2.5 text-right font-medium">{POSITIONS_COPY.colQty}</th>
              <th scope="col" className="pb-2.5 text-right font-medium">{POSITIONS_COPY.colHeld}</th>
              <th scope="col" className="pb-2.5 text-right font-medium" title={SCOPE_COPY.sizeHeader}>
                {POSITIONS_COPY.colSize}
              </th>
              <th scope="col" className="pb-2.5 pl-4 text-left font-medium">{POSITIONS_COPY.colStop}</th>
              <th scope="col" className="pb-2.5 text-right font-medium">{POSITIONS_COPY.colFromEntry}</th>
              <th scope="col" className="pb-2.5 text-right font-medium">{POSITIONS_COPY.colOnCapital}</th>
              <th scope="col" className="pb-2.5 text-right font-medium">{POSITIONS_COPY.colR}</th>
            </tr>
          </thead>
          <tbody>
            {order.length === 0 && (
              <tr>
                <td colSpan={8} className="py-6 text-center text-muted-foreground">
                  {rows.length === 0 ? DESK_COPY.emptyBook : DESK_COPY.emptyFilter}
                </td>
              </tr>
            )}
            {/* The WINDOW, never `order` — every total around this table reads the full book. */}
            {shown.map((r, i) => (
              <PositionRow
                key={r.id}
                row={r}
                index={i}
                pro={pro}
                compact={compact}
                focused={focused?.id === r.id}
                today={data.today}
                atrLength={data.atrLength}
                atrMultPermille={data.positions.atrMultPermille}
                onOpen={openRow}
                onLab={onLab}
              />
            ))}
          </tbody>
          {order.length > 0 && (
            <tfoot>
              <tr className="border-y-2 border-foreground/80 align-middle">
                <td className="py-3 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{POSITIONS_COPY.book(order.length)}</td>
                <td className="py-3 text-right font-mono tabular-nums">{fmt.qty(qtySum)}</td>
                <td />
                <td className="py-3 text-right font-mono tabular-nums">
                  {pro ? (
                    <>
                      {fmt.pct(totals.deployedPpm)}{" "}
                      <span className="block font-sans text-[11px] text-muted-foreground">{SCOPE_COPY.sizeOfTotal}</span>
                    </>
                  ) : (
                    <ProLock />
                  )}
                </td>
                <td className="py-3 pl-4 text-[12px] text-muted-foreground">
                  {/* Σ risk of the rows SHOWN — the Book row sums what it lists, like qty. */}
                  {pro && heat !== null && lens.openRiskP !== null && (
                    <span className="mr-1 font-mono text-[14px] tabular-nums text-foreground">
                      {POSITIONS_COPY.amountAtRisk(fmt.money(lens.openRiskP))} ·
                    </span>
                  )}
                  {POSITIONS_COPY.bookStops(lens.withRisk, lens.atEntry, lens.lockedIn, lens.excluded)}
                </td>
                <td className={`py-3 text-right font-mono tabular-nums ${fmt.pnlClass(totals.unrealisedP)}`}>
                  {fmt.signedMoney(totals.unrealisedP)}
                </td>
                <td className={`py-3 text-right font-mono tabular-nums ${fmt.pnlClass(totals.unrealisedOnCapitalPpm)}`}>
                  {pro ? fmt.signedPct(totals.unrealisedOnCapitalPpm) : <ProLock />}
                </td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
        {/* Renders nothing while the whole book is shown — a book inside one step is unchanged. */}
        <ShowMore hidden={hidden} total={order.length} onClick={() => askFor(shownCount + 1)} noun={WINDOW_NOUN} />
      </div>

      {/* ── footer: exclusions, locked in, the standing lines (Ideas A #9) ── */}
      <footer className="flex flex-col gap-1 text-[12px] leading-relaxed text-muted-foreground">
        {noStopRows.length > 0 && <p>{POSITIONS_COPY.excludedFromHeat(noStopRows.map((r) => r.symbol).join(", "))}</p>}
        {pro && heat !== null ? (
          heat.lockedInProfitP > 0 && <p>{lockedInAtStop(fmt.money(heat.lockedInProfitP))}</p>
        ) : (
          lens.lockedIn > 0 && <p>{POSITIONS_COPY.lockedInAcross(lens.lockedIn)}</p>
        )}
        <p>{DESK_COPY.disclaimer}</p>
        <p>{DESK_COPY.fillsCaveat}</p>
      </footer>

      {/* ── the pop-up card (Blend 2) — Enter / click opens, Esc closes ─── */}
      <Dialog
        open={cardRow !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCardId(null);
            setEditOpen(false);
          }
        }}
      >
        <DialogContent className="max-w-[1020px] gap-0 p-8 max-[1060px]:h-full max-[1060px]:max-h-none max-[1060px]:max-w-none max-[1060px]:rounded-none">
          {cardRow && (
            <PositionCard
              row={cardRow}
              data={data}
              pro={pro}
              heatSharePpm={shareById.get(cardRow.id) ?? null}
              heatShareOfP={lens.openRiskP}
              editOpen={editOpen}
              onEditOpenChange={setEditOpen}
              onOpenChart={() => onOpenChart(cardRow)}
              onLab={() => onLab(cardRow)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ─────────────────────────── the header cohort panel ─────────────────────── */

function CohortPanel({
  pro,
  level,
  cohort,
}: {
  pro: boolean;
  level: CohortLevel;
  cohort: ReturnType<typeof cohortConcentration>;
}) {
  return (
    <div className="flex w-full max-w-[360px] flex-col gap-2" data-testid="positions-cohort">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
          {level === "sector" ? POSITIONS_COPY.cohortTitleSector : POSITIONS_COPY.cohortTitle}
        </span>
        {pro && (
          <span role="group" aria-label={POSITIONS_COPY.cohortToggleLabel} className="inline-flex gap-1">
            {(["industry", "sector"] as const).map((l) => (
              <button
                key={l}
                type="button"
                aria-pressed={level === l}
                onClick={() => writeStored(COHORT_KEY, JSON.stringify({ v: 1, level: l }))}
                className={`rounded-[var(--radius-pill)] border px-2 py-0.5 text-[11px] ${level === l ? "border-primary/40 bg-primary/[0.07] text-primary" : "border-border text-muted-foreground"}`}
              >
                {l === "industry" ? POSITIONS_COPY.cohortIndustry : POSITIONS_COPY.cohortSector}
              </button>
            ))}
          </span>
        )}
      </div>
      {!pro ? (
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <ProLock /> {POSITIONS_COPY.cohortLocked}
        </p>
      ) : (
        <CohortList cohort={cohort} />
      )}
    </div>
  );
}

function CohortList({ cohort }: { cohort: ReturnType<typeof cohortConcentration> }) {
  if (cohort.deployedP <= 0) return <p className="text-[13px] text-muted-foreground">{POSITIONS_COPY.cohortEmpty}</p>;
  return (
    <>
      <ul className="flex flex-col gap-1.5">
        {cohort.nodes.slice(0, 5).map((n) => (
          <li key={`${n.level ?? "none"}:${n.group ?? ""}`}>
            <div className="flex justify-between gap-2 text-[12px]">
              <span className="truncate">
                {n.group ?? POSITIONS_COPY.unclassified}
                {cohort.level === "industry" && n.level === "sector" && (
                  <span className="text-muted-foreground"> · {POSITIONS_COPY.cohortFellUp}</span>
                )}
              </span>
              <span className="font-mono tabular-nums">
                {fmt.pct(n.share.ppm)} <span className="text-muted-foreground">({n.constituents})</span>
              </span>
            </div>
            <div className="h-1 rounded-full bg-muted/20">
              <div
                className={`h-1 rounded-full ${n.group === null ? "bg-muted-foreground/60" : "bg-violet"}`}
                style={{ width: `${pctBar(n.share.ppm)}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground">{POSITIONS_COPY.cohortCaveat(cohort.classified, cohort.total)}</p>
    </>
  );
}

/* ─────────────────────────────── one ledger row ──────────────────────────── */

/**
 * MEMOISED (v4.8.0 P1), default shallow comparison. Every prop is therefore a
 * primitive, the row itself, or a callback that is the SAME function for every
 * row and every render: `onOpen` / `onLab` take the row instead of closing over
 * it, and the three `data` fields the row reads arrive as primitives rather
 * than as `data`. An inline `() => …` or an object built at the call site would
 * make the memo a no-op with nothing going red but the tick cost —
 * `tests/positions-window.test.ts` pins the call site for that reason.
 */
export const PositionRow = React.memo(function PositionRow({
  row: r,
  index,
  pro,
  compact,
  focused,
  today,
  atrLength,
  atrMultPermille,
  onOpen,
  onLab,
}: {
  row: DeskRow;
  index: number;
  pro: boolean;
  compact: boolean;
  focused: boolean;
  /** `data.today`, `data.atrLength` and `data.positions.atrMultPermille`. */
  today: string;
  atrLength: number;
  atrMultPermille: number | null;
  onOpen: (id: number) => void;
  onLab: (row: DeskRow) => void;
}) {
  const near = nearStop(r);
  const state = stopState(r);
  const chip = stopChip(r, atrLength, atrMultPermille);
  const resultsIn = daysToResults(r.resultsDate, today);
  const capitalP = r.pctOfCapital.denominator;
  const computedStopP = r.effectiveStopP === null && (r.stop.kind === "ok" || r.stop.kind === "zero") ? r.stop.stopP : null;
  const pad = compact ? "py-1" : "py-3";
  // The stop cell: value + source chip on one line, the state chip beneath —
  // or all on one line in Compact (D7).
  const stack = compact ? "flex flex-row items-center gap-2 whitespace-nowrap" : "flex flex-col items-start gap-1";

  return (
    <tr
      data-pos-index={index}
      data-trade-id={r.id}
      aria-selected={focused}
      onClick={() => onOpen(r.id)}
      className={`cursor-pointer border-b border-rule align-middle ${compact ? "h-11" : "h-[78px]"} ${focused ? "bg-card-hover" : near ? "bg-warning/[0.06]" : ""} ${state === null && computedStopP === null ? "text-muted-foreground" : ""}`}
    >
      <td className={`${pad} pr-3`}>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={`${compact ? "text-[15px]" : "text-[17px]"} font-semibold tracking-[0.02em] text-foreground`}
          >
            {r.symbol}
          </button>
          {resultsIn !== null && (
            <Badge variant="secondary" className="text-[11px]">
              {resultsChip(resultsIn)}
            </Badge>
          )}
          {r.corpActions.map((a) => (
            <Badge key={`${a.type}-${a.exDate}`} variant="gold" className="text-[11px]">
              {POSITIONS_COPY.corpAction(a.type, a.fromUnits, a.toUnits, fmt.shortDate(a.exDate))}
            </Badge>
          ))}
          {near && r.distanceToStopAtrX100 !== null && (
            <Badge variant="warning" className="text-[11px]">
              {POSITIONS_COPY.nearStop((r.distanceToStopAtrX100 / 100).toFixed(1))}
            </Badge>
          )}
        </div>
        {/* Compact (D7) hides the strip and keeps this line on ONE line — 44 px
            is one line of text, and the mark is free, so it stays visible. */}
        <p className={`text-[12px] text-muted-foreground ${compact ? "max-w-[22rem] truncate" : "mt-0.5"}`}>
          {r.product === "raw" ? r.segment : r.product.toUpperCase()} · {POSITIONS_COPY.avgToMark(fmt.level(r.avgEntryP), fmt.level(r.markP))}
          {r.side === "short" ? " · short" : ""}
          {r.partial && ` · ${POSITIONS_COPY.partiallyBooked(fmt.pct(r.partial.bookedPpm))} · ${POSITIONS_COPY.realisedBeforeCharges(fmt.signedMoney(r.partial.realisedGrossP))}`}
        </p>
        {!compact && <Strip row={r} />}
      </td>
      <td className={`${pad} text-right font-mono tabular-nums`}>{fmt.qty(r.qty)}</td>
      <td className={`${pad} text-right font-mono tabular-nums`}>{POSITIONS_COPY.held(r.holdingDays)}</td>
      {/* Size = DEPLOYED over this row's bucket capital (`pctOfCapital` itself is risk at stop / capital). */}
      <td className={`${pad} text-right font-mono tabular-nums`}>{pro ? fmt.pct(ppmOf(r.investedP, capitalP)) : <ProLock />}</td>
      <td className={`${pad} pl-4`}>
        {r.effectiveStopP !== null ? (
          <div className={stack}>
            <span className="inline-flex items-center gap-2">
              <span className="font-mono tabular-nums text-foreground">{fmt.level(r.effectiveStopP)}</span>
              {chip && (
                <Badge variant="outline" className="text-[10px] text-muted-foreground">
                  {chip.label}
                </Badge>
              )}
            </span>
            <StateChip row={r} pro={pro} state={state} />
          </div>
        ) : computedStopP !== null ? (
          <div className={stack}>
            <span className="inline-flex items-center gap-2">
              <span className="font-mono tabular-nums">{fmt.level(computedStopP)}</span>
              {chip && (
                <Badge variant="outline" className="text-[10px] text-muted-foreground">
                  {chip.label}
                </Badge>
              )}
            </span>
            <Badge variant="secondary" className="text-[10px]">
              {POSITIONS_COPY.computedNotRecorded}
            </Badge>
          </div>
        ) : pro ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onLab(r);
            }}
            className="whitespace-nowrap rounded-[var(--radius-pill)] border border-dashed border-primary/50 px-2 py-0.5 text-[11px] text-primary"
          >
            {POSITIONS_COPY.noStopLab}
          </button>
        ) : (
          <span className="inline-flex items-center gap-1 text-[12px]">
            {POSITIONS_COPY.noStop} <ProLock />
          </span>
        )}
      </td>
      <td className={`${pad} text-right font-mono tabular-nums ${fmt.pnlClass(r.unrealisedPctPpm)}`}>
        <span className={compact ? "whitespace-nowrap" : "block"}>{fmt.signedPct(r.unrealisedPctPpm)}</span>
        <span className={`${compact ? "ml-2 whitespace-nowrap" : "block"} text-[12px] ${fmt.pnlClass(r.unrealisedP)}`}>
          {fmt.signedMoney(r.unrealisedP)}
        </span>
      </td>
      <td className={`${pad} text-right font-mono tabular-nums ${pro ? fmt.pnlClass(r.unrealisedP) : ""}`}>
        {pro ? fmt.signedPct(ppmOf(r.unrealisedP, capitalP)) : <ProLock />}
      </td>
      <td className={`${pad} text-right`}>
        {pro ? (
          <span
            className={`inline-flex min-w-16 justify-end rounded-[10px] px-2.5 ${compact ? "py-0.5" : "py-1.5"} font-mono text-[14px] font-semibold tabular-nums ${
              r.openRPpm === null ? "text-muted-foreground" : r.openRPpm >= 0 ? "bg-profit/15 text-profit" : "bg-loss/15 text-loss"
            }`}
          >
            {fmt.rMultiple(r.openRPpm)}
          </span>
        ) : (
          <ProLock />
        )}
      </td>
    </tr>
  );
});

function StateChip({ row, pro, state }: { row: DeskRow; pro: boolean; state: ReturnType<typeof stopState> }) {
  if (state === null) return null;
  if (state === "at-entry") {
    return (
      <Badge variant="outline" className="text-[10px]">
        {POSITIONS_COPY.stateAtEntry}
      </Badge>
    );
  }
  const amount = pro && row.riskAtStopP !== null ? Math.abs(row.riskAtStopP) : null;
  if (state === "at-risk") {
    return (
      <Badge variant="loss" className="text-[10px]">
        {amount === null ? POSITIONS_COPY.stateAtRisk : POSITIONS_COPY.amountAtRisk(fmt.money(amount))}
      </Badge>
    );
  }
  return (
    <Badge variant="profit" className="text-[10px]">
      {amount === null ? POSITIONS_COPY.stateLockedIn : POSITIONS_COPY.amountLockedIn(fmt.money(amount))}
    </Badge>
  );
}

/** The 150 px stop → mark → target strip under the ticker (Ideas A #4). Hidden in Compact. */
function Strip({ row }: { row: DeskRow }) {
  const zone = zonePoints(row);
  if (zone === null) return null;
  const loss = span(zone.stop, zone.entry);
  const gain = span(zone.entry, zone.target);
  const tick = (pos: number | null, cls: string) =>
    pos === null ? null : <span className={`absolute -top-[3px] h-[11px] w-0.5 ${cls}`} style={{ left: `calc(${pos}% - 1px)` }} />;
  return (
    <div className="relative mt-2 h-[5px] w-[150px] rounded-full bg-muted/20" role="img" aria-label={POSITIONS_COPY.stripLabel(row.symbol)}>
      {loss && <span className="absolute h-[5px] bg-loss/40" style={{ left: `${loss.left}%`, width: `${loss.width}%` }} />}
      {gain && <span className="absolute h-[5px] bg-profit/40" style={{ left: `${gain.left}%`, width: `${gain.width}%` }} />}
      {tick(zone.stop, "bg-loss")}
      {tick(zone.entry, "bg-foreground")}
      {tick(zone.target, "bg-profit")}
      {zone.mark !== null && (
        <span
          className="absolute -top-[3px] size-[11px] rounded-full border-2 border-background bg-foreground"
          style={{ left: `calc(${zone.mark}% - 5.5px)` }}
        />
      )}
    </div>
  );
}

/* ─────────────────────────────── the Risk lens ───────────────────────────── */

function RiskLens({
  pro,
  open,
  lens,
  order,
  data,
  cohortLevel,
  filtered,
}: {
  pro: boolean;
  open: boolean;
  lens: RiskLensSummary;
  order: readonly DeskRow[];
  data: LiveDeskData;
  cohortLevel: CohortLevel;
  /** The rows are a filtered subset — `heat` is still the whole book's. */
  filtered: boolean;
}) {
  const { heat } = data;
  if (!pro || heat === null) {
    return (
      <section
        aria-label={POSITIONS_COPY.lensTitle}
        className="flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] border border-dashed border-border px-4 py-3 text-[13px] text-muted-foreground"
      >
        <span className="font-medium text-foreground">{POSITIONS_COPY.lensTitle}</span>
        <ProLock /> {POSITIONS_COPY.lensLocked}
      </section>
    );
  }
  return (
    <section aria-label={POSITIONS_COPY.lensTitle} className="rounded-[var(--radius-card)] border border-border bg-card">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => writeStored(LENS_KEY, JSON.stringify({ v: 1, open: !open }))}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-[13px]"
      >
        <span>
          <span className="font-medium">{POSITIONS_COPY.lensTitle}</span>
          <span className="text-muted-foreground">
            {" · "}
            {POSITIONS_COPY.lensSummary(fmt.pct(lens.heatPpm), lens.withRisk, lens.lockedIn, lens.excluded)}
            {filtered && ` · heat: ${SCOPE_COPY.wholeBook}`}
          </span>
        </span>
        <span aria-hidden className="text-muted-foreground">
          {open ? "▲" : "▼"}
        </span>
      </button>
      {open && <LensBody lens={lens} order={order} data={data} cohortLevel={cohortLevel} filtered={filtered} />}
    </section>
  );
}

const SEGMENT_SHADES = ["bg-loss/80", "bg-loss/60", "bg-loss/45", "bg-loss/30"];

function LensBody({
  lens,
  order,
  data,
  cohortLevel,
  filtered,
}: {
  lens: RiskLensSummary;
  order: readonly DeskRow[];
  data: LiveDeskData;
  cohortLevel: CohortLevel;
  filtered: boolean;
}) {
  const heat = data.heat!;
  const since = sinceClose(order, heat);
  const events = upcoming(order, data.today);
  const cohort = cohortConcentration(order, cohortLevel);
  const symbolOf = new Map(order.map((r) => [r.id, r.symbol]));
  const chipOf = new Map(order.map((r) => [r.id, stopChip(r, data.atrLength, data.positions.atrMultPermille)]));
  const names = (ids: number[]) => ids.map((id) => symbolOf.get(id) ?? `#${id}`).join(", ");
  const segments = lens.ranked.filter((r) => r.heatSharePpm !== null && r.heatSharePpm > 0);

  return (
    <div className="grid gap-6 border-t border-border p-4 text-[13px] md:grid-cols-[1.4fr_1fr]">
      <div className="flex flex-col gap-3">
        <p className="font-mono text-xl font-semibold tabular-nums">
          {POSITIONS_COPY.lensHeat(fmt.pct(heat.heatPpm), fmt.money(heat.openRiskP), fmt.money(heat.capitalP))}
          {filtered && <span className="font-sans text-[13px] font-normal text-muted-foreground">{` · ${SCOPE_COPY.wholeBook}`}</span>}
        </p>
        {/* The shares below are of the rows IN VIEW (the lens's own Σ); unfiltered that Σ is the heat's. */}
        {filtered && lens.openRiskP !== null && (
          <p className="text-[12px] text-muted-foreground">{SCOPE_COPY.inViewRisk(fmt.money(lens.openRiskP))}</p>
        )}
        <p className="text-[12px] text-muted-foreground">
          {heat.ceilingPpm !== null ? `Your ceiling ${fmt.pct(heat.ceilingPpm)}` : POSITIONS_COPY.heatNoCeiling}
          {" · "}
          {POSITIONS_COPY.lensLockedIn(fmt.money(heat.lockedInProfitP))}
        </p>
        {segments.length > 0 && (
          <div className="flex h-6 w-full overflow-hidden rounded-[var(--radius)] bg-muted/20" role="img" aria-label={POSITIONS_COPY.lensRankTitle}>
            {segments.map((s, i) => (
              <span
                key={s.id}
                className={`flex items-center overflow-hidden whitespace-nowrap px-1 text-[11px] text-foreground ${SEGMENT_SHADES[i % SEGMENT_SHADES.length]}`}
                style={{ width: `${pctBar(s.heatSharePpm)}%` }}
                title={`${s.symbol} ${fmt.pct(s.heatSharePpm)}`}
              >
                {pctBar(s.heatSharePpm) > 9 ? s.symbol : ""}
              </span>
            ))}
          </div>
        )}
        {lens.ranked.length === 0 ? (
          <p className="text-muted-foreground">{POSITIONS_COPY.lensNoStops}</p>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                <th scope="col" className="pb-1 text-left font-medium">{POSITIONS_COPY.lensRankTitle}</th>
                <th scope="col" className="pb-1 text-right font-medium">{POSITIONS_COPY.lensGivesBack}</th>
                <th scope="col" className="pb-1 text-right font-medium">{POSITIONS_COPY.lensShare}</th>
                <th scope="col" className="pb-1 text-right font-medium">{POSITIONS_COPY.lensAtrAway}</th>
              </tr>
            </thead>
            <tbody>
              {lens.ranked.map((r) => (
                <tr key={r.id} className="border-t border-rule">
                  <td className="py-1.5">
                    <span className="font-semibold">{r.symbol}</span>{" "}
                    <span className="text-muted-foreground">
                      {r.state === "locked-in" ? POSITIONS_COPY.stateLockedIn : (chipOf.get(r.id)?.label ?? "")}
                    </span>
                  </td>
                  <td className="py-1.5 text-right font-mono tabular-nums text-loss">
                    {r.givesBackP === null ? EM_DASH : fmt.signedMoney(-r.givesBackP)}
                  </td>
                  <td className="py-1.5 text-right font-mono tabular-nums">{fmt.pct(r.heatSharePpm)}</td>
                  <td className="py-1.5 text-right font-mono tabular-nums">
                    {r.atrAwayX100 === null ? EM_DASH : (r.atrAwayX100 / 100).toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <div className="rounded-[var(--radius)] border border-border p-3" data-testid="positions-since-close">
          <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{POSITIONS_COPY.sinceCloseTitle}</p>
          <p className="mt-1 leading-relaxed">
            {since.compared === 0
              ? POSITIONS_COPY.sinceCloseNoCompare
              : POSITIONS_COPY.sinceCloseUnrealised(fmt.signedMoney(since.unrealisedAtCloseP), fmt.signedMoney(since.unrealisedNowP))}{" "}
            {since.givesBackAtCloseP !== null &&
              since.givesBackNowP !== null &&
              POSITIONS_COPY.sinceCloseGivesBack(fmt.money(since.givesBackAtCloseP), fmt.money(since.givesBackNowP))}{" "}
            {POSITIONS_COPY.sinceCloseOpenedToday(since.openedToday.length)}{" "}
            {since.nearStop.length > 0 ? POSITIONS_COPY.sinceCloseNear(names(since.nearStop)) : POSITIONS_COPY.sinceCloseNoneNear}{" "}
            {POSITIONS_COPY.sinceCloseStops}
          </p>
        </div>
        <div className="rounded-[var(--radius)] border border-border p-3">
          <p className="mb-2 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            {cohortLevel === "sector" ? POSITIONS_COPY.cohortTitleSector : POSITIONS_COPY.cohortTitle}
          </p>
          <CohortList cohort={cohort} />
        </div>
        <div className="rounded-[var(--radius)] border border-border p-3" data-testid="positions-upcoming">
          <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{POSITIONS_COPY.upcomingTitle}</p>
          {events.length === 0 ? (
            <p className="mt-1 text-muted-foreground">{POSITIONS_COPY.upcomingNone}</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-0.5">
              {events.slice(0, 8).map((ev) => (
                <li key={`${ev.kind}|${ev.date}|${ev.symbol}|${ev.fromUnits ?? ""}:${ev.toUnits ?? ""}`}>
                  {ev.kind === "results"
                    ? POSITIONS_COPY.upcomingResults(ev.symbol, whenText(ev.date, data.today))
                    : ev.kind === "expiry"
                      ? POSITIONS_COPY.upcomingExpiry(ev.symbol, whenText(ev.date, data.today))
                      : POSITIONS_COPY.upcomingCorp(ev.kind, ev.symbol, ev.fromUnits ?? 0, ev.toUnits ?? 0, whenText(ev.date, data.today))}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
