import { PageHeader } from "@/components/layout/page-header";
import { ProGate } from "@/components/system/pro-gate";
import { ReconcileTables, type ReconcileBook } from "@/components/reports/reconcile-tables";
import { getReferenceRows, reconcile } from "@/lib/queries/reference";
import { getAccounts, getSelectedAccountId, isAggregateView } from "@/lib/queries/accounts";
import { summariseSources } from "@/lib/analytics/reconcile";

/**
 * v3.9 "Trust the numbers" — Broker truth.
 *
 * The broker's own figures beside the book's, with the delta and the reasons.
 * EVERY number on this screen comes out of `reconcile()`; this file reads,
 * groups by account and hands over. It computes nothing — a total recomputed
 * on the way to a page is a second arithmetic path over the same cells, and
 * `tests/reconcile-screen.test.ts` fails if one appears here.
 *
 * Aggregate view ("All accounts", id 0) renders one BOOK PER ACCOUNT rather
 * than one summed book: two brokers' statements added together is a figure no
 * statement states, and invariant 8 exists to stop exactly that merge.
 */

export const dynamic = "force-dynamic";

export default function BrokerTruthPage() {
  const aggregate = isAggregateView();
  const selected = getSelectedAccountId();
  const accounts = aggregate
    ? getAccounts().map((a) => ({ id: a.id, name: a.name }))
    : getAccounts().filter((a) => a.id === selected).map((a) => ({ id: a.id, name: a.name }));

  const books: ReconcileBook[] = accounts.map((a) => ({
    accountId: a.id,
    accountName: a.name,
    recon: reconcile(a.id),
    sources: summariseSources(getReferenceRows(a.id)),
  }));

  return (
    <>
      <PageHeader
        title="Broker truth"
        description="Your broker's own figures beside Vyuha's — the difference, and what accounts for it."
      />
      <div className="space-y-5 p-6">
        <ProGate>
          <ReconcileTables books={books} aggregate={aggregate} />
        </ProGate>
      </div>
    </>
  );
}
