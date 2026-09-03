/**
 * How an import's row counts are DESCRIBED — one sentence, one source of truth.
 *
 * ZERO DB and ZERO React imports; pure functions over plain numbers.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * A tradebook states EXECUTIONS. Vyuha stores POSITIONS, because a position is
 * the thing a trader reasons about and the thing every report is keyed on. So
 * 414 Paytm executions become 142 positions and 1,554 Zerodha fills become 28,
 * and the screen used to announce the second number on its own: "142 trades".
 *
 * To anyone who knows they placed 414 orders, that reads as 272 trades lost.
 * It cost a live demo (2026-08-30) — the audience concluded the importer had
 * dropped data, and no amount of correct arithmetic underneath undid the first
 * impression. The counts were right the whole time; only the sentence was wrong.
 *
 * The fix is to never state the second number without the first, and to say
 * what the difference IS. `414 executions → 142 positions` is arithmetic the
 * reader can check. It is also the same phrasing the Dhan GTR already used
 * ("92 lines → 73 trades", `ParsedFile.sourceRows`, 2026-08-12) — that lesson
 * simply never reached the aggregate count at the top of the screen.
 *
 * The two sub-counts are here for the same reason. An OPEN position and an
 * OPENING SELL both look like "a trade with no P&L" on screen, and both have
 * an honest explanation, so both are named rather than left to be discovered.
 */

export interface ImportShape {
  /**
   * Executions/fills actually read from the file, when the parser paired them
   * into fewer positions. Null when one source row is one position (a P&L
   * statement, an API pull) — then there is no pairing to explain.
   */
  sourceRows: number | null;
  /** Positions produced — what lands in the journal. */
  positions: number;
  /** Positions still holding quantity, excluding opening sells. */
  open: number;
  /** Sells whose matching buy is not in the file. Cost basis unknown. */
  openingSells: number;
  /**
   * Securities the parser saw under TWO labels (a ticker, then a numeric BSE
   * code — Paytm switched mid-window, 2026-07) and paired into one book by
   * ISIN. Optional: only a parser that pairs by ISIN can know it, and it
   * travels here from `ParsedFile.warnings` (see `relabelledFromWarnings`).
   */
  relabelled?: number;
}

const n = (v: number) => v.toLocaleString("en-IN");
const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/**
 * Share of positions that are opening sells above which Net P&L is not to be
 * trusted without a look. An opening sell books ONLY its charges (invariant
 * 6: no cost, no gain), so a file where one position in ten has no purchase
 * is a file whose Net P&L is systematically understated. 10% — an SME-IPO
 * book lands at 38 of ~800 (4.7%) and is NOT flagged; the 414-row export
 * that first exposed the problem had 24 of 142 (17%) and is.
 */
export const OPENING_SELL_REVIEW_SHARE = 0.1;

/** The caution appended when opening sells are a material share of the book. Null otherwise. */
export function openingSellReviewNote(openingSells: number, positions: number): string | null {
  if (openingSells <= 0 || positions <= 0) return null;
  if (openingSells / positions < OPENING_SELL_REVIEW_SHARE) return null;
  return `${n(openingSells)} ${plural(openingSells, "sale", "sales")} without a purchase — review before trusting Net P&L`;
}

/**
 * The relabel count travels from parser to screen as a warning STRING —
 * `ParsedFile` has no typed slot for it and the parsers must not grow one per
 * fact. So the sentence is minted here and read back here: one regex, one
 * writer, one reader. Null / 0 when nothing was relabelled.
 */
export function relabelledNote(count: number): string | null {
  if (count <= 0) return null;
  return `${n(count)} ${plural(count, "security", "securities")} appeared under two labels — paired by ISIN`;
}

const RELABELLED_RE = /^([\d,]+) securit(?:y|ies) appeared under two labels — paired by ISIN/;

/** Read the count `relabelledNote` wrote into a parser's warnings. 0 when absent. */
export function relabelledFromWarnings(warnings: readonly string[]): number {
  for (const w of warnings) {
    const m = RELABELLED_RE.exec(w);
    if (m) return Number(m[1].replace(/,/g, ""));
  }
  return 0;
}

/**
 * The headline sentence: `414 executions → 142 positions (3 open, 24 opening
 * sells without buy history)`.
 *
 * Degrades in both directions. With no pairing it states positions alone; with
 * nothing open and nothing unmatched it drops the parenthetical entirely,
 * because an empty "(0 open, 0 opening sells)" invites a question that has no
 * answer behind it.
 */
export function importShapeSentence(s: ImportShape): string {
  const paired = s.sourceRows != null && s.sourceRows !== s.positions;
  const head = paired
    ? `${n(s.sourceRows!)} ${plural(s.sourceRows!, "execution", "executions")} → ${n(s.positions)} ${plural(s.positions, "position", "positions")}`
    : `${n(s.positions)} ${plural(s.positions, "position", "positions")}`;

  const parts: string[] = [];
  if (s.open > 0) parts.push(`${n(s.open)} open`);
  if (s.openingSells > 0) {
    parts.push(`${n(s.openingSells)} opening ${plural(s.openingSells, "sell", "sells")} without buy history`);
  }
  const base = parts.length > 0 ? `${head} (${parts.join(", ")})` : head;

  // Cautions follow as sentences of their own, so the arithmetic stays the
  // arithmetic and the warning reads as a warning. Absent when there is none:
  // a caution that is always there stops being read.
  const cautions = [openingSellReviewNote(s.openingSells, s.positions), relabelledNote(s.relabelled ?? 0)]
    .filter((c): c is string => c != null);
  return cautions.length > 0 ? `${base}. ${cautions.join(". ")}.` : base;
}

/**
 * Why some P&L cells read "—", stated on the import result itself.
 *
 * Invariant 6: never fabricate a denominator. A sale of shares bought before
 * the export window has no cost basis anywhere in the file, so its P&L is not
 * zero and not a guess — it is unknown, and the blank says exactly that. The
 * user is told where the number comes from instead of being left to assume the
 * importer failed. Null when there is nothing to explain.
 */
export function openingSellNote(openingSells: number): string | null {
  if (openingSells <= 0) return null;
  const s = openingSells === 1;
  return `${n(openingSells)} of these ${s ? "is a sell" : "are sells"} from holdings this file never shows being bought — usually an earlier purchase or an IPO allotment. ${s ? "Its" : "Their"} P&L reads "—" rather than a number invented from a cost basis the file does not carry. Set the buy price on ${s ? "the position" : "those positions"} and ${s ? "it fills" : "they fill"} in.`;
}

/**
 * Compact form for a table cell: `414 → 142`, or just the position count.
 * The full sentence belongs in the cell's `title`, not squeezed into a column.
 */
export function importShapeCompact(s: ImportShape): string {
  return s.sourceRows != null && s.sourceRows !== s.positions
    ? `${n(s.sourceRows)} → ${n(s.positions)}`
    : n(s.positions);
}
