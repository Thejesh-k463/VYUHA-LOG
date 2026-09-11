// IND-10 — Option strategy recognition + payoff diagrams (PURE, no DB/React).
//
// Groups open legs by UNDERLYING (v4.3: no longer by underlying+expiry, so a
// calendar or diagonal can be seen at all), names the strategy from the data
// catalogue in ./strategy-catalogue.ts, and computes the EXACT expiry payoff:
// net debit/credit, max profit, max loss, breakevens and the payoff curve.
// Payoff at expiry is model-free (intrinsic value only) — no IV or pricing model
// needed. (Live Greeks need an IV feed; out of scope here.)
//
// Three things worth knowing before editing:
//
//  * **Normalisation is for MATCHING ONLY.** `normaliseLegs` collapses duplicate
//    contracts, nets off opposing ones and divides quantities by their GCD so a
//    real 2:4 matches a 1:2 pattern. The payoff, the net premium and the legs on
//    the card are always computed from the RAW legs — netting a long 3 @ ₹5
//    against a short 1 @ ₹7 would throw away ₹7 of real cash flow.
//  * **`maxProfit: null` means UNBOUNDED and nothing else.** A figure §7 of the
//    research note calls model-dependent (the multi-expiry case) is flagged on
//    the separate `notComputed` discriminator, with the numeric value left as
//    computed. Overloading null would make "unbounded" and "we don't know" the
//    same value on screen.
//  * **Accepted limitation (research note §8 Q3).** Grouping by symbol means two
//    UNRELATED single-expiry positions can accidentally read as a real
//    multi-expiry shape — a September long call plus an October short call is a
//    diagonal by every structural test there is. `buildStrategies` splits per
//    expiry only when the whole-symbol read FAILS to match, so this case is named
//    as one strategy. That is deliberate; it is not a bug to fix.

import {
  CATALOGUE,
  strategyName,
  type LegKind,
  type LegPattern,
  type LegSide,
  type StrategyDef,
  type StrategyId,
} from "./strategy-catalogue";

export type { LegKind, LegSide, StrategyDef, StrategyId } from "./strategy-catalogue";

interface OptionLegBase {
  id?: number;
  strike: number;
  side: LegSide;
  qty: number; // contracts (shares = lots × lot size)
  premium: number; // entry premium per unit; for a UL leg, the entry PRICE per unit
  /** The leg's own expiry when it has one. Additive — a leg built before v4.3
   *  carries none and inherits the group's expiry. */
  expiry?: string | null;
}

/** An option leg, or (v4.3) the underlying itself. `kind` is the field to read;
 *  `optionType` is still honoured for every caller that predates it, and at least
 *  one of the two is always present. */
export type OptionLeg = OptionLegBase &
  ({ kind: LegKind; optionType?: "CE" | "PE" } | { kind?: undefined; optionType: "CE" | "PE" });

/** "CE" | "PE" | "UL" for any leg, new-style or legacy. */
export function legKind(l: OptionLeg): LegKind {
  // The union guarantees one of the two is present; TS cannot see that through
  // a property access, hence the cast rather than a runtime default (a default
  // would silently price a UL leg as a call).
  return l.kind ?? (l.optionType as "CE" | "PE");
}

const legExpiry = (l: OptionLeg, groupExpiry: string | null): string | null =>
  l.expiry === undefined ? groupExpiry : l.expiry;

/** Sub-label for a capped figure (research note §6). */
export type CapLabel = "At expiry" | "Computed at underlying = 0" | "Unlimited" | "Not computed";

export interface StrategyGroup {
  key: string;
  symbol: string;
  /** The group's expiry when it has exactly one; null when it spans several. */
  expiry: string | null;
  name: string;
  legs: OptionLeg[];
  netPremium: number; // ₹ total; + = net credit received, − = net debit paid (a UL leg is real cash too)
  isCredit: boolean;
  maxProfit: number | null; // ₹ ; null = UNBOUNDED (never "not computed" — see notComputed)
  maxLoss: number | null; // ₹ (negative) ; null = UNBOUNDED
  breakevens: number[];
  payoff: { price: number; pnl: number }[];
  /** v4.3 seams. */
  strategyId: StrategyId | null;
  displayName: string;
  legacyFree: boolean;
  expiries: string[]; // ascending, option legs only
  nearestExpiry: string | null;
  capLabel: { maxProfit: CapLabel; maxLoss: CapLabel };
  /** true = the figure is model-dependent at this expiry and must not be printed
   *  (research note §7). Independent of the value, which stays as computed. */
  notComputed: { maxProfit: boolean; maxLoss: boolean };
  ulLegs: OptionLeg[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Total P&L of the position if the underlying settles at price S at expiry. */
export function payoffAt(legs: OptionLeg[], S: number): number {
  let pnl = 0;
  for (const l of legs) {
    const kind = legKind(l);
    // A UL leg is worth S itself, so the same long/short arithmetic carries over
    // with `premium` as its entry price (research note §5.4).
    const intrinsic =
      kind === "UL" ? S : kind === "CE" ? Math.max(S - l.strike, 0) : Math.max(l.strike - S, 0);
    const per = l.side === "long" ? intrinsic - l.premium : l.premium - intrinsic;
    pnl += per * l.qty;
  }
  return pnl;
}

/** Net premium: credit (+) when you collect more than you pay. */
export function netPremium(legs: OptionLeg[]): number {
  return legs.reduce((s, l) => s + (l.side === "short" ? l.premium : -l.premium) * l.qty, 0);
}

// ── Normalisation + matching (research note §5.3) ────────────────────────────

export interface NormalisedLeg {
  kind: LegKind;
  side: LegSide;
  strike: number | null; // null = UL
  expiry: string | null;
  qtyRatio: number;
  strikeRank: number | null;
  expiryRank: number;
}

const KIND_ORDER: Record<LegKind, number> = { UL: 0, CE: 1, PE: 2 };
const SIDE_ORDER: Record<LegSide, number> = { long: 0, short: 1 };

const cmpKey = (
  a: { expiryRank: number; strikeRank: number | null; kind: LegKind; side: LegSide },
  b: { expiryRank: number; strikeRank: number | null; kind: LegKind; side: LegSide },
) =>
  a.expiryRank - b.expiryRank ||
  (a.strikeRank ?? -1) - (b.strikeRank ?? -1) ||
  KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
  SIDE_ORDER[a.side] - SIDE_ORDER[b.side];

const gcd2 = (a: number, b: number): number => (b === 0 ? a : gcd2(b, a % b));

/**
 * Normalise a leg set for matching: collapse duplicates, net off opposites,
 * reduce quantities by their GCD, rank strikes and expiries, sort deterministically.
 * Never used for money — see the header.
 */
export function normaliseLegs(legs: OptionLeg[], groupExpiry: string | null = null): NormalisedLeg[] {
  // (a) + (b): one bucket per distinct contract, quantity signed (long +, short −).
  // Collapsing duplicates and netting opposites are the same operation.
  const buckets = new Map<string, { kind: LegKind; strike: number | null; expiry: string | null; qty: number }>();
  for (const l of legs) {
    const kind = legKind(l);
    // A UL leg has no strike, and its expiry (a future's) is not the group's.
    const strike = kind === "UL" ? null : l.strike;
    const expiry = kind === "UL" ? null : legExpiry(l, groupExpiry);
    const key = `${kind}|${strike ?? "-"}|${expiry ?? "-"}`;
    const cur = buckets.get(key) ?? { kind, strike, expiry, qty: 0 };
    cur.qty += (l.side === "long" ? 1 : -1) * l.qty;
    buckets.set(key, cur);
  }
  const rows = [...buckets.values()].filter((b) => b.qty !== 0);
  if (rows.length === 0) return [];

  // (c) quantities → ratios. Non-integer quantities have no GCD; leave them alone.
  const qtys = rows.map((r) => Math.abs(r.qty));
  const div = qtys.every((q) => Number.isInteger(q)) ? qtys.reduce((a, b) => gcd2(a, b)) || 1 : 1;

  const strikes = [...new Set(rows.filter((r) => r.strike !== null).map((r) => r.strike as number))].sort(
    (a, b) => a - b,
  );
  const expiries = [...new Set(rows.filter((r) => r.expiry !== null).map((r) => r.expiry as string))].sort();

  return rows
    .map((r) => ({
      kind: r.kind,
      side: (r.qty > 0 ? "long" : "short") as LegSide,
      strike: r.strike,
      expiry: r.expiry,
      qtyRatio: Math.abs(r.qty) / div,
      strikeRank: r.strike === null ? null : strikes.indexOf(r.strike),
      expiryRank: r.expiry === null ? 0 : expiries.indexOf(r.expiry),
    }))
    .sort(cmpKey);
}

export interface StrategyMatch {
  id: StrategyId;
  def: StrategyDef;
  variant: string | null;
  name: string;
  legacyFree: boolean;
}

interface Candidate {
  def: StrategyDef;
  variant: string | null;
  legs: LegPattern[];
  specificity: number;
}

// Most specific first; Array#sort is stable, so equal specificities keep
// catalogue order and the answer never depends on iteration luck.
const CANDIDATES: Candidate[] = CATALOGUE.flatMap((def) =>
  def.patterns.map((p) => ({
    def,
    variant: p.variant ?? null,
    legs: [...p.legs].sort(cmpKey),
    specificity: p.specificity ?? p.legs.length * 10,
  })),
).sort((a, b) => b.specificity - a.specificity);

/** Name a leg set from the catalogue, or null when nothing matches. */
export function matchStrategy(legs: OptionLeg[], groupExpiry: string | null = null): StrategyMatch | null {
  const norm = normaliseLegs(legs, groupExpiry);
  if (norm.length === 0) return null;
  for (const c of CANDIDATES) {
    if (c.legs.length !== norm.length) continue;
    let ok = true;
    for (let i = 0; i < norm.length; i++) {
      const p = c.legs[i];
      const n = norm[i];
      if (
        p.kind !== n.kind ||
        p.side !== n.side ||
        p.strikeRank !== n.strikeRank ||
        p.expiryRank !== n.expiryRank ||
        p.qtyRatio !== n.qtyRatio
      ) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return {
        id: c.def.id,
        def: c.def,
        variant: c.variant,
        name: strategyName(c.def, c.variant),
        legacyFree: c.def.legacyFree,
      };
    }
  }
  return null;
}

export function classifyStrategy(legs: OptionLeg[], groupExpiry: string | null = null): string {
  if (legs.length === 0) return "Empty";
  const match = matchStrategy(legs, groupExpiry);
  if (match) return match.name;
  const n = normaliseLegs(legs, groupExpiry).length || legs.length;
  return `Custom (${n} legs)`;
}

// ── Payoff ───────────────────────────────────────────────────────────────────

/**
 * True when an underlying FUTURE settles before the LAST option leg does (R104).
 * After it settles the option legs stand alone, so both figures at the later
 * expiry depend on where the future settled — not a number the journal can
 * state. A cash holding (`expiry: null`) never expires. Shared with the card's
 * note (strategy-copy.ts) so the flag and the sentence cannot disagree.
 */
export function underlyingExpiresFirst(ulLegs: readonly OptionLeg[], expiries: readonly string[]): boolean {
  const latest = expiries[expiries.length - 1];
  return !!latest && ulLegs.some((l) => !!l.expiry && l.expiry < latest);
}

export function computeStrategy(
  symbol: string,
  expiry: string | null,
  legs: OptionLeg[],
  key?: string,
): StrategyGroup {
  const ulLegs = legs.filter((l) => legKind(l) === "UL");
  const optionLegs = legs.filter((l) => legKind(l) !== "UL");
  const strikes = [...new Set(optionLegs.map((l) => l.strike))].sort((a, b) => a - b);
  const expiries = [
    ...new Set(optionLegs.map((l) => legExpiry(l, expiry)).filter((e): e is string => !!e)),
  ].sort();
  const nearestExpiry = expiries[0] ?? null;

  // Chart range: strikes, plus any underlying entry price so S0 is on screen.
  const levels = [...strikes, ...ulLegs.map((l) => l.premium)];
  const minK = levels.length ? Math.min(...levels) : 0;
  const maxK = levels.length ? Math.max(...levels) : 0;
  const pad = Math.max((maxK - minK) * 0.6, maxK * 0.15, 50);
  const cLo = Math.max(0, minK - pad);
  const cHi = maxK + pad;

  // Net slope as S→∞ decides upside boundedness: calls AND the underlying gain
  // linearly above every strike, puts are flat there. Downside is bounded at S=0.
  const upSlope = legs.reduce((s, l) => {
    if (legKind(l) === "PE") return s;
    return s + (l.side === "long" ? l.qty : -l.qty);
  }, 0);

  // Analytic vertices (payoff is piecewise-linear with kinks at strikes).
  const vertices = [0, ...strikes, cHi].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
  const vy = vertices.map((p) => ({ price: p, pnl: payoffAt(legs, p) }));

  const finiteMax = Math.max(...vy.map((v) => v.pnl));
  const finiteMin = Math.min(...vy.map((v) => v.pnl));
  const maxProfit = upSlope > 0 ? null : r2(finiteMax);
  const maxLoss = upSlope < 0 ? null : r2(finiteMin);

  // Is the bounded figure reached ONLY at S = 0? That is the §6 labelling case
  // (a long put's "max profit" is a price floor, not a forecast). A flat payoff
  // — a box — is reached everywhere and stays "At expiry".
  const rest = vy.slice(1).map((v) => v.pnl);
  const maxAtZeroOnly = rest.length > 0 && vy[0].pnl > Math.max(...rest) + 1e-9;
  const minAtZeroOnly = rest.length > 0 && vy[0].pnl < Math.min(...rest) - 1e-9;

  // Breakevens: zero-crossings across the analytic vertices.
  // R69: a vertex P&L under half a paisa IS zero. A 100/110 call spread bought
  // for exactly its width is 0 at 110 in arithmetic and ±1e-13 in floats, and
  // the old `<= 0 / > 0` test listed 110 or nothing depending on that residue.
  const breakevens: number[] = [];
  const snapped = vy.map((v) => (Math.abs(v.pnl) < 0.005 ? 0 : v.pnl));
  for (let i = 0; i < vy.length; i++) {
    // A vertex ON zero is a breakeven when the payoff leaves zero on either
    // side of it; a zero span between two strikes therefore lists both ends
    // (decided, R69). Vertex 0 and the strikes only: `cHi` is the chart's
    // edge, and a crossing there belongs to the analytic rescue (R4-M-1).
    const onZero =
      snapped[i] === 0 &&
      vy[i].price !== cHi &&
      ((i > 0 && snapped[i - 1] !== 0) || (i + 1 < vy.length && snapped[i + 1] !== 0));
    if (onZero) breakevens.push(r2(vy[i].price));
    if (i + 1 >= vy.length) continue;
    // Strictly across zero: a vertex ON zero is the branch above's, listed once.
    const a = vy[i];
    const b = vy[i + 1];
    if ((snapped[i] < 0 && snapped[i + 1] > 0) || (snapped[i] > 0 && snapped[i + 1] < 0)) {
      const be = a.price + ((b.price - a.price) * (0 - a.pnl)) / (b.pnl - a.pnl);
      if (Number.isFinite(be)) breakevens.push(r2(be));
    }
  }

  // ...and the crossing those vertices CANNOT see. Above the highest strike the
  // payoff is a straight line of slope `upSlope`, and that line can cross zero
  // far beyond the chart's right edge: a 20000 CE bought at 4,000 breaks even at
  // 24,000, well past maxK + pad. Scanning the vertices alone dropped it and the
  // card printed a blank, which invariant 6 reserves for "no breakeven exists".
  // The LOWER side needs no such rescue: vertex 0 is always in the list and the
  // underlying cannot settle below it, so a crossing under the lowest strike is
  // inside the scan by construction.
  // Units: `payoffAt` is total rupees and `upSlope` is total rupees per price
  // unit, so the quotient is a price.
  const pnlAtMaxK = payoffAt(legs, maxK);
  if ((pnlAtMaxK < 0 && upSlope > 0) || (pnlAtMaxK > 0 && upSlope < 0)) {
    const be = r2(maxK - pnlAtMaxK / upSlope);
    // ONLY when the crossing is at or beyond the chart's right edge (R4-M-1).
    // `cHi` is itself a vertex and the payoff is a straight line from the top
    // strike to it, so every crossing strictly below `cHi` is the scan's by
    // construction — and the two paths reach it by different float routes, so a
    // crossing on an `x.xx5` boundary rounds to neighbouring paise and got
    // listed TWICE (a 0.005 de-duplication cannot see a 0.01 gap, and widening
    // it would swallow two genuine crossings a paisa apart). The guard is `>=`,
    // not `>`: the scan never lists `cHi` itself (R69 excludes it), so
    // a crossing landing exactly on `cHi` is the analytic value's alone. `r2`
    // moves a value by at most 0.005, which is exactly the slack allowed here.
    if (Number.isFinite(be) && be > maxK && be >= cHi - 0.005) {
      breakevens.push(be);
    }
  }

  // Chart series: evenly sampled across a focused range (exact since piecewise-linear).
  // On a multi-expiry group this is research-note §7 option A — the curve is drawn
  // at the NEAREST expiry with the far legs at intrinsic, which understates a long
  // far leg and overstates a short one.
  // Show that crossing: when a breakeven landed beyond the right edge, the chart
  // stretches just past it. ONLY then -- a group whose breakevens already sat
  // inside the range keeps its exact grid, and so do its goldens. The vertices
  // above are deliberately NOT extended: max profit / max loss are read off them
  // and must not move because the picture got wider.
  const maxBe = breakevens.length ? Math.max(...breakevens) : 0;
  const chartHi = maxBe > cHi ? maxBe * 1.05 : cHi;

  const N = 61;
  const payoff = Array.from({ length: N }, (_, i) => {
    const price = cLo + ((chartHi - cLo) * i) / (N - 1);
    return { price: r2(price), pnl: r2(payoffAt(legs, price)) };
  });

  // §7: which tiles are model-dependent. Max loss survives when every far leg is
  // long — the position cannot lose more than the net debit.
  const multiExpiry = expiries.length > 1;
  const farLegsAllLong = optionLegs
    .filter((l) => legExpiry(l, expiry) !== nearestExpiry)
    .every((l) => l.side === "long");
  // R104: a future under the book that settles before the last option leg
  // leaves that leg standing alone, so neither figure at its expiry is printed.
  const ulFirst = underlyingExpiresFirst(ulLegs, expiries);
  const notComputed = {
    maxProfit: multiExpiry || ulFirst,
    maxLoss: (multiExpiry && !farLegsAllLong) || ulFirst,
  };

  const label = (nc: boolean, v: number | null, atZeroOnly: boolean): CapLabel =>
    nc ? "Not computed" : v === null ? "Unlimited" : atZeroOnly ? "Computed at underlying = 0" : "At expiry";

  const match = matchStrategy(legs, expiry);
  const name = match ? match.name : `Custom (${normaliseLegs(legs, expiry).length || legs.length} legs)`;
  const np = netPremium(legs);
  return {
    key: key ?? `${symbol}|${expiry ?? "—"}`,
    symbol,
    expiry: expiries.length === 1 ? expiries[0] : expiries.length === 0 ? expiry : null,
    name,
    legs,
    netPremium: r2(np),
    isCredit: np > 0,
    maxProfit,
    maxLoss,
    breakevens: [...new Set(breakevens)],
    payoff,
    strategyId: match?.id ?? null,
    displayName: name,
    legacyFree: match?.legacyFree ?? false,
    expiries,
    nearestExpiry,
    capLabel: {
      maxProfit: label(notComputed.maxProfit, maxProfit, maxAtZeroOnly),
      maxLoss: label(notComputed.maxLoss, maxLoss, minAtZeroOnly),
    },
    notComputed,
    ulLegs,
  };
}

/** R102: a sub-group states an UNBOUNDED figure where the whole book states a bound. */
const splitContradictsWhole = (whole: StrategyGroup, subs: readonly StrategyGroup[]): boolean =>
  (whole.maxLoss !== null && subs.some((s) => s.maxLoss === null)) ||
  (whole.maxProfit !== null && subs.some((s) => s.maxProfit === null));

export type PositionedLeg = OptionLeg & {
  symbol: string;
  expiry: string | null;
};

/**
 * Group legs by UNDERLYING and build a strategy per group.
 *
 * The whole symbol is read first (that is the only way a calendar or a diagonal
 * can be named at all). If that read lands on `Custom (n legs)` and the symbol
 * holds more than one expiry, it falls back to per-expiry sub-groups and names
 * each half — research note §8 Q3, so a trader holding an unrelated September
 * spread and October put still sees two named cards instead of one Custom.
 */
export function buildStrategies(legs: PositionedLeg[]): StrategyGroup[] {
  const groups = new Map<string, PositionedLeg[]>();
  for (const l of legs) {
    const arr = groups.get(l.symbol) ?? [];
    arr.push(l);
    groups.set(l.symbol, arr);
  }

  const out: StrategyGroup[] = [];
  for (const [symbol, own] of groups) {
    const whole = computeStrategy(symbol, null, own, symbol);
    if (whole.strategyId !== null || whole.expiries.length < 2) {
      out.push(whole);
      continue;
    }
    const byExpiry = new Map<string, PositionedLeg[]>();
    for (const l of own) {
      // A UL leg has no expiry of its own; park it on the nearest so it is
      // counted once rather than repeated on every sub-group.
      const e = legKind(l) === "UL" || !l.expiry ? (whole.nearestExpiry as string) : l.expiry;
      const arr = byExpiry.get(e) ?? [];
      arr.push(l);
      byExpiry.set(e, arr);
    }
    const subs = [...byExpiry.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([e, sub]) => computeStrategy(symbol, e, sub, `${symbol}|${e}`));
    // R102: parking the underlying on the nearest expiry leaves a far short
    // call alone on its own card, reading "Unlimited" while the whole book is
    // covered. When the book holds an underlying, a split that states an
    // unbounded figure the whole contradicts is refused. Option-only splits
    // are ruling 240's and unchanged here.
    if (own.some((l) => legKind(l) === "UL") && splitContradictsWhole(whole, subs)) {
      out.push(whole);
      continue;
    }
    out.push(...subs);
  }

  return out.sort(
    (a, b) =>
      (a.nearestExpiry ?? "").localeCompare(b.nearestExpiry ?? "") || a.symbol.localeCompare(b.symbol),
  );
}
