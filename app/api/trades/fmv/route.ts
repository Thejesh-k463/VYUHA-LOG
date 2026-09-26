import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { trades } from "@/lib/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { recordAuditMany } from "@/lib/audit";
import { resolveTaxScope } from "@/lib/queries/tax-scope";
import { isGrandfatherEligible } from "@/lib/analytics/cg-heads";
import { fmvIsMixed, grandfatherKey } from "@/lib/analytics/grandfather-groups";

export const runtime = "nodejs";

const DELIVERY = new Set(["eq_delivery", "eq_mtf"]);

const bad = (message: string) => NextResponse.json({ ok: false, message }, { status: 400 });

/**
 * Set/clear the 31-Jan-2018 per-share FMV (LTCG grandfathering input) on every
 * lot of ONE scrip (v4.6.0 W7, D3). Body `{ ids, fmv, person? }`, or the legacy
 * `{ id, fmv }` (→ ids = [id]).
 *
 * Every check runs BEFORE the write and refuses with a 400 — nothing is
 * written on a refusal:
 *   1. ids non-empty, each a finite id > 0, no repeats;
 *   2. every id exists;
 *   3. every id's account is inside the tax person's scope (invariant 8 for a
 *      write; a trade id is never account 0, so invariant 9 holds);
 *   4. every lot shares ONE `grandfatherKey` (symbol + ISIN) — an FMV is a fact
 *      about one scrip and never lands on a second;
 *   5. every lot is equity delivery/MTF with an ELIGIBLE buy date
 *      (`isGrandfatherEligible` — never a byte compare). The readers ignore an
 *      FMV on an ineligible lot, so this refuses a write the UI never makes.
 *      An OPEN lot is allowed: a partly-sold pre-2018 ladder has realised rows
 *      the readers already apply its FMV to;
 *   6. fmv blank → null (clear), else a finite price > 0;
 *   7. a blank over a MIXED group (`fmvIsMixed` — the lots' stored values
 *      differ, NULL counting as a value) is refused: it would wipe the values
 *      that exist. A uniform group still clears in one Save (v4.6.0 fix wave,
 *      SG-1 — only the editor refused it, so a crafted POST nulled every lot).
 *
 * The write is ONE transaction: an UPDATE per lot (the FMV and updatedAt; no
 * quantity, so `side` is untouched) and one audit row PER TRADE, both snapshots
 * `{ fmv31Jan2018 }`.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return bad("Bad request");

  const rawIds: unknown[] = Array.isArray(body.ids) ? body.ids : body.id != null ? [body.id] : [];
  const ids = rawIds.map((v) => (typeof v === "number" || typeof v === "string" ? Number(v) : NaN));
  if (ids.length === 0 || ids.some((id) => !Number.isFinite(id) || id <= 0 || !Number.isInteger(id))) {
    return bad("Bad trade id");
  }
  if (new Set(ids).size !== ids.length) return bad("A trade id is repeated.");

  const rows = db.select().from(trades).where(inArray(trades.id, ids)).all();
  if (rows.length !== ids.length) return bad("Trade not found");

  const person = typeof body.person === "string" ? body.person : null;
  const scope = resolveTaxScope(person);
  if (rows.some((r) => !scope.accountIds.includes(r.accountId))) {
    return bad("A lot is outside the selected tax person's accounts.");
  }

  const key = grandfatherKey(rows[0]);
  if (rows.some((r) => grandfatherKey(r) !== key)) {
    return bad("One FMV belongs to one scrip — these lots are different scrips.");
  }
  if (rows.some((r) => !DELIVERY.has(r.segment) || !isGrandfatherEligible(r.buyDate))) {
    return bad("Grandfathering applies only to equity delivery lots bought before 1-Feb-2018.");
  }

  const raw = String(body.fmv ?? "").trim();
  const fmv = raw === "" ? null : Number(raw);
  if (fmv != null && (!Number.isFinite(fmv) || fmv <= 0)) {
    return bad("FMV must be a positive per-share price (or blank to clear).");
  }

  // Lots in the order asked, so "lot i of N" follows the editor's list.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const lots = ids.map((id) => byId.get(id)!);
  const n = lots.length;
  if (fmv == null && fmvIsMixed(lots)) {
    return bad(
      `These ${n} lots hold different FMVs, so a blank would wipe the values that exist. Enter one value to set all ${n} lots; to clear them, set one value first, then save blank.`,
    );
  }
  db.transaction((tx) => {
    for (const r of lots) {
      tx.update(trades).set({ fmv31Jan2018: fmv, updatedAt: sql`(datetime('now'))` }).where(eq(trades.id, r.id)).run();
    }
    recordAuditMany(
      lots.map((r, i) => ({
        entity: "trade" as const,
        entityId: r.id,
        action: "update" as const,
        summary: `${r.symbol} FMV@31-Jan-2018 ${fmv == null ? "cleared" : `set to ₹${fmv}`} (grandfathering, lot ${i + 1} of ${n})`,
        before: { fmv31Jan2018: r.fmv31Jan2018 },
        after: { fmv31Jan2018: fmv },
      })),
    );
  });
  revalidatePath("/reports/tax");
  const lotsText = n === 1 ? "" : ` on ${n} lots`;
  return NextResponse.json({
    ok: true,
    message: fmv == null ? `FMV cleared${lotsText}.` : `FMV ₹${fmv}/share saved${lotsText}.`,
  });
}
