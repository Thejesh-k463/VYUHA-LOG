import { PageHeader } from "@/components/layout/page-header";
import { SettingsForm } from "@/components/settings/settings-form";
import { RiskEditor } from "@/components/settings/risk-editor";
import { ChargeEditor } from "@/components/settings/charge-editor";
import { CapitalCard } from "@/components/settings/capital-card";
import { Card, CardContent } from "@/components/ui/card";
import { db } from "@/lib/db";
import { chargeConfig, riskConfig } from "@/lib/db/schema";
import { getSettings } from "@/lib/queries/settings";
import { getCapitalSummary } from "@/lib/queries/capital";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const settings = getSettings();
  const chargeRows = db.select().from(chargeConfig).all();
  const riskRows = db.select().from(riskConfig).all();
  const capital = getCapitalSummary();

  if (!settings) {
    return (
      <>
        <PageHeader title="Settings" />
        <div className="p-6">
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">
              Database not seeded yet. Run{" "}
              <code className="rounded bg-card-hover px-1.5 py-0.5">npm run setup</code> and refresh.
            </CardContent>
          </Card>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Settings" description="Capital, go-live, charge rates and risk rules — all editable." />
      <div className="space-y-6 p-6">
        <SettingsForm current={settings} />
        <CapitalCard summary={capital} />
        <RiskEditor rows={riskRows} />
        <ChargeEditor rows={chargeRows} />
      </div>
    </>
  );
}
