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

/** Move one key a step up/down within a list (PURE; returns a new array). */
export function moveKey(list: string[], key: string, dir: -1 | 1): string[] {
  const i = list.indexOf(key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
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
