import { NextResponse } from "next/server";
import { getEntitlement } from "@/lib/queries/license";
import { getSelectedAccountId } from "@/lib/queries/accounts";
import { getClinicTrades } from "@/lib/queries/trades";
import { todayIstIso } from "@/lib/domain/trading-day";
import { SEGMENTS, type Segment } from "@/lib/domain/constants";
import {
  JOURNAL_KELLY_WINDOWS,
  allViewRefusal,
  journalKelly,
  journalKellySlices,
  type JournalKellyResponse,
  type JournalKellyWindow,
} from "@/lib/analytics/journal-kelly";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SETUP_LEN = 200;

/**
 * GET /api/sizing/journal-kelly?segment=&setup=&window=all|12m — v4.7.0 C3
 * (design D3, D4). The Sizing Lab's Kelly tab reads the win rate and payoff of
 * ONE slice of the SELECTED account's closed trades, computed on demand here —
 * never on the page render, never from the Clinic's cache (which cannot answer a
 * 12-month window and may be stale), and never by running the Clinic report:
 * the projection is the Clinic's own (`getClinicTrades`) and the figures are
 * `journalKelly` → `kellyCeiling` over one sample.
 *
 * 403 → a free copy (the Lab is Pro, research R9).
 * 400 → an unknown segment or window, a setup without a segment, an over-long setup.
 * 200 → `{ slices, result }`. In the All-accounts view (selection 0) NOTHING is
 *       read: `slices` is empty and `result` is the typed `all-view` refusal
 *       (owner K6 — a Kelly from merged books describes neither; invariant 8).
 */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const windowRaw = sp.get("window") ?? "all";
  if (!(JOURNAL_KELLY_WINDOWS as readonly string[]).includes(windowRaw)) {
    return NextResponse.json({ ok: false, message: "window must be all or 12m." }, { status: 400 });
  }
  const window = windowRaw as JournalKellyWindow;
  const segmentRaw = sp.get("segment") || null;
  if (segmentRaw != null && !(SEGMENTS as readonly string[]).includes(segmentRaw)) {
    return NextResponse.json({ ok: false, message: "Unknown segment." }, { status: 400 });
  }
  const segment = segmentRaw as Segment | null;
  const setup = sp.get("setup") || null;
  if (setup != null && (segment == null || setup.length > MAX_SETUP_LEN)) {
    return NextResponse.json({ ok: false, message: "A setup is read within one segment." }, { status: 400 });
  }

  if (!getEntitlement().pro) {
    return NextResponse.json({ ok: false, message: "The Sizing Lab is part of Pro." }, { status: 403 });
  }

  const accountId = getSelectedAccountId();
  if (!(accountId > 0)) {
    const body: JournalKellyResponse = { slices: [], result: allViewRefusal() };
    return NextResponse.json(body);
  }

  const trades = getClinicTrades([accountId]);
  const today = todayIstIso();
  const body: JournalKellyResponse = {
    slices: journalKellySlices(trades, { window, today }),
    result: journalKelly(trades, { segment, setup, window, today }),
  };
  return NextResponse.json(body);
}
