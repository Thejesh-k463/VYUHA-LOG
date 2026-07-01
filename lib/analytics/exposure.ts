// Pure portfolio-exposure analytics for the Open Positions / Portfolio Risk
// dashboard. All %s are against the chosen capital scope. Defaults to long; pass
// side: "short" for a sell-to-open position (e.g. a written CE/PE) — profit runs
// the opposite way (price falling is favorable), which flips the P&L/risk signs.

export interface ExposureInput {
  id: number;
  symbol: string;
  tradingsymbol: string;
  broker: string;
  bucket: string;
  segment: string;
  exchange: string;
  optionType: string | null;
  strike: number | null;
  expiry: string | null;
  qty: number;
  entry: number; // for a short, the premium/price the position was OPENED at (sell)
  mtm: number;
  originalSl: number | null;
  trailingSl: number | null;
  target: number | null;
  daysHeld: number | null;
  dte: number | null;
  sector?: string | null; // from the instruments master (P1.3)
  side?: "long" | "short"; // default "long"
  impliedVol?: number | null; // user-entered IV % for option Greeks; null = use a flat default
  spot?: number | null; // underlying spot (for options, distinct from mtm which is the premium)
}

export interface ExposurePosition extends ExposureInput {
  invested: number;
  currentValue: number;
  unrealised: number;
  returnPct: number; // vs invested
  allocPct: number; // invested / capital
  runningImpactPct: number; // unrealised / capital
  effectiveStop: number | null; // trailingSl ?? originalSl
  hasStop: boolean;
  openRiskAmt: number | null; // give-back if stopped (sign-adjusted for side)
  openRiskPct: number | null;
  initialRiskAmt: number | null; // risk taken at entry (sign-adjusted for side)
  initialRiskPct: number | null;
  capitalAtRiskAmt: number; // loss below cost if stopped (sign-adjusted for side)
  capitalAtRiskPct: number;
  rr: number | null; // reward:risk (ratio is direction-invariant; see computeExposure)
  toTargetPct: number | null; // move still needed toward target (positive = not there yet)
}

export type RiskLevel = "low" | "medium" | "high";

export interface ExposureSummary {
  capital: number;
  count: number;
  invested: number;
  unrealised: number;
  allocatedPct: number;
  openPnlPct: number;
  openRiskPct: number; // Σ open risk @ SL (only stopped positions)
  initialRiskPct: number;
  capitalAtRiskPct: number;
  unstoppedCount: number;
  riskLevel: RiskLevel;
  positions: ExposurePosition[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Sector concentration (P1.3) — aggregate invested capital by sector to expose
// over-concentration the per-symbol alloc can hide (e.g. five small Bank names
// = one big sector bet). Positions with no mapped sector roll into "Unclassified".
// ---------------------------------------------------------------------------

export interface SectorSlice {
  sector: string;
  invested: number;
  allocPct: number; // invested / capital
  sharePct: number; // invested / total invested
  positions: number;
}

export interface SectorConcentration {
  capital: number;
  totalInvested: number;
  slices: SectorSlice[]; // sorted desc by invested
  topSector: string | null;
  topAllocPct: number; // largest sector as % of capital
  hhi: number; // Herfindahl index over sector shares (0..1); higher = more concentrated
  classifiedPct: number; // % of invested that carries a known sector
}

export function sectorConcentration(
  positions: { invested: number; sector?: string | null }[],
  capital: number,
): SectorConcentration {
  const cap = capital > 0 ? capital : 1;
  const bySector = new Map<string, { invested: number; positions: number }>();
  let totalInvested = 0;
  let classified = 0;
  for (const p of positions) {
    const inv = p.invested > 0 ? p.invested : 0;
    if (inv <= 0) continue;
    const sector = (p.sector ?? "").trim() || "Unclassified";
    if (sector !== "Unclassified") classified += inv;
    totalInvested += inv;
    const cur = bySector.get(sector) ?? { invested: 0, positions: 0 };
    cur.invested += inv;
    cur.positions += 1;
    bySector.set(sector, cur);
  }

  const slices: SectorSlice[] = [...bySector.entries()]
    .map(([sector, v]) => ({
      sector,
      invested: r2(v.invested),
      allocPct: r2((v.invested / cap) * 100),
      sharePct: totalInvested > 0 ? r2((v.invested / totalInvested) * 100) : 0,
      positions: v.positions,
    }))
    .sort((a, b) => b.invested - a.invested);

  // HHI over sector shares of total invested (sum of squared fractions).
  const hhi = totalInvested > 0
    ? r2([...bySector.values()].reduce((s, v) => s + Math.pow(v.invested / totalInvested, 2), 0) * 10000) / 10000
    : 0;

  return {
    capital: cap,
    totalInvested: r2(totalInvested),
    slices,
    topSector: slices[0]?.sector ?? null,
    topAllocPct: slices[0]?.allocPct ?? 0,
    hhi,
    classifiedPct: totalInvested > 0 ? r2((classified / totalInvested) * 100) : 0,
  };
}

export function computeExposure(inputs: ExposureInput[], capital: number): ExposureSummary {
  const cap = capital > 0 ? capital : 1;
  const positions: ExposurePosition[] = inputs.map((p) => {
    // sign flips every P&L-direction formula for a short (profit as price falls).
    // rr is a RATIO of two such differences, so the sign cancels — only its
    // validity guard (is the stop on the correct side of entry?) needs it.
    const sign = (p.side ?? "long") === "long" ? 1 : -1;
    const invested = p.qty * p.entry;
    const currentValue = p.qty * p.mtm;
    const unrealised = (p.mtm - p.entry) * p.qty * sign;
    const effectiveStop = p.trailingSl ?? p.originalSl ?? null;
    const hasStop = effectiveStop != null;
    const openRiskAmt = hasStop ? (p.mtm - (effectiveStop as number)) * p.qty * sign : null;
    const initialRiskAmt = p.originalSl != null ? (p.entry - p.originalSl) * p.qty * sign : null;
    const capitalAtRiskAmt = hasStop ? Math.max(0, (p.entry - (effectiveStop as number)) * p.qty * sign) : invested;
    const rr =
      p.target != null && p.originalSl != null && (p.entry - p.originalSl) * sign > 0
        ? (p.target - p.entry) / (p.entry - p.originalSl)
        : null;
    return {
      ...p,
      invested: r2(invested),
      currentValue: r2(currentValue),
      unrealised: r2(unrealised),
      returnPct: invested > 0 ? r2((unrealised / invested) * 100) : 0,
      allocPct: r2((invested / cap) * 100),
      runningImpactPct: r2((unrealised / cap) * 100),
      effectiveStop,
      hasStop,
      openRiskAmt: openRiskAmt == null ? null : r2(openRiskAmt),
      openRiskPct: openRiskAmt == null ? null : r2((openRiskAmt / cap) * 100),
      initialRiskAmt: initialRiskAmt == null ? null : r2(initialRiskAmt),
      initialRiskPct: initialRiskAmt == null ? null : r2((initialRiskAmt / cap) * 100),
      capitalAtRiskAmt: r2(capitalAtRiskAmt),
      capitalAtRiskPct: r2((capitalAtRiskAmt / cap) * 100),
      rr: rr == null ? null : r2(rr),
      toTargetPct: p.target != null && p.mtm > 0 ? r2(((p.target - p.mtm) / p.mtm) * 100 * sign) : null,
    };
  });

  const sum = (f: (p: ExposurePosition) => number) => positions.reduce((s, p) => s + f(p), 0);
  const invested = sum((p) => p.invested);
  const unrealised = sum((p) => p.unrealised);
  const allocatedPct = r2(sum((p) => p.allocPct));
  const openPnlPct = r2(sum((p) => p.runningImpactPct));
  const openRiskPct = r2(sum((p) => p.openRiskPct ?? 0));
  const initialRiskPct = r2(sum((p) => p.initialRiskPct ?? 0));
  const capitalAtRiskPct = r2(sum((p) => p.capitalAtRiskPct));
  const unstoppedCount = positions.filter((p) => !p.hasStop).length;

  // Heat = real capital at risk below cost. Unstopped positions raise the floor.
  let riskLevel: RiskLevel = "low";
  if (capitalAtRiskPct > 5 || unstoppedCount >= 3) riskLevel = "high";
  else if (capitalAtRiskPct > 2 || unstoppedCount > 0) riskLevel = "medium";

  return {
    capital: cap,
    count: positions.length,
    invested: r2(invested),
    unrealised: r2(unrealised),
    allocatedPct,
    openPnlPct,
    openRiskPct,
    initialRiskPct,
    capitalAtRiskPct,
    unstoppedCount,
    riskLevel,
    positions,
  };
}
