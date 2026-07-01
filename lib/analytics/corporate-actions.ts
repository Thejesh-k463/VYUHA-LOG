// IND-13 (V1 slice) — corporate actions: split/bonus qty-avgPrice adjustment +
// dividend income, PURE (no DB/React). Closes a real correctness gap: an
// unhandled split/bonus on a held stock silently corrupts qty and avg cost basis
// for every downstream calculation (exposure, P&L, risk).
//
// Scope (V1): split, bonus, dividend — the three that most commonly and most
// silently break a journal. Rights/buyback/OFS are out of scope (tracked in the
// roadmap as a future extension of the /ipos-style primary-market flow).
// Dividend is scoped to CURRENTLY OPEN positions only (no point-in-time
// historical share-count reconstruction for already-closed trades).

export type CorporateActionType = "split" | "bonus" | "dividend";

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Multiplier applied to quantity (and inversely to every price level) for a
 * split or bonus, expressed as a ratio "fromUnits : toUnits":
 *   split "1:5" (1 old share -> 5 new shares)      => multiplier = 5/1 = 5
 *   bonus "1:1" (1 bonus share per 1 held)          => multiplier = (1+1)/1 = 2
 *   bonus "2:1" (1 bonus share per 2 held)          => multiplier = (2+1)/2 = 1.5
 * Total invested value (qty × avgPrice) is preserved by construction: qty scales
 * by the multiplier, every price level scales by its inverse.
 */
export function splitBonusMultiplier(type: "split" | "bonus", fromUnits: number, toUnits: number): number {
  if (fromUnits <= 0 || toUnits <= 0) return 1;
  return type === "split" ? toUnits / fromUnits : (fromUnits + toUnits) / fromUnits;
}

export interface AdjustablePosition {
  qty: number;
  avgPrice: number;
  slPlanned: number | null;
  trailingSl: number | null;
  targetPlanned: number | null;
}

export interface AdjustedPosition {
  qty: number;
  avgPrice: number;
  slPlanned: number | null;
  trailingSl: number | null;
  targetPlanned: number | null;
}

/**
 * Apply a split/bonus multiplier to one position: qty scales up, every price
 * level (avg cost + all stop/target levels) scales down by the same factor, so
 * invested value and stop-distance (in ₹) are both preserved.
 */
export function adjustForSplitOrBonus(p: AdjustablePosition, multiplier: number): AdjustedPosition {
  if (multiplier <= 0 || !Number.isFinite(multiplier)) {
    return { qty: p.qty, avgPrice: p.avgPrice, slPlanned: p.slPlanned, trailingSl: p.trailingSl, targetPlanned: p.targetPlanned };
  }
  const scalePrice = (v: number | null) => (v == null ? null : r2(v / multiplier));
  return {
    qty: Math.round(p.qty * multiplier),
    avgPrice: scalePrice(p.avgPrice) as number,
    slPlanned: scalePrice(p.slPlanned),
    trailingSl: scalePrice(p.trailingSl),
    targetPlanned: scalePrice(p.targetPlanned),
  };
}

/** Gross dividend income for a held quantity (before any TDS). */
export function dividendIncome(qty: number, perShare: number): number {
  if (qty <= 0 || perShare <= 0) return 0;
  return r2(qty * perShare);
}

/**
 * Post-2020 dividends are taxable in the investor's hands; TDS applies at 10%
 * once a single company's dividend to one investor crosses ₹5,000 in a FY.
 * This is informational only (V1 does not track the running FY total per
 * company) — surfaced so the UI can flag it, not auto-deduct it.
 */
export const DIVIDEND_TDS_THRESHOLD = 5000;
export const DIVIDEND_TDS_RATE = 0.1;

export interface CorporateActionRow {
  symbol: string;
  type: CorporateActionType;
  exDate: string;
  fromUnits: number | null;
  toUnits: number | null;
  dividendPerShare: number | null;
  note: string | null;
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function toIsoDate(s: string): string | null {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  let m = t.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ](\d{4})$/); // 30-Jun-2026
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (mo) return `${m[3]}-${mo}-${m[1].padStart(2, "0")}`;
  }
  m = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/); // 30-06-2026 (day-month)
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

/**
 * Parse a pasted corporate-actions list. One per line:
 *   SYMBOL, TYPE, EX-DATE, RATIO_OR_AMOUNT
 * where TYPE is split|bonus|dividend, RATIO_OR_AMOUNT is "1:5" / "1:1" for
 * split/bonus or a plain ₹-per-share number for dividend. `#` lines are comments.
 */
export function parseCorporateActionList(text: string): CorporateActionRow[] {
  const rows: CorporateActionRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/[,\t|]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 4) continue;
    const symbol = parts[0].toUpperCase();
    const type = parts[1].toLowerCase() as CorporateActionType;
    if (!symbol || !["split", "bonus", "dividend"].includes(type)) continue;
    const exDate = toIsoDate(parts[2]);
    if (!exDate) continue;

    if (type === "dividend") {
      const amt = Number(parts[3].replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(amt) || amt <= 0) continue;
      rows.push({ symbol, type, exDate, fromUnits: null, toUnits: null, dividendPerShare: amt, note: parts.slice(4).join(" ") || null });
    } else {
      const ratio = parts[3].match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
      if (!ratio) continue;
      const fromUnits = Number(ratio[1]);
      const toUnits = Number(ratio[2]);
      if (!(fromUnits > 0) || !(toUnits > 0)) continue;
      rows.push({ symbol, type, exDate, fromUnits, toUnits, dividendPerShare: null, note: parts.slice(4).join(" ") || null });
    }
  }
  return rows;
}
