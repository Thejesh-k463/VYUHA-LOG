"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Badge } from "@/components/ui/badge";
import { useStoredValue, writeStored } from "@/components/layout/use-stored-value";
import { ProLock } from "@/components/system/pro-lock";
// The ONE source of both prompt sentences (`tests/live-feed-copy.test.ts` pins
// them verbatim, including the ruling that the daily re-sign-in is the
// BROKER's rule and names no regulator). Imported, never restated.
import { LIVE_FEED_COPY } from "@/components/settings/live-feed-card";
import { applyTicks, mergeTicks, type TickMap } from "@/lib/live/apply-ticks";
import { connectPromptDismissal, connectPromptKey, showConnectPrompt } from "@/lib/live/connect-prompt";
import { isMarketOpenIst, istParts } from "@/lib/live/market-hours";
import { daysToResults } from "@/lib/live/results-date";
// The link's whole lifecycle — backoff, the hidden-tab release, the phase
// rules and the close-of-session reconnect — with its browser edges injected
// from here, so `tests/live-stream-link.test.ts` can DRIVE it in node instead
// of grepping this file for the lines that would have done it.
import {
  LINK_IDLE,
  createStreamLink,
  linkStateFor,
  streamKeyOf,
  type KeyedLinkState,
} from "@/lib/live/stream-link";
import {
  CONNECT_PROMPT_COPY,
  DESK_COPY,
  EM_DASH,
  LIVE_STREAM_COPY,
  lockedInAtStop,
  needsData,
  needsSessions,
  resultsChip,
  riskAtStopSentence,
  stalenessLabel,
  stopLabel,
} from "./desk-copy";
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
 * mark, P&L — is FREE, and R, risk at stop, heat and the chart overlay are Pro.
 * The page is NOT wrapped in <ProGate> (invariant 7); the Pro cells render as
 * locked chips, which read as neither a number nor the dash that means "cannot
 * be computed". The SERVER strips the Pro figures too (`load-desk.ts`) — a
 * locked chip over a number that shipped in the payload is not a paywall.
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

/**
 * The virtualiser's INITIAL guess at a row's height, in px — never the last
 * word on it. Every windowed <tr> carries `ref={virtualizer.measureElement}`
 * and a `data-index`, so the real height replaces this one as the row mounts.
 *
 * It is 66 and not 44 because a row is not one line: the Mark cell renders the
 * level and then `<StalenessChip>` as two block-level lines, which is
 * structural, not a font metric. Measured 2026-09-06 in the browser harness
 * (`e2e/z-live-desk.spec.ts`, 45 rows): 2998 px of tbody / 45 ≈ 66.6 px. With
 * 44 here and nothing measuring, every offset was short by (66.6 − 44) × index
 * and the row j had just focused sat 628 px below the fold.
 */
const ROW_HEIGHT = 66;

/**
 * Header height assumed until the <thead> has been measured, in px.
 *
 * The header is `sticky top-0` INSIDE the scrolling box, so the first band of
 * that box's viewport is permanently covered. Neither the virtualiser's
 * `align:"auto"` nor `scrollIntoView({block:"nearest"})` knows that: both
 * treat the top of the box as visible, so j/k landed the focused row exactly
 * this many px under the header. The measured value replaces it on mount; this
 * is only what the first keystroke before layout would use.
 */
const THEAD_HEIGHT_FALLBACK = 40;

/**
 * A STABLE empty tick map, so `applyTicks(rows, ticks)` returns the server's
 * own array by identity until the first frame lands. A fresh `new Map()` per
 * render would make the memo below re-run on every commit.
 */
const NO_TICKS: TickMap = new Map();

const PositionChartPanel = dynamic(
  // W2's real panel. `ssr:false` because it measures its own box and reads a
  // canvas: rendering it on the server produces a different tree than the
  // browser does, and the detail pane only ever opens after a click anyway.
  () => import("./position-chart-panel").then((m) => m.PositionChartPanel),
  { ssr: false, loading: () => <div className="min-h-40 rounded-[var(--radius)] border border-dashed border-border" /> },
);

export type SortKey =
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

/**
 * The rows the desk shows, in the order it shows them: the account chip, the
 * text filter, then the column sort.
 *
 * PURE and EXPORTED so the one interaction that cost the desk a correct
 * keystroke can be tested without a browser (F5): the default sort is
 * `unrealisedP` DESC and `applyTicks` rewrites `unrealisedP` on every tick, so
 * this list REORDERS while the user is looking at it.
 */
export function visibleRows(
  rows: readonly DeskRow[],
  view: { accountFilter: number | null; query: string; sort: { key: SortKey; dir: 1 | -1 } },
): DeskRow[] {
  const q = view.query.trim().toUpperCase();
  const out = rows.filter(
    (r) =>
      (view.accountFilter === null || r.accountId === view.accountFilter) &&
      (q === "" || r.symbol.toUpperCase().includes(q) || r.tradingsymbol.toUpperCase().includes(q)),
  );
  return out.sort((a, b) => compareRows(a, b, view.sort.key, view.sort.dir));
}

/**
 * Where the focused ROW sits now — resolved from its id on every render, never
 * remembered as a position (F5).
 *
 * -1 covers both "nothing focused" and "the focused row is not in this list any
 * more", which is what a filter does to it; `nextIndex()` reads -1 as "start
 * from the top", so j/k stay usable without any state being written back.
 */
export function focusedIndex(visible: readonly DeskRow[], focusId: number | null): number {
  return focusId === null ? -1 : visible.findIndex((r) => r.id === focusId);
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
  const { rows: wireRows, heat, concentration, feed, barsBySymbol, barsCap, atrLength } = data;

  const [accountFilter, setAccountFilter] = React.useState<number | null>(null);
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<{ key: SortKey; dir: 1 | -1 }>({ key: "unrealisedP", dir: -1 });
  /**
   * The focused row's IDENTITY, never its position (F5).
   *
   * An index into `visible` is a promise the list does not keep: `visible`
   * re-sorts on every rows change, the default sort is `unrealisedP` DESC and
   * `applyTicks` rewrites `unrealisedP` on every tick — so two rows whose P&L
   * order flipped swapped the highlight under the user's hands, and Enter / `l`
   * then acted on whatever row the index now pointed at. The Sizing Lab got the
   * wrong position from a keystroke aimed at the right one. Same shape as
   * `expandedId` below, and for the same reason.
   */
  const [focusId, setFocusId] = React.useState<number | null>(null);
  const [expandedId, setExpandedId] = React.useState<number | null>(null);
  // The clock starts null and is set once on mount: rendering an IST time on
  // the server and again in the browser is a hydration mismatch by construction.
  const [now, setNow] = React.useState<Date | null>(null);

  const filterRef = React.useRef<HTMLInputElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  // Measured through a CALLBACK ref, not an effect: React runs it on mount and
  // on unmount, so the height lands without a `setState` inside a `useEffect`
  // keyed on other state (AGENTS.md — that pattern broke the Trades filter).
  const [theadHeight, setTheadHeight] = React.useState(THEAD_HEIGHT_FALLBACK);
  const theadRef = React.useCallback((el: HTMLTableSectionElement | null) => {
    if (el) setTheadHeight(el.offsetHeight || THEAD_HEIGHT_FALLBACK);
  }, []);

  // How much of the scroll box is NOT scrollable content area: its 1px top and
  // bottom borders (plus a horizontal scrollbar, if one ever appears).
  // virtual-core sizes the viewport from `offsetHeight` (`getRect`, the BORDER
  // box) but scrolls in client-box coordinates, so `align:"end"` overshoots by
  // exactly this much and clips the focused row's bottom. Measured 2026-09-06
  // in the harness: offsetHeight 252, clientHeight 250 — the row's bottom sat
  // 1.5 px past the box (`Expected: >= -1  Received: -1.5`). Same callback-ref
  // pattern as the <thead> above, and for the same reason: no setState in an
  // effect keyed on state.
  const [boxChromeY, setBoxChromeY] = React.useState(0);
  const scrollBoxRef = React.useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    if (el) setBoxChromeY(Math.max(0, el.offsetHeight - el.clientHeight));
  }, []);

  React.useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  // ── The live stream ──────────────────────────────────────────────────────
  // Ticks live HERE and nowhere else (owner answer Q25: "ticks in memory only,
  // exactly one persisted mark per position per day"). Nothing below writes.
  const [ticks, setTicks] = React.useState<TickMap>(NO_TICKS);
  /**
   * The link's last report, WITH THE STREAM IT CAME FROM (G3).
   *
   * The desk outlives its connections — it stays mounted across an account
   * switch on purpose — so a bare `LinkState` here made the strip go on
   * printing the DEAD stream's verdict ("Live · openalgo · 14 s", or "Feed
   * stopped — <the old account's reason>") until the new connection's first
   * frame. Storing the key the state was reported for lets `linkStateFor()`
   * answer that at RENDER time; resetting it from the effect instead is the
   * `setState`-in-an-effect AGENTS.md forbids. `""` is no stream's key, so the
   * desk mounts idle.
   */
  const [storedLink, setStoredLink] = React.useState<KeyedLinkState>({ key: "", state: LINK_IDLE });

  const streaming = feed.streaming;

  /**
   * WHICH stream this desk should be holding (F4).
   *
   * `GET /api/live/stream` resolves `getSelectedAccountId()` and captures its
   * quote-key set ONCE per request, and the sidebar account switcher only calls
   * `router.refresh()` — this component stays MOUNTED across a switch, on
   * purpose (a `key` on `<TrackerClient>` would drop every in-memory tick and
   * the keyboard focus every time the user changed account). So the effect has
   * to notice by itself, and this string is what it notices with: the selected
   * account and the exact key set, because the id alone cannot see a position
   * opened in another account while the aggregate view (0) is selected.
   */
  const streamKey = React.useMemo(
    () => streamKeyOf(data.selectedAccountId, wireRows),
    [data.selectedAccountId, wireRows],
  );

  /**
   * DERIVED, never reset in an effect (G3): the old stream's state stops being
   * the answer the instant the key changes, so the strip falls back to
   * "Connecting…" on the frame the switch renders — not 25 s later, and not
   * never on a hidden tab. `lib/live/stream-link.ts` owns the rule.
   */
  const link = linkStateFor(storedLink, streamKey);

  /**
   * ONE `EventSource`, and only for a provider that really streams.
   *
   * `GET /api/live/stream` has existed since v4.0 with no consumer at all, so
   * with the OpenAlgo bridge selected the desk's prices moved only on a server
   * render — while the disclosure (items 2 and 5), PRIVACY item 3, the help
   * page and the Settings slider all describe a 1–5 s refresh "while the Live
   * Desk is open". This effect is that sentence, made true.
   *
   * NOT OPENED FOR `eod` OR `manual`. The route already refuses to subscribe a
   * non-streaming provider, but opening the pipe anyway would hold a request
   * open for a desk that can never receive a tick — and would let the strip say
   * "Live" over an end-of-day print.
   *
   * THE LIFECYCLE ITSELF IS NOT HERE. `createStreamLink` (lib/live/stream-link.ts)
   * owns the backoff, the phase rules and the close-of-session reconnect, with
   * every browser edge — `EventSource`, `document.visibilityState`, the timers,
   * `requestAnimationFrame`, the clock — injected from this file. That is what
   * makes those rules testable at all: this suite runs in node with no DOM, so
   * inside the effect they could only ever be asserted as source text.
   *
   * NO setState IN THIS EFFECT'S BODY. Every write below happens inside a link
   * callback, a `visibilitychange` handler or a timer — never synchronously on
   * a render keyed on other state (AGENTS.md; that pattern broke the Trades
   * filter outright under the React Compiler).
   *
   * Its dependencies are the streaming FLAG and the stream KEY, not `feed` or
   * `data`: re-running on a new object identity would tear down and re-open the
   * stream on every server render.
   */
  React.useEffect(() => {
    if (!streaming) return;
    if (typeof EventSource === "undefined") return; // SSR, and any shell without it

    const link = createStreamLink({
      createSource: () => new EventSource("/api/live/stream"),
      isHidden: () => document.visibilityState === "hidden",
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id),
      schedulePaint: (fn) => requestAnimationFrame(fn),
      cancelPaint: (id) => cancelAnimationFrame(id),
      random: () => Math.random(),
      // Stamped with the stream it is a fact about, so a report that arrives
      // from a connection the desk has already replaced cannot outlive it.
      onState: (state) => setStoredLink({ key: streamKey, state }),
      // Ticks live HERE and nowhere else (owner answer Q25: "ticks in memory
      // only, exactly one persisted mark per position per day"). Nothing on
      // this path writes to the journal.
      onQuotes: (batch) => setTicks((prev) => mergeTicks(prev, batch)),
    });
    const close = () => link.close();

    /**
     * A hidden tab holds no stream. The disclosure promises the feed stops when
     * the desk closes; stopping it when the tab goes to the background is
     * stricter than that promise and costs a background tab nothing.
     */
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        close();
        link.pause();
      } else {
        link.open();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    link.open();

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      close();
      link.destroy();
    };
  }, [streaming, streamKey]);

  /**
   * The rows as the desk shows them: the server's own wire, with whatever has
   * ticked since folded in. PURE and DERIVED — never a `setState` that copies
   * `data.rows` into local state, which is how a payload and a screen drift.
   */
  const rows = React.useMemo(() => applyTicks(wireRows, ticks), [wireRows, ticks]);

  const accountIds = React.useMemo(() => [...new Set(rows.map((r) => r.accountId))], [rows]);

  const visible = React.useMemo(
    () => visibleRows(rows, { accountFilter, query, sort }),
    [rows, accountFilter, query, sort],
  );

  // Derived, never stored: the focused row's POSITION is recomputed from its id
  // on every render, so a re-sort moves the index and leaves the highlight on
  // the same position. A focused row that a filter has just excluded resolves
  // to -1 here — and j/k start again from the top — rather than in an effect
  // that writes state back (AGENTS.md).
  const focusIdx = focusedIndex(visible, focusId);
  const focused = focusIdx >= 0 ? visible[focusIdx] : null;
  const expanded = React.useMemo(() => visible.find((r) => r.id === expandedId) ?? null, [visible, expandedId]);
  /**
   * The newest mark day ON SCREEN, not just the newest the SERVER printed.
   *
   * `feed.asOf` is a snapshot of the payload; once ticks land, a ticked row is
   * newer than it and every un-ticked row is genuinely behind. Reading only
   * `feed.asOf` would leave the "Stale" badge off exactly the rows that had
   * stopped updating.
   */
  const newestDay = React.useMemo(() => {
    let newest = fmt.dayOf(feed.asOf);
    for (const r of rows) {
      const d = fmt.dayOf(r.markAsOf);
      if (d !== null && (newest === null || d > newest)) newest = d;
    }
    return newest;
  }, [rows, feed.asOf]);
  const windowed = visible.length > VIRTUAL_THRESHOLD;

  // ── The feed strip's connection line, DERIVED ────────────────────────────
  // The age refreshes on the desk's existing 30 s clock rather than on a timer
  // of its own; clamped at 0 because `now` can be up to 30 s older than the
  // frame that just arrived.
  const frameAgeS = link.at === null || now === null ? null : Math.max(0, Math.round((now.getTime() - link.at) / 1000));
  const linkLabel = !streaming
    ? null
    : link.phase === "live" && frameAgeS !== null
      ? LIVE_STREAM_COPY.live(feed.providerId, frameAgeS)
      : link.phase === "connected"
        ? LIVE_STREAM_COPY.connected(feed.providerId)
        : link.phase === "reconnecting"
          ? LIVE_STREAM_COPY.reconnecting
          : link.phase === "paused"
            ? LIVE_STREAM_COPY.paused
            : link.phase === "stopped"
              ? LIVE_STREAM_COPY.stopped(link.reason ?? feed.reason ?? LIVE_STREAM_COPY.stoppedNoReason)
              : LIVE_STREAM_COPY.connecting;
  // ONE polite region for the whole desk (F7), and it announces the LINK — not
  // a price and not the frame age. `aria-live` used to sit on every Mark cell,
  // which with the stream really connected queues one announcement per row per
  // tick and makes a screen reader unusable. This changes only when the phase
  // does, so what is read out is the transition.
  const linkAnnouncement = !streaming ? "" : LIVE_STREAM_COPY.announce[link.phase];

  // ── The once-a-day connect prompt (owner answer Q24) ─────────────────────
  // The day key comes from the payload's own IST `today`, so the banner cannot
  // disagree with the desk about which day it is and no client clock is read
  // during render. `useStoredValue` returns null for the server snapshot, so
  // the default (shown) renders on both sides and hydration is clean.
  const promptKey = connectPromptKey(data.today);
  const promptStored = useStoredValue(promptKey);
  const promptOpen = showConnectPrompt({ providerId: feed.providerId, healthState: feed.healthState }, promptStored);

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    // An ESTIMATE, corrected per row by `measureElement` below — a fixed size
    // here is a promise about a row's height that this row does not keep.
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    // The sticky <thead> lives inside this scroll element, so its top
    // `theadHeight` px are never visible. virtual-core subtracts
    // `scrollPaddingStart` in exactly this case (`toOffset = item.start -
    // options.scrollPaddingStart`), and without it `align:"auto"` parked the
    // focused row underneath the header.
    // `scrollMargin` is NOT redundant with the padding, and removing it
    // reintroduces the bug. The <thead> is IN FLOW before the tbody, so a
    // row's real offset is `theadHeight + item.start`; scrollMargin is how
    // virtual-core is told that. Worked numbers, h=40, ROW_HEIGHT 44,
    // clientHeight 600, row 22: align "start"/"auto" now scrolls to 968 (row
    // top lands at 40, flush under the header) where it used to scroll to 928
    // and park the row at 80 — one whole header BELOW where it belongs;
    // align "end" now scrolls to 452, putting the row's bottom exactly on 600
    // instead of clipping its last 40 px. Both spacers below subtract
    // `theadHeight` again because `item.start`/`item.end` become absolute
    // while `getTotalSize()` stays content-relative.
    scrollMargin: theadHeight,
    scrollPaddingStart: theadHeight,
    // The bottom half of the same frame — see `boxChromeY` above.
    scrollPaddingEnd: boxChromeY,
  });

  const openLab = React.useCallback(
    (r: DeskRow) => {
      // `side` travels EXPLICITLY. The Lab used to infer it from the levels
      // (stop above entry ⇒ short), which reads a long whose stop has been
      // trailed above entry as a short and then prices the wrong leg in
      // `chargesAdjustedRisk`. The row already knows the side; sending it is
      // the whole fix, and the Lab refuses a hand-off that omits it.
      const params = new URLSearchParams({ from: "live", symbol: r.symbol, side: r.side, entry: String(r.avgEntryP) });
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
        const next = nextIndex(focusIdx, visible.length, action === "row-down" ? 1 : -1);
        // The index is `desk-keys.ts`'s answer, unchanged; what is STORED is
        // the row it lands on, so the next tick's re-sort cannot move it.
        setFocusId(next >= 0 ? (visible[next]?.id ?? null) : null);
        // Moving an index moves nothing the user can see: the table is a
        // `max-h-[60vh] overflow-auto` box, and past VIRTUAL_THRESHOLD the
        // focused row is not even mounted. Each path needs its own call —
        // the virtualiser can scroll to a row the DOM does not have.
        if (next >= 0) {
          if (windowed) {
            virtualizer.scrollToIndex(next, { align: "auto" });
          } else {
            const box = scrollRef.current;
            const el = box?.querySelector<HTMLElement>(`[data-row-index="${next}"]`);
            el?.scrollIntoView({ block: "nearest" });
            // …and then clear the header BY HAND. `block:"nearest"` counts the
            // band under the sticky <thead> as visible, so a row it scrolls to
            // the top of the box lands underneath it and the user sees the row
            // they just left. It is a no-op when the row was already in view,
            // so this correction only ever fires on the edge that moved.
            if (box && el) {
              const rowTop = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
              if (rowTop - theadHeight < box.scrollTop) box.scrollTop = rowTop - theadHeight;
            }
          }
        }
        return;
      }
      if (action === "focus-filter") {
        e.preventDefault();
        filterRef.current?.focus();
        return;
      }
      // The SAME row the highlight is on — both come from `focusId`, so Enter
      // and `l` can never act on a row a tick re-sorted under the index.
      const row = focused;
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
  }, [visible, focusIdx, focused, openLab, windowed, virtualizer, theadHeight]);

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
          {/* The CONNECTION, never the prices: each mark keeps saying its own
              staleness per row (`stalenessLabel`), and nothing here upgrades a
              delayed print into a tick. */}
          {linkLabel !== null && (
            <>
              <span
                data-testid="live-stream-state"
                className={link.phase === "live" ? "text-profit" : link.phase === "stopped" ? "text-warning" : undefined}
              >
                {linkLabel}
              </span>
              {/* The desk's ONE live region. It carries no number at all, so a
                  30 s clock tick cannot re-announce a state that has not
                  changed. */}
              <span className="sr-only" aria-live="polite" data-testid="live-stream-announce">
                {linkAnnouncement}
              </span>
            </>
          )}
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

      {/* ── "Connect your feed — 20 seconds", once per IST day (Q24) ───────── */}
      {promptOpen && (
        <div
          role="region"
          aria-label={CONNECT_PROMPT_COPY.label}
          data-testid="live-connect-prompt"
          className="flex flex-wrap items-start gap-3 rounded-[var(--radius)] border border-border bg-card-hover/40 px-3 py-2 text-xs"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium">{LIVE_FEED_COPY.connect}</p>
            <p className="mt-1 text-muted-foreground">{CONNECT_PROMPT_COPY.body}</p>
            {/* The re-sign-in is the BROKER's rule, in the broker's own terms —
                the sentence is imported from its one source and names no
                regulator (owner ruling; tests/live-feed-copy.test.ts). */}
            <p className="mt-1 text-muted-foreground">{LIVE_FEED_COPY.dailyReauth}</p>
            {feed.reason && <p className="mt-1 text-muted-foreground">{feed.reason}</p>}
          </div>
          <button
            type="button"
            title={CONNECT_PROMPT_COPY.dismissTitle}
            onClick={() => writeStored(promptKey, connectPromptDismissal())}
            className="ml-auto rounded-[var(--radius)] border border-border px-2 py-1"
          >
            {CONNECT_PROMPT_COPY.dismiss}
          </button>
        </div>
      )}

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
          {/* `heat === null` and `!pro` are the same state by construction —
              the loader strips it — but the null is what the type forces us to
              branch on, so the lock cannot be bypassed by a stale payload. */}
          {!pro || heat === null ? (
            <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <ProLock /> {DESK_COPY.proColumns}
            </p>
          ) : (
            <>
              <p className="mt-1 font-mono text-lg tabular-nums">{fmt.pct(heat.heatPpm)}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {heat.capitalP === null ? DESK_COPY.heatNoCapital : `Open risk ${fmt.money(heat.openRiskP)} of ${fmt.money(heat.capitalP)}.`}
              </p>
              {/* `lockedInProfitP` has been computed since v4.0 and printed
                  nowhere. It is the OTHER side of `max(riskAtStopP, 0)`: heat
                  drops it so a winner cannot cancel another row's real risk,
                  which is right, but dropping it off the SCREEN too lost a real
                  figure. Stated on its own line, never netted into heat above.
                  Pro, because the whole heat tile is (Q55) — this branch only
                  runs inside `pro && heat !== null`. */}
              <p className="text-[11px] text-muted-foreground">{lockedInAtStop(fmt.money(heat.lockedInProfitP))}</p>
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
          {!pro || concentration === null ? (
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
        ref={scrollBoxRef}
        tabIndex={0}
        role="region"
        aria-label="Open positions"
        className="max-h-[60vh] overflow-auto rounded-[var(--radius-card)] border border-border bg-card"
      >
        <table className="w-full border-collapse text-xs">
          <thead ref={theadRef} className="sticky top-0 z-10 bg-[var(--color-header-band)] backdrop-blur">
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
                <td
                  colSpan={COLUMNS.length + 2}
                  style={{
                    height: Math.max(0, (virtualizer.getVirtualItems()[0]?.start ?? theadHeight) - theadHeight),
                  }}
                />
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
                  index={idx}
                  // Windowed rows measure THEMSELVES (same pattern as
                  // `components/ui/data-table.tsx`). Without this the model
                  // keeps `estimateSize` for ever and drifts by
                  // (real − estimate) × index; the un-windowed path scrolls
                  // through the DOM and needs no measurement at all.
                  virtualIndex={windowed ? idx : undefined}
                  measureRef={windowed ? virtualizer.measureElement : undefined}
                  pro={pro}
                  focused={focused?.id === r.id}
                  expanded={expandedId === r.id}
                  breach={breach}
                  newestDay={newestDay}
                  today={data.today}
                  onToggle={() => {
                    setFocusId(r.id);
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
                    height: Math.max(
                      0,
                      virtualizer.getTotalSize() - ((virtualizer.getVirtualItems().at(-1)?.end ?? theadHeight) - theadHeight),
                    ),
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
          today={data.today}
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
  index,
  virtualIndex,
  measureRef,
  pro,
  focused,
  expanded,
  breach,
  newestDay,
  today,
  onToggle,
}: {
  row: DeskRow;
  /** Its position in `visible`, so j/k can scroll the un-windowed table to it. */
  index: number;
  /** Windowed path only: the index `measureElement` reads back off the DOM. */
  virtualIndex?: number;
  /** Windowed path only: `virtualizer.measureElement`. Undefined = unmeasured. */
  measureRef?: (node: HTMLTableRowElement | null) => void;
  pro: boolean;
  focused: boolean;
  expanded: boolean;
  breach: string | null;
  newestDay: string | null;
  /** IST today (`LiveDeskData.today`) — the results chip's only other input. */
  today: string;
  onToggle: () => void;
}) {
  // Q-9. Derived at render from one date and one `today`, so the chip cannot
  // go stale in a cached payload and the row carries no extra number.
  // `daysToResults` returns null for an absent OR past date, and null renders
  // nothing at all — the date stays on the instrument either way.
  const resultsIn = daysToResults(row.resultsDate, today);
  return (
    <tr
      ref={measureRef}
      data-index={virtualIndex}
      className={`border-t border-rule ${focused ? "bg-card-hover" : ""}`}
      aria-selected={focused}
      data-account-id={row.accountId}
      data-row-index={index}
    >
      <td className="px-2 py-1.5">
        <button type="button" onClick={onToggle} aria-expanded={expanded} className="text-left font-medium">
          {row.symbol}
        </button>
        <span className="ml-1 text-[10px] text-muted-foreground">
          {row.side === "short" ? "short" : "long"}
          {row.accountName ? ` · ${row.accountName}` : ` · account ${row.accountId}`}
        </span>
        {resultsIn !== null && (
          <Badge variant="secondary" size="xs" className="ml-1 align-middle">
            {resultsChip(resultsIn)}
          </Badge>
        )}
      </td>
      <td className="px-2 py-1.5">
        <Badge variant="secondary" size="xs">
          {row.product === "raw" ? row.segment : row.product}
        </Badge>
      </td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmt.qty(row.qty)}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmt.level(row.avgEntryP)}</td>
      {/* NO `aria-live` HERE (F7). A polite region per Mark cell was one
          announcement per row per tick once the desk really held the stream —
          40 rows × a 1 s poll is a screen reader that never stops talking. The
          desk announces the LINK, once, from the strip. */}
      <td className="px-2 py-1.5 text-right font-mono tabular-nums">
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
  today,
  onClose,
  onLab,
}: {
  row: DeskRow;
  pro: boolean;
  atrLength: number;
  bars: LiveDeskData["barsBySymbol"][string];
  barsCapped: boolean;
  /** IST today (`LiveDeskData.today`), for the results block. */
  today: string;
  onClose: () => void;
  onLab: () => void;
}) {
  const atrNeed = atrLength + 1;
  const resultsIn = daysToResults(row.resultsDate, today);
  const rvolNeed = 21;
  // Which branch of the stop tree fired. `gated` is the free-licence wire
  // shape (`lib/live/stop.ts`): it keeps the provenance and drops every
  // number, so this sentence reads the same for a free user as for a Pro one.
  const treeSource =
    row.stop.kind === "ok" || row.stop.kind === "zero" || row.stop.kind === "gated" ? row.stop.source : null;
  const stopSource =
    row.effectiveStopSource === "trailing"
      ? "your trailing stop"
      : row.effectiveStopSource === "planned"
        ? "the stop you recorded"
        : treeSource !== null
          ? `the ${treeSource} rule`
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
        {/* Q-9. The DATE as recorded, and its distance as a note. A past date
            is still shown here — it is on the user's own record — but
            `daysToResults` returns null for it, so the note falls back to the
            "not recorded" line rather than counting backwards. */}
        <Block
          title="Results date"
          value={row.resultsDate ?? EM_DASH}
          note={
            row.resultsDate === null
              ? DESK_COPY.resultsMissing
              : resultsIn === null
                ? DESK_COPY.resultsPast
                : resultsChip(resultsIn)
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
              // The row already knows both. The panel inferring either one is
              // how a short rendered as a long and how R drifted (M2, M3).
              side={row.side}
              riskAmountP={row.riskAmountP}
              entryP={row.avgEntryP}
              investedP={row.investedP}
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
            {/* The SAME gate as the visible cell above. A screen reader given
                the em dash would be told the figure cannot be computed, when
                what is true is that this licence does not carry it. */}
            <td>{pro ? fmt.rMultiple(row.openRPpm) : <ProLock />}</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
