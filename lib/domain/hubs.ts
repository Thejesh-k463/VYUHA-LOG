// ANALYTICS HUBS (PURE — no React, no DB; invariant 2).
//
// v4.6.0 W3, owner ruling T1: seven single-purpose analytics screens folded
// into three hubs, one tab per old screen. This registry is the ONE source of
// truth for that mapping — the sidebar (NAV_ITEMS), PRO_FEATURES, the help
// desk, the command palette, the saved-nav-order migration and the seven
// legacy redirects all DERIVE from it, so a tab cannot exist in one of them
// and be missing from another.
//
// ── The URL shape ───────────────────────────────────────────────────────────
//
// A tab is `${hub.href}?tab=${tab.id}`. The SERVER picks the body from the
// param (`resolveTab`), so a deep link, a bookmark and a search result all
// open the right tab with no client state involved. An unknown or missing
// param opens the hub's default tab rather than an error — a stale bookmark
// must land somewhere useful.
//
// ── The seven old routes ────────────────────────────────────────────────────
//
// Each old `app/reports/<r>/page.tsx` survives as a TEMPORARY (307) redirect
// to its tab (`legacyRedirect`). Temporary on purpose: 4.7.0 re-maps the Edge
// Clinic's default tab, and a browser-cached 308 would outlive that.

/** One tab of a hub — the body of what used to be its own screen. */
export type HubTab = {
  id: string;
  label: string;
  /** The old screen's own PageHeader description, verbatim. */
  description: string;
  /** The route this tab replaced; it now redirects here. */
  legacyHref: string;
  /** A tab that belongs to one book only (lib/domain/workspace.ts `tabVisible`). */
  domain?: "equity" | "fno";
};

export type Hub = {
  href: string;
  label: string;
  description: string;
  defaultTab: string;
  tabs: readonly HubTab[];
};

export const HUBS: readonly Hub[] = [
  {
    href: "/reports/edge-clinic",
    label: "Edge Clinic",
    description: "Where your edge comes from and what leaks it — setups, discipline and scaling, one tab each.",
    // 4.6.0: Setups is the default. The Clinic tab itself lands in 4.7.0 and
    // takes the default then — no placeholder tab is registered before it
    // exists (a tab that renders nothing is a broken promise in the strip).
    defaultTab: "setups",
    tabs: [
      {
        id: "setups",
        label: "Setups",
        description: "Which edges pay — expectancy, win rate and avg R per setup and segment.",
        legacyHref: "/reports/edge",
      },
      {
        id: "discipline",
        label: "Discipline",
        description: "Weekly adherence to the rules that protect your capital.",
        legacyHref: "/reports/discipline",
      },
      {
        id: "scaling",
        label: "Scaling & Replay",
        description: "Did the ladder improve the trade, and what path did price take around each fill?",
        legacyHref: "/reports/scaling",
      },
    ],
  },
  {
    href: "/reports/capital",
    label: "Capital & Expiry",
    description: "What the capital you tie up actually earns, and how your F&O book behaves around expiry.",
    defaultTab: "rom",
    tabs: [
      {
        id: "rom",
        label: "Return on Margin",
        description: "What your capital actually earned while it was tied up — not return on turnover.",
        legacyHref: "/reports/rom",
      },
      {
        id: "expiry",
        label: "Expiry",
        description: "How your F&O P&L splits between expiry days and the rest — and what's expiring next.",
        legacyHref: "/reports/expiry",
        domain: "fno",
      },
    ],
  },
  {
    href: "/reports/costs",
    label: "Costs",
    description: "What trading costs you — every charge head, and the same book re-priced on every broker's rate card.",
    defaultTab: "charges",
    tabs: [
      {
        id: "charges",
        label: "Charges & MTF Leak",
        description: "Where the edge leaks — by segment and by month, with break-even move %.",
        legacyHref: "/reports/charges",
      },
      {
        id: "broker-compare",
        label: "Broker Costs",
        description: "Your whole trade history re-priced on every broker's rate card.",
        legacyHref: "/reports/broker-compare",
      },
    ],
  },
];

/** The query-string key the hubs read. */
export const HUB_TAB_PARAM = "tab";

/** `/reports/edge-clinic?tab=scaling` — the one way a tab URL is spelled. */
export function hubTabHref(hub: Pick<Hub, "href">, tabId: string): string {
  return `${hub.href}?${HUB_TAB_PARAM}=${encodeURIComponent(tabId)}`;
}

/** The hub's default tab object. */
function defaultTabOf(hub: Hub): HubTab {
  return hub.tabs.find((t) => t.id === hub.defaultTab) ?? hub.tabs[0];
}

/**
 * The tab a request opens (PURE). Missing, unknown, or REPEATED (`?tab=a&tab=b`
 * arrives as an array — ambiguous, and never produced by the strip) all open
 * the hub's default tab: a stale link lands somewhere useful, never on an error.
 */
export function resolveTab(hub: Hub, param: string | string[] | undefined): HubTab {
  if (typeof param !== "string") return defaultTabOf(hub);
  return hub.tabs.find((t) => t.id === param) ?? defaultTabOf(hub);
}

/** The hub whose PATH this href is (`?` and `#` stripped), if any. */
export function hubForHref(href: string): Hub | undefined {
  const path = href.split("?")[0].split("#")[0];
  return HUBS.find((h) => h.href === path);
}

/** The hub + tab a `?tab=` href names, or undefined for a bare/unknown one. */
export function hubTabForHref(href: string): { hub: Hub; tab: HubTab } | undefined {
  const hub = hubForHref(href);
  if (!hub) return undefined;
  const query = href.split("#")[0].split("?")[1];
  if (query === undefined) return undefined;
  const id = new URLSearchParams(query).get(HUB_TAB_PARAM);
  const tab = hub.tabs.find((t) => t.id === id);
  return tab ? { hub, tab } : undefined;
}

/** "/reports/edge" → "/reports/edge-clinic?tab=setups"; null for anything that is not a legacy route. */
export function legacyRedirect(oldHref: string): string | null {
  for (const hub of HUBS) {
    const tab = hub.tabs.find((t) => t.legacyHref === oldHref);
    if (tab) return hubTabHref(hub, tab.id);
  }
  return null;
}

/** The seven routes the hubs replaced, derived from HUBS. */
export const LEGACY_HREFS: readonly string[] = HUBS.flatMap((h) => h.tabs.map((t) => t.legacyHref));

/** legacy href → hub href, derived (the saved-nav-order migration reads this). */
export const LEGACY_TO_HUB: Readonly<Record<string, string>> = Object.fromEntries(
  HUBS.flatMap((h) => h.tabs.map((t) => [t.legacyHref, h.href] as const)),
);
