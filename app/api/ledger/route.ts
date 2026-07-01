import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { ledgerEntries } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { toPaise } from "@/lib/money";
import { LEDGER_TYPES, type LedgerType } from "@/lib/analytics/ledger";
import { recordAudit } from "@/lib/audit";

export const runtime = "nodejs";

// Types whose sign is fixed regardless of how the magnitude is entered.
const FIXED_SIGN: Partial<Record<LedgerType, 1 | -1>> = {
  deposit: 1,
  interest: 1,
  dividend: 1,
  withdrawal: -1,
  charge: -1,
  mtf_interest: -1,
};

function revalidate() {
  for (const p of ["/cash", "/", "/equity", "/active", "/risk"]) revalidatePath(p);
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });
  }

  if (body.action === "delete") {
    const id = Number(body.id);
    if (!Number.isFinite(id)) return NextResponse.json({ ok: false, message: "Bad id" }, { status: 400 });
    const prev = db.select().from(ledgerEntries).where(eq(ledgerEntries.id, id)).get();
    db.delete(ledgerEntries).where(eq(ledgerEntries.id, id)).run();
    recordAudit({
      entity: "ledger",
      entityId: id,
      action: "delete",
      summary: prev ? `${prev.type} ${prev.amountPaise} paise removed` : `entry ${id} removed`,
      before: prev ? { date: prev.date, bucket: prev.bucket, type: prev.type, amountPaise: prev.amountPaise } : null,
    });
    revalidate();
    return NextResponse.json({ ok: true, message: "Entry deleted." });
  }

  if (body.action === "add") {
    const type = body.type as LedgerType;
    if (!LEDGER_TYPES.includes(type)) {
      return NextResponse.json({ ok: false, message: "Unknown entry type" }, { status: 400 });
    }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : new Date().toISOString().slice(0, 10);
    const bucket = body.bucket === "equity" || body.bucket === "active" ? body.bucket : "";
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount === 0) {
      return NextResponse.json({ ok: false, message: "Enter a non-zero amount" }, { status: 400 });
    }
    const fixed = FIXED_SIGN[type];
    // Fixed-sign types use the magnitude; realised_pnl / adjustment keep the entered sign.
    const amountPaise = fixed != null ? fixed * toPaise(Math.abs(amount)) : toPaise(amount);
    const note = typeof body.note === "string" ? body.note.slice(0, 200) : null;

    const ins = db.insert(ledgerEntries).values({ date, bucket, type, amountPaise, note, source: "manual" }).returning({ id: ledgerEntries.id }).get();
    recordAudit({
      entity: "ledger",
      entityId: ins?.id ?? null,
      action: "create",
      summary: `${type} ${amountPaise} paise · ${bucket || "—"}`,
      after: { date, bucket, type, amountPaise, note },
    });
    revalidate();
    return NextResponse.json({ ok: true, message: "Ledger entry added." });
  }

  return NextResponse.json({ ok: false, message: "Unknown action" }, { status: 400 });
}
