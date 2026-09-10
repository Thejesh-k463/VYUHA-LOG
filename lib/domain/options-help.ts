// OPTIONS HELP DESK CONTENT (PURE — data only, no DB, no React).
//
// One entry per shape in the v4.3 strategy catalogue, keyed by the SAME id
// B1's `STRATEGY_IDS` uses, so the classifier and the help can never describe
// two different catalogues. `tests/options-help.test.ts` joins the two lists in
// both directions and fails on any drift.
//
// COPY RULE (SEBI, absolute). Every sentence here is DESCRIPTIVE. It says what
// a shape is made of and how its four numbers are computed — never what to do
// with it. The register is the owner's own, from the Meridian risk card:
// nouns do the work ("Unlimited", "computed at underlying = 0", "At expiry",
// "naked short risk"), and the vocabulary of advice — should, recommend,
// suggest, consider, must, advice, buy, sell, target, opportunity, expected,
// guaranteed, best, ideal, safe, will — appears nowhere. A strict gate scoped
// to THIS FILE asserts it, and asserts the gate can fire.
//
// Sources for the legs, the caps and the breakevens: the ranked catalogue in
// VYUHA/LIVE-DESK-RESEARCH/13-OPTION-STRATEGY-CATALOGUE.md §4 (rows 1-42, less
// the covered strangle and the ladders, which the v4.3 catalogue does not
// carry), the zero-price cap in §6, and the multi-expiry rules in §7.
//
// Every figure named here is at EXPIRY, from entry premiums, intrinsic value
// only: no volatility, no time value, no charges. That last one is not a
// rounding error in India, which is why every entry carries exactly one
// sentence on STT charged on the INTRINSIC value of a leg left to settle.

import type { SebiFacts } from "@/lib/analytics/sebi-reality";

export type OptionsStyle = "directional" | "income" | "hedging" | "volatility" | "arbitrage";

/** Render order for the grouped section — the two most-held shapes first. */
export const OPTIONS_STYLES: readonly OptionsStyle[] = [
  "directional",
  "income",
  "volatility",
  "hedging",
  "arbitrage",
] as const;

export const OPTIONS_STYLE_LABEL: Record<OptionsStyle, string> = {
  directional: "Directional",
  income: "Income",
  volatility: "Volatility",
  hedging: "Hedging",
  arbitrage: "Arbitrage",
};

export interface OptionsHelpEntry {
  /** IDENTICAL to the classifier's id — the join key. */
  id: string;
  name: string;
  style: OptionsStyle;
  /** §4 rows 1, 2, 5, 6 and 10 only. */
  beginner: boolean;
  /** The legs, and whether the net is a debit or a credit. */
  what: string;
  /** Where it makes and loses, the caps, and the breakevens — in words. */
  payoff: string;
  /** Descriptive, by style: the trader whose expectation this shape expresses. */
  whoUses: string;
  /** Assignment, the naked side, STT on intrinsic, liquidity. */
  risk: string;
  keywords: string[];
}

/**
 * The id list, frozen with B1. Held here as a literal because the help desk
 * ships whether or not the classifier module is on disk yet; the test compares
 * it against `lib/analytics/strategy-catalogue.ts` the moment that file lands.
 */
export const OPTIONS_STRATEGY_IDS: readonly string[] = [
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

export const OPTIONS_HELP: OptionsHelpEntry[] = [
  {
    id: "long-call",
    name: "Long call",
    style: "directional",
    beginner: true,
    what: "One long call at strike K1, one expiry, opened for a net debit. The premium paid is the whole outlay and nothing further is blocked against it.",
    payoff:
      "Above K1 the payoff rises one-for-one with the underlying and has no cap, so max profit is stated as Unlimited. At or below K1 the loss is the debit, in full. Breakeven is computed at K1 plus the premium per unit.",
    whoUses:
      "A trader who expects a move up large enough to clear the premium inside the life of the contract uses this directional shape.",
    risk: "Time decay runs against a long option every day it is held, and the debit is gone in full if the underlying settles at or below K1. A long call left to settle in the money is charged STT on intrinsic value rather than on premium, which is an order of magnitude larger. Far strikes are often thinly quoted.",
    keywords: ["long call", "call option", "ce long", "directional", "beginner", "debit"],
  },
  {
    id: "long-put",
    name: "Long put",
    style: "directional",
    beginner: true,
    what: "One long put at strike K1, one expiry, for a net debit. The premium paid is the entire outlay of the position.",
    payoff:
      "Below K1 the payoff rises as the underlying falls, and the cap is computed at underlying = 0 as (K1 − premium) × quantity — a price floor, not a forecast. At or above K1 the loss is the debit. Breakeven is computed at K1 minus the premium per unit.",
    whoUses:
      "A trader who expects a fall, or who holds the underlying and wants a floor under it, uses this directional and hedging shape.",
    risk: "Decay runs against the position daily and the debit is gone in full if the underlying settles at or above K1. A put left to settle in the money is charged STT on intrinsic value, not on premium. Deep strikes can be hard to exit at a quoted price.",
    keywords: ["long put", "put option", "pe long", "downside", "beginner", "floor"],
  },
  {
    id: "short-call",
    name: "Short call (naked)",
    style: "income",
    beginner: false,
    what: "One short call at K1, one expiry, opened for a net credit. Margin is blocked against the naked leg and marked to market every day it stays open.",
    payoff:
      "Max profit is the credit, kept if the underlying settles at or below K1. Above K1 the loss grows one-for-one with no cap, so max loss is stated as Unlimited — naked short risk. Breakeven is computed at K1 plus the premium per unit.",
    whoUses:
      "A trader who expects the underlying to stay below K1 through expiry uses this income shape; it sits at the advanced end of the catalogue.",
    risk: "Assignment can arrive on any in-the-money short leg, margin can be called intraday, and a gap through K1 has no upper bound. An assigned short call is charged STT on intrinsic value rather than on premium.",
    keywords: ["short call", "naked call", "call writing", "credit", "income", "margin"],
  },
  {
    id: "short-put",
    name: "Short put / cash-secured put",
    style: "income",
    beginner: false,
    what: "One short put at K1, one expiry, for a net credit — cash-secured when the full strike value is set aside against delivery. Margin is blocked against the leg.",
    payoff:
      "Max profit is the credit, kept at or above K1. Below K1 the loss grows as the underlying falls and is computed at underlying = 0 as (K1 − premium) × quantity. Breakeven is computed at K1 minus the premium per unit.",
    whoUses:
      "A trader who expects the underlying to hold above K1, and who accepts delivery at the effective price if it does not, uses this income shape.",
    risk: "Assignment leaves a long position at K1 wherever the market is by then, and margin expands as volatility rises. An assigned in-the-money put is charged STT on intrinsic value rather than on premium.",
    keywords: ["short put", "cash secured put", "put writing", "credit", "income", "assignment"],
  },
  {
    id: "covered-call",
    name: "Covered call",
    style: "income",
    beginner: true,
    what: "The underlying held long against one short call at K1 in the same expiry — a call written against stock or futures already owned, for a net credit.",
    payoff:
      "The gain is capped at (K1 − S0) × quantity plus the credit once the underlying settles above K1. The downside is the underlying's own, cushioned by the credit, and is computed at underlying = 0. Breakeven is computed at the entry price minus the premium per unit.",
    whoUses:
      "A holder who expects the underlying to drift sideways or up slowly, and who accepts a capped exit at K1, uses this income shape.",
    risk: "Everything above K1 is given away while the whole downside stays, and assignment delivers the holding at K1. An in-the-money call left to settle is charged STT on intrinsic value rather than on premium.",
    keywords: ["covered call", "call against holding", "income", "beginner", "capped upside"],
  },
  {
    id: "protective-put",
    name: "Protective put",
    style: "hedging",
    beginner: true,
    what: "The underlying held long plus one long put at K1 in the same expiry, for a net debit — the premium is paid on top of a position already carried.",
    payoff:
      "Above the entry the payoff follows the underlying with no cap, stated as Unlimited. Below K1 the loss is fixed at (S0 − K1) × quantity plus the debit, so the put sets a floor. Breakeven is computed at the entry price plus the premium per unit.",
    whoUses:
      "A holder who expects to carry a position through an event and wants the loss below K1 fixed uses this hedging shape.",
    risk: "The premium is a repeated cost that reduces the net result every cycle it is renewed, and the floor lapses at expiry. An in-the-money put left to settle is charged STT on intrinsic value, not on premium.",
    keywords: ["protective put", "married put", "hedge", "floor", "beginner", "insurance"],
  },
  {
    id: "protective-call",
    name: "Protective call",
    style: "hedging",
    beginner: false,
    what: "The underlying held short plus one long call at K1, one expiry, for a net debit — the mirror of the protective put, also named a synthetic long put.",
    payoff:
      "Below the entry the payoff rises as the underlying falls and is computed at underlying = 0. Above K1 the loss is fixed at (K1 − S0) × quantity plus the debit. Breakeven is computed at the entry price minus the premium per unit.",
    whoUses:
      "A trader carrying a short position who expects a fall but wants the loss above K1 fixed uses this hedging shape.",
    risk: "A short underlying leg brings borrowing and margin costs of its own, and the call premium is a repeated outlay against them. An in-the-money call left to settle is charged STT on intrinsic value rather than on premium.",
    keywords: ["protective call", "synthetic long put", "hedge", "short hedge", "cap"],
  },
  {
    id: "covered-put",
    name: "Covered put",
    style: "income",
    beginner: false,
    what: "The underlying held short plus one short put at K1 in the same expiry, for a net credit — the put is written against a position already short.",
    payoff:
      "Max profit is (S0 − K1) × quantity plus the credit, reached at or below K1. Above K1 the loss grows with the underlying and has no cap, so max loss is stated as Unlimited. Breakeven is computed at the entry price plus the premium per unit.",
    whoUses:
      "A trader already short who expects a slow drift down, and who accepts a capped exit at K1, uses this income shape.",
    risk: "The short underlying leg has no upper bound and the credit cushions little of it; assignment closes the short at K1 whenever the put goes in the money. An in-the-money put left to settle is charged STT on intrinsic value.",
    keywords: ["covered put", "short combination", "income", "credit", "short stock"],
  },
  {
    id: "collar",
    name: "Collar",
    style: "hedging",
    beginner: false,
    what: "The underlying held long, one long put at K1 and one short call at a higher K2, same expiry. The call's credit offsets the put's debit, so the net can fall either way.",
    payoff:
      "The gain is capped at (K2 − S0) × quantity minus the net premium and the loss at (S0 − K1) × quantity plus it — both ends bounded. Breakeven is computed at the entry price minus the net premium per unit.",
    whoUses:
      "A holder who expects to carry a position through a known event, and who exchanges the upside above K2 for a floor at K1, uses this hedging shape.",
    risk: "Assignment on the short call delivers the holding at K2 whatever happens afterwards, and both wings depend on strike liquidity. An in-the-money leg left to settle is charged STT on intrinsic value rather than on premium.",
    keywords: ["collar", "protective collar", "hedge", "floor", "cap", "zero cost"],
  },
  {
    id: "bull-call-spread",
    name: "Bull call spread",
    style: "directional",
    beginner: true,
    what: "One long call at K1 and one short call at a higher K2, same expiry, for a net debit smaller than the outright call at K1.",
    payoff:
      "Max profit is (K2 − K1) × quantity minus the debit, reached at or above K2. Max loss is the debit, at or below K1. Breakeven is computed at K1 plus the debit per unit.",
    whoUses:
      "A trader who expects a limited move up and prefers a known outlay to an open-ended one uses this directional shape.",
    risk: "Both ends are bounded, so the short leg holds the result at K2 however far the move runs. Closing one leg alone leaves a naked short. An in-the-money leg left to settle is charged STT on intrinsic value, not on premium.",
    keywords: ["bull call spread", "debit spread", "vertical", "directional", "beginner"],
  },
  {
    id: "bear-call-spread",
    name: "Bear call spread",
    style: "income",
    beginner: false,
    what: "One short call at K1 and one long call at a higher K2, same expiry, for a net credit. The long wing bounds what the naked side could cost.",
    payoff:
      "Max profit is the credit, kept at or below K1. Max loss is (K2 − K1) × quantity minus the credit, at or above K2. Breakeven is computed at K1 plus the credit per unit.",
    whoUses:
      "A trader who expects the underlying to stay under K1 and wants a defined worst case rather than a naked short uses this income shape.",
    risk: "The wing caps the loss only while both legs are held together; unwinding one alone restores naked short risk. An in-the-money leg left to settle is charged STT on intrinsic value rather than on premium.",
    keywords: ["bear call spread", "credit spread", "vertical", "income", "defined risk"],
  },
  {
    id: "bull-put-spread",
    name: "Bull put spread",
    style: "income",
    beginner: false,
    what: "One short put at K2 and one long put at a lower K1, same expiry, for a net credit. The long put bounds the downside of the written leg.",
    payoff:
      "Max profit is the credit, kept at or above K2. Max loss is (K2 − K1) × quantity minus the credit, at or below K1. Breakeven is computed at K2 minus the credit per unit.",
    whoUses:
      "A trader who expects the underlying to hold above K2 and wants a defined worst case uses this income shape.",
    risk: "Assignment on the short put can arrive while the long put still carries time value, leaving a delivered position for a day. An in-the-money leg left to settle is charged STT on intrinsic value rather than on premium.",
    keywords: ["bull put spread", "credit spread", "vertical", "income", "defined risk"],
  },
  {
    id: "bear-put-spread",
    name: "Bear put spread",
    style: "directional",
    beginner: false,
    what: "One long put at K2 and one short put at a lower K1, same expiry, for a net debit smaller than the outright put at K2.",
    payoff:
      "Max profit is (K2 − K1) × quantity minus the debit, reached at or below K1. Max loss is the debit, at or above K2. Breakeven is computed at K2 minus the debit per unit.",
    whoUses:
      "A trader who expects a limited move down and prefers a bounded outlay uses this directional shape.",
    risk: "The short leg holds the result at K1 and can be assigned before expiry, which unbalances the pair. An in-the-money leg left to settle is charged STT on intrinsic value, not on premium.",
    keywords: ["bear put spread", "debit spread", "vertical", "directional", "downside"],
  },
  {
    id: "long-straddle",
    name: "Long straddle",
    style: "volatility",
    beginner: false,
    what: "One long call and one long put at the same strike K1 and expiry, for a net debit that is the sum of both premiums.",
    payoff:
      "Above K1 the upside is Unlimited; below K1 the payoff is computed at underlying = 0. Max loss is the debit, at exactly K1. Two breakevens are computed at K1 plus and K1 minus the debit per unit.",
    whoUses:
      "A trader who expects a large move without a direction, and who accepts that the move has to clear both premiums, uses this volatility shape.",
    risk: "Both legs decay at once, so a quiet market costs the debit quickly, and a fall in implied volatility after an event can cost more than the move returns. An in-the-money leg left to settle is charged STT on intrinsic value.",
    keywords: ["long straddle", "straddle", "volatility", "event", "atm", "debit"],
  },
  {
    id: "short-straddle",
    name: "Short straddle",
    style: "income",
    beginner: false,
    what: "One short call and one short put at the same strike K1 and expiry, for a net credit that is the sum of both premiums. Margin is blocked against both legs.",
    payoff:
      "Max profit is the credit, and it is kept in full only if the underlying settles exactly at K1. The loss grows in both directions with no cap above, so max loss is stated as Unlimited. Breakevens are computed at K1 plus and K1 minus the credit per unit.",
    whoUses:
      "A trader who expects the underlying to stay near K1 and implied volatility to fall uses this income shape; it sits at the advanced end of the catalogue.",
    risk: "One side is in the money the moment the market moves, margin expands with volatility, and a gap has no upper bound. An assigned in-the-money leg is charged STT on intrinsic value rather than on premium.",
    keywords: ["short straddle", "straddle", "premium", "income", "theta", "naked"],
  },
  {
    id: "long-strangle",
    name: "Long strangle",
    style: "volatility",
    beginner: false,
    what: "One long put at K1 and one long call at a higher K2, same expiry, for a net debit lower than the straddle at the same quantity.",
    payoff:
      "Above K2 the upside is Unlimited; below K1 the payoff is bounded by the price floor. Max loss is the debit, held anywhere between the strikes. Breakevens are computed at K1 minus and K2 plus the debit per unit.",
    whoUses:
      "A trader who expects a very large move either way, and who accepts a wider dead zone in exchange for a smaller outlay, uses this volatility shape.",
    risk: "The distance between the strikes has to be crossed before anything comes back, and both legs decay together. An in-the-money leg left to settle is charged STT on intrinsic value rather than on premium.",
    keywords: ["long strangle", "strangle", "volatility", "otm", "wide", "debit"],
  },
  {
    id: "short-strangle",
    name: "Short strangle",
    style: "income",
    beginner: false,
    what: "One short put at K1 and one short call at a higher K2, same expiry, for a net credit. Margin is blocked against both naked legs.",
    payoff:
      "Max profit is the credit, kept if the underlying settles between K1 and K2. Above K2 there is no cap and below K1 the loss runs to the floor, so max loss is stated as Unlimited. Breakevens are computed at K1 minus and K2 plus the credit per unit.",
    whoUses:
      "A trader who expects the underlying to stay inside the band and implied volatility to fall uses this income shape; it sits at the advanced end of the catalogue.",
    risk: "A gap through either strike is unbounded on the call side, margin rises as volatility rises, and either leg can be assigned. An assigned in-the-money leg is charged STT on intrinsic value.",
    keywords: ["short strangle", "strangle", "premium", "income", "range", "naked"],
  },
  {
    id: "iron-condor",
    name: "Iron condor",
    style: "income",
    beginner: false,
    what: "Four legs at one expiry: a long put at K1, a short put at K2, a short call at K3 and a long call at K4, strikes ascending, for a net credit.",
    payoff:
      "Max profit is the credit, kept between K2 and K3. Max loss is the wider wing — max(K2 − K1, K4 − K3) × quantity — minus the credit. Breakevens are computed at K2 minus and K3 plus the credit per unit.",
    whoUses:
      "A trader who expects the underlying to stay inside a band and wants both tails bounded uses this income shape.",
    risk: "Four legs mean four fills and four sets of charges, and a wing that cannot be filled leaves a naked short behind it. An in-the-money leg left to settle is charged STT on intrinsic value rather than on premium.",
    keywords: ["iron condor", "condor", "range", "credit", "income", "four legs", "wings"],
  },
  {
    id: "iron-butterfly",
    name: "Iron butterfly",
    style: "income",
    beginner: false,
    what: "A long put at K1, a short put and a short call both at K2, and a long call at K3, one expiry, for a net credit larger than the condor's at the same width.",
    payoff:
      "Max profit is the credit, at exactly K2. Max loss is (K2 − K1) × quantity minus the credit, at or beyond either wing. Breakevens are computed at K2 plus and K2 minus the credit per unit.",
    whoUses:
      "A trader who expects the underlying to finish very close to K2 uses this income shape.",
    risk: "The full credit is reached at one point only, and the body is in the money on one side almost always. An in-the-money leg left to settle is charged STT on intrinsic value rather than on premium.",
    keywords: ["iron butterfly", "butterfly", "pin", "credit", "income", "atm body"],
  },
  {
    id: "long-call-butterfly",
    name: "Long call butterfly",
    style: "volatility",
    beginner: false,
    what: "One long call at K1, two short calls at K2 and one long call at K3, equally spaced, one expiry, for a small net debit.",
    payoff:
      "Max profit is (K2 − K1) × quantity minus the debit, at exactly K2. Max loss is the debit, at or outside the wings. Breakevens are computed at K1 plus and K3 minus the debit per unit.",
    whoUses:
      "A trader who expects the underlying to pin near K2 and wants a small fixed outlay uses this volatility shape.",
    risk: "The peak is a single point, so the stated max profit is rarely reached in full, and three strikes mean three fills. A wing left to settle in the money is charged STT on intrinsic value, which here can exceed the whole debit.",
    keywords: ["long call butterfly", "butterfly", "pin", "debit", "three strikes"],
  },
  {
    id: "long-put-butterfly",
    name: "Long put butterfly",
    style: "volatility",
    beginner: false,
    what: "One long put at K3, two short puts at K2 and one long put at K1, equally spaced, one expiry, for a small net debit.",
    payoff:
      "Max profit is (K2 − K1) × quantity minus the debit, at exactly K2. Max loss is the debit, at or outside the wings. Breakevens are computed at K1 plus and K3 minus the debit per unit.",
    whoUses:
      "A trader who expects the underlying to settle near K2 and finds put strikes better quoted uses this volatility shape.",
    risk: "The same single-point peak as the call version, and the body can be assigned early while the wings still carry time value. An in-the-money leg left to settle is charged STT on intrinsic value rather than on premium.",
    keywords: ["long put butterfly", "butterfly", "pin", "debit", "put wings"],
  },
  {
    id: "short-butterfly",
    name: "Short butterfly",
    style: "volatility",
    beginner: false,
    what: "The butterfly reversed: short wings at K1 and K3, two long bodies at K2, one option type and one expiry, for a net credit.",
    payoff:
      "Max profit is the credit, kept at or outside the wings. Max loss is (K2 − K1) × quantity minus the credit, at exactly K2. Breakevens are computed at K1 plus and K3 minus the credit per unit.",
    whoUses:
      "A trader who expects the underlying to leave the K2 area in either direction uses this volatility shape.",
    risk: "The worst case sits where a quiet market most often settles, at the middle strike, and both wings are short. An in-the-money leg left to settle is charged STT on intrinsic value rather than on premium.",
    keywords: ["short butterfly", "butterfly", "credit", "breakout", "reverse"],
  },
  {
    id: "long-call-condor",
    name: "Long call condor",
    style: "volatility",
    beginner: false,
    what: "Four calls at one expiry — long K1, short K2, short K3, long K4, strikes ascending — for a net debit.",
    payoff:
      "Max profit is (K2 − K1) × quantity minus the debit, held anywhere between K2 and K3. Max loss is the debit, at or outside the wings. Breakevens are computed at K1 plus and K4 minus the debit per unit.",
    whoUses:
      "A trader who expects the underlying to finish inside a band and prefers a plateau to the butterfly's single point uses this volatility shape.",
    risk: "Four call legs at one expiry are four fills and four sets of charges, and the plateau is narrow in percentage terms. An in-the-money leg left to settle is charged STT on intrinsic value rather than on premium.",
    keywords: ["long call condor", "condor", "all calls", "debit", "plateau"],
  },
  {
    id: "short-call-condor",
    name: "Short call condor",
    style: "volatility",
    beginner: false,
    what: "Four calls at one expiry — short K1, long K2, long K3, short K4, strikes ascending — for a net credit.",
    payoff:
      "Max profit is the credit, kept at or outside the outer strikes. Max loss is (K2 − K1) × quantity minus the credit, held between K2 and K3. Breakevens are computed at K1 plus and K4 minus the credit per unit.",
    whoUses:
      "A trader who expects the underlying to travel out of the middle band in either direction uses this volatility shape.",
    risk: "The loss zone is the middle of the range, where a quiet market settles most often, and both outer legs are short. An in-the-money leg left to settle is charged STT on intrinsic value rather than on premium.",
    keywords: ["short call condor", "condor", "credit", "breakout", "all calls"],
  },
  {
    id: "long-put-condor",
    name: "Long put condor",
    style: "volatility",
    beginner: false,
    what: "Four puts at one expiry — long K4, short K3, short K2, long K1 — for a net debit; the all-put twin of the call condor.",
    payoff:
      "Max profit is (K2 − K1) × quantity minus the debit, held between K2 and K3. Max loss is the debit, at or outside the wings. Breakevens are computed at K1 plus and K4 minus the debit per unit.",
    whoUses:
      "A trader who expects a settle inside the middle band and finds put strikes better quoted uses this volatility shape.",
    risk: "Deep in-the-money put legs can be assigned early, which unbalances the structure before expiry, and four legs are four fills. An in-the-money leg left to settle is charged STT on intrinsic value rather than on premium.",
    keywords: ["long put condor", "condor", "all puts", "debit", "plateau"],
  },
  {
    id: "reverse-iron-condor",
    name: "Reverse iron condor",
    style: "volatility",
    beginner: false,
    what: "The iron condor inverted: a short put at K1, a long put at K2, a long call at K3 and a short call at K4, one expiry, for a net debit.",
    payoff:
      "Max profit is (K2 − K1) × quantity minus the debit, reached at or beyond either outer strike. Max loss is the debit, held between K2 and K3. Breakevens are computed at K2 minus and K3 plus the debit per unit.",
    whoUses:
      "A trader who expects a move out of the band before expiry, with both the outlay and the gain bounded, uses this volatility shape.",
    risk: "The move has to clear an inner strike plus the debit before anything returns, and the full figure needs the outer strike. An in-the-money leg left to settle is charged STT on intrinsic value rather than on premium.",
    keywords: ["reverse iron condor", "condor", "debit", "breakout", "long volatility"],
  },
  {
    id: "call-ratio-spread",
    name: "Call ratio spread",
    style: "volatility",
    beginner: false,
    what: "One long call at K1 against two short calls at a higher K2, one expiry. The net can be a debit or a credit depending on the strikes chosen.",
    payoff:
      "Max profit is (K2 − K1) × quantity plus any net credit, at exactly K2. Above K2 the second short call is unhedged and the loss is stated as Unlimited. The upper breakeven is computed at K2 plus (K2 − K1) plus the net per unit.",
    whoUses:
      "A trader who expects a move up that stalls near K2 uses this volatility and directional shape.",
    risk: "The unhedged second short leg carries naked short risk above K2 and full margin with it, and a fast move through K2 is the worst case. An in-the-money leg left to settle is charged STT on intrinsic value.",
    keywords: ["call ratio spread", "ratio", "1x2", "front spread", "naked leg"],
  },
  {
    id: "put-ratio-spread",
    name: "Put ratio spread",
    style: "volatility",
    beginner: false,
    what: "One long put at K2 against two short puts at a lower K1, one expiry, for a net that can fall either way depending on the strikes.",
    payoff:
      "Max profit is (K2 − K1) × quantity plus any net credit, at exactly K1. Below K1 the extra short put loses and the figure is computed at underlying = 0, where it is large but bounded. The lower breakeven is computed at K1 minus (K2 − K1) minus the net per unit.",
    whoUses:
      "A trader who expects a move down that halts near K1 uses this volatility and directional shape.",
    risk: "The second short put is unhedged below K1 and can be assigned into a long position there while the market keeps falling. An in-the-money leg left to settle is charged STT on intrinsic value.",
    keywords: ["put ratio spread", "ratio", "1x2", "front spread", "naked leg"],
  },
  {
    id: "call-backspread",
    name: "Call backspread",
    style: "volatility",
    beginner: false,
    what: "One short call at K1 against two long calls at a higher K2, one expiry, often opened for a small net credit.",
    payoff:
      "Above K2 the two long calls outrun the short one and the upside is Unlimited. Max loss is (K2 − K1) × quantity minus any net credit, at exactly K2. The upper breakeven is computed at K2 plus (K2 − K1) minus the net per unit.",
    whoUses:
      "A trader who expects a very large move up, and who accepts a loss if the market stalls at K2, uses this volatility shape.",
    risk: "The worst case sits at the strike a drifting market reaches most easily, and two long legs decay against the position meanwhile. An in-the-money leg left to settle is charged STT on intrinsic value.",
    keywords: ["call backspread", "backspread", "ratio", "1x2", "long volatility"],
  },
  {
    id: "put-backspread",
    name: "Put backspread",
    style: "volatility",
    beginner: false,
    what: "One short put at K2 against two long puts at a lower K1, one expiry, often opened for a small net credit.",
    payoff:
      "Below K1 the long puts outrun the short one and the payoff is computed at underlying = 0, where it is large but bounded. Max loss is (K2 − K1) × quantity minus any net credit, at exactly K1. The lower breakeven is computed at K1 minus (K2 − K1) plus the net per unit.",
    whoUses:
      "A trader who expects a sharp fall, and who accepts a loss if the market settles at K1, uses this volatility shape.",
    risk: "A slow drift into K1 is the worst outcome and the short put can be assigned there, leaving a delivered position. An in-the-money leg left to settle is charged STT on intrinsic value.",
    keywords: ["put backspread", "backspread", "ratio", "1x2", "crash hedge"],
  },
  {
    id: "call-calendar-spread",
    name: "Call calendar spread",
    style: "volatility",
    beginner: false,
    what: "One short call at the near expiry and one long call at the same strike K1 in a later expiry, for a net debit. Two expiries, not one.",
    payoff:
      "The curve is drawn at the nearest expiry with the far leg valued at intrinsic only, which understates a long far leg — so max profit is left as Not computed and stated as needing a volatility input. Max loss is the debit while the far leg is long, and the breakevens describe the nearest expiry alone.",
    whoUses:
      "A trader who expects the underlying to sit near K1 while near-dated premium decays faster than far-dated premium uses this volatility and income shape.",
    risk: "The result turns on implied volatility across two expiries, which an intrinsic-value payoff cannot show, and early assignment on the near leg leaves the far leg standing alone. An in-the-money leg left to settle is charged STT on intrinsic value.",
    keywords: ["call calendar spread", "calendar", "horizontal", "two expiries", "time spread"],
  },
  {
    id: "put-calendar-spread",
    name: "Put calendar spread",
    style: "volatility",
    beginner: false,
    what: "One short put at the near expiry and one long put at the same strike K1 in a later expiry, for a net debit across two expiries.",
    payoff:
      "Drawn at the nearest expiry with the far leg at intrinsic only, so the tent shape does not appear at all and max profit is left as Not computed. Max loss is the debit while the far leg is long, and the breakevens describe the nearest expiry alone.",
    whoUses:
      "A trader who expects the underlying to hold near K1 while near-dated premium decays faster uses this volatility and income shape.",
    risk: "A deep in-the-money near put can be assigned early, leaving a long put and a delivered position to carry, and the far leg's time value is invisible on the drawn curve. An in-the-money leg left to settle is charged STT on intrinsic value.",
    keywords: ["put calendar spread", "calendar", "horizontal", "two expiries", "time spread"],
  },
  {
    id: "diagonal-spread",
    name: "Diagonal spread",
    style: "volatility",
    beginner: false,
    what: "Two legs of one option type across two expiries and two strikes: short near at one strike, long far at another. Usually a net debit.",
    payoff:
      "The curve is drawn at the nearest expiry with the far leg at intrinsic, so max profit is Not computed and max loss is the debit while the far leg is long. The breakevens describe the nearest expiry alone.",
    whoUses:
      "A trader who expects a slow drift towards the near strike while holding longer-dated exposure uses this volatility and directional shape.",
    risk: "The shape changes as the near leg rolls off, so what is on screen describes one expiry of a position that has two, and the far leg's time value is not in it. An in-the-money leg left to settle is charged STT on intrinsic value.",
    keywords: ["diagonal spread", "diagonal", "two expiries", "roll", "time spread"],
  },
  {
    id: "synthetic-long-stock",
    name: "Synthetic long stock",
    style: "directional",
    beginner: false,
    what: "One long call and one short put at the same strike K1 and expiry, which together track the underlying one-for-one. The net can be a debit or a credit.",
    payoff:
      "Above K1 the payoff rises with the underlying, Unlimited on that side. Below K1 it falls with the underlying and is computed at underlying = 0 as (K1 × quantity) minus the net. Breakeven is computed at K1 minus the net per unit.",
    whoUses:
      "A trader who expects an upward move and prefers two option legs to the underlying itself uses this directional shape.",
    risk: "The short put carries the whole downside and its margin, so this is not a limited-loss structure despite being built from options. An in-the-money leg left to settle is charged STT on intrinsic value rather than on premium.",
    keywords: ["synthetic long stock", "combo", "synthetic", "conversion", "directional"],
  },
  {
    id: "synthetic-short-stock",
    name: "Synthetic short stock",
    style: "directional",
    beginner: false,
    what: "One short call and one long put at the same strike K1 and expiry, tracking the underlying downwards one-for-one. The net can fall either way.",
    payoff:
      "Below K1 the payoff rises as the underlying falls and is computed at underlying = 0 as (K1 × quantity) plus the net. Above K1 the loss is stated as Unlimited. Breakeven is computed at K1 plus the net per unit.",
    whoUses:
      "A trader who expects a fall, or who is hedging a holding without touching it, uses this directional and hedging shape.",
    risk: "The short call is naked, so the upside has no bound and margin expands as volatility does. An in-the-money leg left to settle is charged STT on intrinsic value rather than on premium.",
    keywords: ["synthetic short stock", "combo", "synthetic", "reversal", "directional"],
  },
  {
    id: "split-strike-combo",
    name: "Split-strike combo",
    style: "directional",
    beginner: false,
    what: "A call and a put on opposite sides at different strikes, one expiry — the synthetic with its strikes pulled apart, for a debit or a credit.",
    payoff:
      "Between the strikes the payoff is flat at the net premium; outside them it takes the shape of the synthetic it is built from, Unlimited on the short side. One breakeven is computed, on the side the net sits.",
    whoUses:
      "A trader who expects a directional move but wants a band of indifference between the strikes uses this directional shape.",
    risk: "The short leg is naked beyond its own strike and carries the same margin as an outright short option. An in-the-money leg left to settle is charged STT on intrinsic value rather than on premium.",
    keywords: ["split strike combo", "combo", "risk reversal", "synthetic", "split strikes"],
  },
  {
    id: "box-spread",
    name: "Box spread",
    style: "arbitrage",
    beginner: false,
    what: "A bull call spread at K1/K2 and a bear put spread at the same two strikes, one expiry — four legs whose payoff comes to (K2 − K1) × quantity at every price.",
    payoff:
      "The payoff is flat: the same fixed amount at every underlying price, so there is no breakeven at all. Max profit and max loss are both fixed, by the net paid or received against (K2 − K1) × quantity.",
    whoUses:
      "A trader who expects nothing from direction, and who is measuring that fixed payoff against the net cost of getting into it, uses this arbitrage shape.",
    risk: "The whole result lives inside the fills and the charges — four legs, four spreads crossed — and a leg that cannot be filled breaks the flat payoff. Every in-the-money leg left to settle is charged STT on intrinsic value, on both spreads at once.",
    keywords: ["box spread", "box", "arbitrage", "four legs", "flat payoff"],
  },
  {
    id: "jade-lizard",
    name: "Jade lizard",
    style: "income",
    beginner: false,
    what: "A short put at K1, a short call at K2 and a long call at a higher K3, one expiry, for a net credit.",
    payoff:
      "Max profit is the credit, kept between K1 and K2. Above K2 the loss is bounded by the K3 wing, and when the credit is at least (K3 − K2) × quantity there is no upside breakeven at all. Below K1 the loss is computed at underlying = 0 as (K1 × quantity) minus the credit.",
    whoUses:
      "A trader who expects the underlying to hold above K1, with the upside tail closed by the wing, uses this income shape.",
    risk: "The downside is the short put's in full, unhedged all the way to the floor, and no institutional body publishes this name — it was coined on a trading desk. An in-the-money leg left to settle is charged STT on intrinsic value.",
    keywords: ["jade lizard", "lizard", "credit", "income", "no upside risk"],
  },
  {
    id: "strip-strap",
    name: "Strip / strap",
    style: "volatility",
    beginner: false,
    what: "Three long legs at one strike K1 and expiry: a strip is one call and two puts, a strap is two calls and one put. Both are net debits.",
    payoff:
      "A strip leans down and a strap leans up; the strap's upside is Unlimited and the strip's downside runs to the price floor. Max loss is the debit, at exactly K1, and two breakevens are computed from the debit spread over one leg on one side and two on the other.",
    whoUses:
      "A trader who expects a large move with a lean towards one direction uses this volatility and directional shape.",
    risk: "Three long premiums decay together, so the move has to be both large and quick, and no institutional body publishes these two names. An in-the-money leg left to settle is charged STT on intrinsic value.",
    keywords: ["strip", "strap", "straddle variant", "skewed straddle", "debit"],
  },
  {
    id: "guts",
    name: "Guts",
    style: "volatility",
    beginner: false,
    what: "A call at K1 and a put at a higher K2, both in the money, both on the same side — long guts is a net debit, short guts a net credit.",
    payoff:
      "Long guts keeps an Unlimited upside and, inside the strikes, a loss of the debit minus (K2 − K1) × quantity; short guts keeps the credit minus (K2 − K1) × quantity and is Unlimited above. Breakevens are computed at K1 plus and K2 minus the debit per unit.",
    whoUses:
      "A trader who expects a large move and prefers in-the-money strikes to the strangle's out-of-the-money ones uses this volatility shape.",
    risk: "Both legs are in the money from the start, so both carry intrinsic value into settlement and in-the-money series are often thinly quoted. An in-the-money leg left to settle is charged STT on intrinsic value — the charge this structure is most exposed to.",
    keywords: ["guts", "long guts", "short guts", "itm strangle", "volatility"],
  },
];

/** The deep-link anchor for one strategy: `/help#options-<id>`. */
export function optionsAnchorId(id: string): string {
  return `options-${id}`;
}

/** Case-insensitive search across name, id, the four parts, style and keywords. */
export function searchOptionsHelp(entries: OptionsHelpEntry[], query: string): OptionsHelpEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) =>
    [e.name, e.id.replace(/-/g, " "), e.what, e.payoff, e.whoUses, e.risk, e.style, ...e.keywords].some((s) =>
      s.toLowerCase().includes(q),
    ),
  );
}

/**
 * The id of the desk's Options SECTION heading — where `helpHref(null)` sends a
 * Custom card, and the one `options-…` fragment that names no entry.
 */
export const OPTIONS_SECTION_ANCHOR = "options-help";

/**
 * The strategy id a `/help#…` fragment points at, or null when it points
 * somewhere else. Accepts the fragment with or without its leading `#`.
 *
 * R4-U-2: the section heading is "somewhere else". A bare prefix strip read
 * `options-help` as the entry id "help", and while no entry carries that id —
 * so the render was never wrong — the desk's scroll effect is keyed on this
 * value and fired on the heading. That effect exists for a card the reader's
 * own search had filtered OUT of the DOM; a heading is never filtered out, and
 * the browser's fragment navigation reaches it unaided (which is what the
 * heading's own `scroll-mt-20` is for).
 */
export function optionsHashTarget(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw === OPTIONS_SECTION_ANCHOR) return null;
  const prefix = optionsAnchorId("");
  if (!raw.startsWith(prefix)) return null;
  const id = raw.slice(prefix.length);
  return id.length > 0 ? id : null;
}

/**
 * WHAT THE DESK RENDERS: the search hits, PLUS the entry the URL fragment names
 * when the search dropped it.
 *
 * v4.3 audit round 3, U-4. The command palette deep-links to
 * `/help#options-<id>`. Landing on `/help` fresh that works — nothing is typed,
 * so every card is on the page. But a same-path hash push does NOT remount the
 * page, so when the reader is already on `/help` with something typed in the
 * search box, the card the fragment names may have been filtered out: the
 * anchor is simply not in the DOM and the browser scrolls nowhere. Including
 * the target keeps the anchor real without touching the query the reader typed.
 *
 * Catalogue ORDER is preserved (the target is not appended at the end), and an
 * empty hash returns exactly `searchOptionsHelp`'s own result — identity when
 * the query is empty too, so the server render is unchanged.
 */
export function visibleOptions(
  entries: OptionsHelpEntry[],
  query: string,
  hash: string,
): OptionsHelpEntry[] {
  const hits = searchOptionsHelp(entries, query);
  const id = optionsHashTarget(hash);
  if (id === null || hits.some((e) => e.id === id)) return hits;
  if (!entries.some((e) => e.id === id)) return hits; // a fragment for no entry we have
  const keep = new Set(hits.map((e) => e.id));
  keep.add(id);
  return entries.filter((e) => keep.has(e.id));
}

/** Entries of one style, in catalogue order. */
export function optionsByStyle(entries: OptionsHelpEntry[], style: OptionsStyle): OptionsHelpEntry[] {
  return entries.filter((e) => e.style === style);
}

/** ₹ in lakh, one decimal — derived from the figure, never written out as copy. */
export function rupeesInLakh(rupees: number): string {
  return `₹${(rupees / 100000).toFixed(1)} L`;
}

/**
 * The section's ONE SEBI line, computed from `SEBI_FNO_FACTS` — every number in
 * it comes from that record, so a revised study updates the sentence and cannot
 * leave a stale literal behind. There is no published URL in that record and
 * none is invented here.
 */
export function sebiRealityLine(facts: SebiFacts): string {
  return (
    `SEBI's study of individual traders in the equity derivatives segment found ${facts.lossMakingPct}% of them ` +
    `net loss-making in ${facts.period}, at an average net loss of ${rupeesInLakh(facts.avgNetLoss)} per loss-making ` +
    `trader. ${facts.sourceNote} These pages describe how each structure is put together and how its four numbers ` +
    `are computed, at expiry, from entry premiums — intrinsic value only, no volatility, no time value and no ` +
    `charges. They name no trade and forecast nothing.`
  );
}

/** The footer every strategy card carries, in the register of §6. */
export const OPTIONS_HELP_FOOTER =
  "Computed at expiry from entry premiums. Intrinsic value only — no volatility, no time value, no charges. Not a forecast and not advice.";
