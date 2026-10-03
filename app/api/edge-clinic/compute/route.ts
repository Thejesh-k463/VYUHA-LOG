import { NextResponse } from "next/server";
import { computeClinic } from "@/lib/queries/edge-clinic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/edge-clinic/compute — v4.7.0 C2 (design D3). The ONLY caller of the
 * Edge Clinic engine: recomputes the SELECTED scope's report when its input digest
 * moved, upserts `clinic_cache`, and stamps experiments that reached their target.
 * A route handler, not a server action (AGENTS.md: a server action refreshes the
 * route and resets sibling client state); the client runner calls it once and then
 * `router.refresh()`.
 *
 * Open to a FREE copy on purpose: the one free card (the teaser) is derived from
 * this report, and what a free copy RECEIVES is cut by `clinicStateFor` on the
 * page — this response carries no report.
 *
 * Response 200: `{ ok: true, status: "fresh" | "computed", scopeKey, computedAt }`.
 * Response 500: `{ ok: false, message }`.
 */
export async function POST() {
  try {
    const r = await computeClinic();
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "Clinic compute failed" }, { status: 500 });
  }
}
