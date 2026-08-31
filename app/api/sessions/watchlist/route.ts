import { NextResponse } from "next/server";
import { buildContext } from "@/lib/import/detect";
import { readTable } from "@/lib/import/parsers/generic-table";
import { guardReadable } from "@/lib/import/parse-guard";
import {
  parseWatchlistText,
  extractTickerColumn,
  extractTickerTokensFromText,
  type WatchlistExtraction,
} from "@/lib/import/watchlist";

export const runtime = "nodejs";

/**
 * Parse an uploaded watchlist file into CANDIDATE symbols. Read-only: nothing
 * is written here — the client shows the candidates for confirmation and the
 * confirmed set is saved through the existing /api/sessions upsert, which is
 * where canonicalisation and the audit trail live.
 *
 *   .txt        → comma/space/newline tokens, taken as written
 *   .csv/.xlsx  → the column whose values look like tickers; ambiguity is
 *                 returned as a question, never guessed (generic-map rule)
 *   .pdf        → flat text only — candidate tokens that REQUIRE confirmation;
 *                 no table structure is ever claimed for a PDF (parsers/pdf.ts)
 */
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Expected multipart form data." }, { status: 400 });
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file uploaded." }, { status: 400 });

  const bytes = Buffer.from(await file.arrayBuffer());
  const name = file.name;

  let extraction: WatchlistExtraction;

  if (/\.txt$/i.test(name)) {
    extraction = parseWatchlistText(bytes.toString("utf-8"));
  } else if (/\.pdf$/i.test(name)) {
    let text = "";
    try {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(bytes) });
      const res = await parser.getText();
      text = res.text ?? "";
      await parser.destroy();
    } catch (e) {
      return NextResponse.json({ error: `Failed to read PDF: ${(e as Error).message}` }, { status: 422 });
    }
    extraction = extractTickerTokensFromText(text);
  } else if (/\.(csv|xlsx|xls)$/i.test(name)) {
    const guard = guardReadable(name, bytes);
    if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 422 });
    const { headers, rows } = readTable(buildContext(name, bytes));
    if (!headers.length && !rows.length) {
      return NextResponse.json({ error: "No table found in this file — the first sheet has no rows Vyuha can see." }, { status: 422 });
    }
    extraction = extractTickerColumn(headers, rows);
  } else {
    return NextResponse.json({ error: "Drop a .txt, .csv, .xlsx or .pdf watchlist file." }, { status: 422 });
  }

  if (!extraction.symbols.length && !extraction.ambiguousColumns?.length) {
    return NextResponse.json(
      { error: extraction.note ?? "Nothing in this file looks like a ticker." },
      { status: 422 },
    );
  }

  return NextResponse.json({
    ok: true,
    symbols: extraction.symbols,
    requiresConfirmation: extraction.requiresConfirmation,
    ambiguousColumns: extraction.ambiguousColumns ?? null,
    note: extraction.note ?? null,
  });
}
