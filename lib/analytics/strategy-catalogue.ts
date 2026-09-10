// v4.3.0 — the option strategy catalogue as DATA (PURE: no DB, no React — AGENTS.md invariant 2).
//
// 40 rows = rows 1–37 + 39 + 40 + 41 of §4 in
// VYUHA-LIVE-DESK-RESEARCH/13-OPTION-STRATEGY-CATALOGUE.md.
// Row 38 (covered strangle) and row 42 (ladders) are deliberately NOT here.
//
// Three rules this file keeps, each one a way to ship a wrong name silently:
//
//  1. **Every row is written out literally.** §5.3 suggested generating the
//     sign-inverted twin of each row with an `invert()` helper; we do not. A
//     generated row is a row nobody read, and the twins that matter (bull vs
//     bear vertical, long vs short straddle) differ in NAME, tier and audience,
//     not only in sign.
//  2. **`id` is frozen kebab-case, one per §4 row, and is never renamed.** It is
//     the join key for the help registry, the shelf and any stored preference.
//     `STRATEGY_IDS` is the exported tuple; a test asserts it is 1:1 with
//     `CATALOGUE` and with the help registry.
//  3. **A §4 line that covers more than one leg shape carries more than one
//     `patterns` entry**, each with a `variant` label and (where it reads
//     better) its own display `name` — short butterfly (call/put), strip/strap,
//     guts (long/short), the diagonal (call/put × which side is nearer) and the
//     split-strike combo (synthetic long/short × which strike is higher).
//
// `style` is the FIRST audience §4 lists for the row, with "beginner" lifted out
// into its own flag (beginner = true for §4 rows 1, 2, 5, 6 and 10 only).
//
// `maxProfit`, `maxLoss` and `breakevens` are the §4 closed forms as STRINGS:
// documentation, and the cross-check in tests/strategy-catalogue.test.ts. They
// are never the computation — the figures on screen come from exact evaluation
// at the analytic vertices in lib/analytics/strategies.ts, which is right for
// every shape including the ones nobody has named. Notation is §4's:
// K1 < K2 < K3 < K4 are the distinct strikes ascending, p a single leg's premium
// PER UNIT, N the position's net premium in rupees (credit positive), n = N/qty,
// S0 the underlying entry price, W the width between adjacent strikes.

/** What kind of instrument a leg is. "UL" = the underlying itself (equity or future). */
export type LegKind = "CE" | "PE" | "UL";
export type LegSide = "long" | "short";

export interface LegPattern {
  kind: LegKind;
  /** Rank of this leg's strike among the DISTINCT strikes of the group, ascending
   *  from 0. Two legs sharing a rank must share a strike. `null` = no strike (UL). */
  strikeRank: number | null;
  /** Rank of this leg's expiry among the DISTINCT OPTION expiries, ascending from
   *  0. 0 for every leg of a single-expiry strategy, and 0 for a UL leg always —
   *  a share has no expiry and a future's is not the group's. */
  expiryRank: number;
  side: LegSide;
  /** Quantity RATIO, not an absolute. A group's quantities are divided by their
   *  GCD before matching, so a real 2:4 matches a 1:2 pattern. */
  qtyRatio: number;
}

export interface PatternVariant {
  /** Label for a row whose §4 line covers more than one shape; undefined when the
   *  row has exactly one. */
  variant?: string;
  /** Display name for this variant. Falls back to `StrategyDef.name`. */
  name?: string;
  legs: LegPattern[];
  /** Higher wins when two patterns both match. Default = legs.length * 10 (§5.3). */
  specificity?: number;
}

export type NetPremium = "debit" | "credit" | "either";
export type StrategyStyle = "directional" | "income" | "hedging" | "volatility" | "arbitrage";
export type StrategyTier = "core" | "next" | "later";

export interface StrategyDef {
  /** Frozen, kebab-case, never renamed. */
  id: StrategyId;
  /** Display name. For a `legacyFree` row this string is BYTE-IDENTICAL to the one
   *  the pre-v4.3 if-chain printed — casing drift silently re-gates a free strategy. */
  name: string;
  style: StrategyStyle;
  beginner: boolean;
  tier: StrategyTier;
  net: NetPremium;
  patterns: PatternVariant[];
  /** §4 closed form — documentation and cross-check only. `unbounded` = no cap. */
  maxProfit: string;
  maxLoss: string;
  breakevens: string;
  sources: string;
  /** true = a shape the pre-v4.3 if-chain already named, so it was never gated and
   *  must not become gated. Exactly 16 rows carry it. */
  legacyFree: boolean;
}

/** The frozen id list, in catalogue order. Imported by the help registry and the shelf. */
export const STRATEGY_IDS = [
  "long-call",
  "long-put",
  "short-call",
  "short-put",
  "covered-call",
  "protective-put",
  "protective-call",
  "covered-put",
  "collar",
  "bull-call-spread",
  "bear-call-spread",
  "bull-put-spread",
  "bear-put-spread",
  "long-straddle",
  "short-straddle",
  "long-strangle",
  "short-strangle",
  "iron-condor",
  "iron-butterfly",
  "long-call-butterfly",
  "long-put-butterfly",
  "short-butterfly",
  "long-call-condor",
  "short-call-condor",
  "long-put-condor",
  "reverse-iron-condor",
  "call-ratio-spread",
  "put-ratio-spread",
  "call-backspread",
  "put-backspread",
  "call-calendar-spread",
  "put-calendar-spread",
  "diagonal-spread",
  "synthetic-long-stock",
  "synthetic-short-stock",
  "split-strike-combo",
  "box-spread",
  "jade-lizard",
  "strip-strap",
  "guts",
] as const;

export type StrategyId = (typeof STRATEGY_IDS)[number];

export const CATALOGUE: readonly StrategyDef[] = [
  // §4 row 1
  {
    id: "long-call",
    name: "Long Call",
    style: "directional",
    beginner: true,
    tier: "core",
    net: "debit",
    patterns: [{ legs: [{ kind: "CE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 1 }] }],
    maxProfit: "unbounded",
    maxLoss: "debit",
    breakevens: "K1 + p",
    sources: "OIC, NSE#1, Nat 2, McM 3, Lean, optopsy, OSL, qb, Meridian",
    legacyFree: true,
  },
  // §4 row 2
  {
    id: "long-put",
    name: "Long Put",
    style: "directional",
    beginner: true,
    tier: "core",
    net: "debit",
    patterns: [{ legs: [{ kind: "PE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 1 }] }],
    maxProfit: "(K1 − p) × qty at S = 0",
    maxLoss: "debit",
    breakevens: "K1 − p",
    sources: "OIC, NSE#4, Nat 2, Lean, optopsy, OSL, qb, Meridian",
    legacyFree: true,
  },
  // §4 row 3
  {
    id: "short-call",
    name: "Short Call",
    style: "income",
    beginner: false,
    tier: "core",
    net: "credit",
    patterns: [{ legs: [{ kind: "CE", strikeRank: 0, expiryRank: 0, side: "short", qtyRatio: 1 }] }],
    maxProfit: "credit",
    maxLoss: "unbounded",
    breakevens: "K1 + p",
    sources: "OIC, NSE#2, McM 5, Lean (\"Naked Call\"), optopsy, OSL",
    legacyFree: true,
  },
  // §4 row 4
  {
    id: "short-put",
    name: "Short Put",
    style: "income",
    beginner: false,
    tier: "core",
    net: "credit",
    patterns: [{ legs: [{ kind: "PE", strikeRank: 0, expiryRank: 0, side: "short", qtyRatio: 1 }] }],
    maxProfit: "credit",
    maxLoss: "(K1 − p) × qty at S = 0",
    breakevens: "K1 − p",
    sources: "OIC, NSE#5, Lean, optopsy (\"cash_secured_put\"), OSL",
    legacyFree: true,
  },
  // §4 row 5
  {
    id: "covered-call",
    name: "Covered Call",
    style: "income",
    beginner: true,
    tier: "later",
    net: "credit",
    patterns: [
      {
        legs: [
          { kind: "UL", strikeRank: null, expiryRank: 0, side: "long", qtyRatio: 1 },
          { kind: "CE", strikeRank: 0, expiryRank: 0, side: "short", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "(K1 − S0) × qty + credit",
    maxLoss: "(S0 × qty) − credit at S = 0",
    breakevens: "S0 − p",
    sources: "OIC, NSE#6, McM 2, Lean, optopsy, OSL",
    legacyFree: false,
  },
  // §4 row 6
  {
    id: "protective-put",
    name: "Protective Put",
    style: "hedging",
    beginner: true,
    tier: "later",
    net: "debit",
    patterns: [
      {
        legs: [
          { kind: "UL", strikeRank: null, expiryRank: 0, side: "long", qtyRatio: 1 },
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "unbounded",
    maxLoss: "(S0 − K1) × qty + debit",
    breakevens: "S0 + p",
    sources: "OIC, NSE#3 (\"Synthetic Long Call\"), Lean, optopsy, OSL",
    legacyFree: false,
  },
  // §4 row 7
  {
    id: "protective-call",
    name: "Protective Call",
    style: "hedging",
    beginner: false,
    tier: "later",
    net: "debit",
    patterns: [
      {
        legs: [
          { kind: "UL", strikeRank: null, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "CE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "(S0 × qty) − debit at S = 0",
    maxLoss: "(K1 − S0) × qty + debit",
    breakevens: "S0 − p",
    sources: "OIC (\"Synthetic Long Put\"), NSE#8, Lean",
    legacyFree: false,
  },
  // §4 row 8
  {
    id: "covered-put",
    name: "Covered Put",
    style: "income",
    beginner: false,
    tier: "later",
    net: "credit",
    patterns: [
      {
        legs: [
          { kind: "UL", strikeRank: null, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "short", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "(S0 − K1) × qty + credit",
    maxLoss: "unbounded",
    breakevens: "S0 + p",
    sources: "OIC, NSE#9, Lean",
    legacyFree: false,
  },
  // §4 row 9
  {
    id: "collar",
    name: "Collar",
    style: "hedging",
    beginner: false,
    tier: "later",
    net: "either",
    patterns: [
      {
        legs: [
          { kind: "UL", strikeRank: null, expiryRank: 0, side: "long", qtyRatio: 1 },
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 1 },
          { kind: "CE", strikeRank: 1, expiryRank: 0, side: "short", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "(K2 − S0) × qty − N",
    maxLoss: "(S0 − K1) × qty + N",
    breakevens: "S0 − n",
    sources: "OIC, NSE#14, Lean (\"Protective Collar\"), optopsy, OSL",
    legacyFree: false,
  },
  // §4 row 10
  {
    id: "bull-call-spread",
    name: "Bull Call Spread",
    style: "directional",
    beginner: true,
    tier: "core",
    net: "debit",
    patterns: [
      {
        legs: [
          { kind: "CE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 1 },
          { kind: "CE", strikeRank: 1, expiryRank: 0, side: "short", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "(K2 − K1) × qty − debit",
    maxLoss: "debit",
    breakevens: "K1 + debit/qty",
    sources: "OIC, NSE#15, CBOE, Nat 10, McM 7, Lean, optopsy, OSL, qb, Meridian",
    legacyFree: true,
  },
  // §4 row 11
  {
    id: "bear-call-spread",
    name: "Bear Call Spread",
    style: "income",
    beginner: false,
    tier: "core",
    net: "credit",
    patterns: [
      {
        legs: [
          { kind: "CE", strikeRank: 0, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "CE", strikeRank: 1, expiryRank: 0, side: "long", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "credit",
    maxLoss: "(K2 − K1) × qty − credit",
    breakevens: "K1 + credit/qty",
    sources: "OIC, NSE#17, Nat 10, McM 8, Lean, optopsy, OSL, qb, Meridian",
    legacyFree: true,
  },
  // §4 row 12
  {
    id: "bull-put-spread",
    name: "Bull Put Spread",
    style: "income",
    beginner: false,
    tier: "core",
    net: "credit",
    patterns: [
      {
        legs: [
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 1 },
          { kind: "PE", strikeRank: 1, expiryRank: 0, side: "short", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "credit",
    maxLoss: "(K2 − K1) × qty − credit",
    breakevens: "K2 − credit/qty",
    sources: "OIC, NSE#16, Nat 10, McM 22, Lean, optopsy, OSL, qb, Meridian",
    legacyFree: true,
  },
  // §4 row 13
  {
    id: "bear-put-spread",
    name: "Bear Put Spread",
    style: "directional",
    beginner: false,
    tier: "core",
    net: "debit",
    patterns: [
      {
        legs: [
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "PE", strikeRank: 1, expiryRank: 0, side: "long", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "(K2 − K1) × qty − debit",
    maxLoss: "debit",
    breakevens: "K2 − debit/qty",
    sources: "OIC, NSE#18, CBOE, Nat 10, McM 22, Lean, optopsy, OSL, qb, Meridian",
    legacyFree: true,
  },
  // §4 row 14
  {
    id: "long-straddle",
    name: "Long Straddle",
    style: "volatility",
    beginner: false,
    tier: "core",
    net: "debit",
    patterns: [
      {
        legs: [
          { kind: "CE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 1 },
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "unbounded up; (K1 − debit/qty) × qty down",
    maxLoss: "debit",
    breakevens: "K1 ± debit/qty",
    sources: "OIC, NSE#10, Nat 8, McM 18, Lean, optopsy, OSL, qb, Meridian",
    legacyFree: true,
  },
  // §4 row 15
  {
    id: "short-straddle",
    name: "Short Straddle",
    style: "income",
    beginner: false,
    tier: "core",
    net: "credit",
    patterns: [
      {
        legs: [
          { kind: "CE", strikeRank: 0, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "short", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "credit",
    maxLoss: "unbounded",
    breakevens: "K1 ± credit/qty",
    sources: "OIC, NSE#11, Nat 8, McM 20, Lean, optopsy, OSL, qb, Meridian",
    legacyFree: true,
  },
  // §4 row 16
  {
    id: "long-strangle",
    name: "Long Strangle",
    style: "volatility",
    beginner: false,
    tier: "core",
    net: "debit",
    patterns: [
      {
        legs: [
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 1 },
          { kind: "CE", strikeRank: 1, expiryRank: 0, side: "long", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "unbounded up; bounded down",
    maxLoss: "debit",
    breakevens: "K1 − debit/qty, K2 + debit/qty",
    sources: "OIC, NSE#12, Nat 8, McM 18, Lean, optopsy, OSL, qb, Meridian",
    legacyFree: true,
  },
  // §4 row 17
  {
    id: "short-strangle",
    name: "Short Strangle",
    style: "income",
    beginner: false,
    tier: "core",
    net: "credit",
    patterns: [
      {
        legs: [
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "CE", strikeRank: 1, expiryRank: 0, side: "short", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "credit",
    maxLoss: "unbounded",
    breakevens: "K1 − credit/qty, K2 + credit/qty",
    sources: "OIC, NSE#13, Nat 8, McM 20, Lean, optopsy, OSL, qb, Meridian",
    legacyFree: true,
  },
  // §4 row 18
  {
    id: "iron-condor",
    name: "Iron Condor",
    style: "income",
    beginner: false,
    tier: "core",
    net: "credit",
    patterns: [
      {
        legs: [
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 1 },
          { kind: "PE", strikeRank: 1, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "CE", strikeRank: 2, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "CE", strikeRank: 3, expiryRank: 0, side: "long", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "credit",
    maxLoss: "max(K2−K1, K4−K3) × qty − credit",
    breakevens: "K2 − credit/qty, K3 + credit/qty",
    sources: "OIC (\"Short Condor (Iron Condor)\"), CBOE, Nat 8, Lean, optopsy, OSL, Meridian",
    legacyFree: true,
  },
  // §4 row 19
  {
    id: "iron-butterfly",
    name: "Iron Butterfly",
    style: "income",
    beginner: false,
    tier: "core",
    net: "credit",
    patterns: [
      {
        legs: [
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 1 },
          { kind: "PE", strikeRank: 1, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "CE", strikeRank: 1, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "CE", strikeRank: 2, expiryRank: 0, side: "long", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "credit",
    maxLoss: "(K2 − K1) × qty − credit",
    breakevens: "K2 ± credit/qty",
    sources: "OIC (\"Short Iron Butterfly\"), Nat 8, Lean, optopsy, OSL, Meridian",
    legacyFree: true,
  },
  // §4 row 20
  {
    id: "long-call-butterfly",
    name: "Call Butterfly",
    style: "volatility",
    beginner: false,
    tier: "core",
    net: "debit",
    patterns: [
      {
        legs: [
          { kind: "CE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 1 },
          { kind: "CE", strikeRank: 1, expiryRank: 0, side: "short", qtyRatio: 2 },
          { kind: "CE", strikeRank: 2, expiryRank: 0, side: "long", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "(K2 − K1) × qty − debit",
    maxLoss: "debit",
    breakevens: "K1 + debit/qty, K3 − debit/qty",
    sources: "OIC, NSE#19, Nat 8, McM 10 & 23, Lean, optopsy, OSL, qb",
    legacyFree: true,
  },
  // §4 row 21
  {
    id: "long-put-butterfly",
    name: "Put Butterfly",
    style: "volatility",
    beginner: false,
    tier: "core",
    net: "debit",
    patterns: [
      {
        legs: [
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 1 },
          { kind: "PE", strikeRank: 1, expiryRank: 0, side: "short", qtyRatio: 2 },
          { kind: "PE", strikeRank: 2, expiryRank: 0, side: "long", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "(K2 − K1) × qty − debit",
    maxLoss: "debit",
    breakevens: "K1 + debit/qty, K3 − debit/qty",
    sources: "OIC, Nat 8, McM 10, Lean, optopsy, OSL, qb",
    legacyFree: true,
  },
  // §4 row 22 — one line, two shapes.
  {
    id: "short-butterfly",
    name: "Short Butterfly",
    style: "volatility",
    beginner: false,
    tier: "next",
    net: "credit",
    patterns: [
      {
        variant: "call",
        name: "Short Call Butterfly",
        legs: [
          { kind: "CE", strikeRank: 0, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "CE", strikeRank: 1, expiryRank: 0, side: "long", qtyRatio: 2 },
          { kind: "CE", strikeRank: 2, expiryRank: 0, side: "short", qtyRatio: 1 },
        ],
      },
      {
        variant: "put",
        name: "Short Put Butterfly",
        legs: [
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "PE", strikeRank: 1, expiryRank: 0, side: "long", qtyRatio: 2 },
          { kind: "PE", strikeRank: 2, expiryRank: 0, side: "short", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "credit",
    maxLoss: "(K2 − K1) × qty − credit",
    breakevens: "K1 + credit/qty, K3 − credit/qty",
    sources: "OIC, NSE#20 (call), Nat 8, Lean, optopsy, OSL",
    legacyFree: false,
  },
  // §4 row 23
  {
    id: "long-call-condor",
    name: "Long Call Condor",
    style: "volatility",
    beginner: false,
    tier: "next",
    net: "debit",
    patterns: [
      {
        legs: [
          { kind: "CE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 1 },
          { kind: "CE", strikeRank: 1, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "CE", strikeRank: 2, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "CE", strikeRank: 3, expiryRank: 0, side: "long", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "(K2 − K1) × qty − debit",
    maxLoss: "debit",
    breakevens: "K1 + debit/qty, K4 − debit/qty",
    sources: "OIC, NSE#21, Nat 8, Lean, optopsy",
    legacyFree: false,
  },
  // §4 row 24
  {
    id: "short-call-condor",
    name: "Short Call Condor",
    style: "volatility",
    beginner: false,
    tier: "next",
    net: "credit",
    patterns: [
      {
        legs: [
          { kind: "CE", strikeRank: 0, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "CE", strikeRank: 1, expiryRank: 0, side: "long", qtyRatio: 1 },
          { kind: "CE", strikeRank: 2, expiryRank: 0, side: "long", qtyRatio: 1 },
          { kind: "CE", strikeRank: 3, expiryRank: 0, side: "short", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "credit",
    maxLoss: "(K2 − K1) × qty − credit",
    breakevens: "K1 + credit/qty, K4 − credit/qty",
    sources: "OIC, NSE#22, Nat 8, Lean, optopsy",
    legacyFree: false,
  },
  // §4 row 25
  {
    id: "long-put-condor",
    name: "Long Put Condor",
    style: "volatility",
    beginner: false,
    tier: "next",
    net: "debit",
    patterns: [
      {
        legs: [
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 1 },
          { kind: "PE", strikeRank: 1, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "PE", strikeRank: 2, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "PE", strikeRank: 3, expiryRank: 0, side: "long", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "(K2 − K1) × qty − debit",
    maxLoss: "debit",
    breakevens: "K1 + debit/qty, K4 − debit/qty",
    sources: "OIC, Nat 8, optopsy",
    legacyFree: false,
  },
  // §4 row 26
  {
    id: "reverse-iron-condor",
    name: "Reverse Iron Condor",
    style: "volatility",
    beginner: false,
    tier: "next",
    net: "debit",
    patterns: [
      {
        legs: [
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "PE", strikeRank: 1, expiryRank: 0, side: "long", qtyRatio: 1 },
          { kind: "CE", strikeRank: 2, expiryRank: 0, side: "long", qtyRatio: 1 },
          { kind: "CE", strikeRank: 3, expiryRank: 0, side: "short", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "(K2 − K1) × qty − debit",
    maxLoss: "debit",
    breakevens: "K2 − debit/qty, K3 + debit/qty",
    sources: "OIC, Nat 8, Lean, optopsy",
    legacyFree: false,
  },
  // §4 row 27
  {
    id: "call-ratio-spread",
    name: "Call Ratio Spread (1×2)",
    style: "volatility",
    beginner: false,
    tier: "next",
    net: "either",
    patterns: [
      {
        legs: [
          { kind: "CE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 1 },
          { kind: "CE", strikeRank: 1, expiryRank: 0, side: "short", qtyRatio: 2 },
        ],
      },
    ],
    maxProfit: "(K2 − K1) × qty + N",
    maxLoss: "unbounded",
    breakevens: "K2 + (K2 − K1) + n",
    sources: "OIC (\"Long Ratio Call Spread\"), Nat 8, McM 6 & 11, optopsy (\"call_front_spread\")",
    legacyFree: false,
  },
  // §4 row 28
  {
    id: "put-ratio-spread",
    name: "Put Ratio Spread (1×2)",
    style: "volatility",
    beginner: false,
    tier: "next",
    net: "either",
    patterns: [
      {
        legs: [
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "short", qtyRatio: 2 },
          { kind: "PE", strikeRank: 1, expiryRank: 0, side: "long", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "(K2 − K1) × qty + N",
    maxLoss: "bounded at S = 0, large",
    breakevens: "K1 − (K2 − K1) − n",
    sources: "OIC, Nat 8, McM 24, optopsy (\"put_front_spread\")",
    legacyFree: false,
  },
  // §4 row 29
  {
    id: "call-backspread",
    name: "Call Backspread (1×2)",
    style: "volatility",
    beginner: false,
    tier: "next",
    net: "either",
    patterns: [
      {
        legs: [
          { kind: "CE", strikeRank: 0, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "CE", strikeRank: 1, expiryRank: 0, side: "long", qtyRatio: 2 },
        ],
      },
    ],
    maxProfit: "unbounded",
    maxLoss: "(K2 − K1) × qty − N",
    breakevens: "K2 + (K2 − K1) − n",
    sources: "OIC, Nat 8, Lean, optopsy (\"call_back_spread\")",
    legacyFree: false,
  },
  // §4 row 30
  {
    id: "put-backspread",
    name: "Put Backspread (1×2)",
    style: "volatility",
    beginner: false,
    tier: "next",
    net: "either",
    patterns: [
      {
        legs: [
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 2 },
          { kind: "PE", strikeRank: 1, expiryRank: 0, side: "short", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "bounded at S = 0, large",
    maxLoss: "(K2 − K1) × qty − N",
    breakevens: "K1 − (K2 − K1) + n",
    sources: "OIC, Nat 8, Lean, optopsy",
    legacyFree: false,
  },
  // §4 row 31 — two expiries.
  {
    id: "call-calendar-spread",
    name: "Call Calendar Spread",
    style: "volatility",
    beginner: false,
    tier: "later",
    net: "debit",
    patterns: [
      {
        legs: [
          { kind: "CE", strikeRank: 0, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "CE", strikeRank: 0, expiryRank: 1, side: "long", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "model-dependent",
    maxLoss: "debit",
    breakevens: "model-dependent",
    sources: "OIC, Nat 8, McM 9, Lean, optopsy, qb, Meridian (own card)",
    legacyFree: false,
  },
  // §4 row 32 — two expiries.
  {
    id: "put-calendar-spread",
    name: "Put Calendar Spread",
    style: "volatility",
    beginner: false,
    tier: "later",
    net: "debit",
    patterns: [
      {
        legs: [
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "PE", strikeRank: 0, expiryRank: 1, side: "long", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "model-dependent",
    maxLoss: "debit",
    breakevens: "model-dependent",
    sources: "OIC, Nat 8, McM 22, Lean, optopsy, qb",
    legacyFree: false,
  },
  // §4 row 33 — two expiries, and one line covering four shapes (call/put × which
  // strike the near leg sits on). §4 calls the net "usually debit"; `either` is
  // the honest encoding, since a diagonal written for a credit is a real trade.
  {
    id: "diagonal-spread",
    name: "Diagonal Spread",
    style: "volatility",
    beginner: false,
    tier: "later",
    net: "either",
    patterns: [
      {
        variant: "call · near leg lower",
        name: "Call Diagonal Spread",
        legs: [
          { kind: "CE", strikeRank: 0, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "CE", strikeRank: 1, expiryRank: 1, side: "long", qtyRatio: 1 },
        ],
      },
      {
        variant: "call · near leg higher",
        name: "Call Diagonal Spread",
        legs: [
          { kind: "CE", strikeRank: 1, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "CE", strikeRank: 0, expiryRank: 1, side: "long", qtyRatio: 1 },
        ],
      },
      {
        variant: "put · near leg lower",
        name: "Put Diagonal Spread",
        legs: [
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "PE", strikeRank: 1, expiryRank: 1, side: "long", qtyRatio: 1 },
        ],
      },
      {
        variant: "put · near leg higher",
        name: "Put Diagonal Spread",
        legs: [
          { kind: "PE", strikeRank: 1, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "PE", strikeRank: 0, expiryRank: 1, side: "long", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "model-dependent",
    maxLoss: "debit (long-far case)",
    breakevens: "model-dependent",
    sources: "Nat 8, McM 14 (ch. unverified), Lean, optopsy",
    legacyFree: false,
  },
  // §4 row 34
  {
    id: "synthetic-long-stock",
    name: "Synthetic Long Stock",
    style: "directional",
    beginner: false,
    tier: "next",
    net: "either",
    patterns: [
      {
        legs: [
          { kind: "CE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 1 },
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "short", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "unbounded",
    maxLoss: "(K1 × qty) − N at S = 0",
    breakevens: "K1 − n",
    sources: "OIC, NSE#7, Nat App. E, McM 21, Lean, OSL",
    legacyFree: false,
  },
  // §4 row 35
  {
    id: "synthetic-short-stock",
    name: "Synthetic Short Stock",
    style: "directional",
    beginner: false,
    tier: "next",
    net: "either",
    patterns: [
      {
        legs: [
          { kind: "CE", strikeRank: 0, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "(K1 × qty) + N at S = 0",
    maxLoss: "unbounded",
    breakevens: "K1 + n",
    sources: "OIC, Nat App. E, McM 21, Lean",
    legacyFree: false,
  },
  // §4 row 36 — one line, four shapes (synthetic long/short × which strike is higher).
  {
    id: "split-strike-combo",
    name: "Split-Strike Combo",
    style: "directional",
    beginner: false,
    tier: "next",
    net: "either",
    patterns: [
      {
        variant: "synthetic long · call higher",
        name: "Split-Strike Synthetic Long",
        legs: [
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "CE", strikeRank: 1, expiryRank: 0, side: "long", qtyRatio: 1 },
        ],
      },
      {
        variant: "synthetic long · call lower",
        name: "Split-Strike Synthetic Long",
        legs: [
          { kind: "CE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 1 },
          { kind: "PE", strikeRank: 1, expiryRank: 0, side: "short", qtyRatio: 1 },
        ],
      },
      {
        variant: "synthetic short · call higher",
        name: "Split-Strike Synthetic Short",
        legs: [
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 1 },
          { kind: "CE", strikeRank: 1, expiryRank: 0, side: "short", qtyRatio: 1 },
        ],
      },
      {
        variant: "synthetic short · call lower",
        name: "Split-Strike Synthetic Short",
        legs: [
          { kind: "CE", strikeRank: 0, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "PE", strikeRank: 1, expiryRank: 0, side: "long", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "as synthetic long / short stock",
    maxLoss: "as synthetic long / short stock",
    breakevens: "one",
    sources: "NSE#7, McM 21 (\"Splitting the Strikes\"), Lean",
    legacyFree: false,
  },
  // §4 row 37
  {
    id: "box-spread",
    name: "Box Spread",
    style: "arbitrage",
    beginner: false,
    tier: "next",
    net: "either",
    patterns: [
      {
        legs: [
          { kind: "CE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 1 },
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "CE", strikeRank: 1, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "PE", strikeRank: 1, expiryRank: 0, side: "long", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "(K2 − K1) × qty − debit, fixed",
    maxLoss: "fixed",
    breakevens: "none — flat",
    sources: "Nat 11, McM 27, Lean, qb. Not in OIC, not in NSE",
    legacyFree: false,
  },
  // §4 row 39 (row 38, the covered strangle, is deliberately absent).
  {
    id: "jade-lizard",
    name: "Jade Lizard",
    style: "income",
    beginner: false,
    tier: "next",
    net: "credit",
    patterns: [
      {
        legs: [
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "CE", strikeRank: 1, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "CE", strikeRank: 2, expiryRank: 0, side: "long", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "credit",
    maxLoss: "(K1 × qty) − credit at S = 0",
    breakevens: "K1 − credit/qty; no upside BE when credit ≥ (K3 − K2) × qty",
    sources: "No institutional source. Coined on tastytrade (Liz Dierking / Jenny Andrews)",
    legacyFree: false,
  },
  // §4 row 40 — one line, two shapes.
  {
    id: "strip-strap",
    name: "Strip / Strap",
    style: "volatility",
    beginner: false,
    tier: "next",
    net: "debit",
    patterns: [
      {
        variant: "strip",
        name: "Strip",
        legs: [
          { kind: "CE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 1 },
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 2 },
        ],
      },
      {
        variant: "strap",
        name: "Strap",
        legs: [
          { kind: "CE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 2 },
          { kind: "PE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "strip: bounded down, unbounded up; strap: unbounded",
    maxLoss: "debit",
    breakevens: "strip K1 + debit/qty, K1 − debit/(2qty); strap mirrored",
    sources: "No institutional source. qb (\"strip\", \"strap\")",
    legacyFree: false,
  },
  // §4 row 41 — one line, two shapes.
  {
    id: "guts",
    name: "Guts",
    style: "volatility",
    beginner: false,
    tier: "next",
    net: "either",
    patterns: [
      {
        variant: "long",
        name: "Long Guts",
        legs: [
          { kind: "CE", strikeRank: 0, expiryRank: 0, side: "long", qtyRatio: 1 },
          { kind: "PE", strikeRank: 1, expiryRank: 0, side: "long", qtyRatio: 1 },
        ],
      },
      {
        variant: "short",
        name: "Short Guts",
        legs: [
          { kind: "CE", strikeRank: 0, expiryRank: 0, side: "short", qtyRatio: 1 },
          { kind: "PE", strikeRank: 1, expiryRank: 0, side: "short", qtyRatio: 1 },
        ],
      },
    ],
    maxProfit: "long: unbounded up; short: credit − (K2 − K1) × qty",
    maxLoss: "long: debit − (K2 − K1) × qty; short: unbounded",
    breakevens: "K1 + debit/qty, K2 − debit/qty",
    sources: "No institutional source. Secondary only",
    legacyFree: false,
  },
];

const BY_ID = new Map<string, StrategyDef>(CATALOGUE.map((d) => [d.id, d]));

/** The catalogue row for an id, or undefined. */
export function getStrategyDef(id: string): StrategyDef | undefined {
  return BY_ID.get(id);
}

/** Display name for a matched row + variant (variant names win). */
export function strategyName(def: StrategyDef, variant?: string | null): string {
  if (!variant) return def.name;
  return def.patterns.find((p) => p.variant === variant)?.name ?? def.name;
}
