import { BROKER_LABELS, BROKERS, type Broker } from "@/lib/domain/constants";
import type { ParseContext, ParsedFile } from "../types";

/**
 * Which broker issued this PDF, or null when the text does not say.
 *
 * Every broker the app knows is checked, not a hand-picked three. The old
 * version recognised only Dhan, Groww and Zerodha and then fell back to
 * `"dhan"` for everything else — so a Kotak Neo or Angel One contract note was
 * silently labelled Dhan, and its trades would have been charged at Dhan's
 * rates. Returning null is the honest answer and lets the caller ask.
 */
export function detectBrokerFromText(text: string): Broker | null {
  const patterns: Record<Broker, RegExp> = {
    dhan: /\bdhan\b|dhanhq/i,
    zerodha: /\bzerodha\b|\bkite\b/i,
    groww: /\bgroww\b/i,
    angelone: /angel\s*one|angel\s*broking|angelbroking/i,
    upstox: /\bupstox\b|\brksv\b/i,
    kotakneo: /kotak\s*(neo|securities)|\bkotak\b/i,
    paytm: /paytm\s*money|\bpaytm\b/i,
    sahi: /\bsahi\b|aaritya/i,
  };
  for (const b of BROKERS) {
    if (patterns[b].test(text)) return b;
  }
  return null;
}

export function detectPdf(ctx: ParseContext): number {
  return /\.pdf$/i.test(ctx.filename) ? 0.9 : 0;
}

/**
 * PDF importer. Extracts text (and tables, best-effort) via pdf-parse, detects the
 * broker, and — because broker PDF layouts vary and no sample is calibrated yet —
 * returns the extracted text for a guided manual mapping rather than guessing rows.
 * The seam is here: once a real broker P&L PDF is available, plug a layout parser in.
 */
export async function parsePdf(ctx: ParseContext): Promise<ParsedFile> {
  if (!ctx.buffer) {
    return { sourceId: "pdf", broker: "dhan", format: "pdf", trades: [], warnings: ["No file buffer."] };
  }
  let text = "";
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(ctx.buffer) });
    const res = await parser.getText();
    text = res.text ?? "";
    await parser.destroy();
  } catch (e) {
    return {
      sourceId: "pdf",
      broker: "dhan",
      format: "pdf",
      trades: [],
      warnings: [`Failed to read PDF: ${(e as Error).message}`],
    };
  }

  const detected = detectBrokerFromText(text);
  return {
    sourceId: "pdf",
    // The field is not nullable, so an unrecognised note still needs a value —
    // but the warning says plainly that it is a placeholder, and no trades are
    // produced from this path anyway, so nothing is booked against it.
    broker: detected ?? "dhan",
    format: "pdf",
    trades: [],
    rawText: text,
    warnings: [
      detected
        ? `Extracted text from a ${BROKER_LABELS[detected]} PDF.`
        : "Extracted the text, but nothing in it names a broker Vyuha knows — pick the broker yourself before entering these trades.",
      "Automatic table parsing for broker PDFs is not calibrated. For a CSV or XLSX from this broker, use the file dropzone instead — any broker's table can be imported by mapping its columns.",
    ],
  };
}
