/**
 * What the Groww and Upstox contract-note readers share (v4.4.0).
 *
 * The Dhan note (`dhan-contract-note.ts`) set the rule these follow: a
 * contract note NEVER creates a trade. The book is the broker's tradebook /
 * order history; a note describes one day on one exchange, and importing it
 * beside the book would double-book every execution. So a note emits
 * `enrich` rows (fill times, ISIN, exchange, applied at commit to trades the
 * book already holds) and `reference` rows (the note's own charge lines), and
 * `trades: []`.
 *
 * What these two add over the Dhan reader is a CONSERVATION CHECK against the
 * note's own stated figures: Σ(sell values) − Σ(buy values) over every fill
 * must equal the stated pay-in/pay-out obligation, and that less the stated
 * charges must equal the stated net amount — to the paisa. A fill the reader
 * could not see shows up as a gap, never as a silently smaller day.
 *
 * Sign convention, whatever the broker prints: RECEIVABLE BY THE CLIENT IS
 * POSITIVE; a charge is a positive cost. ZERO DB and ZERO React imports.
 */
import type { EnrichmentRow, ReferenceRow } from "../types";

export interface NoteFill {
  orderNo: string;
  orderTime: string;
  tradeNo: string;
  tradeTime: string;
  /** The security as the note prints it (a company name, not a ticker). */
  description: string;
  isin: string | null;
  exchange: string | null;
  side: "buy" | "sell";
  qty: number;
  price: number;
  /** Trade value, positive, as printed (|net total|). */
  value: number;
}

export interface NoteReconciliation {
  fills: number;
  buyValue: number;
  sellValue: number;
  /** Σ sells − Σ buys — receivable before charges (negative = the client pays). */
  fillsNet: number;
  /** The note's own pay-in / pay-out obligation, receivable-positive. */
  statedObligation: number | null;
  /** Charge heads as positive costs, summed across the note's segments. */
  charges: Record<string, number>;
  chargesTotal: number;
  /** The note's own net amount, receivable-positive. */
  statedNet: number | null;
  /** fillsNet − statedObligation (0 = the fills are the whole obligation). */
  obligationGap: number | null;
  /** (fillsNet − chargesTotal) − statedNet (0 = fills + charges are the net). */
  netGap: number | null;
}

export interface ParsedBrokerNote {
  date: string | null;
  fills: NoteFill[];
  /** Lines shaped like a fill that the reader could not read — never dropped silently. */
  unreadable: string[];
  enrich: EnrichmentRow[];
  reference: ReferenceRow[];
  reconciliation: NoteReconciliation;
  warnings: string[];
}

export const r2 = (n: number) => Math.round(n * 100) / 100;

/** `-24,042.60` → -24042.6; anything else → null (refused, never 0). */
export function amountOf(raw: string): number | null {
  const s = String(raw ?? "").trim().replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/** The LAST figure on a summary line — the across-segment total column. */
export function lastFigure(line: string): number | null {
  const m = /(-?[\d,]+\.\d{2})\s*$/.exec(String(line ?? "").trim());
  return m ? amountOf(m[1]!) : null;
}

/** A line that STARTS like a fill: an order number and a time. */
export const FILL_LIKE = /^\d{8,}\s+\d{2}:\d{2}:\d{2}\s/;

/**
 * pdf-parse wraps a 19-digit BSE order number inside its table cell, so the
 * line arrives split: `1767587900687199` then `282 10:14:32 5321000 …`. Join
 * such a pair back into one line; nothing else is touched.
 */
export function unwrapOrderNumbers(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i]!.trim();
    const next = (lines[i + 1] ?? "").trim();
    if (/^\d{8,}$/.test(cur) && /^\d+\s+\d{2}:\d{2}:\d{2}\s/.test(next)) {
      out.push(cur + next);
      i++;
      continue;
    }
    out.push(cur);
  }
  return out;
}

/** Build the conservation record from the fills and the note's own figures. */
export function reconcile(
  fills: NoteFill[],
  statedObligation: number | null,
  charges: Record<string, number>,
  statedNet: number | null,
): NoteReconciliation {
  const buyValue = r2(fills.filter((f) => f.side === "buy").reduce((s, f) => s + f.value, 0));
  const sellValue = r2(fills.filter((f) => f.side === "sell").reduce((s, f) => s + f.value, 0));
  const fillsNet = r2(sellValue - buyValue);
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(charges)) clean[k] = r2(v);
  const chargesTotal = r2(Object.values(clean).reduce((s, v) => s + v, 0));
  return {
    fills: fills.length,
    buyValue,
    sellValue,
    fillsNet,
    statedObligation,
    charges: clean,
    chargesTotal,
    statedNet,
    obligationGap: statedObligation == null ? null : r2(fillsNet - statedObligation),
    netGap: statedNet == null ? null : r2(fillsNet - chargesTotal - statedNet),
  };
}

/** The warning that states the conservation outcome in words. */
export function reconciliationWarning(broker: string, rec: NoteReconciliation): string {
  if (rec.statedObligation == null || rec.statedNet == null) {
    return `This ${broker} note states no readable ${rec.statedObligation == null ? "pay-in / pay-out obligation" : "net amount"}, so its fills could not be checked against the note's own figures.`;
  }
  if (rec.obligationGap === 0 && rec.netGap === 0) {
    return `Reconciled to the paisa: ${rec.fills} fills net Rs${rec.fillsNet} = the note's stated obligation, and less Rs${rec.chargesTotal} of stated charges = its stated net amount Rs${rec.statedNet}.`;
  }
  return `Does NOT reconcile: ${rec.fills} fills net Rs${rec.fillsNet} against a stated obligation of Rs${rec.statedObligation} (gap Rs${rec.obligationGap}); fills less stated charges miss the stated net amount Rs${rec.statedNet} by Rs${rec.netGap}. A fill the reader could not see is the usual cause — check the note before trusting its times.`;
}

/** The note's charge heads as broker-stated reference rows (positive costs). */
export function chargeReferences(charges: Record<string, number>, date: string | null, broker: string): ReferenceRow[] {
  return Object.entries(charges).map(([key, amount]) => ({
    scope: "charge" as const,
    key,
    isin: null,
    symbol: null,
    asOf: date,
    figures: { amount: r2(amount) },
    note: `stated by the ${broker} contract note, summed across its segments`,
  }));
}

/** One enrichment per fill, addressed by ISIN and the printed name. */
export function toEnrichment(fills: NoteFill[], date: string | null): EnrichmentRow[] {
  if (!date) return [];
  return fills.map((f) => ({
    symbol: f.description,
    isin: f.isin,
    name: f.description,
    date,
    side: f.side,
    qty: f.qty,
    time: f.tradeTime,
    instrumentType: "equity" as const,
    exchange: f.exchange,
    note: f.description,
  }));
}

/** Page text via pdf-parse (async; the parse path only, never detection). */
export async function readPdfText(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    return (await parser.getText()).text ?? "";
  } finally {
    await parser.destroy();
  }
}
