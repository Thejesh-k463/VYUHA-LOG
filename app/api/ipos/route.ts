import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { ipos } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";

export const runtime = "nodejs";

const num = (v: unknown): number => {
  const x = Number(String(v ?? "").trim());
  return Number.isFinite(x) ? x : 0;
};
const numOrNull = (v: unknown): number | null => {
  const s = String(v ?? "").trim();
  if (s === "") return null;
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
};
const strOrNull = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
};

function revalidate() {
  for (const p of ["/ipos", "/settings", "/"]) revalidatePath(p);
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });

  const name = strOrNull(body.name);
  if (!name) return NextResponse.json({ ok: false, message: "IPO name is required." }, { status: 400 });

  const allotted = Boolean(body.allotted);
  const values = {
    name,
    broker: strOrNull(body.broker),
    exchange: strOrNull(body.exchange) ?? "NSE",
    appliedPrice: num(body.appliedPrice),
    lotSize: Math.max(1, Math.round(num(body.lotSize)) || 1),
    lotsApplied: Math.max(1, Math.round(num(body.lotsApplied)) || 1),
    allotted,
    allottedQty: allotted ? num(body.allottedQty) : 0,
    listingPrice: numOrNull(body.listingPrice),
    exitPrice: numOrNull(body.exitPrice),
    appliedDate: strOrNull(body.appliedDate),
    listingDate: strOrNull(body.listingDate),
    exitDate: strOrNull(body.exitDate),
    notes: strOrNull(body.notes),
  };

  const id = Number(body.id);
  if (Number.isFinite(id) && id > 0) {
    db.update(ipos).set({ ...values, updatedAt: sql`(datetime('now'))` }).where(eq(ipos.id, id)).run();
    revalidate();
    return NextResponse.json({ ok: true, message: "IPO updated.", id });
  }
  const row = db.insert(ipos).values(values).returning({ id: ipos.id }).get();
  revalidate();
  return NextResponse.json({ ok: true, message: "IPO added.", id: row!.id });
}

export async function DELETE(req: Request) {
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isFinite(id)) return NextResponse.json({ ok: false, message: "Bad id" }, { status: 400 });
  db.delete(ipos).where(eq(ipos.id, id)).run();
  revalidate();
  return NextResponse.json({ ok: true, message: "IPO deleted." });
}
