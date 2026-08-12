import { PageHeader } from "@/components/layout/page-header";
import { LensesClient } from "@/components/lenses/lenses-client";
import { toSlimTrade } from "@/lib/domain/slim-trade";
import { getTrades, getImportBatches } from "@/lib/queries/trades";
import { getPlaybooks } from "@/lib/queries/playbooks";
import { getEntitlement } from "@/lib/queries/license";
import { LENSES, lensGroups, groupIds, type LensKind } from "@/lib/domain/lenses";
import { toLensRow, type LensRow } from "@/lib/domain/lens-edge";
import { computeKpis } from "@/lib/analytics/metrics";

export const dynamic = "force-dynamic";

export default function LensesPage() {
  const trades = getTrades().map(toSlimTrade);
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
  const rows = {} as Record<LensKind, Record<string, LensRow>>;
  for (const lens of LENSES) {
    const perGroup: Record<string, LensRow> = {};
    for (const group of lensGroups(lens.kind, trades, { batches, playbooks })) {
      const members = groupIds(group, trades)
        .map((id) => byId.get(id))
        .filter((t) => t != null);
      perGroup[group.key] = toLensRow(computeKpis(members), pro);
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
