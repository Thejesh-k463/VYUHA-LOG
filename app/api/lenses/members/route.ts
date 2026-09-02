import { NextResponse } from "next/server";
import { getLensTrades, getLensChargeRows, getImportBatches } from "@/lib/queries/trades";
import { getPlaybooks } from "@/lib/queries/playbooks";
import { getEntitlement } from "@/lib/queries/license";
import { lensGroups, groupIds, isLensKind } from "@/lib/domain/lenses";
import { toLensRow, lensChargeHeads } from "@/lib/domain/lens-edge";
import { computeKpis } from "@/lib/analytics/metrics";
import { runRules } from "@/lib/intelligence/insight";
import { GROUP_RULES } from "@/lib/intelligence/rules/group";

export const runtime = "nodejs";

/**
 * ONE LENS GROUP'S MEMBERS, ON DEMAND.
 *
 * `/lenses` renders a list of ~45 group rows and, only when one is clicked, a
 * drill-down over that group's trades. Shipping the whole book so the browser
 * could rebuild those groups itself cost ~9.3 MB of RSC flight per visit on
 * the 25,001-trade perf book — for rows nobody had asked to see yet. The page
 * now ships the group rows; this route answers the click.
 *
 * ── Why it re-derives rather than taking ids ────────────────────────────────
 *
 * It runs the SAME pure functions over the SAME projection (`getLensTrades`,
 * the 19-column read, unchanged ORDER BY, account scope via
 * `getSelectedAccountId` inside it — invariant 8). So `members` is
 * byte-for-byte the array the page used to hand the client: same rows, same
 * order, therefore the same float summation order in every figure derived from
 * it. Accepting a list of ids from the browser instead would let a caller ask
 * for any set at all — and this array feeds a DELETE preview.
 *
 * ── Why the charge heads and insights come from here ────────────────────────
 *
 * Both are drill-down-only. Computing them for every group of all six lenses
 * on every page load was 214 ms of `runRules` plus a second whole-book
 * projection read, for at most one group's worth of screen. They still pass
 * through `toLensRow`, so the Pro allow-list remains the single gate: an
 * unlicensed copy gets no `insights` key here either.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const lens = url.searchParams.get("lens");
  const key = url.searchParams.get("key");
  if (!isLensKind(lens) || !key) {
    return NextResponse.json({ ok: false, message: "Bad lens or group key" }, { status: 400 });
  }

  const trades = getLensTrades();
  const batches = getImportBatches().map((b) => ({
    id: b.id,
    fileName: b.fileName,
    broker: b.broker,
    importedAt: b.importedAt ?? "",
  }));
  const playbooks = getPlaybooks().map((p) => ({ id: p.id, name: p.name }));

  const group = lensGroups(lens, trades, { batches, playbooks }).find((g) => g.key === key);
  // A group key from a book that has since changed (the trades were deleted,
  // the import record removed) resolves to nothing. That is not an error —
  // 404 so the client can say "this group is gone" and go back to the list.
  if (!group) {
    return NextResponse.json({ ok: false, message: "That group is no longer in this book." }, { status: 404 });
  }

  const byId = new Map(trades.map((t) => [t.id, t]));
  const ids = groupIds(group, trades);
  const members = ids.map((id) => byId.get(id)).filter((t) => t != null);

  const chargeById = new Map(getLensChargeRows().map((c) => [c.id, c]));
  const chargeHeads = lensChargeHeads(ids.map((id) => chargeById.get(id)).filter((c) => c != null));

  const pro = getEntitlement().pro;
  const kpis = computeKpis(members);
  const row = toLensRow(kpis, pro, {
    chargeHeads,
    insights: pro ? runRules(GROUP_RULES, { label: group.label, kpis, members }) : undefined,
  });

  return NextResponse.json({
    ok: true,
    members,
    chargeHeads: row.totals.chargeHeads,
    insights: row.insights,
  });
}
