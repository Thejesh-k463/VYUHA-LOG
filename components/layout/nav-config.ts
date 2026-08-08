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
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  group: string;
};

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, group: "Overview" },
  { href: "/risk", label: "Portfolio Risk", icon: Gauge, group: "Positions" },
  { href: "/strategies", label: "Option Strategies", icon: Layers, group: "Positions" },
  { href: "/options-journal", label: "Options Seller Journal", icon: Sigma, group: "Journal" },
  { href: "/equity", label: "Equity Tracker", icon: Wallet, group: "Positions" },
  { href: "/active", label: "Trade F&O Tracker", icon: Activity, group: "Positions" },
  { href: "/targets/equity", label: "Targets — Equity", icon: Target, group: "Risk" },
  { href: "/targets/active", label: "Targets — Trade F&O", icon: Crosshair, group: "Risk" },
  { href: "/surveillance", label: "Surveillance", icon: ShieldAlert, group: "Risk" },
  { href: "/calculator", label: "Trade Calculator", icon: Calculator, group: "Risk" },
  { href: "/trades", label: "Trades", icon: ListOrdered, group: "Journal" },
  { href: "/sessions", label: "Session Plan", icon: ClipboardCheck, group: "Journal" },
  { href: "/arjuns-eye", label: "Arjun's Eye", icon: Eye, group: "Journal" },
  { href: "/playbooks", label: "Playbooks", icon: BookOpen, group: "Journal" },
  { href: "/ipos", label: "IPOs", icon: Rocket, group: "Journal" },
  { href: "/import", label: "Import", icon: Upload, group: "Journal" },
  { href: "/cash", label: "Cash & Ledger", icon: Banknote, group: "Journal" },
  { href: "/corporate-actions", label: "Corporate Actions", icon: Split, group: "Journal" },
  { href: "/reports/performance", label: "Performance", icon: LineChart, group: "Analytics" },
  { href: "/reports/monthly", label: "Report (PDF)", icon: Printer, group: "Analytics" },
  { href: "/reports/charges", label: "Charges & MTF Leak", icon: Receipt, group: "Analytics" },
  { href: "/reports/broker-compare", label: "Broker Costs", icon: Scale, group: "Analytics" },
  { href: "/reports/advance-tax", label: "Advance Tax", icon: Landmark, group: "Analytics" },
  { href: "/reports/harvest", label: "Tax Harvest", icon: Scissors, group: "Analytics" },
  { href: "/reports/expiry", label: "Expiry Analytics", icon: CalendarClock, group: "Analytics" },
  { href: "/reports/rom", label: "Return on Margin", icon: Gauge, group: "Analytics" },
  { href: "/reports/edge", label: "Edge / Setups", icon: TrendingUp, group: "Analytics" },
  { href: "/reports/scaling", label: "Scaling & Replay", icon: GitBranch, group: "Analytics" },
  { href: "/reports/discipline", label: "Discipline", icon: ShieldCheck, group: "Analytics" },
  { href: "/reports/tax", label: "Tax Summary", icon: FileText, group: "Analytics" },
  { href: "/reports/itr", label: "ITR Pack (India)", icon: FileSearch, group: "Analytics" },
  { href: "/reports/ais", label: "AIS Reconcile", icon: FileSearch, group: "Analytics" },
  { href: "/audit", label: "Audit Log", icon: History, group: "System" },
  { href: "/data-quality", label: "Data Quality", icon: ScanSearch, group: "System" },
  { href: "/rule-packs", label: "Rule & Rate Packs", icon: LibraryBig, group: "System" },
  { href: "/backup", label: "Backup & Restore", icon: Database, group: "System" },
  { href: "/aliases", label: "Symbol Aliases", icon: Tags, group: "System" },
  { href: "/instruments", label: "Instruments", icon: Boxes, group: "System" },
  { href: "/help", label: "Help Desk", icon: LifeBuoy, group: "System" },
  { href: "/settings", label: "Settings", icon: Settings, group: "System" },
];

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

export const NAV_GROUPS = [
  "Overview",
  "Positions",
  "Risk",
  "Journal",
  "Analytics",
  "System",
] as const;
