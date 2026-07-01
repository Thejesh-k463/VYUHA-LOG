import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AliasManager } from "@/components/system/alias-manager";
import { getAliases } from "@/lib/queries/aliases";

export const dynamic = "force-dynamic";

export default function AliasesPage() {
  const rows = getAliases();
  return (
    <>
      <PageHeader
        title="Symbol aliases"
        description="Map broker scrip names to NSE/BSE tickers so bhavcopy auto-MTM and surveillance lists match your positions."
        actions={<Badge variant="secondary">{rows.length} mapped</Badge>}
      />
      <div className="space-y-5 p-6">
        <Card>
          <CardHeader>
            <CardTitle>Mappings</CardTitle>
          </CardHeader>
          <CardContent>
            <AliasManager rows={rows} />
          </CardContent>
        </Card>
        <p className="text-[11px] text-muted-foreground">
          Broker P&amp;L files store full scrip names (e.g. &ldquo;ADANI TOTAL GAS LIMITED&rdquo;), while NSE/BSE bhavcopy
          and the F&amp;O ban / ASM / GSM lists use tickers (&ldquo;ATGL&rdquo;). These mappings let the app reconcile the
          two — used by Auto-MTM (Portfolio Risk) and Surveillance. Matching always tries the raw name first, then the
          alias, so a mapping is only needed where the names differ.
        </p>
      </div>
    </>
  );
}
