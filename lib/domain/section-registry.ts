// PAGE SECTION REGISTRY (PURE — no DB, no React).
//
// The single source of truth for which cards a page renders and in what
// DEFAULT order. `components/layout/section-stack.tsx` sorts its `<Section>`
// children by this list merged with the user's saved order
// (lib/domain/section-order.ts), exactly as the sidebar sorts NAV_ITEMS.
//
// Three rules, each pinned by tests/section-order.test.ts:
//
// 1. **A section id is a PERMANENT name.** The saved order is a list of ids;
//    renaming `settings-appearance` to `settings-look` silently drops that
//    card's position for every existing user. If a card is replaced, keep its
//    id. If one SPLITS in two, the original keeps its id (and the user's slot)
//    and the new half gets a new id at its default rank.
// 2. **Every id here is rendered by its page, and every rendered `<Section>`
//    is registered here.** `mergeOrder` drops keys the current list does not
//    contain, so a typo'd id is not an error — it is a card that silently
//    disappears. The AST test walks the `<SectionStack page=…>` JSX and fails
//    on any disagreement.
// 3. **A grid pair is ONE section** (a `lg:grid-cols-*` row). Order inside a
//    grid is 2-D; dissolving it is a layout redesign, not a reorder.
//
// Pilot pages (v4.4.0 ruling): `/settings` and the dashboard `/`. Other pages
// join by adding an entry here, a `<SectionStack page=…>` and `<Section>`s.

export const PAGE_IDS = ["settings", "dashboard"] as const;
export type PageId = (typeof PAGE_IDS)[number];

export interface SectionDef {
  /** Stable, kebab-case, page-prefixed; NEVER reused for a different card. */
  id: string;
  /** What the Rearrange list, the grip's aria-label and the frame's name say. */
  label: string;
  /** `false` pins the section at its default slot (toolbars, sequences, runners). */
  movable?: false;
}

/**
 * DEFAULT order per page — ranked by the research pack's ladder (what says
 * STOP → the one number → the working surface → analysis → reference →
 * cosmetics). /settings follows §1.1 of
 * `page-section-order-and-user-arrangement.md`: Capital & Go-Live first, the
 * goals directly under total capital, Appearance LAST (owner, 2026-09-16), the
 * License card near the bottom regardless of licence state (v4.4.0 ruling).
 */
export const PAGE_SECTIONS: Record<PageId, readonly SectionDef[]> = {
  settings: [
    { id: "settings-capital-golive", label: "Capital & Go-Live" },
    { id: "settings-capital-management", label: "Capital management" },
    { id: "settings-capital-goals", label: "Expected capital goals" },
    { id: "settings-capital-growth", label: "Capital growth" },
    { id: "settings-workspace", label: "Workspace" },
    { id: "settings-preferences", label: "Preferences" },
    { id: "settings-accounts", label: "Portfolio accounts" },
    { id: "settings-defaults", label: "My Default Settings" },
    { id: "settings-risk-rules", label: "Risk rules" },
    { id: "settings-charge-rates", label: "Charge rates" },
    { id: "settings-telegram", label: "Telegram digest" },
    { id: "settings-live-feed", label: "Live feed" },
    { id: "settings-integrations", label: "Integrations (advanced)" },
    { id: "settings-license", label: "License" },
    { id: "settings-first-run", label: "First-run setup" },
    { id: "settings-app-updates", label: "App updates" },
    { id: "settings-appearance", label: "Appearance" },
  ],
  // The dashboard's filter bar is a CONTROL over everything below it and stays
  // above the stack; the breach banner and the review nag are rank-1 alerts and
  // stay pinned above the filter bar in app/page.tsx (a warning a user can drag
  // below the fold is a warning that was not given). Neither is registered.
  dashboard: [
    { id: "dash-kpis", label: "KPI strip" },
    { id: "dash-equity-curve", label: "Equity curve and monthly target ladder" },
    { id: "dash-daily-calendar", label: "Daily P&L calendar" },
    { id: "dash-by-segment", label: "Net P&L by segment and setup tag" },
    { id: "dash-streaks", label: "Streaks, win/loss size and charge leak" },
  ],
};

/** The registry entry for `id` on `page`, or undefined. */
export function sectionDef(page: PageId, id: string): SectionDef | undefined {
  return PAGE_SECTIONS[page].find((s) => s.id === id);
}
