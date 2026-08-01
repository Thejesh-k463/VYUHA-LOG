import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { dumpDatabase, restoreDatabase, readSqliteFile, encryptBackup, previewBackup } from "@/lib/backup";
import { recordAudit } from "@/lib/audit";

export const runtime = "nodejs";

function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ts = stamp();
  if (url.searchParams.get("format") === "sqlite") {
    const buf = readSqliteFile();
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="vyuha-${ts}.sqlite"`,
      },
    });
  }
  const dump = dumpDatabase();
  return new NextResponse(JSON.stringify(dump), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="vyuha-backup-${ts}.json"`,
    },
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });
  }
  if (body.action === "export") {
    try {
      const dump = dumpDatabase(body.includeAttachments !== false);
      const payload = body.password ? encryptBackup(dump, String(body.password)) : dump;
      return NextResponse.json({ ok: true, payload, fileName: `vyuha-backup-${stamp()}${body.password ? ".encrypted" : ""}.json` });
    } catch (e) {
      return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "Backup failed." }, { status: 400 });
    }
  }
  const preview = previewBackup(body.dump, String(body.password ?? ""));
  if (body.action === "preview") {
    const { dump: _dump, ...safe } = preview as typeof preview & { dump?: unknown };
    void _dump;
    return NextResponse.json(safe, { status: preview.ok ? 200 : 400 });
  }
  if (body.action !== "restore" || !preview.ok || !("dump" in preview)) {
    return NextResponse.json({ ok: false, message: preview.message ?? "Bad request" }, { status: 400 });
  }
  const res = restoreDatabase(preview.dump);
  if (res.ok) {
    recordAudit({ entity: "settings", action: "update", summary: `restored from backup — ${res.restored} rows`, source: "backup" });
    for (const p of ["/", "/audit", "/cash", "/trades", "/risk", "/ipos"]) revalidatePath(p);
  }
  return NextResponse.json(res, { status: res.ok ? 200 : 400 });
}
