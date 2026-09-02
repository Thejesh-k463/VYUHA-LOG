import type { LucideIcon } from "lucide-react";
import {
  LifeBuoy,
  LayoutDashboard,
  Wallet,
  Activity,
  Target,
  Crosshair,
  Calculator,
  Gauge,
  ListOrdered,
  Rocket,
  Receipt,
  LineChart,
  TrendingUp,
  ShieldAlert,
  ShieldCheck,
  Scale,
  Landmark,
  Scissors,
  CalendarClock,
  Layers,
  Banknote,
  History,
  Database,
  Tags,
  Boxes,
  Split,
  FileText,
  FileQuestion,
  Upload,
  Settings,
  BookOpen,
  Printer,
  FileSearch,
  Eye,
  ScanSearch,
  ClipboardCheck,
  LibraryBig,
  GitBranch,
  Sigma,
  Columns3,
  NotebookPen,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  group: string;
};

/**
 * v3.6 grouping (owner decision #5). Within each group the DEFAULT-VISIBLE
 * screens (see NAV_DEFAULT_VISIBLE) are listed first, so the default saved
 * order and the default fold agree without any normalisation.
 */
export const NAV_ITEMS: NavItem[] = [
  // Overview
  { href: "/", label: "Dashboard", icon: LayoutDashboard, group: "Overview" },
  // Positions
  { href: "/risk", label: "Portfolio Risk", icon: Gauge, group: "Positions" },
  { href: "/strategies", label: "Option Strategies", icon: Layers, group: "Positions" },
  { href: "/equity", label: "Equity Tracker", icon: Wallet, group: "Positions" },
  { href: "/active", label: "Trade F&O Tracker", icon: Activity, group: "Positions" },
  // Risk
  { href: "/targets/equity", label: "Targets — Equity", icon: Target, group: "Risk" },
  { href: "/calculator", label: "Trade Calculator", icon: Calculator, group: "Risk" },
  { href: "/targets/active", label: "Targets — Trade F&O", icon: Crosshair, group: "Risk" },
  // Journal
  { href: "/trades", label: "Trades", icon: ListOrdered, group: "Journal" },
  { href: "/lenses", label: "Lenses", icon: Columns3, group: "Journal" },
  { href: "/sessions", label: "Session Plan", icon: ClipboardCheck, group: "Journal" },
  { href: "/review", label: "Trade Review Desk", icon: NotebookPen, group: "Journal" },
  { href: "/playbooks", label: "Playbooks", icon: BookOpen, group: "Journal" },
  { href: "/options-journal", label: "Options Seller Journal", icon: Sigma, group: "Journal" },
  { href: "/ipos", label: "IPOs", icon: Rocket, group: "Journal" },
  // Import
  { href: "/import", label: "Import", icon: Upload, group: "Import" },
  { href: "/import-help", label: "Import Help", icon: FileQuestion, group: "Import" },
  // Tax
  { href: "/reports/tax", label: "Tax Summary", icon: FileText, group: "Tax" },
  { href: "/reports/advance-tax", label: "Advance Tax", icon: Landmark, group: "Tax" },
  { href: "/reports/harvest", label: "Tax Harvest", icon: Scissors, group: "Tax" },
  { href: "/reports/itr", label: "ITR Pack (India)", icon: FileSearch, group: "Tax" },
  { href: "/reports/ais", label: "AIS Reconcile", icon: FileSearch, group: "Tax" },
  // Analytics
  { href: "/reports/performance", label: "Performance", icon: LineChart, group: "Analytics" },
  { href: "/arjuns-eye", label: "Arjun's Eye", icon: Eye, group: "Analytics" },
  { href: "/reports/monthly", label: "Report (PDF)", icon: Printer, group: "Analytics" },
  { href: "/reports/charges", label: "Charges & MTF Leak", icon: Receipt, group: "Analytics" },
  { href: "/reports/broker-compare", label: "Broker Costs", icon: Scale, group: "Analytics" },
  { href: "/reports/expiry", label: "Expiry Analytics", icon: CalendarClock, group: "Analytics" },
  { href: "/reports/rom", label: "Return on Margin", icon: Gauge, group: "Analytics" },
  { href: "/reports/edge", label: "Edge / Setups", icon: TrendingUp, group: "Analytics" },
  { href: "/reports/scaling", label: "Scaling & Replay", icon: GitBranch, group: "Analytics" },
  { href: "/reports/discipline", label: "Discipline", icon: ShieldCheck, group: "Analytics" },
  // Back Office
  { href: "/cash", label: "Cash & Ledger", icon: Banknote, group: "Back Office" },
  { href: "/surveillance", label: "Surveillance", icon: ShieldAlert, group: "Back Office" },
  { href: "/corporate-actions", label: "Corporate Actions", icon: Split, group: "Back Office" },
  { href: "/aliases", label: "Symbol Aliases", icon: Tags, group: "Back Office" },
  { href: "/instruments", label: "Instruments", icon: Boxes, group: "Back Office" },
  // System
  { href: "/settings", label: "Settings", icon: Settings, group: "System" },
  { href: "/backup", label: "Backup & Restore", icon: Database, group: "System" },
  { href: "/audit", label: "Audit Log", icon: History, group: "System" },
  { href: "/data-quality", label: "Data Quality", icon: ScanSearch, group: "System" },
  { href: "/rule-packs", label: "Rule & Rate Packs", icon: LibraryBig, group: "System" },
  { href: "/help", label: "Help Desk", icon: LifeBuoy, group: "System" },
];

export const NAV_GROUPS = [
  "Overview",
  "Positions",
  "Risk",
  "Journal",
  "Import",
  "Tax",
  "Analytics",
  "Back Office",
  "System",
] as const;

/**
 * The screens each group shows while FOLDED — the owner-approved "visible"
 * sets (decision #5). Everything else sits behind the group's "N more…" row.
 * NAV_ITEMS stays the single source of truth for what exists; this map only
 * says which of it leads the fold, and `tests/nav-order.test.ts` fails if an
 * href here drifts away from NAV_ITEMS or names the wrong group.
 */
export const NAV_DEFAULT_VISIBLE: Record<string, string[]> = {
  Overview: ["/"],
  Positions: ["/risk"],
  Risk: ["/targets/equity", "/calculator"],
  Journal: ["/trades", "/lenses", "/sessions", "/review"],
  Import: ["/import"],
  Tax: ["/reports/tax"],
  Analytics: ["/reports/performance", "/arjuns-eye"],
  "Back Office": ["/cash"],
  System: ["/settings", "/backup"],
} satisfies Record<(typeof NAV_GROUPS)[number], string[]>;

/**
 * Merge a user's saved ordering with the CURRENT set of keys (PURE).
 *
 * The saved order wins for everything it knows; keys it has never seen —
 * screens added by an app update — slot in at their default position instead
 * of vanishing or piling up at the end. Deleted screens drop out silently.
 * This is what makes a persisted nav order survive updates.
 */
export function mergeOrder(saved: string[] | null | undefined, current: string[]): string[] {
  if (!saved || saved.length === 0) return current;
  const known = saved.filter((k) => current.includes(k));
  const out: string[] = [...known];
  current.forEach((k, i) => {
    if (out.includes(k)) return;
    // Insert after the nearest preceding default neighbour already placed.
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const idx = out.indexOf(current[j]);
      if (idx >= 0) { at = idx + 1; break; }
    }
    out.splice(at, 0, k);
  });
  return out;
}

/**
 * Merge a user's saved fold-visible set with the CURRENT keys (PURE).
 *
 * A saved set wins outright — including a deliberately EMPTY one (the
 * customizer lets a user fold a whole group away). Two fallbacks to the
 * defaults exist: no saved set at all, and a saved set whose every member was
 * removed by an update — an all-unknown set is stale data, not a choice, and
 * honouring it would fold the group to nothing without the user ever asking.
 */
export function mergeShown(
  saved: string[] | null | undefined,
  defaults: string[],
  current: string[],
): string[] {
  if (saved) {
    const known = saved.filter((k) => current.includes(k));
    if (known.length > 0 || saved.length === 0) return known;
  }
  return defaults.filter((k) => current.includes(k));
}

/**
 * Partition `full` so members of `shown` lead (PURE); both sides keep their
 * relative order. This is the order the sidebar RENDERS: the fold line is a
 * real place only when every visible-when-folded screen sits above it.
 */
export function partitionByShown(full: string[], shown: ReadonlySet<string>): string[] {
  return [...full.filter((h) => shown.has(h)), ...full.filter((h) => !shown.has(h))];
}

/**
 * Move the entry at `from` so it sits at `to` (PURE; returns a new array).
 *
 * Index-based rather than direction-based because dragging knows POSITIONS,
 * not steps: the pointer lands between two neighbours and the item travels
 * however far it needs in one motion. Splice-out-then-splice-in, so the
 * indices after removal are the ones `to` is measured against — the reason a
 * naive swap produces an off-by-one when dragging downward.
 */
export function moveIndex<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const clamped = Math.max(0, Math.min(list.length - 1, to));
  const out = [...list];
  const [moved] = out.splice(from, 1);
  out.splice(clamped, 0, moved);
  return out;
}

/**
 * Apply a reorder that the user performed on a FILTERED view of `full` (PURE).
 *
 * Workspace mode can hide screens, so a drag produces indices that count only
 * the visible rows. Committing those straight into the saved order would write
 * back a list with every hidden screen missing — and the user would find their
 * ordering quietly rebuilt the next time they switched modes.
 *
 * The move is therefore expressed as a RELATION: the dragged entry keeps its
 * new position relative to its visible neighbours, and hidden entries are left
 * exactly where they sit. Dropping at the end of the visible list appends,
 * which is the only case with no following neighbour to anchor to.
 */
export function moveWithinVisible<T>(full: T[], visible: T[], from: number, to: number): T[] {
  const moved = visible[from];
  if (moved === undefined) return full;
  const nextVisible = moveIndex(visible, from, to);
  const follower = nextVisible[nextVisible.indexOf(moved) + 1];
  const rest = full.filter((x) => x !== moved);
  const at = follower === undefined ? -1 : rest.indexOf(follower);
  const out = [...rest];
  out.splice(at < 0 ? rest.length : at, 0, moved);
  return out;
}

/**
 * Commit a drag performed on the sidebar's RENDERED rows (PURE).
 *
 * The rendered list is `full` filtered TWICE — by workspace mode and, when the
 * group is folded, by the visible set — always over the partitioned order, so
 * `rendered` is a subsequence of `partitionByShown(full, shown)` and
 * `moveWithinVisible` can keep every hidden entry exactly where it sits.
 *
 * The same commit also decides which side of the fold the dragged entry lands
 * on: an entry dropped strictly inside the visible region is promoted, one
 * dropped past it is demoted, and an already-visible entry may sit at the very
 * end of the visible region without falling off it. In a folded group every
 * rendered row is visible, so the fold is unreachable and membership cannot
 * change — dragging there is pure reordering.
 */
export function foldDrag(
  full: string[],
  rendered: string[],
  shown: string[],
  from: number,
  to: number,
): { order: string[]; shown: string[] } {
  const moved = rendered[from];
  if (moved === undefined) return { order: full, shown };
  const shownSet = new Set(shown);
  const base = partitionByShown(full, shownSet);
  const order = moveWithinVisible(base, rendered, from, to);
  const nextRendered = moveIndex(rendered, from, to);
  const p = nextRendered.indexOf(moved);
  const wasShown = shownSet.has(moved);
  // The fold, in rendered coordinates: every OTHER rendered visible row, plus
  // the dragged row's own slot when it was already visible.
  const fold = rendered.filter((h, i) => i !== from && shownSet.has(h)).length + (wasShown ? 1 : 0);
  const nextSet = new Set(shownSet);
  if (p < fold) nextSet.add(moved);
  else nextSet.delete(moved);
  return { order, shown: order.filter((h) => nextSet.has(h)) };
}

/** The persisted sidebar-nav envelope (localStorage `vyuha-nav-order`). */
export type NavOrderState = {
  v: 1;
  /** Saved group order (may be empty = default). */
  groups: string[];
  /** Saved per-group item order. */
  items: Record<string, string[]>;
  /** Per-group visible-when-folded hrefs; a MISSING key means the defaults. */
  shown: Record<string, string[]>;
  /** Per-group expand state; missing/false means folded. */
  expanded: Record<string, boolean>;
};

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const strArrayRecord = (v: unknown): Record<string, string[]> => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string[]> = {};
  for (const [k, val] of Object.entries(v)) if (Array.isArray(val)) out[k] = strArray(val);
  return out;
};

const boolRecord = (v: unknown): Record<string, boolean> => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, boolean> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === "boolean") out[k] = val;
  return out;
};

/**
 * Parse the stored nav-order value into a v1 envelope (PURE).
 *
 * Three shapes arrive here: the current versioned envelope; the LEGACY
 * un-versioned `{groups, items}` written by every release before v3.6, which
 * is MIGRATED rather than discarded — a user's saved order must survive the
 * update that added folding; and garbage (corrupt JSON, a future version,
 * wrong types), which returns null so the defaults render instead of a
 * mis-read.
 */
export function parseNavOrder(raw: string | null | undefined): NavOrderState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    if (o.v === undefined) {
      // Legacy {groups, items}: order carries over, fold state starts default.
      if (o.groups === undefined && o.items === undefined) return null;
      return { v: 1, groups: strArray(o.groups), items: strArrayRecord(o.items), shown: {}, expanded: {} };
    }
    if (o.v !== 1) return null; // a future shape is discarded, never mis-read
    return {
      v: 1,
      groups: strArray(o.groups),
      items: strArrayRecord(o.items),
      shown: strArrayRecord(o.shown),
      expanded: boolRecord(o.expanded),
    };
  } catch {
    return null;
  }
}
