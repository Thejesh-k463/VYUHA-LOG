import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { brokerConnections } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import { kiteImportSource, toParsedFile as kiteToParsedFile } from "@/lib/import/api/kite";
import { dhanImportSource, toParsedFile as dhanToParsedFile } from "@/lib/import/api/dhan";
import { previewParsedFile, commitParsedFile } from "@/lib/import/commit";

export const runtime = "nodejs";

// Broker-API auto-import. Supports Zerodha (Kite Connect) and Dhan (DhanHQ v2).
// The pull reuses the exact file-import pipeline: normalize → preview/commit.
//
// Dhan matters for one specific reason: its API is the ONLY Dhan source that
// states MTF. Every Dhan file is silent about margin funding — a P&L export has
// no product column, and in a transaction report MTF is indistinguishable from
// delivery because the two carry identical STT and stamp duty while financing
// interest lives in the ledger. `productType: "MTF"` ends that guessing.

/** Brokers with a working API pull, and what each needs in the two fields. */
const API_BROKERS: Record<string, { label: string; keyLabel: string; note: string }> = {
  zerodha: {
    label: "Zerodha (Kite Connect)",
    keyLabel: "API key",
    note: "Kite access tokens expire daily — re-paste after each login.",
  },
  dhan: {
    label: "Dhan (DhanHQ v2)",
    keyLabel: "Client ID",
    note: "Dhan access tokens are issued from web.dhan.co → DhanHQ Trading APIs and are valid for 24 hours by default.",
  },
};

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
    const spec = API_BROKERS[broker];
    if (!spec) {
      return NextResponse.json(
        { ok: false, message: `Unsupported broker. Available: ${Object.values(API_BROKERS).map((b) => b.label).join(", ")}.` },
        { status: 400 },
      );
    }
    if (!apiKey || !accessToken) {
      return NextResponse.json({ ok: false, message: `${spec.keyLabel} and access token are required.` }, { status: 400 });
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
    return NextResponse.json({ ok: true, message: `Connection saved. ${spec.note}` });
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
      if (broker === "dhan") {
        // apiKey holds the Dhan CLIENT ID; the column is named for Kite, which
        // came first. Renaming it would need a migration for no behavioural gain.
        const source = dhanImportSource({ clientId: conn.apiKey, accessToken: conn.accessToken });
        parsed = dhanToParsedFile(await source.fetchTrades({}));
      } else {
        const source = kiteImportSource({ apiKey: conn.apiKey, accessToken: conn.accessToken });
        parsed = kiteToParsedFile(await source.fetchTrades({}));
      }
    } catch (e) {
      return NextResponse.json({ ok: false, message: (e as Error).message }, { status: 502 });
    }

    if (mode === "commit") {
      const fileName = `${broker === "dhan" ? "dhan" : "kite"}-api-${new Date().toISOString().slice(0, 10)}`;
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
