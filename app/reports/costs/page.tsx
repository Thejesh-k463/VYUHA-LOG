import { PageHeader } from "@/components/layout/page-header";
import { HubTabs } from "@/components/reports/hub-tabs";
import { ProGate } from "@/components/system/pro-gate";
import { HUB_TAB_PARAM, hubForHref, resolveTab } from "@/lib/domain/hubs";
import { asWorkspace, hubStripTabs, type Workspace } from "@/lib/domain/workspace";
import { getSettings } from "@/lib/queries/settings";
import { ChargesTab } from "./_tabs/charges";
import { BrokerCompareTab } from "./_tabs/broker-compare";

export const dynamic = "force-dynamic";

/**
 * Costs (v4.6.0 W3, owner ruling T1) — the old /reports/charges and
 * /reports/broker-compare screens as one hub, one tab each. The tab comes
 * from `?tab=` (lib/domain/hubs.ts `resolveTab`); only the active tab's body
 * is rendered. Every tab is Pro.
 */
const HUB = hubForHref("/reports/costs")!;

const BODIES: Record<string, () => React.ReactNode> = {
  charges: () => <ChargesTab />,
  "broker-compare": () => <BrokerCompareTab />,
};

export default async function CostsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const tab = resolveTab(HUB, (await searchParams)[HUB_TAB_PARAM]);
  let workspace: Workspace = "both";
  try {
    workspace = asWorkspace(getSettings()?.workspace);
  } catch {
    // Read the way app/layout.tsx reads it: an unmigrated DB has no column,
    // and the strip then shows every tab.
  }
  return (
    <>
      <PageHeader title={HUB.label} description={tab.description} />
      <HubTabs hub={HUB} active={tab.id} visible={hubStripTabs(HUB, tab.id, workspace)} />
      <div className="space-y-5 p-6">
        <ProGate>{BODIES[tab.id]()}</ProGate>
      </div>
    </>
  );
}
