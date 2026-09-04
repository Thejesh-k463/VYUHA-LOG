"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useRouter } from "next/navigation";
import { NAV_ITEMS } from "@/components/layout/nav-config";
import { useNavHistory } from "@/components/layout/nav-history";
import { screenVisible, type Workspace } from "@/lib/domain/workspace";
import type { SearchResult, SourceKey } from "@/lib/domain/search-scope";
import { Search, CornerDownLeft, Plus, ArrowLeft, Undo2 } from "lucide-react";
import {
  MIN_QUERY,
  SEARCH_DEBOUNCE_MS,
  catsKey,
  deriveKeywords,
  groupBySource,
  searchUrl,
  toggleCat,
  useSearchSession,
  visibleResults,
} from "./use-search-session";

/**
 * Search v1 in the palette (v3.8 Wave 3) — PERFORMANCE CONTRACT.
 *
 * The palette mounts on EVERY page, so everything search-shaped is lazy:
 *  - the results list is reached only through `next/dynamic` (below), never a
 *    static import — its chunk loads on the first search, not on page load;
 *  - the help desk's keyword registry is `import()`-ed on the first OPEN, not
 *    at module evaluation — help-content.ts is a page of prose that no page
 *    but /help ships today, and this file must not change that;
 *  - the ONE fetch call in this file sits inside the debounced search effect,
 *    behind the MIN_QUERY guard. Nothing is requested before the user types.
 * tests/search-palette.test.ts reads this file and fails on any of the three.
 */
const SearchResults = dynamic(() => import("./search-results"), {
  ssr: false,
  loading: () => <div className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground">Searching…</div>,
});

interface Command {
  label: string;
  group: string;
  href: string;
  keywords: string;
  action?: true;
}

const ACTIONS: Command[] = [
  { label: "Add trade (closed / manual)", group: "Actions", href: "/trades?add=manual", keywords: "new trade entry log", action: true },
  { label: "Add open trade", group: "Actions", href: "/trades?add=open", keywords: "new position running sl target", action: true },
  { label: "Add IPO", group: "Actions", href: "/ipos?add=1", keywords: "new application allotment", action: true },
  { label: "New playbook", group: "Actions", href: "/playbooks?add=1", keywords: "new setup rules", action: true },
];

/**
 * Screen keywords are DERIVED from HELP_ENTRIES by href (one registry, kept
 * by the help desk) — the hand-written map this replaced had drifted from it
 * silently. Loaded once per session on the first open; until it lands a screen
 * matches on its label and group, which is what the first keystroke hits anyway.
 */
type KeywordMap = ReadonlyMap<string, string>;
let keywordCache: KeywordMap | null = null;

function buildCommands(keywords: KeywordMap | null): Command[] {
  return [
    ...NAV_ITEMS.map((n) => ({ label: n.label, group: n.group, href: n.href, keywords: keywords?.get(n.href) ?? n.label.toLowerCase() })),
    ...ACTIONS,
  ];
}

/**
 * Workspace mode hides the other book's screens here too — a palette that
 * still offers Expiry Analytics to an equity-only user has not tidied
 * anything. Actions are matched on their PATH, so "Add IPO" (/ipos?add=1)
 * disappears with the IPO screen it would open.
 */
function commandsFor(all: Command[], ws: Workspace): Command[] {
  if (ws === "both") return all;
  return all.filter((c) => screenVisible(c.href.split("?")[0], ws));
}

function rank(c: Command, q: string): number {
  const label = c.label.toLowerCase();
  if (label.startsWith(q)) return 0;
  if (label.includes(q)) return 1;
  if (c.group.toLowerCase().includes(q)) return 2;
  if (c.keywords.includes(q)) return 3;
  return -1;
}

const NO_HITS: SearchResult[] = [];

interface Hits {
  q: string;
  /**
   * ACCOUNT + chips. The account belongs in the cache key because the palette
   * is mounted once by the root layout and survives an account switch (the
   * switcher POSTs, then router.refresh() — no client state is torn down).
   * Without it, `fresh` short-circuits the fetch and the same query renders
   * account A's trade rows while the sidebar says B.
   */
  key: string;
  results: SearchResult[];
  error: boolean;
}

/** `hits` is valid only for the account it was fetched under, and the chips it was fetched with. */
function hitsKey(accountId: number, cats: readonly SourceKey[]): string {
  return `${accountId}|${catsKey(cats)}`;
}

/**
 * Ctrl+K / Cmd+K command palette — keyboard-first navigation over every screen + quick actions, and Search v1.
 *
 * `accountId` is the SELECTED account, read server-side by the layout. The
 * layout also keys this component on it, so a switch remounts the palette;
 * the key and the session's own account stamp are the belt to that braces —
 * either one alone stops account A's results appearing under account B.
 */
export function CommandPalette({ workspace = "both", accountId = 0 }: { workspace?: Workspace; accountId?: number }) {
  const router = useRouter();
  const nav = useNavHistory();
  const session = useSearchSession(accountId);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const [cats, setCats] = React.useState<SourceKey[]>([]);
  const [hits, setHits] = React.useState<Hits | null>(null);
  const [keywords, setKeywords] = React.useState<KeywordMap | null>(keywordCache);

  // Close resets the query so every open starts fresh (no setState-in-effect needed).
  const close = React.useCallback(() => {
    setOpen(false);
    setQuery("");
    setActive(0);
    setCats([]);
  }, []);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
      // Escape is Radix Dialog's job now — it closes only the topmost layer.
    }
    // C7 — the sidebar's ⌘K hint chip and the page-header search button open the palette via this event.
    function onOpenEvent() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("vyuha:command-palette", onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("vyuha:command-palette", onOpenEvent);
    };
  }, [close]);

  // Keywords: one lazy import per session, on the first open.
  React.useEffect(() => {
    if (!open || keywords) return;
    let live = true;
    import("@/lib/domain/help-content").then((m) => {
      keywordCache = new Map(NAV_ITEMS.map((n) => [n.href, deriveKeywords(m.HELP_ENTRIES, n.href, n.label)]));
      if (live) setKeywords(keywordCache);
    });
    return () => {
      live = false;
    };
  }, [open, keywords]);

  const q = query.trim();
  const ql = q.toLowerCase();
  const commands = React.useMemo(() => {
    const pool = commandsFor(buildCommands(keywords), workspace);
    if (!ql) return pool;
    return pool
      .map((c) => ({ c, r: rank(c, ql) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r)
      .map((x) => x.c);
  }, [ql, workspace, keywords]);

  // ── Search (debounced, aborted on change) ────────────────────────────────
  const searching = open && q.length >= MIN_QUERY;
  const key = hitsKey(accountId, cats);
  // `fresh` is derived, not stored: a restored frame or a landed fetch makes
  // it true, and a true `fresh` is what stops the effect from fetching again.
  const fresh = hits != null && hits.q === q && hits.key === key;

  React.useEffect(() => {
    if (!searching || fresh) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetch(searchUrl(q, cats), { signal: ctrl.signal, cache: "no-store" })
        .then(async (res) => {
          const body = (await res.json().catch(() => null)) as { ok?: boolean; results?: SearchResult[] } | null;
          if (ctrl.signal.aborted) return;
          setHits({ q, key, results: body?.ok ? (body.results ?? []) : [], error: !body?.ok });
        })
        .catch((e: unknown) => {
          if ((e as { name?: string })?.name === "AbortError") return;
          setHits({ q, key, results: [], error: true });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [searching, fresh, q, key, cats]);

  // Stale results stay on screen (dimmed by `loading`) while the next fetch
  // runs — the list the cursor walks is exactly the list on screen.
  const shownHits = searching && hits ? hits.results : NO_HITS;
  const ordered = React.useMemo(() => groupBySource(visibleResults(q, shownHits)).flatMap((g) => g.results), [q, shownHits]);
  const total = commands.length + ordered.length;

  function go(c: Command) {
    close();
    router.push(c.href);
  }

  function openHit(r: SearchResult) {
    if (hits) session.push({ q: hits.q, cats, results: hits.results });
    close();
    router.push(r.href);
  }

  /** "← previous search": pop the session stack and put that search back — no refetch. */
  function restorePrevious() {
    const frame = session.pop();
    if (!frame) return;
    setQuery(frame.q);
    setCats(frame.cats);
    setHits({ q: frame.q, key: hitsKey(accountId, frame.cats), results: frame.results, error: false });
    setActive(0);
  }

  /** "Back to <screen>": the in-app route beneath this one, via push — never the browser history. */
  function backToPrevious() {
    if (!nav.previous) return;
    const href = nav.previous;
    close();
    router.push(href);
  }

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, Math.max(total - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Backspace" && query === "" && session.depth > 0) {
      e.preventDefault();
      restorePrevious();
    } else if (e.key === "Enter") {
      if (active < commands.length && commands[active]) {
        e.preventDefault();
        go(commands[active]);
      } else if (ordered[active - commands.length]) {
        e.preventDefault();
        openHit(ordered[active - commands.length]);
      }
    }
  }

  const backLabel = nav.previous ? `Back to ${nav.previousLabel ?? nav.previous}` : null;

  return (
    // Radix Dialog (v2.99.70): the palette was the app's only overlay without
    // a focus trap, scroll lock, or dismissal parity with the dialogs. Radix
    // supplies all three — Escape and outside-click close via onOpenChange,
    // Tab cannot escape into the page behind, and the page cannot scroll
    // under the overlay. Same entrance and chrome tokens as every dialog.
    <DialogPrimitive.Root open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="animate-overlay-in fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <DialogPrimitive.Content
          // Top-anchored (12vh), unlike the centred dialogs — a palette that
          // jumps to mid-screen reads as a modal, not a launcher.
          className="animate-dialog-in panel-luxe fixed left-1/2 top-[12vh] z-50 w-full max-w-lg -translate-x-1/2 overflow-hidden rounded-[var(--radius-card)] border border-border bg-card shadow-[var(--shadow-overlay)] focus:outline-none"
          aria-describedby={undefined}
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onInputKey}
            placeholder="Jump to a screen, or search trades, symbols, help… (try: tax, var, add trade)"
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border border-border bg-card-hover px-1.5 py-0.5 text-[10px] text-muted-foreground">esc</kbd>
        </div>
        {/* Two backs, both hidden until they can act, neither via the browser history:
            the SEARCH stack (owner ruling) and the in-app ROUTE beneath this one. */}
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
        <div className="max-h-[60vh] overflow-y-auto p-1.5">
          {commands.length === 0 && !searching ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">No match for &ldquo;{query}&rdquo;</p>
          ) : (
            commands.map((c, i) => (
              <button
                key={c.href + c.label}
                onClick={() => go(c)}
                onMouseEnter={() => setActive(i)}
                className={`flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors duration-100 motion-reduce:transition-none ${
                  i === active ? "bg-card-hover text-foreground" : "text-muted-foreground"
                }`}
              >
                <span className="flex items-center gap-2">
                  {c.action && <Plus className="size-3.5 text-profit" />}
                  {c.label}
                </span>
                <span className="flex items-center gap-2 text-[10px] uppercase tracking-wide opacity-70">
                  {c.group}
                  {i === active && <CornerDownLeft className="size-3" />}
                </span>
              </button>
            ))
          )}
          {searching && (
            <SearchResults
              q={q}
              results={shownHits}
              loading={!fresh}
              error={fresh && !!hits?.error}
              cats={cats}
              onToggleCat={(k) => { setCats((c) => toggleCat(c, k)); setActive(0); }}
              activeIndex={active - commands.length}
              onHover={(i) => setActive(commands.length + i)}
              onOpen={openHit}
            />
          )}
        </div>
          <div className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
            ↑↓ navigate · Enter open · Ctrl+K toggle{session.depth > 0 ? " · Backspace on empty: previous search" : ""}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * The page-header search button — "a search box on the main tabs". It opens
 * the palette through the same window event the sidebar's ⌘K chip uses, so
 * the header (a server component) needs no state of its own.
 */
export function PaletteSearchButton() {
  return (
    <button
      type="button"
      aria-label="Search (Ctrl+K)"
      onClick={() => window.dispatchEvent(new Event("vyuha:command-palette"))}
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
    >
      <Search className="size-3.5 shrink-0" />
      <span className="hidden sm:inline">Search</span>
      <kbd className="rounded border border-border bg-card-hover px-1 py-px text-[10px]">Ctrl K</kbd>
    </button>
  );
}
