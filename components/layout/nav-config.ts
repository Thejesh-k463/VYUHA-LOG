import type { LucideIcon } from "lucide-react";
import {
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
  { href: "/equity", label: "Equity Tracker", icon: Wallet, group: "Positions" },
  { href: "/active", label: "Active Tracker", icon: Activity, group: "Positions" },
  { href: "/targets/equity", label: "Targets — Equity", icon: Target, group: "Risk" },
  { href: "/targets/active", label: "Targets — Active", icon: Crosshair, group: "Risk" },
  { href: "/surveillance", label: "Surveillance", icon: ShieldAlert, group: "Risk" },
  { href: "/calculator", label: "Trade Calculator", icon: Calculator, group: "Risk" },
  { href: "/trades", label: "Trades", icon: ListOrdered, group: "Journal" },
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
  { href: "/reports/edge", label: "Edge / Setups", icon: TrendingUp, group: "Analytics" },
  { href: "/reports/discipline", label: "Discipline", icon: ShieldCheck, group: "Analytics" },
  { href: "/reports/tax", label: "Tax Summary", icon: FileText, group: "Analytics" },
  { href: "/reports/ais", label: "AIS Reconcile", icon: FileSearch, group: "Analytics" },
  { href: "/audit", label: "Audit Log", icon: History, group: "System" },
  { href: "/backup", label: "Backup & Restore", icon: Database, group: "System" },
  { href: "/aliases", label: "Symbol Aliases", icon: Tags, group: "System" },
  { href: "/instruments", label: "Instruments", icon: Boxes, group: "System" },
  { href: "/settings", label: "Settings", icon: Settings, group: "System" },
];

export const NAV_GROUPS = [
  "Overview",
  "Positions",
  "Risk",
  "Journal",
  "Analytics",
  "System",
] as const;
