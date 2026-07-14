// SL/TSL/target breach detector (PURE, no DB/React). Compares each open
// position's latest mark against its own recorded stop/trailing-stop/target.
//
// Honest framing (repeated in the UI): marks here are EOD or manually entered —
// NOT live quotes. A breach is a prompt to review the exit plan against a live
// price at your broker, never an instruction to act. The user stays in control.

export interface AlertPositionInput {
  id: number;
  symbol: string;
  side: "long" | "short";
  qty: number;
  entry: number;
  mtm: number; // latest mark (EOD/manual)
  slPlanned: number | null;
  trailingSl: number | null;
  targetPlanned: number | null;
  riskAmount: number | null;
}

export type BreachKind = "sl" | "tsl" | "target";

export interface Breach {
  id: number;
  symbol: string;
  kind: BreachKind;
  side: "long" | "short";
  level: number; // the breached level
  mtm: number;
  /** How far through the level the mark is, as % of the level (≥ 0). */
  throughPct: number;
  message: string; // caution-toned, review-your-plan phrasing
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** A long breaches its stop when the mark is AT/below it; a short when at/above.
 *  Targets mirror that. TSL wins over the original SL when both are breached
 *  (the trailing stop is the active one); both never double-report. */
export function detectBreaches(positions: AlertPositionInput[]): Breach[] {
  const out: Breach[] = [];
  for (const p of positions) {
    if (!(p.mtm > 0) || !(p.qty > 0)) continue;
    const long = p.side === "long";
    const stopHit = (level: number) => (long ? p.mtm <= level : p.mtm >= level);
    const targetHit = (level: number) => (long ? p.mtm >= level : p.mtm <= level);
    const through = (level: number) => (level > 0 ? r2((Math.abs(p.mtm - level) / level) * 100) : 0);

    const tslBreached = p.trailingSl != null && p.trailingSl > 0 && stopHit(p.trailingSl);
    const slBreached = p.slPlanned != null && p.slPlanned > 0 && stopHit(p.slPlanned);

    if (tslBreached) {
      out.push({
        id: p.id, symbol: p.symbol, kind: "tsl", side: p.side, level: p.trailingSl!, mtm: p.mtm,
        throughPct: through(p.trailingSl!),
        message: `${p.symbol}: mark ${p.mtm} is through your trailing SL ${p.trailingSl} — check a live quote and review your exit plan.`,
      });
    } else if (slBreached) {
      out.push({
        id: p.id, symbol: p.symbol, kind: "sl", side: p.side, level: p.slPlanned!, mtm: p.mtm,
        throughPct: through(p.slPlanned!),
        message: `${p.symbol}: mark ${p.mtm} is through your stop ${p.slPlanned} — check a live quote and review your exit plan.`,
      });
    }

    if (p.targetPlanned != null && p.targetPlanned > 0 && targetHit(p.targetPlanned)) {
      out.push({
        id: p.id, symbol: p.symbol, kind: "target", side: p.side, level: p.targetPlanned, mtm: p.mtm,
        throughPct: through(p.targetPlanned),
        message: `${p.symbol}: mark ${p.mtm} has reached your target ${p.targetPlanned} — review whether to book, trail, or hold per your plan.`,
      });
    }
  }
  // Stops first (they need attention before targets), deepest breach first.
  const rank: Record<BreachKind, number> = { tsl: 0, sl: 0, target: 1 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || b.throughPct - a.throughPct);
}
