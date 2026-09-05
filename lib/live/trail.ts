/**
 * Live Desk — trailing-stop levels. PURE (invariant 2). 03 §5, spec §4.3.
 *
 * NOTE FOR THE COPY GUARD (§4 of the build prompt): the exported name
 * `trailSuggestions` is the identifier the spec mandates. The banned-phrase
 * guard must match STRING LITERALS, not identifiers — nothing in this file
 * produces user-facing text at all, and no level here tells anyone to do
 * anything. A level is stated with its method and its number ("Chandelier exit,
 * 22 bars × 3 ATR, puts the level at X"); the decision stays the user's.
 *
 * THREE PROPERTIES, EACH OF WHICH IS A BUG SOMEWHERE ELSE WHEN ABSENT:
 *
 *  1. MONOTONE, ENFORCED EXACTLY ONCE. A long's trail takes `max(previous,
 *     candidate)` and a short's takes `min`, in `updateTrail` and nowhere else.
 *     Enforcing it twice is how a "ratchet" quietly stops ratcheting: the second
 *     site re-derives from a candidate the first already clamped.
 *  2. IDEMPOTENT FOR A REPEATED BAR. Feeding the same session twice returns the
 *     state unchanged. Intraday refresh, an SSE reconnect and a re-import all
 *     replay the same last bar, and a trail that stepped on each replay would
 *     walk the stop up on a day price never moved.
 *  3. IT READS THE PREVIOUS BAR'S ATR, NEVER THE CURRENT BAR'S. The current
 *     bar's ATR does not exist until that bar closes. A backfilled test has
 *     every bar closed, so an implementation that peeks at the current bar
 *     passes every historical test and produces a different level live — the
 *     exact failure mode this note exists to prevent. The input field is NAMED
 *     `atrP3Prev` so the mistake has to be typed out deliberately.
 *
 * ROUNDING: the ATR offset FLOORS, which for a long makes the level no higher
 * than the arithmetic (a trail that is never tighter than computed) and for a
 * short no lower. Levels are paise; nothing here is rounded to a tick — tick
 * rounding belongs to `stop.ts`, at the point the level becomes an order.
 */

import { wilderAtrSeriesP3 } from "./tracker-row";
import { PERMILLE, PPM, type AtrP3, type Bar, type Paise, type Side } from "./types";

export type TrailMethod = "chandelier" | "ma" | "atr-ratchet" | "percent" | "turtle";

/** Chandelier default: 22 bars of extreme, 3.0 × ATR below it. */
export const DEFAULT_CHANDELIER_BARS = 22;
export const DEFAULT_CHANDELIER_ATR_MULT_PERMILLE = 3000;
/** The MA trail's default length. */
export const DEFAULT_MA_LENGTH = 21;
/** The R ladder trims a third at each of 1R, 2R and 3R. */
export const R_LADDER_STEPS = [1, 2, 3] as const;
export const R_LADDER_DENOMINATOR = 3;

/** One session, carrying the values known AT ITS OPEN — never its own ATR. */
export interface TrailBar {
  date: string;
  highP: Paise;
  lowP: Paise;
  closeP: Paise;
  /** Wilder ATR as of the PREVIOUS bar's close. null ⇒ no ATR-based candidate. */
  atrP3Prev: AtrP3 | null;
  /** Moving average as of the PREVIOUS bar's close, for the MA trail. */
  maPrev?: Paise | null;
}

export interface TrailParams {
  chandelierBars: number;
  atrMultPermille: number;
  /** For the `percent` method: 30_000 ppm = 3% below the close. */
  percentPpm?: number | null;
  /** For the `turtle` method: the 10- or 20-day exit window. */
  turtleExitBars?: number | null;
}

export interface TrailState {
  side: Side;
  method: TrailMethod;
  entryP: Paise;
  /** The level in force. null until a candidate could first be computed. */
  levelP: Paise | null;
  /** The last session applied; a repeat of it is a no-op. */
  lastBarDate: string | null;
  barsSeen: number;
  /** Rolling extremes (highs for a long, lows for a short), oldest first. */
  window: readonly Paise[];
  params: TrailParams;
}

export const DEFAULT_TRAIL_PARAMS: TrailParams = {
  chandelierBars: DEFAULT_CHANDELIER_BARS,
  atrMultPermille: DEFAULT_CHANDELIER_ATR_MULT_PERMILLE,
  percentPpm: null,
  turtleExitBars: null,
};

/** A fresh state. `levelP` starts null: no bars, no level, never a fake one. */
export function initTrail(side: Side, entryP: Paise, method: TrailMethod, params: Partial<TrailParams> = {}): TrailState {
  return {
    side,
    method,
    entryP,
    levelP: null,
    lastBarDate: null,
    barsSeen: 0,
    window: [],
    params: { ...DEFAULT_TRAIL_PARAMS, ...params },
  };
}

/** ATR offset in paise: `atrP3` is paise × 1000 and `mult` is × 1000. */
function atrOffsetP(atrP3Prev: AtrP3 | null | undefined, multPermille: number): Paise | null {
  if (atrP3Prev === null || atrP3Prev === undefined || atrP3Prev <= 0) return null;
  if (!Number.isFinite(multPermille) || multPermille <= 0) return null;
  return Math.floor((atrP3Prev * multPermille) / (PERMILLE * PERMILLE));
}

function windowExtreme(side: Side, window: readonly Paise[]): Paise | null {
  if (window.length === 0) return null;
  return side === "short" ? Math.min(...window) : Math.max(...window);
}

/** The unclamped level this bar implies. null when the method lacks an input. */
function candidateFor(state: TrailState, bar: TrailBar, window: readonly Paise[]): Paise | null {
  const { side, method, params } = state;
  const sign = side === "short" ? -1 : 1;
  switch (method) {
    case "chandelier": {
      const extreme = windowExtreme(side, window);
      const off = atrOffsetP(bar.atrP3Prev, params.atrMultPermille);
      return extreme === null || off === null ? null : extreme - sign * off;
    }
    case "atr-ratchet": {
      const off = atrOffsetP(bar.atrP3Prev, params.atrMultPermille);
      return off === null ? null : bar.closeP - sign * off;
    }
    case "ma":
      return bar.maPrev ?? null;
    case "percent": {
      const pct = params.percentPpm;
      if (pct === null || pct === undefined || pct <= 0) return null;
      return bar.closeP - sign * Math.floor((bar.closeP * pct) / PPM);
    }
    case "turtle": {
      // Turtle exits on the N-day extreme in the ADVERSE direction: the lowest
      // low of the window for a long. The chandelier's ATR offset is absent by
      // design — the two are different exits, not one with a parameter.
      const n = params.turtleExitBars;
      if (n === null || n === undefined || n < 1) return null;
      const recent = window.slice(-n);
      if (recent.length < n) return null;
      return side === "short" ? Math.max(...recent) : Math.min(...recent);
    }
  }
}

/**
 * Apply one session. The single contract every method shares, so a new method
 * is a `case` in `candidateFor` and never a second monotonicity rule.
 */
export function updateTrail(state: TrailState, bar: TrailBar): TrailState {
  // (2) Idempotence: the same session twice changes nothing.
  if (state.lastBarDate !== null && bar.date === state.lastBarDate) return state;

  // The chandelier tracks favourable extremes; turtle tracks adverse ones.
  const tracked = state.method === "turtle" ? (state.side === "short" ? bar.highP : bar.lowP) : state.side === "short" ? bar.lowP : bar.highP;
  const span = Math.max(state.params.chandelierBars, state.params.turtleExitBars ?? 0, 1);
  const window = [...state.window, tracked].slice(-span);

  const candidate = candidateFor(state, bar, window);
  // (1) Monotone, enforced HERE and only here.
  const levelP =
    candidate === null
      ? state.levelP
      : state.levelP === null
        ? candidate
        : state.side === "short"
          ? Math.min(state.levelP, candidate)
          : Math.max(state.levelP, candidate);

  return { ...state, levelP, lastBarDate: bar.date, barsSeen: state.barsSeen + 1, window };
}

/** Replay a whole series through `updateTrail`. Bars must be ascending by date. */
export function runTrail(state: TrailState, bars: readonly TrailBar[]): TrailState {
  return bars.reduce(updateTrail, state);
}

// ---------------------------------------------------------------------------
// The batch entry point the desk uses.
// ---------------------------------------------------------------------------

export interface TrailSuggestionInput {
  side: Side;
  entryP: Paise;
  /** Ascending EOD bars for the symbol. */
  bars: readonly Bar[];
  /** The stop currently in force, so the level can be compared to it. */
  currentStopP: Paise | null;
  /** `|entry − stop|` at first entry. null ⇒ the R ladder is null, never 0. */
  riskPerShareP: Paise | null;
  /** Open quantity, for the ladder's per-step size. */
  qty: number;
  atrLength?: number;
  chandelierBars?: number;
  atrMultPermille?: number;
  maLength?: number;
}

export interface TrailLevel {
  method: TrailMethod;
  levelP: Paise | null;
  /** Stated so the label can name the method and its parameters. */
  params: Record<string, number>;
  /** null when either the level or the current stop is unknown. */
  beyondCurrentStop: boolean | null;
  /** How many sessions the level had to work with. */
  sessions: number;
}

export interface RLadderStep {
  /** 1, 2 or 3. */
  r: number;
  priceP: Paise;
  /** Whole shares for this step; the remainder rides on the last step. */
  qty: number;
  /** Whether the latest close has already traded through the level. */
  reached: boolean;
}

export interface TrailSuggestions {
  chandelier: TrailLevel;
  ma: TrailLevel;
  /** null when `riskPerShareP` is null — an R ladder without R is not a ladder. */
  rLadder: RLadderStep[] | null;
}

/** SMA of the closes ENDING at index `end` (inclusive). null when too short. */
function smaAt(bars: readonly Bar[], end: number, length: number): Paise | null {
  if (length < 1 || end < length - 1) return null;
  let sum = 0;
  for (let i = end - length + 1; i <= end; i++) sum += bars[i].closeP;
  return Math.floor(sum / length);
}

/**
 * Chandelier, MA trail and the R ladder for one position.
 *
 * Every ATR and MA used here is taken from the bar BEFORE the one being
 * applied, so the answer is identical whether it is computed while today's bar
 * is still forming or after it has closed.
 */
export function trailSuggestions(input: TrailSuggestionInput): TrailSuggestions {
  const {
    side,
    entryP,
    bars,
    currentStopP,
    riskPerShareP,
    qty,
    atrLength = DEFAULT_CHANDELIER_BARS,
    chandelierBars = DEFAULT_CHANDELIER_BARS,
    atrMultPermille = DEFAULT_CHANDELIER_ATR_MULT_PERMILLE,
    maLength = DEFAULT_MA_LENGTH,
  } = input;

  const atr = wilderAtrSeriesP3(bars, atrLength);
  const trailBars: TrailBar[] = bars.map((b, i) => ({
    date: b.date,
    highP: b.highP ?? b.closeP,
    lowP: b.lowP ?? b.closeP,
    closeP: b.closeP,
    // i - 1: the PREVIOUS bar's ATR and MA. See property (3) in the header.
    atrP3Prev: i > 0 ? atr[i - 1] : null,
    maPrev: i > 0 ? smaAt(bars, i - 1, maLength) : null,
  }));

  const chandelier = runTrail(initTrail(side, entryP, "chandelier", { chandelierBars, atrMultPermille }), trailBars);
  const ma = runTrail(initTrail(side, entryP, "ma", { chandelierBars, atrMultPermille }), trailBars);

  const beyond = (levelP: Paise | null): boolean | null =>
    levelP === null || currentStopP === null ? null : side === "short" ? levelP < currentStopP : levelP > currentStopP;

  const lastCloseP = bars.length ? bars[bars.length - 1].closeP : null;
  const sign = side === "short" ? -1 : 1;

  let rLadder: RLadderStep[] | null = null;
  if (riskPerShareP !== null && riskPerShareP > 0 && qty > 0) {
    const per = Math.floor(qty / R_LADDER_DENOMINATOR);
    rLadder = R_LADDER_STEPS.map((r, idx) => {
      const priceP = entryP + sign * r * riskPerShareP;
      // The remainder rides on the last step, so the steps sum to `qty` exactly
      // and no share is stranded by three floors.
      const stepQty = idx === R_LADDER_STEPS.length - 1 ? qty - per * (R_LADDER_STEPS.length - 1) : per;
      return {
        r,
        priceP,
        qty: stepQty,
        reached: lastCloseP === null ? false : side === "short" ? lastCloseP <= priceP : lastCloseP >= priceP,
      };
    });
  }

  return {
    chandelier: {
      method: "chandelier",
      levelP: chandelier.levelP,
      params: { bars: chandelierBars, atrMultPermille, atrLength },
      beyondCurrentStop: beyond(chandelier.levelP),
      sessions: bars.length,
    },
    ma: {
      method: "ma",
      levelP: ma.levelP,
      params: { maLength },
      beyondCurrentStop: beyond(ma.levelP),
      sessions: bars.length,
    },
    rLadder,
  };
}
