/**
 * Groww EQUITY contract note (PDF, `Contract_Note_<ucc>_<dd-Mon-yyyy>.pdf`).
 *
 * VERIFIED against one real owner note, 2026-09-16: 30 pages, unprotected,
 * trade date 05-01-2026, 713 fills over 14 ISINs on NSE and BSE, pinned in
 * tests/golden-books.test.ts against the note's own Pay In / Pay Out
 * Obligation (8,813.99) and Net Amount (5,800.16) — to the paisa. The
 * committed fixture is the note's TEXT with identity tokenised
 * (`tests/fixtures/redacted/groww-contract-note-2026-01-05.txt`, made by
 * `scripts/fixtures/redact-contract-note.mjs`). EQUITY ONLY: the owner has
 * never traded F&O on Groww, so no derivative line has been seen and none is
 * read (a derivative-looking fill is refused, not guessed).
 *
 * ── What pdf-parse renders ────────────────────────────────────────────────
 *   Trade Date 05-01-2026 / Settlement Date 06-01-2026 …
 *   ISIN summary:   INE227C01017 MM FORGINGS LTD 1000 422.41 0.02 … 0 2220.10
 *   Obligation:     Pay In / Pay Out Obligation (before Brokerage) 8813.99 8813.99
 *                   Taxable Value of Supply (Brokerage) -560.00 -560.00
 *                   … IGST (18% on …) -177.08 -177.08 … Stamp Duty -198.00 …
 *                   Net Amount Receivable / Payable By Client 5800.16 5800.16
 *   Annexure A, one line per FILL, per-ISIN blocks closed by a Total line:
 *     1200000046657005 12:42:53 405047892 12:42:53 Mm Forgings Ltd NSE B 57 421.80 421.80 -24042.60
 *     …                                                            NSE S -14 424.90 424.90 5948.60
 *     Total INE227C01017 0 2260.10
 *     …
 *     Net Total 8813.99
 * Groww prints a SELL with a negative quantity and a positive value, a BUY the
 * other way round; the last figure on a summary line is the net-total column;
 * a positive obligation is money RECEIVABLE by the client. A BSE order number
 * is 19 digits and wraps inside its cell (see `unwrapOrderNumbers`). The fill
 * lines name the company, never a ticker — the ISIN, read from the block's
 * Total line, is the identity the book (Groww's order history) shares.
 *
 * ── Detection (AGENTS.md: NAME before SHAPE) ──────────────────────────────
 * No page text names Groww — the logo is an image. The name is in the
 * UNCOMPRESSED digital-signature dictionary every Groww note carries:
 * `/Name (DS GROWW INVEST TECH PRIVATE LIMITED 1) /Reason (Contract-note-
 * verification)`. Both the legal name and a contract-note marker (that
 * reason, or the filename) are required, read synchronously from the bytes.
 */
import type { ParseContext, ParsedFile } from "../types";
import { pdfLatin1 } from "./pdf-bytes";
import {
  FILL_LIKE, amountOf, chargeReferences, lastFigure, r2, readPdfText, reconcile, reconciliationWarning,
  toEnrichment, unwrapOrderNumbers, type NoteFill, type ParsedBrokerNote,
} from "./contract-note-common";

/** The signer's legal name, as the signature dictionary states it. */
const GROWW_MARKER = /GROWW INVEST TECH/i;
const NOTE_MARKER = /contract[\s_-]*note/i;

export function detectGrowwContractNote(ctx: ParseContext): number {
  if (!/\.pdf$/i.test(ctx.filename) || !ctx.buffer) return 0;
  const bytes = pdfLatin1(ctx.buffer);
  if (!GROWW_MARKER.test(bytes)) return 0;
  if (!NOTE_MARKER.test(ctx.filename) && !NOTE_MARKER.test(bytes)) return 0;
  return /groww/i.test(ctx.filename) ? 1 : 0.95;
}

const FILL =
  /^(\d{8,})\s+(\d{2}:\d{2}:\d{2})\s+(\d+)\s+(\d{2}:\d{2}:\d{2})\s+(.+?)\s+(NSE|BSE)\s+([BS])\s+(-?[\d,]+)\s+([\d,]+\.\d+)\s+([\d,]+\.\d+)\s+(-?[\d,]+\.\d+)(?:\s+(\S.*))?$/;
const TOTAL = /^Total\s+(IN[A-Z0-9]{10})\s+(-?[\d,]+)\s+(-?[\d,]+\.\d+)$/;
const DERIVATIVE = /\b(?:CE|PE|FUT|FUTIDX|FUTSTK|OPTIDX|OPTSTK)\b/;

/** `Trade Date 05-01-2026` → ISO, cross-checked against the settlement date. */
export function parseGrowwNoteDate(text: string): string | null {
  const t = /Trade Date\s+(\d{2})-(\d{2})-(\d{4})/.exec(text);
  if (!t) return null;
  const [d, m, y] = [Number(t[1]), Number(t[2]), Number(t[3])];
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const iso = `${t[3]}-${t[2]}-${t[1]}`;
  // Day-first is asserted, not assumed: read day-first, the settlement date
  // must fall within a week AFTER the trade date. Read month-first, a T+1 note
  // would settle a month away — the reading is refused rather than guessed.
  const s = /Settlement Date\s+(\d{2})-(\d{2})-(\d{4})/.exec(text);
  if (s) {
    const trade = Date.UTC(y, m - 1, d);
    const settle = Date.UTC(Number(s[3]), Number(s[2]) - 1, Number(s[1]));
    const days = (settle - trade) / 86_400_000;
    if (!(days >= 0 && days <= 7)) return null;
  }
  return iso;
}

/** Obligation-block label → charge head (null = not a charge line). */
function chargeKey(label: string): string | null {
  if (/^Taxable Value of Supply \(Brokerage\)/i.test(label)) return "brokerage";
  if (/^Exchange Transaction Charges/i.test(label)) return "exchangeTxn";
  if (/^(?:CGST|SGST|IGST|UTT)\b/i.test(label)) return "gst";
  if (/^Securities Transaction Tax/i.test(label)) return "stt";
  if (/^SEBI Turnover Fees/i.test(label)) return "sebi";
  if (/^Stamp Duty/i.test(label)) return "stamp";
  if (/^IPFT Charges/i.test(label)) return "ipft";
  return null;
}

/** Read the extracted text of a Groww equity contract note. Pure. */
export function readGrowwContractNoteText(text: string): ParsedBrokerNote {
  const warnings: string[] = [];
  const date = parseGrowwNoteDate(text);
  if (!date) warnings.push("This Groww note states no readable trade date (or one its settlement date contradicts), so its fill times cannot be placed on a trading day and nothing will be applied.");

  const lines = unwrapOrderNumbers(String(text ?? "").split(/\r?\n/));
  const fills: NoteFill[] = [];
  const unreadable: string[] = [];
  let block: NoteFill[] = [];
  let statedObligation: number | null = null;
  let statedNet: number | null = null;
  let annexureTotal: number | null = null;
  const charges: Record<string, number> = {};
  const blockBreaks: string[] = [];

  for (const line of lines) {
    const f = FILL.exec(line);
    if (f) {
      const qtySigned = amountOf(f[8]!), price = amountOf(f[9]!), netRate = amountOf(f[10]!), net = amountOf(f[11]!);
      const side = f[7] === "B" ? "buy" : "sell";
      const desc = f[5]!.trim();
      const signsAgree = qtySigned != null && net != null &&
        (side === "buy" ? qtySigned > 0 && net < 0 : qtySigned < 0 && net > 0);
      const qty = Math.abs(qtySigned ?? 0);
      // A line is read only when its own arithmetic holds: quantity × net rate
      // is the value it prints. A column read one position off fails this.
      if (!signsAgree || price == null || netRate == null || DERIVATIVE.test(desc) ||
        Math.abs(r2(qty * netRate) - Math.abs(net!)) > 0.01) {
        unreadable.push(line);
        continue;
      }
      const fill: NoteFill = {
        orderNo: f[1]!, orderTime: f[2]!, tradeNo: f[3]!, tradeTime: f[4]!,
        description: desc, isin: null, exchange: f[6]!, side, qty, price, value: Math.abs(net!),
      };
      fills.push(fill);
      block.push(fill);
      continue;
    }
    if (FILL_LIKE.test(line)) { unreadable.push(line); continue; }
    const t = TOTAL.exec(line);
    if (t) {
      // The block's own total names its ISIN and states its net value.
      const stated = amountOf(t[3]!);
      const got = r2(block.reduce((s, x) => s + (x.side === "sell" ? x.value : -x.value), 0));
      for (const x of block) x.isin = t[1]!;
      if (stated == null || Math.abs(got - stated) > 0.005) blockBreaks.push(`${t[1]} (fills ${got}, stated ${t[3]})`);
      block = [];
      continue;
    }
    const nt = /^Net Total\s+(-?[\d,]+\.\d+)$/.exec(line);
    if (nt) { annexureTotal = amountOf(nt[1]!); continue; }
    if (/^Pay In \/ Pay Out Obligation/i.test(line)) { statedObligation = lastFigure(line); continue; }
    if (/^Net Amount Receivable \/ Payable By Client/i.test(line)) { statedNet = lastFigure(line); continue; }
    const key = chargeKey(line);
    if (key) {
      const v = lastFigure(line);
      // Printed negative = payable by the client = a positive cost.
      if (v != null) charges[key] = (charges[key] ?? 0) - v;
    }
  }

  if (fills.length === 0) warnings.push("No trade-annexure lines could be read from this Groww note. Nothing is applied; the extracted text is returned so the layout can be checked.");
  if (block.length) warnings.push(`${block.length} fill(s) followed the last per-ISIN Total line, so no ISIN could be read for them.`);
  if (unreadable.length) warnings.push(`${unreadable.length} line(s) look like fills but could not be read (derivative lines are not verified for Groww notes) — they are not applied, and the reconciliation below shows their absence.`);
  if (blockBreaks.length) warnings.push(`${blockBreaks.length} per-ISIN block(s) do not sum to their own Total line: ${blockBreaks.join("; ")}.`);
  const reconciliation = reconcile(fills, statedObligation, charges, statedNet);
  if (annexureTotal != null && Math.abs(annexureTotal - reconciliation.fillsNet) > 0.005) {
    warnings.push(`The annexure's own Net Total (Rs${annexureTotal}) differs from its fills (Rs${reconciliation.fillsNet}).`);
  }
  warnings.push(reconciliationWarning("Groww", reconciliation));

  return {
    date,
    fills,
    unreadable,
    enrich: toEnrichment(fills.filter((x) => x.isin), date),
    reference: chargeReferences(reconciliation.charges, date, "Groww"),
    reconciliation,
    warnings,
  };
}

/** The registered import source. Enrichment + charge references; no trades. */
export async function parseGrowwContractNote(ctx: ParseContext): Promise<ParsedFile> {
  const base = { sourceId: "groww-contract-note", broker: "groww" as const, format: "contract-note", trades: [] };
  if (!ctx.buffer) return { ...base, warnings: ["No file buffer."] };
  if (!GROWW_MARKER.test(pdfLatin1(ctx.buffer))) {
    return { ...base, warnings: ["Nothing in this PDF names Groww's signing entity, so it is not read as a Groww contract note."] };
  }
  let text = "";
  try {
    text = await readPdfText(ctx.buffer);
  } catch (e) {
    return { ...base, warnings: [`Failed to read the contract note PDF: ${(e as Error).message}`] };
  }
  const parsed = readGrowwContractNoteText(text);
  return {
    ...base,
    sourceRows: parsed.fills.length,
    enrich: parsed.enrich,
    reference: parsed.reference,
    warnings: [
      `This is a Groww contract note${parsed.date ? ` for ${parsed.date}` : ""} — ${parsed.fills.length} fill${parsed.fills.length === 1 ? "" : "s"}, each with a trade time. A contract note NEVER creates trades: your order history is the book, and importing a note beside it would double-book the same day. These fills are applied to trades the book already holds — fill time and exchange, matched by ISIN — and anything that matches nothing is reported, not stored.`,
      ...parsed.warnings,
    ],
  };
}
