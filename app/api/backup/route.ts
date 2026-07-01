import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { dumpDatabase, restoreDatabase, readSqliteFile } from "@/lib/backup";
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
  if (!body || body.action !== "restore") {
    return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });
  }
  const res = restoreDatabase(body.dump);
  if (res.ok) {
    recordAudit({ entity: "settings", action: "update", summary: `restored from backup — ${res.restored} rows`, source: "backup" });
    for (const p of ["/", "/audit", "/cash", "/trades", "/risk", "/ipos"]) revalidatePath(p);
  }
  return NextResponse.json(res, { status: res.ok ? 200 : 400 });
}
