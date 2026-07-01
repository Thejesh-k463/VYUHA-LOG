import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CorporateActionManager } from "@/components/system/corporate-action-manager";
import { getCorporateActions } from "@/lib/queries/corporate-actions";

export const dynamic = "force-dynamic";

export default function CorporateActionsPage() {
  const rows = getCorporateActions();
  const pending = rows.filter((r) => !r.appliedAt).length;

  return (
    <>
      <PageHeader
        title="Corporate actions"
        description="Splits, bonuses and dividends — apply to currently-open positions so qty, avg cost, stops and targets stay correct."
        actions={<Badge variant="secondary">{rows.length} events · {pending} pending</Badge>}
      />
      <div className="space-y-5 p-6">
        <Card>
          <CardHeader>
            <CardTitle>Events</CardTitle>
          </CardHeader>
          <CardContent>
            <CorporateActionManager rows={rows} />
          </CardContent>
        </Card>
        <p className="text-[11px] text-muted-foreground">
          <strong>Split / bonus</strong> scales quantity up and every price level (avg cost, SL, trailing SL, target)
          down by the same factor for every currently-open position in that symbol — invested value and ₹
          stop-distance are both preserved. <strong>Dividend</strong> posts one Cash &amp; Ledger entry per open LONG
          EQUITY holding (options/futures don&apos;t pay dividends; a short seller owes rather than receives one — not
          modelled here). Each event can only be applied once (locked after apply); applying doesn&apos;t retroactively
          touch already-closed trades. Post-2020 dividends are taxable in your hands with 10% TDS above ₹5,000/company/
          FY (section 194) — each dividend posts a matching TDS ledger entry once that company&apos;s FY aggregate
          crosses the threshold; see the Dividend &amp; TDS card on Tax Summary for the per-company breakdown.
        </p>
      </div>
    </>
  );
}
