import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { saveCurrentAsBaseline, restoreBaseline, baselineDiff } from "@/lib/queries/settings-baseline";

export const runtime = "nodejs";

const Body = z.object({ action: z.enum(["save", "restore", "diff"]) });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });

  if (parsed.data.action === "diff") return NextResponse.json({ ok: true, ...baselineDiff() });

  const res = parsed.data.action === "save" ? saveCurrentAsBaseline() : restoreBaseline();
  if (res.ok) revalidatePath("/", "layout"); // theme/accent may have changed app-wide
  return NextResponse.json(res, { status: res.ok ? 200 : 400 });
}
