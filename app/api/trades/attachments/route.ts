import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db, attachmentsDir } from "@/lib/db";
import { tradeAttachments, trades } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";

export const runtime = "nodejs";

// P2.4 — trade attachments (chart screenshots). Images only, bytes on disk
// under <data-dir>/attachments/, rows in trade_attachments. Not part of the
// JSON backup (stated on the Backup screen).

const ALLOWED_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB

function filePathFor(storedName: string): string {
  // storedName is generated server-side (hex + fixed extension), but never
  // trust a path from the DB blindly — resolve and confine to attachmentsDir.
  const p = path.resolve(attachmentsDir, storedName);
  if (!p.startsWith(path.resolve(attachmentsDir))) throw new Error("bad path");
  return p;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const tradeId = url.searchParams.get("tradeId");
  const id = url.searchParams.get("id");

  if (tradeId != null) {
    const rows = db
      .select()
      .from(tradeAttachments)
      .where(eq(tradeAttachments.tradeId, Number(tradeId)))
      .all();
    return NextResponse.json({
      ok: true,
      attachments: rows.map((r) => ({ id: r.id, fileName: r.fileName, mime: r.mime, sizeBytes: r.sizeBytes, createdAt: r.createdAt })),
    });
  }

  if (id != null) {
    const row = db.select().from(tradeAttachments).where(eq(tradeAttachments.id, Number(id))).all()[0];
    if (!row) return NextResponse.json({ ok: false, message: "Not found" }, { status: 404 });
    try {
      const bytes = fs.readFileSync(filePathFor(row.storedName));
      return new NextResponse(new Uint8Array(bytes), {
        headers: {
          "Content-Type": row.mime,
          "Content-Disposition": `inline; filename="${row.fileName.replace(/[^\w.\- ]/g, "_")}"`,
          "Cache-Control": "private, max-age=3600",
        },
      });
    } catch {
      return NextResponse.json({ ok: false, message: "File missing on disk" }, { status: 404 });
    }
  }

  return NextResponse.json({ ok: false, message: "tradeId or id required" }, { status: 400 });
}

export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") ?? "";

  // delete action arrives as JSON
  if (contentType.includes("application/json")) {
    const body = await req.json().catch(() => null);
    if (body?.action === "delete") {
      const id = Number(body.id);
      const row = db.select().from(tradeAttachments).where(eq(tradeAttachments.id, id)).all()[0];
      if (!row) return NextResponse.json({ ok: false, message: "Not found" }, { status: 404 });
      db.delete(tradeAttachments).where(eq(tradeAttachments.id, id)).run();
      try {
        fs.unlinkSync(filePathFor(row.storedName));
      } catch {
        /* row removed; a missing file is fine */
      }
      recordAudit({
        entity: "trade",
        entityId: row.tradeId,
        action: "update",
        summary: `Attachment removed: ${row.fileName}`,
        before: { attachmentId: row.id, fileName: row.fileName },
        after: null,
      });
      return NextResponse.json({ ok: true, message: "Attachment deleted." });
    }
    return NextResponse.json({ ok: false, message: "Unknown action" }, { status: 400 });
  }

  // upload arrives as multipart form-data
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ ok: false, message: "Bad form data" }, { status: 400 });
  const tradeId = Number(form.get("tradeId"));
  const file = form.get("file");
  if (!Number.isFinite(tradeId) || !(file instanceof File)) {
    return NextResponse.json({ ok: false, message: "tradeId and file are required" }, { status: 400 });
  }
  const trade = db.select({ id: trades.id }).from(trades).where(eq(trades.id, tradeId)).all()[0];
  if (!trade) return NextResponse.json({ ok: false, message: "No such trade" }, { status: 404 });

  const ext = ALLOWED_MIME[file.type];
  if (!ext) return NextResponse.json({ ok: false, message: "Images only (PNG/JPG/WebP/GIF)." }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ ok: false, message: "Max 8 MB per image." }, { status: 400 });

  const storedName = `${crypto.randomBytes(16).toString("hex")}${ext}`;
  fs.mkdirSync(attachmentsDir, { recursive: true });
  fs.writeFileSync(filePathFor(storedName), Buffer.from(await file.arrayBuffer()));

  const inserted = db
    .insert(tradeAttachments)
    .values({ tradeId, fileName: file.name || `chart${ext}`, storedName, mime: file.type, sizeBytes: file.size })
    .run();
  recordAudit({
    entity: "trade",
    entityId: tradeId,
    action: "update",
    summary: `Attachment added: ${file.name}`,
    before: null,
    after: { fileName: file.name, sizeBytes: file.size },
  });
  return NextResponse.json({ ok: true, message: "Attached.", id: Number(inserted.lastInsertRowid) });
}
