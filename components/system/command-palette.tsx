"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { NAV_ITEMS } from "@/components/layout/nav-config";
import { Search, CornerDownLeft, Plus } from "lucide-react";

// Extra search keywords per screen — what a trader would TYPE, not the menu label.
const KEYWORDS: Record<string, string> = {
  "/": "home dashboard pnl equity curve calendar",
  "/risk": "var cvar greeks delta gamma theta vega stress exposure beta vix mtm bhavcopy limits",
  "/strategies": "straddle strangle spread iron condor payoff options",
  "/trades": "journal orders history fno options tag playbook mistake",
  "/playbooks": "setup rules checklist behavior discipline",
  "/ipos": "allotment listing sme gmp application",
  "/import": "csv xlsx zerodha dhan groww upload broker file",
  "/cash": "ledger deposit withdrawal capital dividend margin penalty",
  "/corporate-actions": "split bonus dividend adjust",
  "/reports/performance": "sharpe sortino calmar xirr twr cagr drawdown monte carlo benchmark alpha beta nifty",
  "/reports/monthly": "pdf print share report export scorecard",
  "/reports/charges": "brokerage stt gst leak mtf interest",
  "/reports/broker-compare": "broker cost switch zerodha dhan groww",
  "/reports/advance-tax": "234b 234c instalment june september december march",
  "/reports/harvest": "tax loss harvesting ltcg stcg march",
  "/reports/expiry": "expiry weekly thursday theta",
  "/reports/rom": "return on margin capital efficiency rom blocked",
  "/reports/edge": "setups expectancy win rate",
  "/reports/discipline": "score mistakes emotions playbook expectancy sebi",
  "/reports/tax": "stcg ltcg capital gains itr tds dividend grandfathering fmv set-off carry forward",
  "/reports/itr": "itr-3 44ab 44ad audit turnover speculative non-speculative business income ca guidance note",
  "/audit": "log history changes",
  "/backup": "restore export snapshot",
  "/aliases": "symbol ticker mapping",
  "/instruments": "sector lot size isin master",
  "/settings": "capital fy charges risk license theme",
};

interface Command {
  label: string;
  group: string;
  href: string;
  keywords: string;
  action?: true;
}

const COMMANDS: Command[] = [
  ...NAV_ITEMS.map((n) => ({ label: n.label, group: n.group, href: n.href, keywords: KEYWORDS[n.href] ?? "" })),
  { label: "Add trade (closed / manual)", group: "Actions", href: "/trades?add=manual", keywords: "new trade entry log", action: true },
  { label: "Add open trade", group: "Actions", href: "/trades?add=open", keywords: "new position running sl target", action: true },
  { label: "Add IPO", group: "Actions", href: "/ipos?add=1", keywords: "new application allotment", action: true },
  { label: "New playbook", group: "Actions", href: "/playbooks?add=1", keywords: "new setup rules", action: true },
];

function rank(c: Command, q: string): number {
  const label = c.label.toLowerCase();
  if (label.startsWith(q)) return 0;
  if (label.includes(q)) return 1;
  if (c.group.toLowerCase().includes(q)) return 2;
  if (c.keywords.includes(q)) return 3;
  return -1;
}

/** Ctrl+K / Cmd+K command palette — keyboard-first navigation over every screen + quick actions. */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);

  // Close resets the query so every open starts fresh (no setState-in-effect needed).
  const close = React.useCallback(() => {
    setOpen(false);
    setQuery("");
    setActive(0);
  }, []);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        close();
      }
    }
    // C7 — the sidebar's ⌘K hint chip opens the palette via this event.
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

  const q = query.trim().toLowerCase();
  const results = React.useMemo(() => {
    if (!q) return COMMANDS;
    return COMMANDS.map((c) => ({ c, r: rank(c, q) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r)
      .map((x) => x.c);
  }, [q]);

  function go(c: Command) {
    close();
    router.push(c.href);
  }

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && results[active]) {
      e.preventDefault();
      go(results[active]);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[12vh] backdrop-blur-sm"
      onClick={close}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onInputKey}
            placeholder="Jump to a screen or action… (try: tax, var, add trade)"
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border border-border bg-card-hover px-1.5 py-0.5 text-[10px] text-muted-foreground">esc</kbd>
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">No match for &ldquo;{query}&rdquo;</p>
          ) : (
            results.map((c, i) => (
              <button
                key={c.href + c.label}
                onClick={() => go(c)}
                onMouseEnter={() => setActive(i)}
                className={`flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm ${
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
        </div>
        <div className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
          ↑↓ navigate · Enter open · Ctrl+K toggle
        </div>
      </div>
    </div>
  );
}
