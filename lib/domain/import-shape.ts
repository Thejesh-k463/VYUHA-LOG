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
}

const n = (v: number) => v.toLocaleString("en-IN");
const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

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
  return parts.length > 0 ? `${head} (${parts.join(", ")})` : head;
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
