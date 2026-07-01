// IND-8 — SEBI/exchange surveillance alerts (PURE, no DB/React).
//
// Indian exchanges publish daily restriction lists:
//   • F&O ban   — a stock's open interest crossed 95% of its Market-Wide Position
//                 Limit (MWPL); only position-REDUCTION is allowed, no new/added F&O.
//   • ASM / GSM — Additional / Graded Surveillance: higher margins, price bands,
//                 trade-to-trade or periodic call-auction settlement.
//   • Circuit   — daily price-band limits.
// This module matches the user's held / open positions against such a list and
// raises actionable alerts. Offline-first: the list is pasted/imported by the user.

export type RestrictionCategory = "fno_ban" | "asm" | "gsm" | "circuit" | "other";
export type Severity = "high" | "medium" | "info";

export interface RestrictedRow {
  symbol: string;
  category: RestrictionCategory;
  stage?: string | null;
  note?: string | null;
  asOfDate: string;
  source?: string | null;
}

export interface HeldSymbol {
  symbol: string;
  isOpen: boolean; // any open position in this symbol
  isFno: boolean; // holds a derivative (option/future) on this symbol
  qty: number; // net open quantity (informational)
  segments: string[]; // distinct segments held
}

export interface RestrictionAlert {
  symbol: string;
  categories: RestrictionCategory[];
  severity: Severity;
  isOpen: boolean;
  isFno: boolean;
  matched: RestrictedRow[];
  headline: string;
  guidance: string;
}

export interface RestrictionReport {
  asOfDate: string | null;
  totalRestricted: number; // distinct restricted symbols in the list
  byCategory: Record<RestrictionCategory, number>;
  heldRestricted: number; // distinct held symbols that are restricted
  alerts: RestrictionAlert[]; // held ∩ restricted, severity desc
}

interface CatMeta {
  label: string;
  base: Severity;
  guidance: string;
}

export const CATEGORY_META: Record<RestrictionCategory, CatMeta> = {
  fno_ban: {
    label: "F&O ban",
    base: "high",
    guidance: "In ban — only position reduction allowed. You cannot add or open fresh F&O; new positions attract penalty. Square off or trim.",
  },
  gsm: {
    label: "GSM",
    base: "high",
    guidance: "Graded Surveillance — trade-to-trade, up to 100% margin and periodic call-auction. Avoid fresh exposure; exits may be slow.",
  },
  asm: {
    label: "ASM",
    base: "medium",
    guidance: "Additional Surveillance — higher margins and tighter price bands. Size positions carefully and expect volatility.",
  },
  circuit: {
    label: "Circuit / band",
    base: "info",
    guidance: "Daily price band may freeze the order book. Use limit orders; market orders can get stuck at the band.",
  },
  other: {
    label: "Flagged",
    base: "info",
    guidance: "Surveillance flag — confirm trading conditions with your broker.",
  },
};

const SEV_RANK: Record<Severity, number> = { high: 3, medium: 2, info: 1 };

/** Normalize a free-text category token to a canonical RestrictionCategory. */
export function normalizeCategory(raw: string): RestrictionCategory {
  const s = raw.toLowerCase();
  if (s.includes("circuit") || s.includes("band")) return "circuit"; // before "ban" (band ⊃ ban)
  if (s.includes("ban") || s.includes("fno") || s.includes("f&o") || s.includes("mwpl")) return "fno_ban";
  if (s.includes("gsm")) return "gsm";
  if (s.includes("asm")) return "asm";
  return "other";
}

/**
 * Parse a pasted/imported restriction list. One entry per line:
 *   SYMBOL, category, [stage/note...]
 * Separators may be comma, tab or pipe. Lines starting with # are comments.
 */
export function parseRestrictedList(
  text: string,
  asOfDate: string,
  source = "manual",
): RestrictedRow[] {
  const rows: RestrictedRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const parts = t.split(/[,\t|]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) continue;
    const symbol = parts[0].toUpperCase();
    if (!symbol) continue;
    const category = parts[1] ? normalizeCategory(parts[1]) : "other";
    const rest = parts.slice(2).join(" ") || null;
    rows.push({ symbol, category, stage: rest, note: null, asOfDate, source });
  }
  return rows;
}

/** Per-category effective severity for a holding (F&O ban only bites F&O holders). */
function effectiveSeverity(cat: RestrictionCategory, isFno: boolean): Severity {
  if (cat === "fno_ban" && !isFno) return "info";
  return CATEGORY_META[cat].base;
}

export function computeRestrictions(
  held: HeldSymbol[],
  list: RestrictedRow[],
  resolve: (symbol: string) => string = (s) => s,
): RestrictionReport {
  // Index the list by symbol.
  const bySymbol = new Map<string, RestrictedRow[]>();
  for (const r of list) {
    const key = r.symbol.toUpperCase();
    const arr = bySymbol.get(key) ?? [];
    arr.push(r);
    bySymbol.set(key, arr);
  }

  const byCategory: Record<RestrictionCategory, number> = {
    fno_ban: 0, asm: 0, gsm: 0, circuit: 0, other: 0,
  };
  for (const [, rows] of bySymbol) {
    const cats = new Set(rows.map((r) => r.category));
    for (const c of cats) byCategory[c] += 1;
  }

  const alerts: RestrictionAlert[] = [];
  for (const h of held) {
    // Match on the canonical ticker (lists use tickers; holdings may be full broker names).
    const matched = bySymbol.get(h.symbol.toUpperCase()) ?? bySymbol.get(resolve(h.symbol).toUpperCase());
    if (!matched || matched.length === 0) continue;
    const categories = [...new Set(matched.map((m) => m.category))];
    let severity: Severity = "info";
    for (const c of categories) {
      const eff = effectiveSeverity(c, h.isFno);
      if (SEV_RANK[eff] > SEV_RANK[severity]) severity = eff;
    }
    // Headline + guidance from the highest-severity matched category.
    const topCat = categories
      .slice()
      .sort((a, b) => SEV_RANK[effectiveSeverity(b, h.isFno)] - SEV_RANK[effectiveSeverity(a, h.isFno)])[0];
    const labels = categories.map((c) => CATEGORY_META[c].label).join(" · ");
    const headline =
      topCat === "fno_ban" && !h.isFno
        ? `${labels} — you hold equity only (ban applies to F&O)`
        : labels;
    alerts.push({
      symbol: h.symbol.toUpperCase(),
      categories,
      severity,
      isOpen: h.isOpen,
      isFno: h.isFno,
      matched,
      headline,
      guidance: CATEGORY_META[topCat].guidance,
    });
  }

  alerts.sort(
    (a, b) =>
      SEV_RANK[b.severity] - SEV_RANK[a.severity] ||
      Number(b.isOpen) - Number(a.isOpen) ||
      a.symbol.localeCompare(b.symbol),
  );

  const asOf = list.map((r) => r.asOfDate).filter(Boolean).sort();
  return {
    asOfDate: asOf[asOf.length - 1] ?? null,
    totalRestricted: bySymbol.size,
    byCategory,
    heldRestricted: alerts.length,
    alerts,
  };
}
