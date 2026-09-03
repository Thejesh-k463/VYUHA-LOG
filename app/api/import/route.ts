import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { buildContext, detectParser, rankParsers } from "@/lib/import/detect";
import { previewParsedFile, commitParsedFile } from "@/lib/import/commit";
import { AccountRequiredError } from "@/lib/queries/accounts";
import { guardReadable, unreadableError } from "@/lib/import/parse-guard";
import { classifyFileKind, capabilityOf } from "@/lib/import/file-kind";
import type { ProductHint } from "@/lib/engine/types";
import { BROKERS, type Broker } from "@/lib/domain/constants";
import type { ColumnMapping } from "@/lib/import/generic-map";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Expected multipart form data." }, { status: 400 });

  const file = form.get("file");
  const mode = String(form.get("mode") ?? "preview");
  const forcedSource = form.get("sourceId") ? String(form.get("sourceId")) : null;
  // Only sent from the "All accounts" view, where the target is ambiguous.
  // Validated against the accounts table downstream in getWriteAccountId.
  const rawAccountId = form.get("accountId");
  const accountId = rawAccountId ? Number(rawAccountId) : null;

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

  // Refuse unreadable bytes (an image, an encrypted workbook) BEFORE detection:
  // detectors open the workbook themselves, and an XLSX throw there used to
  // escape as a raw 500 instead of copy the user can act on.
  const guard = guardReadable(file.name, bytes);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 422 });

  const ctx = buildContext(file.name, bytes);

  // Column mapping for the generic "any other broker" source. Absent on the
  // first pass (the UI has not asked the question yet) and on every file a
  // hand-written parser claims — those parsers ignore ctx.generic entirely.
  const rawMapping = form.get("mapping");
  if (rawMapping) {
    try {
      const m = JSON.parse(String(rawMapping)) as { broker?: string; mapping?: unknown; defaultProduct?: ProductHint };
      if (!m.broker || !BROKERS.includes(m.broker as Broker)) {
        return NextResponse.json({ error: "Pick which broker this file is from." }, { status: 400 });
      }
      ctx.generic = {
        broker: m.broker as Broker,
        mapping: (m.mapping ?? {}) as ColumnMapping,
        defaultProduct: m.defaultProduct ?? null,
      };
    } catch {
      return NextResponse.json({ error: "Malformed column mapping." }, { status: 400 });
    }
  }

  // The guard above catches every known throw; this keeps an unforeseen one
  // (a container XLSX opens but a detector's cell read chokes on) at 422
  // rather than a 500 the client cannot JSON-parse.
  let ranked, chosen;
  try {
    ranked = rankParsers(ctx);
    chosen = forcedSource
      ? ranked.find((p) => p.sourceId === forcedSource) ?? null
      : detectParser(ctx);
  } catch (e) {
    return NextResponse.json({ error: unreadableError(e) }, { status: 422 });
  }

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

  // A file waiting on its column mapping has no trades yet. Committing it
  // would write an empty batch and read as "import did nothing".
  if (parsed.format === "generic-unmapped" && mode === "commit") {
    return NextResponse.json(
      { error: "Map the columns before importing this file." },
      { status: 422 },
    );
  }

  if (mode === "commit") {
    try {
      const result = commitParsedFile(parsed, file.name, productOverrides, accountId);
      revalidatePath("/trades");
      revalidatePath("/");
      return NextResponse.json({
        mode: "commit",
        detected: { sourceId: chosen.sourceId, label: chosen.label, confidence: chosen.confidence },
        result,
        warnings: parsed.warnings,
      });
    } catch (e) {
      // No account to land on (All accounts selected, no accountId in the
      // form): a 400 with a stable code, not a 500 the client reads as a
      // crash. getWriteAccountId throws this since v3.8 — no lowest-id fallback.
      if (e instanceof AccountRequiredError) {
        return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
      }
      return NextResponse.json({ error: `Commit failed: ${(e as Error).message}` }, { status: 500 });
    }
  }

  // preview
  let preview;
  try {
    preview = previewParsedFile(parsed, productOverrides, accountId, file.name);
  } catch (e) {
    if (e instanceof AccountRequiredError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    throw e;
  }
  const kind = classifyFileKind(parsed.format);
  return NextResponse.json({
    mode: "preview",
    detected: { sourceId: chosen.sourceId, label: chosen.label, confidence: chosen.confidence },
    candidates: ranked.map((p) => ({ sourceId: p.sourceId, label: p.label, confidence: p.confidence })),
    // What this KIND of file can and cannot tell us — drives whether the UI
    // asks for product types or trusts the file.
    fileKind: capabilityOf(kind, parsed.format),
    // Present only for the generic source: the file's own headers, sample rows
    // and a suggested mapping for the user to confirm or correct.
    table: parsed.table ?? null,
    warnings: parsed.warnings,
    preview,
  });
}
