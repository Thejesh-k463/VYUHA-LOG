/**
 * Upstox EQUITY contract note cum tax invoice (PDF,
 * `CW_T_<ucc>_<yyyymmdd>_<EXCH>_<contract no>.pdf`).
 *
 * VERIFIED against one real owner note, 2026-09-16: 3 pages, unprotected,
 * NSE-EQ, trade date 28/08/2026, 2 fills — pinned in
 * tests/golden-books.test.ts against the note's own PAY IN / (PAY OUT)
 * OBLIGATION (1.05) and net amount (4.28), to the paisa. The same round trip
 * is the one populated Upstox realised-P&L export already pinned there (gross
 * −1.05, charges 3.23, net −4.28), so two Upstox documents now agree with each
 * other as well as with this reader. The committed fixture is the note's TEXT
 * with identity tokenised
 * (`tests/fixtures/redacted/upstox-contract-note-2026-08-28.txt`). EQUITY
 * ONLY: no Upstox F&O-day note has been seen, and a derivative line is not
 * read (it has no `[ISIN]`, so it lands in `unreadable` and the conservation
 * check shows the gap).
 *
 * ── What pdf-parse renders ────────────────────────────────────────────────
 *   Trade Date : 28/08/2026
 *   PAY IN / ( PAY OUT ) OBLIGATION 1.05 1.05
 *   Brokerage Charges 2.66 2.66
 *   [IGST 18% On Brokerage] 0.48 0.48      [STT-Round off] -0.33 -0.33
 *   [IGST 18% On Charges] 0.01 0.01        [STT-SQUP] 0.33 0.33
 *   [TURNOVER CHG] 0.08 0.08
 *   Net amount (-) receivable by Client / (+) payable by Client (Rs.) 4.28 4.28
 *   Annexure A, one line per FILL:
 *     1200000038507282 11:55:42 404283923 11:55:42 PRECISIO WIR [INE372C01037] B 3 443.3000 443.3000 1329.90 NSE
 *     1200000038664383 11:56:42 404303228 11:56:42 PRECISIO WIR [INE372C01037] S -3 442.9500 442.9500 -1328.85 NSE
 * Upstox signs the other way round from Groww: a positive figure is PAYABLE
 * by the client, and a sell prints a negative quantity AND a negative value.
 * The obligation block is split by a page footer; only `Brokerage Charges`
 * and `[bracketed]` lines inside it are charge lines. `[TURNOVER CHG]` is the
 * exchange transaction charge, IPFT included (the note says so itself).
 *
 * ── Detection (AGENTS.md: NAME before SHAPE) ──────────────────────────────
 * The raw bytes name nobody: the metadata says only `/Title (Contract Note)`
 * and the producer — the SAME two strings Dhan's note carries. Upstox's legal
 * name is page text, drawn with standard fonts, so it is plain `(…) Tj` text
 * once a content stream is inflated (`pdfInflatedText`, synchronous and
 * bounded). The claim needs `UPSTOX SECURITIES PRIVATE LIMITED` (or the RKSV
 * predecessor) there AND a contract-note marker.
 */
import type { ParseContext, ParsedFile } from "../types";
import { pdfInflatedText, pdfLatin1 } from "./pdf-bytes";
import {
  FILL_LIKE, amountOf, chargeReferences, lastFigure, r2, readPdfText, reconcile, reconciliationWarning,
  toEnrichment, type NoteFill, type ParsedBrokerNote,
} from "./contract-note-common";

const UPSTOX_MARKER = /UPSTOX SECURITIES PRIVATE LIMITED|RKSV (?:COMMODITIES|SECURITIES)/i;
const NOTE_MARKER = /contract[\s_-]*note/i;

export function detectUpstoxContractNote(ctx: ParseContext): number {
  if (!/\.pdf$/i.test(ctx.filename) || !ctx.buffer) return 0;
  const raw = pdfLatin1(ctx.buffer);
  if (!raw.startsWith("%PDF")) return 0;
  const inflated = pdfInflatedText(ctx.buffer);
  if (!UPSTOX_MARKER.test(inflated) && !UPSTOX_MARKER.test(raw)) return 0;
  if (!NOTE_MARKER.test(ctx.filename) && !NOTE_MARKER.test(raw) && !NOTE_MARKER.test(inflated)) return 0;
  return /upstox/i.test(ctx.filename) ? 1 : 0.95;
}

const FILL =
  /^(\d{8,})\s+(\d{2}:\d{2}:\d{2})\s+(\d+)\s+(\d{2}:\d{2}:\d{2})\s+(.+?)\s+\[(IN[A-Z0-9]{10})\]\s+([BS])\s+(-?[\d,]+)\s+([\d,]+\.\d+)\s+([\d,]+\.\d+)\s+(-?[\d,]+\.\d+)(?:\s+(NSE|BSE))?\s*$/;

/** `Trade Date : 28/08/2026` → ISO. Day-first; a month above 12 is refused. */
export function parseUpstoxNoteDate(text: string): string | null {
  const m = /Trade Date\s*:\s*(\d{2})\/(\d{2})\/(\d{4})/.exec(String(text ?? ""));
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** A charge line's head, read from the label the note prints. */
function chargeKey(label: string): string {
  const l = label.toUpperCase();
  if (/BROKERAGE/.test(l) && !/GST/.test(l)) return "brokerage";
  if (/GST/.test(l)) return "gst";
  if (/\bSTT\b|SECURITIES TRANSACTION/.test(l)) return "stt";
  if (/SEBI/.test(l)) return "sebi"; // before TURNOVER: "SEBI turnover fees" is SEBI's
  if (/TURNOVER|TRANSACTION CH/.test(l)) return "exchangeTxn";
  if (/STAMP/.test(l)) return "stamp";
  if (/IPFT/.test(l)) return "ipft";
  return "other";
}

/** Read the extracted text of an Upstox equity contract note. Pure. */
export function readUpstoxContractNoteText(text: string): ParsedBrokerNote {
  const warnings: string[] = [];
  const date = parseUpstoxNoteDate(text);
  if (!date) warnings.push("This Upstox note states no readable trade date, so its fill times cannot be placed on a trading day and nothing will be applied.");

  const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim());
  const segExchange = lines.map((l) => /^(NSE|BSE)-EQ$/.exec(l)?.[1]).find(Boolean) ?? null;
  const fills: NoteFill[] = [];
  const unreadable: string[] = [];
  const charges: Record<string, number> = {};
  const others: string[] = [];
  let statedObligation: number | null = null;
  let statedNet: number | null = null;
  let inBlock = false;

  for (const line of lines) {
    const f = FILL.exec(line);
    if (f) {
      const qtySigned = amountOf(f[8]!), price = amountOf(f[9]!), netRate = amountOf(f[10]!), net = amountOf(f[11]!);
      const side = f[7] === "B" ? "buy" : "sell";
      const signsAgree = qtySigned != null && net != null &&
        (side === "buy" ? qtySigned > 0 && net > 0 : qtySigned < 0 && net < 0);
      const qty = Math.abs(qtySigned ?? 0);
      if (!signsAgree || price == null || netRate == null || Math.abs(r2(qty * netRate) - Math.abs(net!)) > 0.01) {
        unreadable.push(line);
        continue;
      }
      fills.push({
        orderNo: f[1]!, orderTime: f[2]!, tradeNo: f[3]!, tradeTime: f[4]!,
        description: f[5]!.trim(), isin: f[6]!, exchange: f[12] ?? segExchange,
        side, qty, price, value: Math.abs(net!),
      });
      continue;
    }
    if (FILL_LIKE.test(line)) { unreadable.push(line); continue; }
    if (/^PAY IN \/ \( ?PAY OUT ?\) OBLIGATION/i.test(line)) {
      const v = lastFigure(line);
      // Printed positive = payable by the client; receivable-positive here.
      statedObligation = v == null ? null : -v;
      inBlock = true;
      continue;
    }
    if (/^Net amount \(-\) receivable by Client/i.test(line)) {
      const v = lastFigure(line);
      statedNet = v == null ? null : -v;
      inBlock = false;
      continue;
    }
    if (!inBlock) continue;
    const label = /^Brokerage Charges\b/i.test(line) ? "Brokerage Charges" : /^\[([^\]]+)\]/.exec(line)?.[1];
    if (!label) continue; // page footers inside the block are not charge lines
    const v = lastFigure(line);
    if (v == null) continue;
    const key = chargeKey(label);
    if (key === "other") others.push(label);
    charges[key] = (charges[key] ?? 0) + v;
  }

  if (fills.length === 0) warnings.push("No trade-annexure lines could be read from this Upstox note. Nothing is applied; the extracted text is returned so the layout can be checked.");
  if (unreadable.length) warnings.push(`${unreadable.length} line(s) look like fills but could not be read (derivative lines are not verified for Upstox notes) — they are not applied, and the reconciliation below shows their absence.`);
  if (others.length) warnings.push(`Charge line(s) this reader does not name were kept as "other": ${others.join(", ")}.`);
  const reconciliation = reconcile(fills, statedObligation, charges, statedNet);
  warnings.push(reconciliationWarning("Upstox", reconciliation));

  return {
    date,
    fills,
    unreadable,
    enrich: toEnrichment(fills, date),
    reference: chargeReferences(reconciliation.charges, date, "Upstox"),
    reconciliation,
    warnings,
  };
}

/** The registered import source. Enrichment + charge references; no trades. */
export async function parseUpstoxContractNote(ctx: ParseContext): Promise<ParsedFile> {
  const base = { sourceId: "upstox-contract-note", broker: "upstox" as const, format: "contract-note", trades: [] };
  if (!ctx.buffer) return { ...base, warnings: ["No file buffer."] };
  let text = "";
  try {
    text = await readPdfText(ctx.buffer);
  } catch (e) {
    return { ...base, warnings: [`Failed to read the contract note PDF: ${(e as Error).message}`] };
  }
  if (!UPSTOX_MARKER.test(text)) {
    return {
      ...base,
      rawText: text,
      warnings: ["Nothing in this PDF's text names Upstox's legal entity, so it is not read as an Upstox contract note. The extracted text is returned for a manual check."],
    };
  }
  const parsed = readUpstoxContractNoteText(text);
  return {
    ...base,
    sourceRows: parsed.fills.length,
    enrich: parsed.enrich,
    reference: parsed.reference,
    warnings: [
      `This is an Upstox contract note${parsed.date ? ` for ${parsed.date}` : ""} — ${parsed.fills.length} fill${parsed.fills.length === 1 ? "" : "s"}, each with a trade time. A contract note NEVER creates trades: the trade report is the book, and importing a note beside it would double-book the same day. These fills are applied to trades the book already holds — fill time and exchange, matched by ISIN or name — and anything that matches nothing is reported, not stored.`,
      ...parsed.warnings,
    ],
  };
}
