import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { buildContext, detectParser, rankParsers } from "@/lib/import/detect";
import { previewParsedFile, commitParsedFile } from "@/lib/import/commit";
import { classifyFileKind, capabilityOf } from "@/lib/import/file-kind";
import type { ProductHint } from "@/lib/engine/types";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Expected multipart form data." }, { status: 400 });

  const file = form.get("file");
  const mode = String(form.get("mode") ?? "preview");
  const forcedSource = form.get("sourceId") ? String(form.get("sourceId")) : null;

  // Bulk product corrections for a P&L file, keyed by tradingsymbol. Sent by
  // the P&L tab once the user has confirmed what these trades actually were.
  let productOverrides: Record<string, ProductHint> | null = null;
  const rawOverrides = form.get("productOverrides");
  if (rawOverrides) {
    try {
      productOverrides = JSON.parse(String(rawOverrides)) as Record<string, ProductHint>;
    } catch {
      return NextResponse.json({ error: "Malformed product overrides." }, { status: 400 });
    }
  }

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const ctx = buildContext(file.name, bytes);

  const ranked = rankParsers(ctx);
  const chosen = forcedSource
    ? ranked.find((p) => p.sourceId === forcedSource) ?? null
    : detectParser(ctx);

  if (!chosen) {
    return NextResponse.json(
      {
        error: "Could not detect the broker/format for this file.",
        candidates: ranked.map((p) => ({ sourceId: p.sourceId, label: p.label, confidence: p.confidence })),
      },
      { status: 422 },
    );
  }

  let parsed;
  try {
    parsed = await chosen.parse(ctx);
  } catch (e) {
    return NextResponse.json({ error: `Parse failed: ${(e as Error).message}` }, { status: 422 });
  }

  if (mode === "commit") {
    try {
      const result = commitParsedFile(parsed, file.name, productOverrides);
      revalidatePath("/trades");
      revalidatePath("/");
      return NextResponse.json({
        mode: "commit",
        detected: { sourceId: chosen.sourceId, label: chosen.label, confidence: chosen.confidence },
        result,
        warnings: parsed.warnings,
      });
    } catch (e) {
      return NextResponse.json({ error: `Commit failed: ${(e as Error).message}` }, { status: 500 });
    }
  }

  // preview
  const preview = previewParsedFile(parsed, productOverrides);
  const kind = classifyFileKind(parsed.format);
  return NextResponse.json({
    mode: "preview",
    detected: { sourceId: chosen.sourceId, label: chosen.label, confidence: chosen.confidence },
    candidates: ranked.map((p) => ({ sourceId: p.sourceId, label: p.label, confidence: p.confidence })),
    // What this KIND of file can and cannot tell us — drives whether the UI
    // asks for product types or trusts the file.
    fileKind: capabilityOf(kind),
    preview,
  });
}
