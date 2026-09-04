"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { ArrowLeft, GripHorizontal, Search, Undo2, X } from "lucide-react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useStoredValue, writeStored } from "@/components/layout/use-stored-value";
import { useNavHistory } from "@/components/layout/nav-history";
import type { SearchResult, SourceKey } from "@/lib/domain/search-scope";
import {
  MIN_QUERY,
  SEARCH_DEBOUNCE_MS,
  catsKey,
  groupBySource,
  searchUrl,
  toggleCat,
  useSearchSession,
  visibleResults,
} from "./use-search-session";
import { frameFor, isPanelToggleChord } from "./search-panel-keys";
import {
  DEFAULT_PANEL_STATE,
  PANEL_SIZE,
  PANEL_STATE_KEY,
  parsePanelState,
  resolvePosition,
  serialisePanelState,
  usePanelDrag,
  useViewport,
  type Point,
} from "./use-panel-drag";

/**
 * The floating SEARCH ASSISTANT (v3.9, Search v2).
 *
 * ── One engine, two surfaces ────────────────────────────────────────────────
 *
 * Ctrl+K's modal palette is for a search you finish and leave. This panel is
 * for a search you WORK ALONGSIDE: it stays open across navigation, so a
 * result can be opened, read, and the next one tried without retyping. Both
 * surfaces call the same /api/search through the same `use-search-session`
 * helpers and render the same `search-results` list — the chips, the locks and
 * their unlock lines, the "trades need 3+ characters" notice and the
 * truncation line are therefore identical on both by construction, not by two
 * copies kept in step. Nothing search-shaped is duplicated here except the
 * debounced fetch effect itself, which is per-surface state.
 *
 * ── Radix Popover, driven by a positioned ANCHOR ────────────────────────────
 *
 * The panel is freely draggable, which a popover's own placement engine cannot
 * express. Rather than hand-roll dismissal, portalling and focus, the panel
 * renders a 1×1 fixed `PopoverAnchor` AT the resolved position and lets Radix
 * place the content against it. `modal={false}` because the page underneath
 * stays live — this is a tool beside the work, not over it — and an outside
 * click is therefore NOT a dismissal: a persistent panel that vanished when
 * the user clicked the page it is helping them read would be useless.
 *
 * The launcher is a PLAIN button, deliberately NOT a `PopoverTrigger`, and
 * that is load-bearing rather than a style choice. `PopoverTrigger` renders
 * itself inside a `PopperPrimitive.Anchor` until Radix's `hasCustomAnchor`
 * flips true — which happens in an effect, i.e. AFTER the first commit. So on
 * that first commit the trigger registers itself as the popper's anchor (its
 * ref callback runs after ours), and when the flip re-parents it React builds
 * a NEW button node and detaches the old one. Radix's anchor registration is
 * mount-only and null-guarded (`if (node) onAnchorChange(node)`), so it goes
 * on holding the DETACHED node: `getBoundingClientRect()` on it is all zeros,
 * the popper wrapper is pinned at `translate(0px, 0px)`, and the panel renders
 * in the top-left corner and never follows the anchor a drag moves. The drag
 * hook was innocent — it committed `{v:1,x:772,y:72,open:true}` correctly
 * while the panel's own box sat at 0,0. With no trigger there is exactly one
 * anchor, and it is the positioned one.
 *
 * ── State ───────────────────────────────────────────────────────────────────
 *
 * Position and open-ness live in localStorage under a versioned envelope
 * (use-panel-drag.ts), read through `useStoredValue`, so they are DERIVED, not
 * mirrored into React state — and they survive navigation because the root
 * layout mounts this once. The QUERY does not persist: a stale query restored
 * days later would re-fetch on mount, which is a page-load cost for something
 * nobody asked for.
 *
 * The mount is KEYED on the account (app/layout.tsx), and `useSearchSession`
 * stamps its frames with it too — the palette's invariant-8 belt and braces,
 * for the same reason: this component outlives an account switch.
 */
const SearchResults = dynamic(() => import("./search-results"), {
  ssr: false,
  loading: () => <div className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground">Searching…</div>,
});

const NO_HITS: SearchResult[] = [];

interface Hits {
  q: string;
  /** ACCOUNT + chips — the palette's rule, and for the same reason (invariant 8). */
  key: string;
  /** The chips these results were FETCHED with. `openHit` pushes the session
   *  frame from here, never from the live `cats`: a chip toggled between the
   *  fetch and the click made the pushed frame's results and its filter
   *  disagree, and restoring it hid results under chips they never matched. */
  cats: readonly SourceKey[];
  results: SearchResult[];
  error: boolean;
}

function hitsKey(accountId: number, cats: readonly SourceKey[]): string {
  return `${accountId}|${catsKey(cats)}`;
}

export function SearchPanel({ accountId = 0 }: { accountId?: number }) {
  const router = useRouter();
  const nav = useNavHistory();
  const session = useSearchSession(accountId);
  const viewport = useViewport();
  const stored = parsePanelState(useStoredValue(PANEL_STATE_KEY));

  const inputRef = React.useRef<HTMLInputElement>(null);
  /** The launcher, so closing the panel can put focus BACK on it. There is no
   *  PopoverTrigger here (see the header note), and Radix restores focus to
   *  `triggerRef` — which is null — so focus fell to <body>: a keyboard user
   *  who closed the panel landed at the top of the document with no way back
   *  except Tab from the start of the page. */
  const launcherRef = React.useRef<HTMLButtonElement>(null);
  const panelId = React.useId();
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const [cats, setCats] = React.useState<SourceKey[]>([]);
  const [hits, setHits] = React.useState<Hits | null>(null);

  // Before hydration there is no viewport to clamp against, and the server
  // snapshot of storage is the default (closed) — so nothing renders and no
  // markup mismatch is possible.
  const open = stored.open && viewport != null;

  const write = React.useCallback((next: typeof DEFAULT_PANEL_STATE) => {
    writeStored(PANEL_STATE_KEY, serialisePanelState(next));
  }, []);

  const setOpen = React.useCallback(
    (o: boolean) => {
      write({ v: 1, x: stored.x, y: stored.y, open: o });
    },
    [write, stored.x, stored.y],
  );

  const commit = React.useCallback((p: Point) => write({ v: 1, x: p.x, y: p.y, open: true }), [write]);

  const committed = resolvePosition(stored, PANEL_SIZE, viewport ?? { w: PANEL_SIZE.w, h: PANEL_SIZE.h });
  const drag = usePanelDrag(committed, PANEL_SIZE, viewport, commit);

  // Ctrl+Shift+K toggles the panel. Ctrl+K is the modal palette's and is not
  // touched here — two surfaces, two chords, neither shadowing the other.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isPanelToggleChord(e)) {
        e.preventDefault();
        setOpen(!stored.open);
      }
    }
    function onOpenEvent() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("vyuha:search-panel", onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("vyuha:search-panel", onOpenEvent);
    };
  }, [setOpen, stored.open]);

  const q = query.trim();
  const searching = open && q.length >= MIN_QUERY;
  const key = hitsKey(accountId, cats);
  const fresh = hits != null && hits.q === q && hits.key === key;

  React.useEffect(() => {
    if (!searching || fresh) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetch(searchUrl(q, cats), { signal: ctrl.signal, cache: "no-store" })
        .then(async (res) => {
          const body = (await res.json().catch(() => null)) as { ok?: boolean; results?: SearchResult[] } | null;
          if (ctrl.signal.aborted) return;
          setHits({ q, key, cats, results: body?.ok ? (body.results ?? []) : [], error: !body?.ok });
        })
        .catch((e: unknown) => {
          if ((e as { name?: string })?.name === "AbortError") return;
          setHits({ q, key, cats, results: [], error: true });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [searching, fresh, q, key, cats]);

  const shownHits = searching && hits ? hits.results : NO_HITS;
  const ordered = React.useMemo(() => groupBySource(visibleResults(q, shownHits)).flatMap((g) => g.results), [q, shownHits]);

  function openHit(r: SearchResult) {
    const frame = frameFor(hits);
    if (frame) session.push({ q: frame.q, cats: [...frame.cats], results: frame.results });
    // The panel STAYS OPEN — that is the whole point of it. The query stays
    // too, so the next result of the same search is one click away.
    router.push(r.href);
  }

  /** "← previous search": pop the session stack and put that search back — no refetch. */
  function restorePrevious() {
    const frame = session.pop();
    if (!frame) return;
    setQuery(frame.q);
    setCats(frame.cats);
    setHits({ q: frame.q, key: hitsKey(accountId, frame.cats), cats: frame.cats, results: frame.results, error: false });
    setActive(0);
  }

  /** "Back to <screen>": the in-app route beneath this one, via push — never the browser history. */
  function backToPrevious() {
    if (!nav.previous) return;
    router.push(nav.previous);
  }

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, Math.max(ordered.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Backspace" && query === "" && session.depth > 0) {
      e.preventDefault();
      restorePrevious();
    } else if (e.key === "Enter" && ordered[active]) {
      e.preventDefault();
      openHit(ordered[active]);
    }
  }

  /** Arrow-key nudge for anyone who cannot drag a header with a pointer. */
  function onHeaderKey(e: React.KeyboardEvent) {
    const step = e.shiftKey ? 32 : 8;
    const by: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = by[e.key];
    if (!d) return;
    e.preventDefault();
    drag.nudge(d[0], d[1]);
  }

  const backLabel = nav.previous ? `Back to ${nav.previousLabel ?? nav.previous}` : null;

  return (
    <>
      {/* Plain button, NOT a PopoverTrigger — see the header note: a second
          anchor is what pinned this panel to 0,0. */}
      <button
        ref={launcherRef}
        type="button"
        aria-label="Search assistant (Ctrl+Shift+K)"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!stored.open)}
        className="fixed bottom-4 right-4 z-40 inline-flex size-10 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-[var(--shadow-overlay)] transition-colors hover:border-primary/40 hover:text-foreground print:hidden"
      >
        <Search className="size-4" />
      </button>

      <Popover open={open} onOpenChange={setOpen} modal={false}>
        {/* The anchor IS the position. Radix places the content against this
            1×1 fixed point, so dragging the panel is a matter of moving one
            number pair — no re-implementation of portalling or dismissal. */}
        <PopoverAnchor asChild>
          <div
            aria-hidden
            className="pointer-events-none fixed z-40 size-px"
            style={{ left: drag.position.x, top: drag.position.y }}
          />
        </PopoverAnchor>

        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={0}
          avoidCollisions={false}
          // The clamp in use-panel-drag.ts is the collision handling; Radix's
          // own flip would fight it and move the panel out from under the drag.
          onInteractOutside={(e) => e.preventDefault()}
          onOpenAutoFocus={(e) => {
            // Focus the input, not the panel shell — the user opened a search box.
            e.preventDefault();
            inputRef.current?.focus();
          }}
          onCloseAutoFocus={(e) => {
            // Radix restores focus to its trigger; this popover HAS no trigger
            // (a second anchor is what pinned the panel to 0,0), so its
            // triggerRef is null and focus fell to <body>. Put it back on the
            // launcher, which is where the user's attention already is.
            e.preventDefault();
            launcherRef.current?.focus();
          }}
          id={panelId}
          className="flex flex-col overflow-hidden p-0 print:hidden"
          style={{ width: PANEL_SIZE.w, height: PANEL_SIZE.h }}
          data-search-panel
          data-dragging={drag.dragging || undefined}
          aria-label="Search assistant"
        >
          <div
            data-search-panel-header
            tabIndex={0}
            // A toolbar role would promise that the arrow keys move focus
            // BETWEEN its controls (the APG roving-tabindex pattern),
            // and here they move the PANEL. A screen-reader user following
            // that promise would drag the window instead of reaching the close
            // button. `group` makes the same label available and promises
            // nothing about the arrows.
            role="group"
            aria-label="Move the search assistant (arrow keys)"
            onPointerDown={drag.onPointerDown}
            onKeyDown={onHeaderKey}
            className="flex cursor-grab items-center gap-2 border-b border-border px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring active:cursor-grabbing"
          >
            <GripHorizontal className="size-3.5 shrink-0" />
            <span>Search</span>
            <button
              type="button"
              aria-label="Close search assistant"
              onClick={() => setOpen(false)}
              className="ml-auto rounded-sm p-0.5 hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>

          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onInputKey}
              placeholder="Search trades, ledger, audit, symbols, help…"
              className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          {(session.depth > 0 || backLabel) && (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5">
              {session.depth > 0 && (
                <button
                  type="button"
                  onClick={restorePrevious}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  <Undo2 className="size-3" />
                  ← previous search
                  {session.previous && <span className="opacity-70">&ldquo;{session.previous.q}&rdquo;</span>}
                </button>
              )}
              {backLabel && (
                <button
                  type="button"
                  onClick={backToPrevious}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  <ArrowLeft className="size-3" />
                  {backLabel}
                </button>
              )}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {searching ? (
              <SearchResults
                q={q}
                results={shownHits}
                loading={!fresh}
                error={fresh && !!hits?.error}
                cats={cats}
                onToggleCat={(k) => {
                  setCats((c) => toggleCat(c, k));
                  setActive(0);
                }}
                activeIndex={active}
                onHover={setActive}
                onOpen={openHit}
              />
            ) : (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                Type {MIN_QUERY}+ characters. The panel stays open while you read — drag its header to move it.
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}
