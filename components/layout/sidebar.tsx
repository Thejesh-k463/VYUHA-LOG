"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen, Search, ChevronUp, ChevronDown, SlidersHorizontal } from "lucide-react";
import { NAV_GROUPS, NAV_ITEMS, mergeOrder, moveKey } from "./nav-config";
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

export function Sidebar({accounts,selectedAccountId}:{accounts:{id:number;name:string;archived:boolean}[];selectedAccountId:number}) {
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
  const [customizing, setCustomizing] = React.useState(false);
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
  const orderedItems = (group: string) => {
    const current = NAV_ITEMS.filter((i) => i.group === group).map((i) => i.href);
    const hrefs = mergeOrder(navOrder?.items?.[group], current);
    return hrefs.map((h) => NAV_ITEMS.find((i) => i.href === h)!).filter(Boolean);
  };

  const moveGroup = (group: string, dir: -1 | 1) =>
    saveOrder({ groups: moveKey(orderedGroups, group, dir), items: navOrder?.items ?? {} });
  const moveItem = (group: string, href: string, dir: -1 | 1) =>
    saveOrder({
      groups: navOrder?.groups ?? orderedGroups,
      items: { ...(navOrder?.items ?? {}), [group]: moveKey(orderedItems(group).map((i) => i.href), href, dir) },
    });
  const resetOrder = () => {
    localStorage.removeItem(NAV_ORDER_KEY);
    setNavOrder(null);
  };

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
        {orderedGroups.map((group, gi) => {
          const items = orderedItems(group);
          if (items.length === 0) return null;
          return (
            <div key={group} className="mb-4">
              {!collapsed && (
                <div className="flex items-center px-2 pb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
                    {group}
                  </span>
                  {customizing && (
                    <span className="ml-auto flex gap-0.5">
                      <button type="button" aria-label={`Move ${group} up`} disabled={gi === 0} onClick={() => moveGroup(group, -1)} className="rounded px-1 text-muted-foreground hover:text-foreground disabled:opacity-25">
                        <ChevronUp className="size-3" />
                      </button>
                      <button type="button" aria-label={`Move ${group} down`} disabled={gi === orderedGroups.length - 1} onClick={() => moveGroup(group, 1)} className="rounded px-1 text-muted-foreground hover:text-foreground disabled:opacity-25">
                        <ChevronDown className="size-3" />
                      </button>
                    </span>
                  )}
                </div>
              )}
              {items.map((item, ii) => {
                const active =
                  item.href === "/"
                    ? pathname === "/"
                    : pathname.startsWith(item.href);
                const Icon = item.icon;
                return (
                  <div key={item.href} className="flex items-center">
                    <Link
                      href={item.href}
                      title={collapsed ? item.label : undefined}
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
                    {customizing && !collapsed && (
                      <span className="flex gap-0.5 pr-1">
                        <button type="button" aria-label={`Move ${item.label} up`} disabled={ii === 0} onClick={() => moveItem(group, item.href, -1)} className="rounded px-0.5 text-muted-foreground hover:text-foreground disabled:opacity-25">
                          <ChevronUp className="size-3" />
                        </button>
                        <button type="button" aria-label={`Move ${item.label} down`} disabled={ii === items.length - 1} onClick={() => moveItem(group, item.href, 1)} className="rounded px-0.5 text-muted-foreground hover:text-foreground disabled:opacity-25">
                          <ChevronDown className="size-3" />
                        </button>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
        {!collapsed && (
          <div className="mt-2 flex items-center gap-2 border-t border-border px-2 pt-2">
            <button
              type="button"
              onClick={() => setCustomizing((c) => !c)}
              className={cn("flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px]", customizing ? "text-primary" : "text-muted-foreground hover:text-foreground")}
            >
              <SlidersHorizontal className="size-3" /> {customizing ? "Done" : "Customize order"}
            </button>
            {customizing && (
              <button type="button" onClick={resetOrder} className="ml-auto rounded px-1.5 py-1 text-[11px] text-muted-foreground hover:text-foreground">
                Reset
              </button>
            )}
          </div>
        )}
      </nav>

      <div className={cn("flex flex-col gap-1 border-t border-border py-2 text-[10px] text-muted-foreground", collapsed ? "items-center px-1" : "px-4")}>
        {!collapsed && <span>Local · Offline · v2.99</span>}
        <MarketClock />
      </div>
    </aside>
  );
}
