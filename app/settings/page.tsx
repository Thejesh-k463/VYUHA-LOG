import { PageHeader } from "@/components/layout/page-header";
import {
  AppUpdatesCard,
  AppearanceCard,
  CapitalGoLiveCard,
  FirstRunCard,
  IntegrationsCard,
  PreferencesCard,
  SettingsFormProvider,
  SettingsLiveFeedCard,
  WorkspaceCard,
} from "@/components/settings/settings-form";
import { Section, SectionArrangeProvider, SectionStack } from "@/components/layout/section-stack";
import { RearrangeControls } from "@/components/layout/rearrange-controls";
import { DefaultSettingsCard } from "@/components/settings/default-settings-card";
import { RiskEditor } from "@/components/settings/risk-editor";
import { ChargeEditor } from "@/components/settings/charge-editor";
import { CapitalCard } from "@/components/settings/capital-card";
import { LicenseCard } from "@/components/settings/license-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/lib/db";
import { chargeConfig, riskConfig } from "@/lib/db/schema";
import { getRiskFree, getSettings } from "@/lib/queries/settings";
import { RiskFreeCard } from "@/components/settings/risk-free-card";
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
  const riskFree = getRiskFree();
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

  // Default order = PAGE_SECTIONS.settings (lib/domain/section-registry.ts):
  // capital first, the goals directly under total capital, Appearance LAST.
  // The user can move any card (Rearrange, saved on this device). Every
  // section arrives in the client stack as CHILDREN — never imported there —
  // so these server reads stay on the server.
  return (
    <SectionArrangeProvider page="settings">
      <PageHeader
        title="Settings"
        description="Capital, go-live, charge rates and risk rules — all editable."
        actions={<RearrangeControls page="settings" />}
      />
      <SettingsFormProvider current={settings}>
        <SectionStack page="settings" className="space-y-6 p-6">
          <Section id="settings-capital-golive"><CapitalGoLiveCard /></Section>
          <Section id="settings-capital-management"><CapitalCard summary={capital} /></Section>
          <Section id="settings-capital-goals">
            <GoalCard
              goals={goalView.goals}
              capital={{ equity: bucketCapital.equityCapital, active: bucketCapital.activeCapital, total: bucketCapital.totalCapital }}
              aggregate={goalView.aggregate}
              excluded={goalView.excluded}
            />
          </Section>
          <Section id="settings-capital-growth">
            <Card>
              <CardHeader><CardTitle>Capital growth</CardTitle></CardHeader>
              <CardContent>
                <CapitalGrowth data={getCapitalHistory()} targets={{ equity: goalLevel("equity"), active: goalLevel("active") }} />
                <p className="mt-2 text-[0.6875rem] text-muted-foreground">
                  Capital checkpoints per bucket (snapshots taken when capital changes), ending at today&apos;s live values.
                </p>
              </CardContent>
            </Card>
          </Section>
          <Section id="settings-workspace"><WorkspaceCard /></Section>
          <Section id="settings-preferences"><PreferencesCard /></Section>
          <Section id="settings-accounts"><AccountManager accounts={getAccounts()} /></Section>
          <Section id="settings-defaults"><DefaultSettingsCard /></Section>
          <Section id="settings-risk-rules">
            {/* v4.4.0 D5 — the dated risk-free rate sits with the risk rules
                rather than in a section of its own, so the section registry
                (and every saved arrangement) is unchanged. */}
            <div className="space-y-6">
              <RiskEditor rows={riskRows} />
              <RiskFreeCard ppm={riskFree.ppm} asOf={riskFree.asOf} label={riskFree.label} />
            </div>
          </Section>
          <Section id="settings-charge-rates"><ChargeEditor rows={chargeRows} /></Section>
          <Section id="settings-telegram">
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
          </Section>
          <Section id="settings-live-feed"><SettingsLiveFeedCard /></Section>
          <Section id="settings-integrations"><IntegrationsCard /></Section>
          <Section id="settings-license"><LicenseCard status={getLicenseStatus()} entitlement={getEntitlement()} /></Section>
          <Section id="settings-first-run"><FirstRunCard /></Section>
          <Section id="settings-app-updates"><AppUpdatesCard /></Section>
          <Section id="settings-appearance"><AppearanceCard /></Section>
        </SectionStack>
      </SettingsFormProvider>
    </SectionArrangeProvider>
  );
}
