import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { compoundRealised } from "@/lib/queries/capital";

export const runtime = "nodejs";

/**
 * Compound realised P&L into the selected account's bucket capital.
 * The decision and the writes live in lib/queries/capital.ts
 * (`compoundRealised`) so the temp-DB tests exercise the real path; this
 * route only parses, calls, and revalidates.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const bucket = body?.bucket === "active" ? "active" : "equity";

  const res = compoundRealised(bucket);
  if (!res.ok) {
    // "Nothing to compound" is a normal outcome, not an error status.
    const status = res.message.startsWith("No new realised") ? 200 : 400;
    return NextResponse.json(res, { status });
  }

  for (const p of ["/", "/settings", "/equity", "/active", "/targets/equity", "/targets/active", "/risk", "/ipos"]) {
    revalidatePath(p);
  }
  return NextResponse.json(res);
}
