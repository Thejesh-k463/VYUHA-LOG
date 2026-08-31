import { summarise, type Direction, type Leg } from "@/lib/domain/staged";

export interface ScalingTradeInput { id: number; symbol: string; direction: Direction; legs: Leg[]; }
export interface ScalingRow { id: number; symbol: string; entries: number; exits: number; actualNet: number; firstEntryOnlyNet: number | null; scalingImpact: number | null; verdict: "improved" | "harmed" | "neutral" | "open"; }
export interface ScalingReport { rows: ScalingRow[]; closed: number; improved: number; harmed: number; neutral: number; totalImpact: number; avgImpact: number | null; }
const r2 = (n: number) => Math.round(n * 100) / 100;
export function scalingQuality(inputs: ScalingTradeInput[]): ScalingReport {
  const rows = inputs.map((t): ScalingRow => {
    const pos = summarise(t.legs, t.direction); const first = [...t.legs].sort((a,b) => a.seq-b.seq || a.id-b.id).find((l) => l.kind === "entry");
    if (!pos.isClosed || !first || pos.avgExitPrice == null) return { id: t.id, symbol: t.symbol, entries: pos.entryCount, exits: pos.exitCount, actualNet: pos.realisedNet, firstEntryOnlyNet: null, scalingImpact: null, verdict: "open" };
    // CHARGE SYMMETRY: summarise()'s realisedNet nets EXIT charges only, while
    // the counterfactual below subtracts the first entry's charges — comparing
    // those two booked every ladder roughly one brokerage "improved" for free.
    // On a CLOSED ladder every entry tranche was consumed, so the actual side
    // bears ALL its entry charges and each scenario now carries its own
    // entry + exit costs — the extra entries' brokerage is a real cost of
    // scaling and now counts against it.
    const entryChargesAll = t.legs.reduce((s, l) => s + (l.kind === "entry" ? (l.chargesTotal ?? 0) : 0), 0);
    const actualNet = r2(pos.realisedNet - entryChargesAll);
    const entryCharges = first.chargesTotal ?? 0;
    const exitCharges = pos.realisedCharges * Math.min(1, first.qty / Math.max(1e-9, pos.totalExitQty));
    const gross = t.direction === "long" ? (pos.avgExitPrice - first.price) * first.qty : (first.price - pos.avgExitPrice) * first.qty;
    const base = r2(gross - entryCharges - exitCharges); const impact = r2(actualNet - base); const threshold = Math.max(10, Math.abs(base) * 0.01);
    return { id: t.id, symbol: t.symbol, entries: pos.entryCount, exits: pos.exitCount, actualNet, firstEntryOnlyNet: base, scalingImpact: impact, verdict: impact > threshold ? "improved" : impact < -threshold ? "harmed" : "neutral" };
  });
  const closedRows = rows.filter((r) => r.scalingImpact != null); const totalImpact = r2(closedRows.reduce((s,r) => s + r.scalingImpact!, 0));
  return { rows, closed: closedRows.length, improved: closedRows.filter((r) => r.verdict === "improved").length, harmed: closedRows.filter((r) => r.verdict === "harmed").length, neutral: closedRows.filter((r) => r.verdict === "neutral").length, totalImpact, avgImpact: closedRows.length ? r2(totalImpact / closedRows.length) : null };
}
