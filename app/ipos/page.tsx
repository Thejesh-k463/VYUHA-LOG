import { PageHeader } from "@/components/layout/page-header";
import { IpoClient } from "@/components/ipo/ipo-client";
import { getIposComputed } from "@/lib/queries/ipos";

export const dynamic = "force-dynamic";

export default function IposPage() {
  const { rows, summary } = getIposComputed();
  return (
    <>
      <PageHeader title="IPOs" description="Track applications, allotment, listing & exit P&L." />
      <div className="space-y-5 p-6">
        <IpoClient rows={rows} summary={summary} />
      </div>
    </>
  );
}
