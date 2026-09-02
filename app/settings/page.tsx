import { PageHeader } from "@/components/layout/page-header";
import { SettingsForm } from "@/components/settings/settings-form";
import { DefaultSettingsCard } from "@/components/settings/default-settings-card";
import { RiskEditor } from "@/components/settings/risk-editor";
import { ChargeEditor } from "@/components/settings/charge-editor";
import { CapitalCard } from "@/components/settings/capital-card";
import { LicenseCard } from "@/components/settings/license-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/lib/db";
import { chargeConfig, riskConfig } from "@/lib/db/schema";
import { getSettings } from "@/lib/queries/settings";
import { getCapitalSummary, getCapitalHistory, getBucketCapital } from "@/lib/queries/capital";
import { getGoalView } from "@/lib/queries/goals";
import { GoalCard } from "@/components/settings/goal-card";
import { getLicenseStatus, getEntitlement } from "@/lib/queries/license";
import { CapitalGrowth } from "@/components/dashboard/charts";
import { AccountManager } from "@/components/settings/account-manager";
import { getAccounts } from "@/lib/queries/accounts";
import { TelegramCard } from "@/components/settings/telegram-card";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const settings = getSettings();
  const chargeRows = db.select().from(chargeConfig).all();
  const riskRows = db.select().from(riskConfig).all();
  const capital = getCapitalSummary();
  const bucketCapital = getBucketCapital();
  const goalView = getGoalView();
  // Absolute per-bucket targets become reference lines on the capital chart;
  // a %-goal's resolved level needs its frozen baseline, so only those with
  // one draw (never an invented level — invariant 6).
  const goalLevel = (bucket: "equity" | "active"): number | null => {
    const g = goalView.goals.find((x) => x.bucket === bucket);
    if (!g) return null;
    if (g.kind === "absolute") return g.targetAmount;
    return g.baselineCapital != null && g.pctTarget != null ? g.baselineCapital * (1 + g.pctTarget / 100) : null;
  };

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
        {/* Explicit props, not the settings row: the encrypted token must not
            cross to the client even as ciphertext — `connected` is all the
            card needs to know. */}
        <TelegramCard
          enabled={settings.telegramEnabled}
          ackVersion={settings.telegramAckVersion}
          sendTime={settings.telegramSendTime}
          lastSentDate={settings.lastTelegramSentDate}
          connected={Boolean(settings.telegramTokenEnc && settings.telegramChatId)}
          chatId={settings.telegramChatId}
        />
        <DefaultSettingsCard />
        <AccountManager accounts={getAccounts()} />
        <LicenseCard status={getLicenseStatus()} entitlement={getEntitlement()} />
        <CapitalCard summary={capital} />
        <GoalCard
          goals={goalView.goals}
          capital={{ equity: bucketCapital.equityCapital, active: bucketCapital.activeCapital, total: bucketCapital.totalCapital }}
          aggregate={goalView.aggregate}
          excluded={goalView.excluded}
        />
        <Card>
          <CardHeader><CardTitle>Capital growth</CardTitle></CardHeader>
          <CardContent>
            <CapitalGrowth data={getCapitalHistory()} targets={{ equity: goalLevel("equity"), active: goalLevel("active") }} />
            <p className="mt-2 text-[0.6875rem] text-muted-foreground">
              Capital checkpoints per bucket (snapshots taken when capital changes), ending at today&apos;s live values.
            </p>
          </CardContent>
        </Card>
        <RiskEditor rows={riskRows} />
        <ChargeEditor rows={chargeRows} />
      </div>
    </>
  );
}
