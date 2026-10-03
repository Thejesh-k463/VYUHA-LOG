import { NextResponse } from "next/server";
import { getEntitlement } from "@/lib/queries/license";
import { abandonExperiment, startExperiment } from "@/lib/queries/edge-clinic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/edge-clinic/experiments — v4.7.0 C2 (design D5 + review change 5).
 *
 *   POST  { cellKey: string }                 → start one experiment on that cell
 *   PATCH { id: number, status: "abandoned" } → set an open experiment aside
 *
 * Pro only: 403 `{ ok: false, message }` when `getEntitlement().pro` is false (the
 * one entitlement predicate). The account is the SELECTED one: the All view (0)
 * is refused 400 on POST (invariant 9 — a view is never a write target), and
 * PATCH requires `exp.accountId === selected > 0` (403 otherwise).
 *
 * 200 → `{ ok: true, experiment: ClinicExperiment }`
 * 4xx → `{ ok: false, message }` (400 bad body / All view / ungraded cell,
 *        403 not Pro / another account, 404 unknown id, 409 duplicate or not open
 *        or no cached report yet).
 */
function notPro() {
  return NextResponse.json({ ok: false, message: "The Edge Clinic's experiments are part of Pro." }, { status: 403 });
}

async function body(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  if (!getEntitlement().pro) return notPro();
  const b = await body(req);
  const cellKey = typeof b?.cellKey === "string" ? b.cellKey.trim() : "";
  if (!cellKey || cellKey.length > 200) return NextResponse.json({ ok: false, message: "cellKey is required." }, { status: 400 });
  const r = startExperiment(cellKey);
  return r.ok ? NextResponse.json(r) : NextResponse.json({ ok: false, message: r.message }, { status: r.status });
}

export async function PATCH(req: Request) {
  if (!getEntitlement().pro) return notPro();
  const b = await body(req);
  const id = typeof b?.id === "number" && Number.isInteger(b.id) && b.id > 0 ? b.id : null;
  if (id == null || b?.status !== "abandoned") {
    return NextResponse.json({ ok: false, message: "Send { id, status: \"abandoned\" }." }, { status: 400 });
  }
  const r = abandonExperiment(id);
  return r.ok ? NextResponse.json(r) : NextResponse.json({ ok: false, message: r.message }, { status: r.status });
}
