/**
 * Every standing string /strategies prints, plus the three PURE functions the
 * screen is built out of. NO `"use client"` — the server page reads this module
 * directly, and `tests/client-value-imports.test.ts` is the rule that says a
 * server module may take only PascalCase component names out of a client one.
 * So the shared VALUES live here, where both halves can have them.
 *
 * WHY A MODULE AND NOT LITERALS IN THE JSX: `tests/strategies-copy.test.ts`
 * scans the comment-stripped source of `app/strategies/**` and
 * `components/strategies/**` for the vocabulary the research note bans (§6),
 * and pins these strings BY VALUE. Copy that lives in one object can be
 * asserted; copy scattered through six JSX files can only be grepped.
 *
 * REGISTER (§6, and the owner's own wording in §1.4): nouns and arithmetic.
 * The screen states how a structure is put together and how its four numbers
 * are computed. It names no trade and forecasts nothing.
 */

import {
  getStrategyDef,
  type StrategyId,
} from "@/lib/analytics/strategy-catalogue";
import { legKind, type CapLabel, type OptionLeg, type StrategyGroup } from "@/lib/analytics/strategies";
import type { ShelfHistory, ShelfPostResult } from "@/lib/domain/strategy-shelf";
import { OPTIONS_HELP_FOOTER, optionsAnchorId } from "@/lib/domain/options-help";
import { inr } from "@/lib/format";

/** The em dash every un-computable figure renders. Never a 0 (invariant 6). */
export const EM_DASH = "—";

export const STRATEGY_COPY = {
  title: "Option strategies",
  description: "Your open legs grouped into a named structure, with its exact value at expiry.",

  /** Empty state. It says where legs come from, and states nothing about them. */
  empty:
    "No open option positions. Record option legs on the same underlying (Trades → Open trade) to see the structure and its payoff at expiry.",

  /** §6, Q6: the four tiles are gross, and the label says so. */
  beforeCharges: "Before charges — brokerage and statutory charges are not in these figures.",

  /**
   * §6, Q6: ONE sentence, and the reason the tiles above it can read as
   * reachable when they are not. Exercise STT is charged on INTRINSIC value,
   * which is an order of magnitude larger than squaring off and falls on
   * exactly the shapes people let settle.
   */
  sttNote:
    "STT on an exercised option is charged on intrinsic value, not on premium, so a long butterfly's stated maximum is unreachable if the position is left to settle.",

  /** §7, option A: model-free, and honest about the direction of its error. */
  multiExpiryNote:
    "Drawn at the nearest expiry. Legs expiring later are valued at intrinsic only — their remaining time value is not included, so a long far leg is understated and a short far leg is overstated. Max profit, max loss and breakevens on this card describe the nearest expiry alone.",

  /** §6: the zero-price cap is a floor, not a forecast. */
  atZeroNote:
    "Computed from your entry premiums as the value at expiry if the underlying settled at zero. A price floor, not a forecast.",

  /** §7: why a tile is blank rather than confidently wrong (invariant 6). */
  notComputedNote: "Model-dependent at this expiry — it needs a volatility input, which Vyuha has none of.",

  /** The accented link on every card, and the anchor it lands on. */
  howThisWorks: "How this works",

  /** The one line beside a `ProLock` where a named shape has been withheld. */
  proWithheldNote:
    "Named shapes beyond the eight defaults are part of Vyuha Pro. Your legs, the four figures and the payoff curve stay free.",

  /** The shelf, for a free build: a locked strip and one line. */
  shelfLocked: "The strategy shelf and the 40-shape picker are part of Vyuha Pro.",

  shelfTitle: "Your shelf",
  shelfEmpty: "Nothing on the shelf.",
  browseTitle: "Browse the catalogue",
  browseOpen: "Browse all 40",
  browseClose: "Close",
  restoreDefaults: "Restore defaults",
  undo: "Undo",
  redo: "Redo",

  /** The write never reached the route at all — state, and store nothing. */
  shelfUnreachable: "The shelf did not reach Vyuha. Nothing was stored.",

  /** §6: the footer every card carries. One constant, shared with /help. */
  footer: OPTIONS_HELP_FOOTER,
} as const;

/** `Custom (n legs)` — the same shape `computeStrategy` prints for an unmatched group. */
export function customName(legCount: number): string {
  return `Custom (${legCount} legs)`;
}

/** Where a card's "How this works" link lands: the strategy's own entry, or the section top. */
export function helpHref(strategyId: string | null): string {
  return strategyId ? `/help#${optionsAnchorId(strategyId)}` : "/help#options";
}

/**
 * A group as the screen renders it: the catalogue group plus the one flag that
 * says its real name was held back.
 */
export type ScreenGroup = StrategyGroup & { proWithheld: boolean };

/**
 * One catalogue row as the picker needs it — four fields of a `StrategyDef`.
 *
 * Declared here rather than in the drawer because the SERVER page builds the
 * array: a server module may take only PascalCase component names out of a
 * `"use client"` module (`tests/client-value-imports.test.ts`), and a type that
 * lives beside its data is one import that can never become a value import by
 * accident.
 */
export interface PickerRow {
  id: StrategyId;
  name: string;
  style: string;
  beginner: boolean;
}

/**
 * THE PRO WITHHOLDING, AND WHY IT IS A FUNCTION AND NOT A PROP.
 *
 * `/live` learned this first (app/live/page.tsx:21): passing the entitlement
 * only as a prop leaves every Pro value computed on the server and shipped
 * inside the RSC payload, where a locked chip on screen hides nothing at all —
 * the name is one "view source" away. So the substitution happens BEFORE the
 * payload is built: for a free build, a group that matched a catalogue shape
 * which is not one of the pre-v4.3 free names loses both its `strategyId` and
 * its `displayName`, and carries `proWithheld` instead.
 *
 * `legacyFree` is the boundary and it is B1's, not ours: those names printed on
 * this screen before the catalogue existed and invariant 7 does not let a
 * release take something away. A `Custom (n legs)` group (`strategyId === null`)
 * has no name to withhold and is untouched.
 *
 * PURE, so `tests/strategies-page.test.ts` can prove the absence on the
 * SERIALISED result — a prop check would only prove the flag was set.
 */
export function withholdForFree(groups: readonly StrategyGroup[], pro: boolean): ScreenGroup[] {
  return groups.map((g) => {
    if (pro || g.legacyFree || g.strategyId === null) return { ...g, proWithheld: false };
    const name = customName(g.legs.length);
    return { ...g, name, displayName: name, strategyId: null, proWithheld: true };
  });
}

/**
 * FOLD THE ROUTE'S OWN ANSWER — never a `router.refresh()` and never a second
 * fetch. `components/settings/live-feed-card.tsx:603` is the precedent and the
 * scar: an initialiser does NOT re-run after `router.refresh()`, so the panel
 * went on printing the state it had before the write. The shelf route already
 * RE-READS the row it just wrote, so its body is the database, and folding it
 * is what makes the strip and the store impossible to disagree.
 *
 * It does NOT push an undo step: a server echo is not a user action, and
 * `shelfReducer` would otherwise make one Ctrl+Z undo the round-trip rather
 * than the tick that caused it. A refusal folds nothing — the state stands and
 * the caller states the error.
 */
export function foldShelfPost(h: ShelfHistory, r: ShelfPostResult): ShelfHistory {
  if (!r.ok) return h;
  return { ...h, present: { selected: [...r.shelf.selected] } };
}

/** Which word a card prints for its cash: the catalogue's, never the sign's. */
export type NetTone = "credit" | "debit" | null;

/**
 * B1's note, made executable: label credit/debit from the CATALOGUE, not from
 * `isCredit`. A covered call's `netPremium` includes the underlying entry cash,
 * so its sign describes the position's cash flow and not the structure — and
 * a "net debit" chip on a credit structure is a wrong fact, cheaply avoided.
 *
 * `null` = no chip. An unnamed or withheld group has no catalogue row to ask,
 * and a group carrying an underlying leg whose row is `either` has a sign that
 * answers a different question.
 */
export function netTone(
  strategyId: StrategyId | null,
  netPremium: number,
  hasUnderlying: boolean,
): NetTone {
  if (strategyId === null) return null;
  const def = getStrategyDef(strategyId);
  if (!def) return null;
  if (def.net === "credit") return "credit";
  if (def.net === "debit") return "debit";
  if (hasUnderlying) return null;
  return netPremium > 0 ? "credit" : "debit";
}

export const NET_LABEL: Record<"credit" | "debit", string> = {
  credit: "Net credit",
  debit: "Net debit",
};

/** The §6 sub-label a figure carries, and the sentence that explains the odd ones. */
export function capNote(label: CapLabel): string | null {
  if (label === "Computed at underlying = 0") return STRATEGY_COPY.atZeroNote;
  if (label === "Not computed") return STRATEGY_COPY.notComputedNote;
  return null;
}

/** How a figure is coloured: what the NUMBER is, never which tile holds it. */
export type FigureTone = "gain" | "loss" | "neutral";

export const FIGURE_TONE_CLASS: Record<FigureTone, string> = {
  gain: "text-profit",
  loss: "text-loss",
  neutral: "text-muted-foreground",
};

/** One payoff tile, fully described: its heading, its colour and its second line. */
export interface FigureDescriptor {
  label: string;
  tone: FigureTone;
  /** The line under the number — never the number's own word (§6). */
  sub: string;
}

/**
 * The §6 sub-label for an UNBOUNDED tile. "Unlimited" is already the VALUE, and
 * a tile that printed it twice stated one fact and looked like two. Both
 * unbounded cases come from the same slope: `maxProfit === null` is a payoff
 * that rises without bound as the underlying rises, `maxLoss === null` one that
 * falls without bound there, so one sentence is true of both by construction.
 */
export const UNCAPPED_SUB = "No cap as the underlying rises";

/**
 * THE LABEL AND THE COLOUR FOLLOW THE SIGN OF THE FIGURE.
 *
 * `maxLoss` is B1's MINIMUM payoff (strategies.ts: `r2(finiteMin)`), and a
 * minimum can be a gain: 400 INFY at ₹1,450 under a 1500 PE at ₹30 is worth
 * +₹8,000 at every price, and the card printed "Max loss ₹8,000" in loss red —
 * a wrong fact in two places at once. Symmetrically a structure entered at a
 * debit it can never recover has a `maxProfit` below zero. So the heading is
 * "Worst case" / "Highest outcome" whenever the sign contradicts the tile's usual
 * reading, the tone is the sign's own, and the second line states it in words.
 *
 * `Not computed` takes no tone at all: §7 refuses to print that number, and a
 * colour is a statement about a figure the screen is withholding.
 */
export function figureDescriptor(
  which: "maxProfit" | "maxLoss",
  value: number | null,
  cap: CapLabel,
): FigureDescriptor {
  const plain = which === "maxProfit" ? "Max profit" : "Max loss";
  const ordinary: FigureTone = which === "maxProfit" ? "gain" : "loss";

  if (cap === "Not computed") return { label: plain, tone: "neutral", sub: cap };
  if (value === null) return { label: plain, tone: ordinary, sub: UNCAPPED_SUB };

  let label: string | null = null;
  let tone: FigureTone = ordinary;
  let note: string | null = null;
  if (which === "maxLoss" && value > 0) {
    label = "Worst case";
    tone = "gain";
    note = "a gain at every price";
  } else if (which === "maxLoss" && value === 0) {
    label = "Worst case";
    tone = "neutral";
    note = "no loss at any price";
  } else if (which === "maxProfit" && value < 0) {
    label = "Highest outcome";
    tone = "loss";
    note = "a loss at every price";
  } else if (which === "maxProfit" && value === 0) {
    label = "Highest outcome";
    tone = "neutral";
    note = "no gain at any price";
  }

  if (label === null || note === null) return { label: plain, tone: ordinary, sub: cap };
  // "At expiry" is the default cap label and says less than the note; the two
  // that carry a §6 sentence are kept, so no fact is traded for another.
  return { label, tone, sub: cap === "At expiry" ? note : `${cap} — ${note}` };
}

/**
 * The premium the OPTION legs alone stand for, in B1's own sign convention
 * (+ = collected, − = paid).
 *
 * `netPremium` counts a UL leg's entry cash because it is real money, which is
 * right for the position and wrong for a tile headed "Net premium": a covered
 * call printed "Net premium −₹4,56,750" in red beside its "Net credit" chip,
 * and the two disagreed because they were answering different questions.
 */
export function optionNetPremium(group: { legs: readonly OptionLeg[] }): number {
  const total = group.legs
    .filter((l) => legKind(l) !== "UL")
    .reduce((s, l) => s + (l.side === "short" ? l.premium : -l.premium) * l.qty, 0);
  return Math.round(total * 100) / 100;
}

/**
 * The other half of that cash, STATED rather than folded in: the underlying is
 * priced from the journal and is never edited on this screen. `null` when the
 * group holds none, so the tile carries no line it does not need.
 */
export function underlyingEntryLine(group: { ulLegs: readonly OptionLeg[] }): string | null {
  if (group.ulLegs.length === 0) return null;
  const cash = group.ulLegs.reduce(
    (s, l) => s + (l.side === "short" ? l.premium : -l.premium) * l.qty,
    0,
  );
  return `Underlying entry ${inr(Math.round(cash * 100) / 100, { decimals: 0 })} (read-only)`;
}

/** `1 leg` / `2 legs`. The chip on every card header used to read "1 legs". */
export function legCountLabel(n: number): string {
  return `${n} ${n === 1 ? "leg" : "legs"}`;
}
