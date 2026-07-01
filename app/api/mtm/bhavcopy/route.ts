import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { applyBhavcopyMtm } from "@/lib/import/mtm-bhavcopy";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.text !== "string") {
    return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });
  }
  const res = applyBhavcopyMtm(body.text);
  if (res.ok) for (const p of ["/risk", "/equity", "/active", "/", "/reports/performance", "/strategies"]) revalidatePath(p);
  return NextResponse.json(res, { status: res.ok ? 200 : 400 });
}
