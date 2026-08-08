"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen, Search, GripVertical, Filter } from "lucide-react";
import { NAV_GROUPS, NAV_ITEMS, mergeOrder, moveWithinVisible } from "./nav-config";
import { useListDrag } from "./use-list-drag";
import { WORKSPACE_LABELS, screenVisible, type Workspace } from "@/lib/domain/workspace";
import { cn } from "@/lib/utils";
import { AccountSwitcher } from "@/components/system/account-switcher";
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

  // ── User-adjustable nav order ─────────────────────────────────────────────
  // Saved order is merged with the CURRENT nav at render (mergeOrder), so
  // screens added by updates appear in their default slot instead of being
  // lost — the stored arrays never gate what exists, only how it's sorted.
  const [navOrder, setNavOrder] = React.useState<{ groups: string[]; items: Record<string, string[]> } | null>(null);

  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(NAV_ORDER_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { groups: string[]; items: Record<string, string[]> };
        Promise.resolve().then(() => setNavOrder(parsed));
      }
    } catch { /* corrupt order = default order */ }
  }, []);

  const saveOrder = (next: { groups: string[]; items: Record<string, string[]> }) => {
    setNavOrder(next);
    localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(next));
  };

  const orderedGroups = mergeOrder(navOrder?.groups, [...NAV_GROUPS]);

  /** Every screen in a group, in the user's order — hidden ones included. */
  const fullItems = (group: string) =>
    mergeOrder(navOrder?.items?.[group], NAV_ITEMS.filter((i) => i.group === group).map((i) => i.href));

  const isCurrent = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  // Workspace mode hides the other book's screens. The screen you are ON is
  // always kept: arriving via a link or bookmark and finding no menu entry for
  // where you are reads as a broken app, not a tidy one.
  const orderedItems = (group: string) =>
    fullItems(group)
      .map((h) => NAV_ITEMS.find((i) => i.href === h)!)
      .filter(Boolean)
      .filter((i) => screenVisible(i.href, workspace) || isCurrent(i.href));

  // Groups are rendered from this list, so indices, refs and drop lines all
  // count the same rows — a group emptied by workspace mode disappears
  // entirely rather than leaving a gap the drag maths would trip over.
  const visibleGroups = orderedGroups
    .map((group) => ({ group, items: orderedItems(group) }))
    .filter((g) => g.items.length > 0);

  const resetOrder = () => {
    localStorage.removeItem(NAV_ORDER_KEY);
    setNavOrder(null);
  };

  // Drag commits by SCOPE: "__groups__" reorders the group list, any other
  // scope is a group name and reorders that group's items. Items stay inside
  // their group by design — the groups are semantic (Risk, Journal…), so
  // dragging Tax Harvest into "Positions" would make the labels lie.
  const GROUPS_SCOPE = "__groups__";
  // Both branches commit through moveWithinVisible because both lists can be
  // filtered by workspace mode — the drag counts visible rows, the saved order
  // must keep every row.
  const { drag, begin } = useListDrag((scope, from, to) => {
    if (scope === GROUPS_SCOPE) {
      const visible = visibleGroups.map((g) => g.group);
      saveOrder({ groups: moveWithinVisible(orderedGroups, visible, from, to), items: navOrder?.items ?? {} });
    } else {
      const visible = orderedItems(scope).map((i) => i.href);
      saveOrder({
        groups: navOrder?.groups ?? orderedGroups,
        items: { ...(navOrder?.items ?? {}), [scope]: moveWithinVisible(fullItems(scope), visible, from, to) },
      });
    }
  });

  // Element refs per scope, so a drag can measure its siblings once on grab.
  const rowRefs = React.useRef<Map<string, (HTMLElement | null)[]>>(new Map());
  const setRowRef = (scope: string, index: number) => (el: HTMLElement | null) => {
    const arr = rowRefs.current.get(scope) ?? [];
    arr[index] = el;
    rowRefs.current.set(scope, arr);
  };

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
        "flex h-screen shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-200",
        collapsed ? "w-14" : "w-60",
      )}
    >
      <div className={cn("flex h-14 items-center gap-2 border-b border-border", collapsed ? "justify-center px-0" : "px-4")}>
        {/* Outline, not a text node: `व` is a tofu box on a machine with no
            Devanagari font, and the sidebar is the one place it would show. */}
        <VyuhaMark size={28} className="shrink-0" title="Vyuha" />
        {!collapsed && (
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-wide">VYUHA</div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
              Trade Journal
            </div>
          </div>
        )}
        {!collapsed && (
          <button
            type="button"
            onClick={toggle}
            title="Collapse sidebar"
            className="ml-auto rounded p-1 text-muted-foreground hover:bg-card-hover hover:text-foreground"
          >
            <PanelLeftClose className="size-4" />
          </button>
        )}
      </div>

      {/* ⌘K hint — the command palette is the fastest way around the app. */}
      {!collapsed && <div className="border-b border-border px-3 py-2"><AccountSwitcher accounts={accounts} selected={selectedAccountId} compact /></div>}
      <div className={cn("border-b border-border py-2", collapsed ? "px-2" : "px-3")}>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event("vyuha:command-palette"))}
          title="Command palette (Ctrl+K)"
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
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {collapsed && (
          <button
            type="button"
            onClick={toggle}
            title="Expand sidebar"
            className="mb-2 flex w-full items-center justify-center rounded-md py-1.5 text-muted-foreground hover:bg-card-hover hover:text-foreground"
          >
            <PanelLeftOpen className="size-4" />
          </button>
        )}
        {visibleGroups.map(({ group, items }, gi) => {
          const groupDragging = drag?.scope === GROUPS_SCOPE && drag.key === group;
          return (
            <div
              key={group}
              ref={setRowRef(GROUPS_SCOPE, gi)}
              className={cn("mb-4", groupDragging && "transition-none")}
              style={dragStyle(GROUPS_SCOPE, group)}
            >
              {dropLine(GROUPS_SCOPE, gi)}
              {!collapsed && (
                <div className="group/hdr flex items-center px-2 pb-1">
                  {/* Grip is always present, revealed on hover — no mode to
                      enter. touch-action:none so a touch-drag reorders instead
                      of scrolling the sidebar. */}
                  <button
                    type="button"
                    aria-label={`Reorder ${group} group`}
                    title="Drag to move this whole group"
                    onPointerDown={(e) => begin(e, GROUPS_SCOPE, group, gi, rowRefs.current.get(GROUPS_SCOPE) ?? [])}
                    style={{ touchAction: "none" }}
                    className="mr-1 cursor-grab text-muted-foreground/40 opacity-0 transition-opacity hover:text-foreground group-hover/hdr:opacity-100 active:cursor-grabbing"
                  >
                    <GripVertical className="size-3" />
                  </button>
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
                    {group}
                  </span>
                </div>
              )}
              {items.map((item, ii) => {
                const active = isCurrent(item.href);
                const Icon = item.icon;
                const itemDragging = drag?.scope === group && drag.key === item.href;
                return (
                  <React.Fragment key={item.href}>
                    {dropLine(group, ii)}
                    <div
                      ref={setRowRef(group, ii)}
                      className={cn("group/row flex items-center", itemDragging && "transition-none")}
                      style={dragStyle(group, item.href)}
                    >
                      {!collapsed && (
                        <button
                          type="button"
                          aria-label={`Reorder ${item.label}`}
                          title={`Drag to move ${item.label}`}
                          onPointerDown={(e) => begin(e, group, item.href, ii, rowRefs.current.get(group) ?? [])}
                          style={{ touchAction: "none" }}
                          className="cursor-grab pl-0.5 pr-0.5 text-muted-foreground/30 opacity-0 transition-opacity hover:text-foreground group-hover/row:opacity-100 active:cursor-grabbing"
                        >
                          <GripVertical className="size-3" />
                        </button>
                      )}
                      <Link
                        href={item.href}
                        title={collapsed ? item.label : undefined}
                        // A drag that started on the grip must not navigate when
                        // the pointer happens to lift over the link.
                        onClick={(e) => { if (drag) e.preventDefault(); }}
                        className={cn(
                          "flex flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors",
                          collapsed && "justify-center px-0",
                          active
                            ? "bg-primary/10 font-medium text-primary shadow-[inset_2px_0_0_0_var(--color-primary),0_0_12px_-4px_color-mix(in_oklab,var(--color-primary)_50%,transparent)]"
                            : "text-muted-foreground hover:bg-card-hover hover:text-foreground",
                        )}
                      >
                        <Icon className="size-4 shrink-0" />
                        {!collapsed && item.label}
                      </Link>
                    </div>
                    {ii === items.length - 1 && dropLine(group, items.length)}
                  </React.Fragment>
                );
              })}
            </div>
          );
        })}
        {!collapsed && visibleGroups.length > 0 && dropLine(GROUPS_SCOPE, visibleGroups.length)}
        {!collapsed && (
          <div className="mt-2 flex items-center gap-2 border-t border-border px-2 pt-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <GripVertical className="size-3 opacity-50" /> drag to reorder
            </span>
            {navOrder && (
              <button type="button" onClick={resetOrder} className="ml-auto rounded px-1.5 py-1 hover:text-foreground">
                Reset
              </button>
            )}
          </div>
        )}
        {/* Workspace chip — a filtered sidebar must SAY it is filtered, and say
            where to undo it. Without this, a missing screen looks like a bug. */}
        {!collapsed && workspace !== "both" && (
          <Link
            href="/settings"
            title="Some screens are hidden by your workspace mode. Click to change it."
            className="mt-2 flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2 py-1.5 text-[11px] text-primary hover:border-primary/60"
          >
            <Filter className="size-3 shrink-0" />
            <span className="truncate">{WORKSPACE_LABELS[workspace]}</span>
            <span className="ml-auto shrink-0 opacity-70">change</span>
          </Link>
        )}
      </nav>

      <div className={cn("flex flex-col gap-1 border-t border-border py-2 text-[10px] text-muted-foreground", collapsed ? "items-center px-1" : "px-4")}>
        {!collapsed && <span>Local · Offline · v2.99</span>}
        <MarketClock />
      </div>
    </aside>
  );
}
