import { NextResponse } from "next/server";
import { getItrExportRows } from "@/lib/queries/tax-itr";
import { getEntitlement } from "@/lib/queries/license";
import { resolveTaxScope, taxScopeHeader } from "@/lib/queries/tax-scope";

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
export async function GET(req: Request) {
  const ent = getEntitlement();
  if (!(ent.state === "licensed" || ent.pro || ent.enforcement === "banner")) {
    return NextResponse.json({ ok: false, message: "Vyuha Pro required." }, { status: 403 });
  }
  // v4.5.0 wave TP — the export is a TAX PERSON's, not an account's. `?person`
  // carries the picker's choice from the page so the file the user downloads
  // covers exactly the accounts the page just showed (owner ruling T1). A read
  // only: nothing is written and nothing is persisted.
  const person = new URL(req.url).searchParams.get("person");
  const scope = resolveTaxScope(person);
  const rows = getItrExportRows(person);
  return NextResponse.json({ ok: true, rows, total: rows.length, scope: taxScopeHeader(scope) });
}
