"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen, Search, GripVertical, Filter, SlidersHorizontal } from "lucide-react";
import {
  NAV_GROUPS,
  NAV_ITEMS,
  NAV_DEFAULT_VISIBLE,
  mergeOrder,
  mergeShown,
  partitionByShown,
  foldDrag,
  parseNavOrder,
  type NavItem,
  type NavOrderState,
  moveWithinVisible,
} from "./nav-config";
import { useListDrag } from "./use-list-drag";
import { useStoredValue, writeStored } from "./use-stored-value";
import { WORKSPACE_LABELS, screenVisible, type Workspace } from "@/lib/domain/workspace";
import { cn } from "@/lib/utils";
import { AccountSwitcher } from "@/components/system/account-switcher";
import { Tip } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { VyuhaMark } from "@/components/brand/mark";

const COLLAPSE_KEY = "vyuha-sidebar-collapsed";
const NAV_ORDER_KEY = "vyuha-nav-order";

/** C7 — live IST clock + NSE market-hours dot (Mon–Fri 09:15–15:30 IST).
 *  Client-only; renders nothing until mounted to avoid hydration drift. */
function MarketClock() {
  const [now, setNow] = React.useState<Date | null>(null);
  React.useEffect(() => {
    const tick = () => setNow(new Date());
    // .then keeps the first write async (react-compiler set-state-in-effect rule)
    Promise.resolve().then(tick);
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);
  if (!now) return null;

  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const mins = ist.getHours() * 60 + ist.getMinutes();
  const weekday = ist.getDay() >= 1 && ist.getDay() <= 5;
  const open = weekday && mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
  const hh = String(ist.getHours()).padStart(2, "0");
  const mm = String(ist.getMinutes()).padStart(2, "0");

  return (
    <span className="flex items-center gap-1.5" title={open ? "NSE market hours" : "Market closed"}>
      <span
        className={cn(
          "size-1.5 rounded-full",
          open ? "bg-profit [animation:pulse-dot_2s_ease-in-out_infinite]" : "bg-muted-foreground/50",
        )}
      />
      <span className="tabular-nums">{hh}:{mm} IST</span>
      <span className="text-muted-foreground/60">· {open ? "open" : "closed"}</span>
    </span>
  );
}

/**
 * One nav row, memoised so a pathname change re-renders only the rows whose
 * `active` actually flipped — not all ~40 Radix-tooltip links. The React
 * Compiler is OFF (next.config.ts), so this memo is load-bearing, not
 * decorative. Every prop is identity-stable across Sidebar renders: `item`
 * rows are the module-level NAV_ITEMS objects, `onGripDown` and `onRegister`
 * are useCallback'd in the Sidebar, and `style` is undefined except on the
 * dragged row.
 */
const NavRow = React.memo(function NavRow({
  item,
  group,
  index,
  active,
  collapsed,
  dragging,
  style,
  suppressNav,
  onGripDown,
  onRegister,
}: {
  item: NavItem;
  group: string;
  index: number;
  active: boolean;
  collapsed: boolean;
  dragging: boolean;
  style?: React.CSSProperties;
  /** True while ANY drag is live — a lift over the link must not navigate. */
  suppressNav: boolean;
  onGripDown: (e: React.PointerEvent, scope: string, key: string, index: number) => void;
  onRegister: (scope: string, index: number, el: HTMLElement | null) => void;
}) {
  const Icon = item.icon;
  const link = (
    <Link
      href={item.href}
      aria-label={collapsed ? item.label : undefined}
      // A drag that started on the grip must not navigate when the pointer
      // happens to lift over the link.
      onClick={(e) => { if (suppressNav) e.preventDefault(); }}
      className={cn(
        "flex flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors",
        collapsed && "justify-center px-0",
        active
          ? "bg-[linear-gradient(90deg,rgba(45,212,191,0.14),rgba(45,212,191,0.04))] font-medium text-primary shadow-[inset_2px_0_0_0_var(--color-primary),0_0_14px_-6px_color-mix(in_oklab,var(--color-primary)_60%,transparent)]"
          : "text-muted-foreground hover:bg-card-hover hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" />
      {!collapsed && item.label}
    </Link>
  );
  return (
    <div ref={(el) => onRegister(group, index, el)} className={cn("group/row flex items-center", dragging && "transition-none")} style={style}>
      {!collapsed && (
        <Tip label={`Drag to move ${item.label}`}>
          <button
            type="button"
            aria-label={`Reorder ${item.label}`}
            onPointerDown={(e) => onGripDown(e, group, item.href, index)}
            style={{ touchAction: "none" }}
            className="cursor-grab pl-0.5 pr-0.5 text-muted-foreground/30 opacity-0 transition-opacity hover:text-foreground group-hover/row:opacity-100 active:cursor-grabbing"
          >
            <GripVertical className="size-3" />
          </button>
        </Tip>
      )}
      {/* The label IS the link text when expanded — a tip there would only
          repeat it, so it exists for the icon rail. */}
      {collapsed ? <Tip label={item.label} side="right">{link}</Tip> : link}
    </div>
  );
});

/**
 * Pure fold-state decision for one nav group — extracted so tests can pin the
 * two edge cases the inline version got wrong (tests/nav-order.test.ts):
 * a route-FORCED group must not offer "Show less" (clicking it did nothing —
 * `forced` keeps the group open regardless of the stored flag), and a group
 * whose fold-visible set is entirely workspace-hidden must render EXPANDED,
 * not as a bare header with an "N more…" button and zero rows under it.
 */
export function groupFoldState({ total, primary, stored, forced, collapsed }: {
  /** Rows this group renders at all (after workspace filtering). */
  total: number;
  /** How many of those rows are fold-visible. */
  primary: number;
  /** The user stored this group as expanded. */
  stored: boolean;
  /** The CURRENT screen sits below the fold — never hide where the user is. */
  forced: boolean;
  /** Icon rail — folding is ignored entirely. */
  collapsed: boolean;
}): { expanded: boolean; showMore: boolean; showLess: boolean } {
  const hidden = total - primary;
  // Every fold-visible row is workspace-hidden: folding would render a bare
  // header over nothing, so the group opens instead.
  const emptyFold = primary === 0 && total > 0;
  const expanded = collapsed || stored || forced || emptyFold || hidden === 0;
  return {
    expanded,
    // "N more…" only while rows are actually withheld right now.
    showMore: !collapsed && hidden > 0 && !expanded,
    // "Show less" only where clicking it would actually fold something —
    // never while `forced` or `emptyFold` pins the group open.
    showLess: !collapsed && hidden > 0 && stored && !forced && !emptyFold,
  };
}

export function Sidebar({accounts,selectedAccountId,workspace="both"}:{accounts:{id:number;name:string;archived:boolean}[];selectedAccountId:number;workspace?:Workspace}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = React.useState(false);

  React.useEffect(() => {
    const stored = localStorage.getItem(COLLAPSE_KEY) === "1";
    // .then keeps the write async (react-compiler set-state-in-effect rule)
    if (stored) Promise.resolve().then(() => setCollapsed(true));
  }, []);

  function toggle() {
    setCollapsed((c) => {
      localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      return !c;
    });
  }

  // ── User-adjustable nav order + fold state ────────────────────────────────
  // Saved order is merged with the CURRENT nav at render (mergeOrder), so
  // screens added by updates appear in their default slot instead of being
  // lost — the stored arrays never gate what exists, only how it's sorted.
  // Persistence goes through useStoredValue/writeStored (hydration-safe,
  // storage is the single source of truth) with the versioned envelope
  // {v:1, groups, items, shown, expanded}; parseNavOrder MIGRATES the legacy
  // un-versioned {groups, items} value instead of discarding a saved order.
  const rawNavOrder = useStoredValue(NAV_ORDER_KEY);
  const navOrder = React.useMemo(() => parseNavOrder(rawNavOrder), [rawNavOrder]);

  const persist = React.useCallback((next: NavOrderState) => {
    writeStored(NAV_ORDER_KEY, JSON.stringify(next));
  }, []);

  /** The stored envelope with every field defaulted — spread, patch, persist. */
  const envelope = React.useCallback(
    (): NavOrderState => ({
      v: 1,
      groups: navOrder?.groups ?? [],
      items: navOrder?.items ?? {},
      shown: navOrder?.shown ?? {},
      expanded: navOrder?.expanded ?? {},
    }),
    [navOrder],
  );

  // Memoised (with NavRow below) so the nav model keeps its identity across
  // renders that change none of its inputs — a pathname change recomputes only
  // because isCurrent gates workspace-hidden screens.
  const orderedGroups = React.useMemo(() => mergeOrder(navOrder?.groups, [...NAV_GROUPS]), [navOrder]);

  const groupHrefs = React.useCallback(
    (group: string) => NAV_ITEMS.filter((i) => i.group === group).map((i) => i.href),
    [],
  );

  /** Every screen in a group, in the user's order — hidden ones included. */
  const fullItems = React.useCallback(
    (group: string) => mergeOrder(navOrder?.items?.[group], groupHrefs(group)),
    [navOrder, groupHrefs],
  );

  /** The hrefs this group keeps on screen while folded. */
  const shownList = React.useCallback(
    (group: string) =>
      mergeShown(navOrder?.shown?.[group], NAV_DEFAULT_VISIBLE[group] ?? groupHrefs(group), groupHrefs(group)),
    [navOrder, groupHrefs],
  );

  const isCurrent = React.useCallback(
    (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href)),
    [pathname],
  );

  // Workspace mode hides the other book's screens. The screen you are ON is
  // always kept: arriving via a link or bookmark and finding no menu entry for
  // where you are reads as a broken app, not a tidy one. Items render in the
  // PARTITIONED order (fold-visible first) so the fold line is a real place;
  // this list is a subsequence of partitionByShown(fullItems, shown), which is
  // exactly the base foldDrag commits against.
  const orderedItems = React.useCallback(
    (group: string) =>
      partitionByShown(fullItems(group), new Set(shownList(group)))
        .map((h) => NAV_ITEMS.find((i) => i.href === h)!)
        .filter(Boolean)
        .filter((i) => screenVisible(i.href, workspace) || isCurrent(i.href)),
    [fullItems, shownList, workspace, isCurrent],
  );

  // Groups are rendered from this list, so indices, refs and drop lines all
  // count the same rows — a group emptied by workspace mode disappears
  // entirely rather than leaving a gap the drag maths would trip over.
  // `items` is what actually renders: the fold-visible rows when folded, all
  // rows when expanded. Four ways a group renders expanded: the user opened
  // it (stored), the CURRENT screen sits below the fold (never hide where the
  // user is — the same rule workspace hiding follows above), every fold-visible
  // row is workspace-hidden (folding would leave a bare header), or nothing is
  // folded away. The icon rail ignores folding entirely (as before v3.6).
  // groupFoldState (pure, above) owns the decision, including which fold
  // toggle — if any — is honest to render.
  const visibleGroups = React.useMemo(
    () =>
      orderedGroups
        .map((group) => {
          const all = orderedItems(group);
          const shownSet = new Set(shownList(group));
          const primary = all.filter((i) => shownSet.has(i.href));
          const hidden = all.length - primary.length;
          const stored = navOrder?.expanded?.[group] === true;
          const forced = all.some((i) => isCurrent(i.href) && !shownSet.has(i.href));
          const fold = groupFoldState({ total: all.length, primary: primary.length, stored, forced, collapsed });
          return { group, all, primary, hidden, stored, forced, ...fold, foldAt: primary.length, items: fold.expanded ? all : primary };
        })
        .filter((g) => g.all.length > 0),
    [orderedGroups, orderedItems, shownList, isCurrent, navOrder, collapsed],
  );

  const resetOrder = () => writeStored(NAV_ORDER_KEY, null);

  const toggleGroup = (group: string, open: boolean) =>
    persist({ ...envelope(), expanded: { ...(navOrder?.expanded ?? {}), [group]: open } });

  // ── Customizer (non-drag path) ────────────────────────────────────────────
  // Checkbox parity for promote/demote: folding a screen away must never be
  // pointer-only. One dialog serves every group.
  const [customizing, setCustomizing] = React.useState<string | null>(null);

  const setItemShown = (group: string, href: string, on: boolean) => {
    const next = new Set(shownList(group));
    if (on) next.add(href);
    else next.delete(href);
    persist({
      ...envelope(),
      shown: { ...(navOrder?.shown ?? {}), [group]: fullItems(group).filter((h) => next.has(h)) },
    });
  };

  // Drag commits by SCOPE: "__groups__" reorders the group list, any other
  // scope is a group name and reorders that group's items. Items stay inside
  // their group by design — the groups are semantic (Risk, Journal…), so
  // dragging Tax Harvest into "Positions" would make the labels lie.
  const GROUPS_SCOPE = "__groups__";
  // Both branches commit against the RENDERED rows because both lists are
  // filtered — groups by workspace mode, items by workspace mode AND the fold.
  // The drag counts rendered rows; the saved order must keep every row, which
  // is what moveWithinVisible (inside foldDrag for items) guarantees. The item
  // branch also decides fold membership: a row dropped across the fold line is
  // promoted or demoted, and the visible set persists in `shown`.
  const { drag, begin } = useListDrag((scope, from, to) => {
    if (scope === GROUPS_SCOPE) {
      const visible = visibleGroups.map((g) => g.group);
      persist({ ...envelope(), groups: moveWithinVisible(orderedGroups, visible, from, to) });
    } else {
      const g = visibleGroups.find((v) => v.group === scope);
      const rendered = (g?.items ?? orderedItems(scope)).map((i) => i.href);
      const { order, shown } = foldDrag(fullItems(scope), rendered, shownList(scope), from, to);
      persist({
        ...envelope(),
        items: { ...(navOrder?.items ?? {}), [scope]: order },
        shown: { ...(navOrder?.shown ?? {}), [scope]: shown },
      });
    }
  });

  // Element refs per scope, so a drag can measure its siblings once on grab.
  // registerRow is a single stable callback (NavRow closes an inline ref
  // arrow over it) so NavRow's memo is not defeated by a fresh per-row
  // setter closure on every Sidebar render.
  const rowRefs = React.useRef<Map<string, (HTMLElement | null)[]>>(new Map());
  const registerRow = React.useCallback((scope: string, index: number, el: HTMLElement | null) => {
    const arr = rowRefs.current.get(scope) ?? [];
    arr[index] = el;
    rowRefs.current.set(scope, arr);
  }, []);

  /** Stable grip handler for NavRow — `begin` is useCallback'd in useListDrag. */
  const gripDown = React.useCallback(
    (e: React.PointerEvent, scope: string, key: string, index: number) => {
      begin(e, scope, key, index, rowRefs.current.get(scope) ?? []);
    },
    [begin],
  );

  /** Glow that follows whatever is being dragged. */
  const dragStyle = (scope: string, key: string): React.CSSProperties | undefined =>
    drag && drag.scope === scope && drag.key === key
      ? {
          transform: `translateY(${drag.dy}px)`,
          zIndex: 30,
          position: "relative",
          boxShadow:
            "0 0 0 1px color-mix(in oklab, var(--color-primary) 55%, transparent), 0 8px 26px -6px color-mix(in oklab, var(--color-primary) 65%, transparent)",
          background: "color-mix(in oklab, var(--color-primary) 12%, var(--color-card))",
          borderRadius: "var(--radius)",
        }
      : undefined;

  /** The insertion line — where the thing would land if released now. */
  const dropLine = (scope: string, index: number) =>
    drag && drag.scope === scope && drag.toIndex === index && drag.fromIndex !== index ? (
      <div
        aria-hidden
        className="pointer-events-none -my-px h-0.5 rounded-full"
        style={{
          background: "var(--color-primary)",
          boxShadow: "0 0 10px 1px color-mix(in oklab, var(--color-primary) 80%, transparent)",
        }}
      />
    ) : null;

  return (
    <aside
      className={cn(
        // v3: 232px and a vertical gradient rather than a flat surface. The
        // width is set in px because the sidebar is chrome — it should not
        // grow with the Comfortable density's larger root font, or the nav
        // eats the table it exists to navigate.
        "flex h-screen shrink-0 flex-col border-r border-border transition-[width] duration-200",
        // Token-driven, NOT the spec's literal #0a101c→#070b13. Hard-coding
        // those left the sidebar dark navy while the rest of the app went
        // white in light mode — the same trap globals.css warns about for
        // table-luxe. --color-surface already IS #0a101c in dark, so the top
        // stop is exact; the bottom resolves to --color-background (#05080f
        // vs the spec's #070b13, two units of luminance apart and invisible)
        // and becomes a soft white gradient in light mode.
        "bg-[linear-gradient(180deg,var(--color-surface),var(--color-background))]",
        collapsed ? "w-14" : "w-[232px]",
      )}
    >
      <div className={cn("flex h-14 items-center gap-2 border-b border-border", collapsed ? "justify-center px-0" : "px-3")}>
        {/* Outline, not a text node: `व` is a tofu box on a machine with no
            Devanagari font, and the sidebar is the one place it would show. */}
        <VyuhaMark size={34} className="shrink-0" title="Vyuha" />
        {!collapsed && (
          // The locked lockup: wordmark in the display face, caption in teal.
          // `nowrap` on both — at 232px a wrapped caption pushes the collapse
          // button off the row.
          <div className="min-w-0 leading-tight">
            {/* text-foreground, not the spec's literal #f2f5f9: that hex is a
                near-white for a dark ground, and on the now-themed light
                sidebar the wordmark disappeared into the background. The token
                resolves to #e9eef5 in dark — the same colour to the eye. */}
            <div className="whitespace-nowrap font-display text-[14px] font-bold tracking-[0.14em] text-foreground">
              VYUHA
            </div>
            <div className="whitespace-nowrap text-[8.5px] uppercase tracking-[0.16em] text-primary">
              Journal · Measure · Master
            </div>
          </div>
        )}
      </div>

      {/* ⌘K hint — the command palette is the fastest way around the app. */}
      {!collapsed && <div className="border-b border-border px-3 py-2"><AccountSwitcher accounts={accounts} selected={selectedAccountId} compact /></div>}
      {/* The collapse control lives on this row rather than in the brand header.
          At 232px the lockup's caption needs the full width: sharing the row
          pushed "Journal · Measure · Master" under the button, and because
          `nowrap` paints past a shrunk flex box the overflow never showed up in
          a bounding-rect check — only in a screenshot. */}
      <div className={cn("flex items-center gap-2 border-b border-border py-2", collapsed ? "px-2" : "px-3")}>
        <Tip label="Command palette (Ctrl+K)" side={collapsed ? "right" : "bottom"}>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event("vyuha:command-palette"))}
            aria-label="Command palette (Ctrl+K)"
            className={cn(
              "flex w-full items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground",
              collapsed && "justify-center px-0",
            )}
          >
            <Search className="size-3.5 shrink-0" />
            {!collapsed && (
              <>
                <span>Jump to…</span>
                <kbd className="ml-auto rounded border border-border bg-card-hover px-1 font-mono text-[10px]">Ctrl K</kbd>
              </>
            )}
          </button>
        </Tip>
        {!collapsed && (
          <Tip label="Collapse sidebar">
            <button
              type="button"
              onClick={toggle}
              aria-label="Collapse sidebar"
              className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-card-hover hover:text-foreground"
            >
              <PanelLeftClose className="size-4" />
            </button>
          </Tip>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {collapsed && (
          <Tip label="Expand sidebar" side="right">
            <button
              type="button"
              onClick={toggle}
              aria-label="Expand sidebar"
              className="mb-2 flex w-full items-center justify-center rounded-md py-1.5 text-muted-foreground hover:bg-card-hover hover:text-foreground"
            >
              <PanelLeftOpen className="size-4" />
            </button>
          </Tip>
        )}
        {visibleGroups.map(({ group, items, hidden, expanded, showMore, showLess, foldAt }, gi) => {
          const groupDragging = drag?.scope === GROUPS_SCOPE && drag.key === group;
          return (
            <div
              key={group}
              ref={(el) => registerRow(GROUPS_SCOPE, gi, el)}
              className={cn("mb-4", groupDragging && "transition-none")}
              style={dragStyle(GROUPS_SCOPE, group)}
            >
              {dropLine(GROUPS_SCOPE, gi)}
              {!collapsed && (
                <div className="group/hdr flex items-center px-2 pb-1">
                  {/* Grip is always present, revealed on hover — no mode to
                      enter. touch-action:none so a touch-drag reorders instead
                      of scrolling the sidebar. */}
                  <Tip label="Drag to move this whole group">
                    <button
                      type="button"
                      aria-label={`Reorder ${group} group`}
                      onPointerDown={(e) => begin(e, GROUPS_SCOPE, group, gi, rowRefs.current.get(GROUPS_SCOPE) ?? [])}
                      style={{ touchAction: "none" }}
                      className="mr-1 cursor-grab text-muted-foreground/40 opacity-0 transition-opacity hover:text-foreground group-hover/hdr:opacity-100 active:cursor-grabbing"
                    >
                      <GripVertical className="size-3" />
                    </button>
                  </Tip>
                  <span className="shrink-0 text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
                    {group}
                  </span>
                  {/* Hairline continuing past the label — the group reads as a
                      band rather than a floating word. */}
                  <span aria-hidden className="ml-2 h-px flex-1 bg-border" />
                  {/* The customizer entry point. Its OWN hit target, after the
                      hairline — the grip's pointerdown is never contested. */}
                  <Tip label={`Choose which ${group} screens stay when folded`}>
                    <button
                      type="button"
                      aria-label={`Customize ${group} group`}
                      onClick={() => setCustomizing(group)}
                      className="ml-1 rounded p-0.5 text-muted-foreground/40 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/hdr:opacity-100"
                    >
                      <SlidersHorizontal className="size-3" />
                    </button>
                  </Tip>
                </div>
              )}
              {items.map((item, ii) => (
                <React.Fragment key={item.href}>
                  {/* The fold line, made visible: rows above it survive the
                      fold, rows below sit behind "N more…". Dragging a row
                      across it promotes/demotes (foldDrag). */}
                  {!collapsed && expanded && hidden > 0 && foldAt > 0 && ii === foldAt && (
                    <div aria-hidden className="mx-2 my-1 border-t border-dashed border-border/80" />
                  )}
                  {dropLine(group, ii)}
                  <NavRow
                    item={item}
                    group={group}
                    index={ii}
                    active={isCurrent(item.href)}
                    collapsed={collapsed}
                    dragging={drag?.scope === group && drag.key === item.href}
                    style={dragStyle(group, item.href)}
                    suppressNav={drag !== null}
                    onGripDown={gripDown}
                    onRegister={registerRow}
                  />
                  {ii === items.length - 1 && dropLine(group, items.length)}
                </React.Fragment>
              ))}
              {/* Fold toggles — groupFoldState decides which (if either) is
                  honest. A group pinned open — by the CURRENT screen sitting
                  below the fold, or by every fold-visible row being
                  workspace-hidden — shows neither: it cannot fold while
                  pinned, and "N more…" under an expanded group would lie. */}
              {showMore && (
                <button
                  type="button"
                  onClick={() => toggleGroup(group, true)}
                  aria-label={`Show ${hidden} more ${group} screen${hidden === 1 ? "" : "s"}`}
                  className="flex w-full items-center rounded-md px-2 py-1 pl-[26px] text-[11px] text-muted-foreground/60 transition-colors hover:bg-card-hover hover:text-foreground"
                >
                  {hidden} more…
                </button>
              )}
              {showLess && (
                <button
                  type="button"
                  onClick={() => toggleGroup(group, false)}
                  aria-label={`Show fewer ${group} screens`}
                  className="flex w-full items-center rounded-md px-2 py-1 pl-[26px] text-[11px] text-muted-foreground/60 transition-colors hover:bg-card-hover hover:text-foreground"
                >
                  Show less
                </button>
              )}
            </div>
          );
        })}
        {!collapsed && visibleGroups.length > 0 && dropLine(GROUPS_SCOPE, visibleGroups.length)}
        {!collapsed && (
          <div className="mt-2 flex items-center gap-2 border-t border-border px-2 pt-2 text-[0.6875rem] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <GripVertical className="size-3 opacity-50" /> drag to reorder
            </span>
            {rawNavOrder !== null && (
              <button type="button" onClick={resetOrder} className="ml-auto rounded px-1.5 py-1 hover:text-foreground">
                Reset
              </button>
            )}
          </div>
        )}
        {/* Workspace chip — a filtered sidebar must SAY it is filtered, and say
            where to undo it. Without this, a missing screen looks like a bug. */}
        {!collapsed && workspace !== "both" && (
          <Tip label="Some screens are hidden by your workspace mode. Click to change it.">
            <Link
              href="/settings"
              className="mt-2 flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2 py-1.5 text-[0.6875rem] text-primary hover:border-primary/60"
            >
              <Filter className="size-3 shrink-0" />
              <span className="truncate">{WORKSPACE_LABELS[workspace]}</span>
              <span className="ml-auto shrink-0 opacity-70">change</span>
            </Link>
          </Tip>
        )}
      </nav>

      <div className={cn("flex flex-col gap-1 border-t border-border py-2 text-[10px] text-muted-foreground", collapsed ? "items-center px-1" : "px-4")}>
        {!collapsed && <span>Local · Offline · v3.5</span>}
        <MarketClock />
      </div>

      {/* Per-group customizer — the keyboard/click path to promote/demote.
          Checkboxes, not drag: folding a screen away must never be
          pointer-only. Same Dialog chrome as every other dialog. */}
      <Dialog open={customizing !== null} onOpenChange={(o) => { if (!o) setCustomizing(null); }}>
        {customizing !== null && (
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Customize “{customizing}”</DialogTitle>
              <DialogDescription>
                Ticked screens stay visible when the group is folded; the rest wait behind
                &ldquo;more…&rdquo;. Drag rows in the sidebar to reorder.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-0.5">
              {fullItems(customizing).map((href) => {
                const item = NAV_ITEMS.find((i) => i.href === href);
                if (!item) return null;
                const Icon = item.icon;
                const on = shownList(customizing).includes(href);
                return (
                  <label
                    key={href}
                    className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-foreground hover:bg-card-hover"
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) => setItemShown(customizing, href, e.target.checked)}
                      className="accent-[var(--color-primary)]"
                    />
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    {item.label}
                  </label>
                );
              })}
            </div>
          </DialogContent>
        )}
      </Dialog>
    </aside>
  );
}
