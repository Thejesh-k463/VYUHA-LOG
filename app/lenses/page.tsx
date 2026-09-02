import { PageHeader } from "@/components/layout/page-header";
import { LensesClient } from "@/components/lenses/lenses-client";
import { getLensTrades, getImportBatches } from "@/lib/queries/trades";
import { getPlaybooks } from "@/lib/queries/playbooks";
import { getEntitlement } from "@/lib/queries/license";
import { LENSES, lensGroups, groupIds, type LensKind } from "@/lib/domain/lenses";
import { toLensRow, type LensGroupRow } from "@/lib/domain/lens-edge";
import { computeKpis } from "@/lib/analytics/metrics";

export const dynamic = "force-dynamic";

export default function LensesPage() {
  // The slim projection is selected in SQL — same rows, order and values as
  // getTrades().map(toSlimTrade), without mapping every column to keep the
  // nineteen this page groups on (perf sweep 2026-08-29).
  const trades = getLensTrades();
  // `batches` and `playbooks` are LABEL SOURCES for the grouping, and the
  // grouping now happens only here — so neither crosses the RSC payload any
  // more (2026-09-02: they were shipped whole so the client could re-group).
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

  // GROUP ROWS, NOT THE BOOK. Every KPI below is still computed over the FULL
  // membership of its group — only the per-trade rows stopped crossing the
  // wire. The drill-down asks `/api/lenses/members` for one group's trades,
  // which is also where the charge heads and the Pro insights are computed:
  // both are drill-down-only, and running them for all six lenses on every
  // visit was the bulk of this page's server time.
  const lenses = {} as Record<LensKind, LensGroupRow[]>;
  for (const lens of LENSES) {
    lenses[lens.kind] = lensGroups(lens.kind, trades, { batches, playbooks }).map((group) => {
      const members = groupIds(group, trades)
        .map((id) => byId.get(id))
        .filter((t) => t != null);
      return { group, row: toLensRow(computeKpis(members), pro) };
    });
  }

  return (
    <>
      <PageHeader
        title="Lenses"
        description="The same book, cut six ways — by month, broker, trade type, import file, setup and outcome."
      />
      <div className="space-y-5 p-6">
        <LensesClient lenses={lenses} pro={pro} />
      </div>
    </>
  );
}
