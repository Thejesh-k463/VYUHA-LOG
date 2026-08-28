import { NextResponse } from "next/server";
import { getItrExportRows } from "@/lib/queries/tax-itr";
import { getEntitlement } from "@/lib/queries/license";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The full ITR-schedule-shaped per-trade export (closed equity + F&O + exited
 * IPOs) — fetched only when the user clicks CSV/XLSX on /reports/tax, never as
 * part of a render. At 25k trades the old inline props serialised ~4.8 MB of
 * never-rendered rows into every visit's RSC payload (the /cash ledger export
 * had the identical disease at 60k entries — same cure, see /api/ledger).
 *
 * The Tax Summary sits behind <ProGate>; mirror its ONLY blocking branch
 * (enforcement "block" with no licence/trial) so this endpoint is not a side
 * door around the gate. Every other entitlement state renders the page's
 * content, so it gets the export too.
 */
export async function GET() {
  const ent = getEntitlement();
  if (!(ent.state === "licensed" || ent.pro || ent.enforcement === "banner")) {
    return NextResponse.json({ ok: false, message: "Vyuha Pro required." }, { status: 403 });
  }
  const rows = getItrExportRows();
  return NextResponse.json({ ok: true, rows, total: rows.length });
}
