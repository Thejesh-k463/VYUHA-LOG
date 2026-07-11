import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AisReconcile } from "@/components/reports/ais-reconcile";

export const dynamic = "force-dynamic";

export default function AisReconcilePage() {
  return (
    <>
      <PageHeader
        title="AIS / 26AS Reconciliation"
        description="Reconcile the IT-department's Annual Information Statement against your journal before filing."
      />
      <div className="space-y-5 p-6">
        <Card>
          <CardHeader>
            <CardTitle>Paste AIS / Form 26AS rows</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Open your AIS (compliance portal → AIS) or Form 26AS and copy the rows you want checked — one per
              line as <span className="font-mono">type, company/symbol, FY-or-date, amount[, TDS]</span>. Types:
              dividend, sale (SFT-18), purchase (SFT-17), interest. The journal side comes from your Corporate
              Actions dividends (incl. TDS), delivery/MTF trades and IPO allotments/exits. Tolerance:
              max(₹10, 0.5%).
            </p>
            <AisReconcile />
            <p className="text-[11px] text-muted-foreground">
              Informational, not filing advice. AIS aggregates by reporting entity and may include off-journal
              accounts (other demats, bank interest) — a &quot;Not in journal&quot; row isn&apos;t necessarily an
              error, but a MISMATCH on a company you track deserves a look before you file.
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
