import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { brokerConnections } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import { kiteImportSource, toParsedFile } from "@/lib/import/api/kite";
import { previewParsedFile, commitParsedFile } from "@/lib/import/commit";

export const runtime = "nodejs";

// P2.1 — broker-API auto-import. v1 supports Zerodha (Kite Connect). The pull
// reuses the exact file-import pipeline: normalize → preview/commit.

const mask = (s: string) => (s.length <= 4 ? "••••" : `${s.slice(0, 4)}…${"•".repeat(4)}`);

export async function GET() {
  const rows = db.select().from(brokerConnections).all();
  return NextResponse.json({
    ok: true,
    connections: rows.map((r) => ({
      broker: r.broker,
      apiKeyMasked: mask(r.apiKey),
      lastPullAt: r.lastPullAt,
      updatedAt: r.updatedAt,
    })),
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });
  }

  if (body.action === "save") {
    const broker = String(body.broker ?? "");
    const apiKey = String(body.apiKey ?? "").trim();
    const accessToken = String(body.accessToken ?? "").trim();
    if (broker !== "zerodha") {
      return NextResponse.json({ ok: false, message: "Only Zerodha (Kite Connect) is supported so far." }, { status: 400 });
    }
    if (!apiKey || !accessToken) {
      return NextResponse.json({ ok: false, message: "API key and access token are required." }, { status: 400 });
    }
    db.insert(brokerConnections)
      .values({ broker, apiKey, accessToken })
      .onConflictDoUpdate({
        target: brokerConnections.broker,
        set: { apiKey, accessToken, updatedAt: new Date().toISOString() },
      })
      .run();
    recordAudit({
      entity: "settings",
      action: "update",
      summary: `Broker connection saved: ${broker} (key ${mask(apiKey)})`,
      before: null,
      after: { broker, apiKey: mask(apiKey) }, // never audit the token
    });
    return NextResponse.json({ ok: true, message: "Connection saved. Kite access tokens expire daily — re-paste after each login." });
  }

  if (body.action === "disconnect") {
    const broker = String(body.broker ?? "");
    db.delete(brokerConnections).where(eq(brokerConnections.broker, broker)).run();
    recordAudit({ entity: "settings", action: "delete", summary: `Broker connection removed: ${broker}`, before: { broker }, after: null });
    return NextResponse.json({ ok: true, message: "Disconnected." });
  }

  if (body.action === "pull") {
    const broker = String(body.broker ?? "zerodha");
    const mode = body.mode === "commit" ? "commit" : "preview";
    const conn = db.select().from(brokerConnections).where(eq(brokerConnections.broker, broker)).all()[0];
    if (!conn) return NextResponse.json({ ok: false, message: "No saved connection — save the API key + access token first." }, { status: 400 });

    let parsed;
    try {
      const source = kiteImportSource({ apiKey: conn.apiKey, accessToken: conn.accessToken });
      parsed = toParsedFile(await source.fetchTrades({}));
    } catch (e) {
      return NextResponse.json({ ok: false, message: (e as Error).message }, { status: 502 });
    }

    if (mode === "commit") {
      const fileName = `kite-api-${new Date().toISOString().slice(0, 10)}`;
      const result = commitParsedFile(parsed, fileName);
      db.update(brokerConnections)
        .set({ lastPullAt: new Date().toISOString() })
        .where(eq(brokerConnections.broker, broker))
        .run();
      revalidatePath("/trades");
      revalidatePath("/");
      return NextResponse.json({ ok: true, mode, result, warnings: parsed.warnings });
    }

    return NextResponse.json({ ok: true, mode, preview: previewParsedFile(parsed), warnings: parsed.warnings });
  }

  return NextResponse.json({ ok: false, message: "Unknown action" }, { status: 400 });
}
