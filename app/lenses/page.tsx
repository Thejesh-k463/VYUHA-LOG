import { PageHeader } from "@/components/layout/page-header";
import { LensesClient } from "@/components/lenses/lenses-client";
import { getLensTrades, getLensChargeRows, getImportBatches } from "@/lib/queries/trades";
import { getPlaybooks } from "@/lib/queries/playbooks";
import { getEntitlement } from "@/lib/queries/license";
import { LENSES, lensGroups, groupIds, type LensKind } from "@/lib/domain/lenses";
import { toLensRow, lensChargeHeads, type LensRow } from "@/lib/domain/lens-edge";
import { computeKpis } from "@/lib/analytics/metrics";
import { runRules } from "@/lib/intelligence/insight";
import { GROUP_RULES } from "@/lib/intelligence/rules/group";

export const dynamic = "force-dynamic";

export default function LensesPage() {
  // The slim projection is selected in SQL — same rows, order and values as
  // getTrades().map(toSlimTrade), without mapping 74 columns to keep 43
  // (perf sweep 2026-08-29).
  const trades = getLensTrades();
  const batches = getImportBatches().map((b) => ({
    id: b.id,
    fileName: b.fileName,
    broker: b.broker,
    importedAt: b.importedAt ?? "",
  }));
  const playbooks = getPlaybooks().map((p) => ({ id: p.id, name: p.name }));

  // HYBRID GATING — the split happens HERE, on the server. The client never
  // sees `computeKpis`; when unlicensed the wire carries `edge: null` and the
  // Pro figures simply do not exist in the payload. Grouping, counts, sums
  // and the per-group delete stay free (invariant 7 — this page is on the
  // pro-gating free list and must never grow a whole-page gate component).
  const pro = getEntitlement().pro;
  const byId = new Map(trades.map((t) => [t.id, t]));
  // Second narrow projection: the 10 charge heads per trade, aggregated to one
  // LensChargeHeads per group HERE — the per-trade charge columns never reach
  // the client (LENS_FIELDS stays 19 columns, the render-windowing budget).
  const chargeById = new Map(getLensChargeRows().map((c) => [c.id, c]));
  const rows = {} as Record<LensKind, Record<string, LensRow>>;
  for (const lens of LENSES) {
    const perGroup: Record<string, LensRow> = {};
    for (const group of lensGroups(lens.kind, trades, { batches, playbooks })) {
      const ids = groupIds(group, trades);
      const members = ids.map((id) => byId.get(id)).filter((t) => t != null);
      const kpis = computeKpis(members);
      const chargeHeads = lensChargeHeads(
        ids.map((id) => chargeById.get(id)).filter((c) => c != null),
      );
      // Insights cite edge-class figures (loss shares, streaks, drag), so they
      // are computed and ATTACHED only when licensed — same wire proof as edge.
      const insights = pro
        ? runRules(GROUP_RULES, { label: group.label, kpis, members })
        : undefined;
      perGroup[group.key] = toLensRow(kpis, pro, { chargeHeads, insights });
    }
    rows[lens.kind] = perGroup;
  }

  return (
    <>
      <PageHeader
        title="Lenses"
        description="The same book, cut six ways — by month, broker, trade type, import file, setup and outcome."
      />
      <div className="space-y-5 p-6">
        <LensesClient
          // `toSlimTrade` already carries every field the lenses group on, so
          // this adds nothing to the RSC payload that /trades does not send.
          trades={trades}
          batches={batches}
          playbooks={playbooks}
          rows={rows}
          pro={pro}
        />
      </div>
    </>
  );
}
