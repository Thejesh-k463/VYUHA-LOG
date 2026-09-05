"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Badge } from "@/components/ui/badge";
import { ProLock } from "@/components/system/pro-lock";
import { isMarketOpenIst, istParts } from "@/lib/live/market-hours";
import { DESK_COPY, EM_DASH, needsData, needsSessions, riskAtStopSentence, stalenessLabel, stopLabel } from "./desk-copy";
import * as fmt from "./desk-format";
import { deskAction, isTypingTarget, nextIndex } from "./desk-keys";
import type { DeskRow, LiveDeskData } from "./desk-types";

/**
 * The Live Desk tracker (spec §3.1).
 *
 * COLUMN ORDER is the owner's Q19 ruling — spec §2.1 read top to bottom, with
 * the account carried as a chip on every row rather than as a fourteenth
 * column, so the ruling's order survives and "account id on every row"
 * (invariant 8) is still literally true.
 *
 * FREE / PRO is the owner's Q55 ruling: the tracker's own record — positions,
 * mark, P&L — is FREE, and R, risk at stop, heat, the chart overlay and alerts
 * are Pro. The page is NOT wrapped in <ProGate> (invariant 7); the Pro cells
 * render as locked chips, which read as neither a number nor the dash that
 * means "cannot be computed".
 *
 * WHY THE DETAIL PANE IS NOT AN INLINE ROW: rows are virtualised, and a
 * variable-height row inside a windowed list re-measures on every expand. One
 * pane under the table also enforces spec §3.2's "one full chart at a time".
 *
 * NO setState IN AN EFFECT KEYED ON STATE. Everything derived — the filtered
 * list, the sort, the focused row's identity — is computed during render with
 * `useMemo`. The only effects here are a window keydown listener and the
 * market clock's interval, neither of which reads another piece of state.
 */

/** Beyond this many rows the list is windowed (spec §8: 50 and 100 positions). */
export const VIRTUAL_THRESHOLD = 40;

/** Row height the virtualiser estimates, in px. */
const ROW_HEIGHT = 44;

const PositionChartPanel = dynamic(
  // W2's real panel. `ssr:false` because it measures its own box and reads a
  // canvas: rendering it on the server produces a different tree than the
  // browser does, and the detail pane only ever opens after a click anyway.
  () => import("./position-chart-panel").then((m) => m.PositionChartPanel),
  { ssr: false, loading: () => <div className="min-h-40 rounded-[var(--radius)] border border-dashed border-border" /> },
);

type SortKey =
  | "symbol"
  | "product"
  | "qty"
  | "avgEntryP"
  | "markP"
  | "dayChangePpm"
  | "unrealisedP"
  | "unrealisedPctPpm"
  | "holdingDays"
  | "riskAtStopP"
  | "openRPpm"
  | "pctOfCapital";

interface Column {
  key: SortKey;
  label: string;
  /** Right-aligned numeric cells; the identity columns are not. */
  num: boolean;
  /** Pro capability (Q55). Rendered as a locked chip for a free user. */
  pro?: true;
}

/** Q19 / spec §2.1, in order. Nothing reorders this at runtime. */
const COLUMNS: Column[] = [
  { key: "symbol", label: "Symbol", num: false },
  { key: "product", label: "Product", num: false },
  { key: "qty", label: "Qty", num: true },
  { key: "avgEntryP", label: "Avg entry", num: true },
  { key: "markP", label: "Mark", num: true },
  { key: "dayChangePpm", label: "Day", num: true },
  { key: "unrealisedP", label: "Unrealised ₹", num: true },
  { key: "unrealisedPctPpm", label: "Unrealised %", num: true },
  { key: "holdingDays", label: "Days", num: true },
  { key: "riskAtStopP", label: "Risk at stop", num: true, pro: true },
  { key: "openRPpm", label: "Open R", num: true, pro: true },
  { key: "pctOfCapital", label: "% of capital", num: true, pro: true },
];

function sortValue(r: DeskRow, key: SortKey): number | string | null {
  switch (key) {
    case "symbol":
      return r.symbol;
    case "product":
      return r.product;
    case "pctOfCapital":
      return r.pctOfCapital.ppm;
    default:
      return r[key] as number | null;
  }
}

/** Nulls always sort last, in both directions — a missing figure is not a small one. */
function compareRows(a: DeskRow, b: DeskRow, key: SortKey, dir: 1 | -1): number {
  const x = sortValue(a, key);
  const y = sortValue(b, key);
  if (x === null && y === null) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  if (typeof x === "string" || typeof y === "string") return String(x).localeCompare(String(y)) * dir;
  return (x - y) * dir;
}

/** A level the mark has passed, as a TEXT chip — never a colour on its own. */
function breachOf(r: DeskRow): string | null {
  if (r.markP === null) return null;
  const long = r.side === "long";
  if (r.effectiveStopP !== null && (long ? r.markP <= r.effectiveStopP : r.markP >= r.effectiveStopP)) {
    return "Stop touched";
  }
  if (r.targetP !== null && (long ? r.markP >= r.targetP : r.markP <= r.targetP)) return "Target reached";
  return null;
}

/** 120×32 inline SVG from the stored closes. No chart library, no canvas. */
function Sparkline({ closes, label }: { closes: number[]; label: string }) {
  if (closes.length < 2) {
    return (
      <span className="text-[10px] text-muted-foreground" title={needsData("2 stored sessions")}>
        {EM_DASH}
      </span>
    );
  }
  const w = 120;
  const h = 32;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const step = w / (closes.length - 1);
  const points = closes.map((c, i) => `${(i * step).toFixed(1)},${(h - ((c - min) / span) * h).toFixed(1)}`).join(" ");
  const rising = closes[closes.length - 1] >= closes[0];
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={label}
      className="overflow-visible"
      preserveAspectRatio="none"
    >
      <polyline
        points={points}
        fill="none"
        strokeWidth={1.25}
        className={rising ? "stroke-profit" : "stroke-loss"}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function StalenessChip({ row, newestDay }: { row: DeskRow; newestDay: string | null }) {
  const day = fmt.dayOf(row.markAsOf);
  const stale = newestDay !== null && day !== null && day < newestDay;
  return (
    <span className="inline-flex items-center gap-1">
      <Badge variant={row.staleness === null ? "secondary" : "outline"} size="xs">
        {stalenessLabel(row.staleness, day ? fmt.shortDate(day) : null)}
      </Badge>
      {stale && (
        <Badge variant="warning" size="xs" title={DESK_COPY.staleMark}>
          Stale
        </Badge>
      )}
    </span>
  );
}

export function TrackerClient({ data, pro }: { data: LiveDeskData; pro: boolean }) {
  const router = useRouter();
  const { rows, heat, concentration, feed, barsBySymbol, barsCap, atrLength } = data;

  const [accountFilter, setAccountFilter] = React.useState<number | null>(null);
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<{ key: SortKey; dir: 1 | -1 }>({ key: "unrealisedP", dir: -1 });
  const [focusIdx, setFocusIdx] = React.useState(-1);
  const [expandedId, setExpandedId] = React.useState<number | null>(null);
  // The clock starts null and is set once on mount: rendering an IST time on
  // the server and again in the browser is a hydration mismatch by construction.
  const [now, setNow] = React.useState<Date | null>(null);

  const filterRef = React.useRef<HTMLInputElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const accountIds = React.useMemo(() => [...new Set(rows.map((r) => r.accountId))], [rows]);

  const visible = React.useMemo(() => {
    const q = query.trim().toUpperCase();
    const out = rows.filter(
      (r) =>
        (accountFilter === null || r.accountId === accountFilter) &&
        (q === "" || r.symbol.toUpperCase().includes(q) || r.tradingsymbol.toUpperCase().includes(q)),
    );
    return out.sort((a, b) => compareRows(a, b, sort.key, sort.dir));
  }, [rows, accountFilter, query, sort]);

  // Derived, never stored: a focus index past the end of a freshly filtered
  // list resolves here rather than in an effect that writes state back.
  const focused = focusIdx >= 0 && focusIdx < visible.length ? visible[focusIdx] : null;
  const expanded = React.useMemo(() => visible.find((r) => r.id === expandedId) ?? null, [visible, expandedId]);
  const newestDay = fmt.dayOf(feed.asOf);
  const windowed = visible.length > VIRTUAL_THRESHOLD;

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const openLab = React.useCallback(
    (r: DeskRow) => {
      const params = new URLSearchParams({ from: "live", symbol: r.symbol, entry: String(r.avgEntryP) });
      if (r.effectiveStopP !== null) params.set("stop", String(r.effectiveStopP));
      router.push(`/sizing-lab?${params.toString()}`);
    },
    [router],
  );

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const typing = isTypingTarget(el?.tagName, el?.isContentEditable ?? false);
      const action = deskAction(e, typing);
      if (action === null) return;
      if (action === "escape") {
        filterRef.current?.blur();
        scrollRef.current?.focus();
        return;
      }
      if (action === "row-down" || action === "row-up") {
        e.preventDefault();
        setFocusIdx((i) => nextIndex(i, visible.length, action === "row-down" ? 1 : -1));
        return;
      }
      if (action === "focus-filter") {
        e.preventDefault();
        filterRef.current?.focus();
        return;
      }
      const row = focusIdx >= 0 && focusIdx < visible.length ? visible[focusIdx] : null;
      if (row === null) return;
      if (action === "expand") {
        e.preventDefault();
        setExpandedId((id) => (id === row.id ? null : row.id));
      } else if (action === "sizing-lab") {
        e.preventDefault();
        openLab(row);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, focusIdx, openLab]);

  const marketOpen = now === null ? null : isMarketOpenIst(now);

  return (
    <div className="flex flex-col gap-4 p-6">
      {/* ── Header rail: clock · feed · account filter · text filter ───────── */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant={marketOpen === null ? "secondary" : marketOpen ? "profit" : "secondary"} size="xs">
            {marketOpen === null ? EM_DASH : marketOpen ? DESK_COPY.marketOpen : DESK_COPY.marketClosed}
          </Badge>
          <span className="font-mono tabular-nums">
            {now === null ? EM_DASH : `${istParts(now).hhmm} ${DESK_COPY.marketClock}`}
          </span>
        </span>

        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground" title={feed.reason ?? undefined}>
          <Badge variant={feed.ok ? "outline" : "warning"} size="xs">
            {feed.providerId}
          </Badge>
          <span>{feed.label}</span>
          <span className="font-mono tabular-nums">{feed.asOf ? fmt.shortDate(feed.asOf) : EM_DASH}</span>
        </span>

        {accountIds.length > 1 && (
          <span className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by account">
            <button
              type="button"
              onClick={() => setAccountFilter(null)}
              aria-pressed={accountFilter === null}
              className={`rounded-[var(--radius-pill)] border px-2 py-0.5 text-[11px] ${accountFilter === null ? "border-primary/40 bg-primary/[0.07] text-primary" : "border-border text-muted-foreground"}`}
            >
              All accounts
            </button>
            {accountIds.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setAccountFilter(id)}
                aria-pressed={accountFilter === id}
                className={`rounded-[var(--radius-pill)] border px-2 py-0.5 text-[11px] ${accountFilter === id ? "border-primary/40 bg-primary/[0.07] text-primary" : "border-border text-muted-foreground"}`}
              >
                {rows.find((r) => r.accountId === id)?.accountName ?? `Account ${id}`}
              </button>
            ))}
          </span>
        )}

        <input
          ref={filterRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter symbols  ( / )"
          aria-label="Filter the desk by symbol"
          className="ml-auto h-7 w-48 rounded-[var(--radius)] border border-border bg-input px-2 text-xs"
        />
      </div>

      {/* ── "Risk not set" → the Sizing Lab (Q33) ──────────────────────────── */}
      {data.riskNotSet && (
        <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius)] border border-gold/40 bg-gold/[0.07] px-3 py-2 text-xs">
          <span>{DESK_COPY.riskNotSet}</span>
          <Link href="/sizing-lab?from=live" className="font-medium text-primary underline underline-offset-2">
            {DESK_COPY.riskNotSetCta}
          </Link>
        </div>
      )}

      {/* ── Heat strip + sector concentration (Pro, Q55) ────────────────────── */}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-[var(--radius-card)] border border-border bg-card p-3">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{DESK_COPY.heatTitle}</p>
          {!pro ? (
            <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <ProLock /> {DESK_COPY.proColumns}
            </p>
          ) : (
            <>
              <p className="mt-1 font-mono text-lg tabular-nums">{fmt.pct(heat.heatPpm)}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {heat.capitalP === null ? DESK_COPY.heatNoCapital : `Open risk ${fmt.money(heat.openRiskP)} of ${fmt.money(heat.capitalP)}.`}
              </p>
              {heat.rowsWithoutStop > 0 && (
                <p className="text-[11px] text-muted-foreground">{DESK_COPY.heatNoStop(heat.rowsWithoutStop)}</p>
              )}
              {heat.ceilingPpm !== null && (
                <p className="text-[11px] text-muted-foreground">Your ceiling is {fmt.pct(heat.ceilingPpm)}.</p>
              )}
            </>
          )}
        </div>

        <div className="rounded-[var(--radius-card)] border border-border bg-card p-3">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{DESK_COPY.concentrationTitle}</p>
          {!pro ? (
            <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <ProLock /> {DESK_COPY.proColumns}
            </p>
          ) : concentration.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">{DESK_COPY.concentrationEmpty}</p>
          ) : (
            <>
              <ul className="mt-1 space-y-0.5">
                {concentration.slice(0, 5).map((c) => (
                  <li key={c.group ?? "unclassified"} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate">
                      {c.group ?? "Unclassified"}{" "}
                      {c.tier && (
                        <Badge variant="secondary" size="xs">
                          {c.tier}
                        </Badge>
                      )}
                    </span>
                    <span className="font-mono tabular-nums">
                      {fmt.pct(c.share.ppm)} <span className="text-muted-foreground">({c.constituents})</span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[11px] text-muted-foreground">{DESK_COPY.rotationCaveat}</p>
            </>
          )}
        </div>
      </div>

      {/* ── The tracker table ───────────────────────────────────────────────── */}
      <div
        ref={scrollRef}
        tabIndex={0}
        role="region"
        aria-label="Open positions"
        className="max-h-[60vh] overflow-auto rounded-[var(--radius-card)] border border-border bg-card"
      >
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-[var(--color-header-band)] backdrop-blur">
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
                  className={`whitespace-nowrap px-2 py-1.5 font-medium text-[var(--color-header-text)] ${c.num ? "text-right" : "text-left"}`}
                >
                  <button
                    type="button"
                    onClick={() => setSort((s) => (s.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: c.num ? -1 : 1 }))}
                    className="inline-flex items-center gap-1"
                  >
                    {c.label}
                    {c.pro && !pro && <ProLock />}
                    {sort.key === c.key && <span aria-hidden>{sort.dir === 1 ? "▲" : "▼"}</span>}
                  </button>
                </th>
              ))}
              <th scope="col" className="px-2 py-1.5 text-left font-medium text-[var(--color-header-text)]">
                Trend
              </th>
              <th scope="col" className="px-2 py-1.5 text-left font-medium text-[var(--color-header-text)]">
                State
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length + 2} className="px-2 py-6 text-center text-muted-foreground">
                  {rows.length === 0 ? DESK_COPY.emptyBook : DESK_COPY.emptyFilter}
                </td>
              </tr>
            )}
            {windowed && visible.length > 0 && (
              <tr aria-hidden>
                <td colSpan={COLUMNS.length + 2} style={{ height: virtualizer.getVirtualItems()[0]?.start ?? 0 }} />
              </tr>
            )}
            {/* Indices, not rows: the virtualiser already knows which index it
                is rendering, and looking a row's position back up with
                indexOf() is a quadratic scan on the 100-position budget row. */}
            {(windowed ? virtualizer.getVirtualItems().map((v) => v.index) : visible.map((_, i) => i)).map((idx) => {
              const r = visible[idx];
              const breach = breachOf(r);
              return (
                <Row
                  key={r.id}
                  row={r}
                  pro={pro}
                  focused={focused?.id === r.id}
                  expanded={expandedId === r.id}
                  breach={breach}
                  newestDay={newestDay}
                  onToggle={() => {
                    setFocusIdx(idx);
                    setExpandedId((id) => (id === r.id ? null : r.id));
                  }}
                />
              );
            })}
            {windowed && visible.length > 0 && (
              <tr aria-hidden>
                <td
                  colSpan={COLUMNS.length + 2}
                  style={{
                    height: Math.max(0, virtualizer.getTotalSize() - (virtualizer.getVirtualItems().at(-1)?.end ?? 0)),
                  }}
                />
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-muted-foreground">
        {visible.length} of {rows.length} open positions{windowed ? " · rows are windowed as you scroll" : ""}.{" "}
        {DESK_COPY.keyboardHelp}
      </p>

      {/* ── Detail pane: one position at a time (spec §3.2) ─────────────────── */}
      {expanded && (
        <DetailPane
          row={expanded}
          pro={pro}
          atrLength={atrLength}
          bars={barsBySymbol[expanded.symbol.toUpperCase()] ?? []}
          barsCapped={barsCap.trimmed}
          onClose={() => setExpandedId(null)}
          onLab={() => openLab(expanded)}
        />
      )}

      <footer className="border-t border-border pt-3 text-[11px] text-muted-foreground">
        <p>{DESK_COPY.disclaimer}</p>
        <p className="mt-1">{DESK_COPY.disclaimerShort}</p>
        <p className="mt-1">{DESK_COPY.fillsCaveat}</p>
        <p className="mt-1">{DESK_COPY.chargesCaveat}</p>
      </footer>
    </div>
  );
}

function Row({
  row,
  pro,
  focused,
  expanded,
  breach,
  newestDay,
  onToggle,
}: {
  row: DeskRow;
  pro: boolean;
  focused: boolean;
  expanded: boolean;
  breach: string | null;
  newestDay: string | null;
  onToggle: () => void;
}) {
  return (
    <tr
      className={`border-t border-rule ${focused ? "bg-card-hover" : ""}`}
      aria-selected={focused}
      data-account-id={row.accountId}
    >
      <td className="px-2 py-1.5">
        <button type="button" onClick={onToggle} aria-expanded={expanded} className="text-left font-medium">
          {row.symbol}
        </button>
        <span className="ml-1 text-[10px] text-muted-foreground">
          {row.side === "short" ? "short" : "long"}
          {row.accountName ? ` · ${row.accountName}` : ` · account ${row.accountId}`}
        </span>
      </td>
      <td className="px-2 py-1.5">
        <Badge variant="secondary" size="xs">
          {row.product === "raw" ? row.segment : row.product}
        </Badge>
      </td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmt.qty(row.qty)}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmt.level(row.avgEntryP)}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums" aria-live="polite">
        <span className="block">{fmt.level(row.markP)}</span>
        <StalenessChip row={row} newestDay={newestDay} />
      </td>
      <td className={`px-2 py-1.5 text-right font-mono tabular-nums ${fmt.pnlClass(row.dayChangePpm)}`}>
        <span aria-hidden>{fmt.directionGlyph(row.dayChangePpm)}</span> {fmt.signedPct(row.dayChangePpm)}
      </td>
      <td className={`px-2 py-1.5 text-right font-mono tabular-nums ${fmt.pnlClass(row.unrealisedP)}`}>
        <span aria-hidden>{fmt.directionGlyph(row.unrealisedP)}</span> {fmt.signedMoney(row.unrealisedP)}
      </td>
      <td className={`px-2 py-1.5 text-right font-mono tabular-nums ${fmt.pnlClass(row.unrealisedPctPpm)}`}>
        {fmt.signedPct(row.unrealisedPctPpm)}
      </td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{row.holdingDays ?? EM_DASH}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">
        {pro ? fmt.money(row.riskAtStopP) : <ProLock />}
      </td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{pro ? fmt.rMultiple(row.openRPpm) : <ProLock />}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">
        {pro ? fmt.pct(row.pctOfCapital.ppm) : <ProLock />}
      </td>
      <td className="px-2 py-1.5">
        <Sparkline closes={row.spark} label={`${row.symbol}: last ${row.spark.length} closing prices`} />
      </td>
      <td className="px-2 py-1.5">
        {breach ? (
          <Badge variant="warning" size="xs">
            {breach}
          </Badge>
        ) : (
          <span className="text-muted-foreground">{EM_DASH}</span>
        )}
      </td>
    </tr>
  );
}

/** One labelled figure with its own empty state. Never renders a bare number. */
function Block({ title, value, note }: { title: string; value: React.ReactNode; note?: string }) {
  return (
    <div className="rounded-[var(--radius)] border border-border p-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{title}</p>
      <p className="font-mono text-sm tabular-nums">{value}</p>
      {note && <p className="text-[10px] text-muted-foreground">{note}</p>}
    </div>
  );
}

function DetailPane({
  row,
  pro,
  atrLength,
  bars,
  barsCapped,
  onClose,
  onLab,
}: {
  row: DeskRow;
  pro: boolean;
  atrLength: number;
  bars: LiveDeskData["barsBySymbol"][string];
  barsCapped: boolean;
  onClose: () => void;
  onLab: () => void;
}) {
  const atrNeed = atrLength + 1;
  const rvolNeed = 21;
  const stopSource =
    row.effectiveStopSource === "trailing"
      ? "your trailing stop"
      : row.effectiveStopSource === "planned"
        ? "the stop you recorded"
        : row.stop.kind === "ok" || row.stop.kind === "zero"
          ? `the ${row.stop.source} rule`
          : null;

  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-card p-4" aria-label={`${row.symbol} detail`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {row.symbol}{" "}
          <span className="text-xs font-normal text-muted-foreground">
            account {row.accountId}
            {row.accountName ? ` · ${row.accountName}` : ""} · {row.qty} @ {fmt.level(row.avgEntryP)}
          </span>
        </h2>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onLab} className="rounded-[var(--radius)] border border-border px-2 py-1 text-xs">
            {DESK_COPY.riskNotSetCta}
          </button>
          <button type="button" onClick={onClose} className="rounded-[var(--radius)] border border-border px-2 py-1 text-xs">
            Close
          </button>
        </div>
      </div>

      {/* Q31 (b) as the label, (a) as the sentence below it. */}
      <p className="mt-2 text-xs">
        {row.effectiveStopP === null
          ? DESK_COPY.riskNotSet
          : stopLabel(fmt.level(row.effectiveStopP), stopSource ?? "your record", fmt.signedPct(row.distanceToStopPpm))}
      </p>
      {pro && row.riskAtStopP !== null && row.effectiveStopP !== null && (
        <p className="mt-1 text-xs text-muted-foreground">
          {riskAtStopSentence(
            fmt.level(row.effectiveStopP),
            fmt.money(row.riskAtStopP),
            row.pctOfCapital.ppm === null ? null : fmt.pct(row.pctOfCapital.ppm),
          )}
        </p>
      )}

      <div className="mt-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Block
          title={`ATR(${atrLength}) % of mark`}
          value={row.atrP3 === null ? EM_DASH : fmt.atrPctOfMark(row.atrP3, row.markP)}
          note={row.atrP3 === null ? needsSessions(atrNeed, row.atrSessions) : `Stop is ${fmt.atrUnits(row.distanceToStopAtrX100)} ATR away.`}
        />
        <Block
          title="RVOL"
          value={fmt.ratio(row.rvol.ppm)}
          note={row.rvol.ppm === null ? needsSessions(rvolNeed, row.atrSessions) : `Baseline ${row.rvol.denominator ?? EM_DASH}.`}
        />
        <Block
          title={`${row.highDistance.label} high distance`}
          value={fmt.signedPct(row.highDistance.ppm)}
          note={
            row.highDistance.ppm === null
              ? needsSessions(2, row.highDistance.sessions)
              : `Measured over ${row.highDistance.sessions} stored sessions.`
          }
        />
        <Block
          title="Relative strength"
          value={EM_DASH}
          note={needsData("a stored history for the market it is measured against")}
        />
        <Block
          title="Target"
          value={fmt.level(row.targetP)}
          note={row.targetP === null ? needsData("a target on the trade") : `${fmt.signedPct(row.distanceToTargetPpm)} away.`}
        />
      </div>

      {row.mtf && (
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <Block title="MTF funded" value={fmt.money(row.mtf.fundedP)} />
          <Block title="Your own capital" value={fmt.money(row.mtf.ownCapitalP)} />
          <Block title="Interest accrued" value={fmt.money(row.mtf.accruedInterestP)} />
        </div>
      )}

      <div className="mt-3">
        {pro ? (
          <>
            <PositionChartPanel
              symbol={row.symbol}
              isin={row.isin}
              entryP={row.avgEntryP}
              targetP={row.targetP}
              qty={row.qty}
              accountId={row.accountId}
              stop={row.stop}
              bars={bars}
            />
            {barsCapped && (
              <p className="mt-1 text-[10px] text-muted-foreground">
                Chart history is capped at the most recent sessions this desk loaded.
              </p>
            )}
          </>
        ) : (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <ProLock /> {DESK_COPY.proColumns}
          </p>
        )}
      </div>

      {/* The canvas is opaque to a screen reader (spec §9): the same five
          numbers, in a table, adjacent to it. */}
      <table className="sr-only">
        <caption>{row.symbol} levels</caption>
        <tbody>
          <tr>
            <th scope="row">Entry</th>
            <td>{fmt.level(row.avgEntryP)}</td>
          </tr>
          <tr>
            <th scope="row">Mark</th>
            <td>{fmt.level(row.markP)}</td>
          </tr>
          <tr>
            <th scope="row">Target</th>
            <td>{fmt.level(row.targetP)}</td>
          </tr>
          <tr>
            <th scope="row">Stop</th>
            <td>{fmt.level(row.effectiveStopP)}</td>
          </tr>
          <tr>
            <th scope="row">Unrealised R</th>
            <td>{fmt.rMultiple(row.openRPpm)}</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
