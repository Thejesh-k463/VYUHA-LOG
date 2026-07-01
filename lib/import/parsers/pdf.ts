import type { Broker } from "@/lib/domain/constants";
import type { ParseContext, ParsedFile } from "../types";

function detectBroker(text: string): Broker | null {
  if (/dhan/i.test(text)) return "dhan";
  if (/groww/i.test(text)) return "groww";
  if (/zerodha|kite/i.test(text)) return "zerodha";
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

  const broker = detectBroker(text) ?? "dhan";
  return {
    sourceId: "pdf",
    broker,
    format: "pdf",
    trades: [],
    rawText: text,
    warnings: [
      `Extracted text from PDF (detected broker: ${broker}). Automatic table parsing for broker PDFs is not yet calibrated — review the text and add trades via manual entry (guided mapping).`,
    ],
  };
}
