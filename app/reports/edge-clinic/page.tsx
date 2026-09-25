import { PageHeader } from "@/components/layout/page-header";
import { HubTabs } from "@/components/reports/hub-tabs";
import { ProGate } from "@/components/system/pro-gate";
import { HUB_TAB_PARAM, hubForHref, resolveTab } from "@/lib/domain/hubs";
import { asWorkspace, hubStripTabs, type Workspace } from "@/lib/domain/workspace";
import { getSettings } from "@/lib/queries/settings";
import { SetupsTab } from "./_tabs/setups";
import { DisciplineTab } from "./_tabs/discipline";
import { ScalingTab } from "./_tabs/scaling";

export const dynamic = "force-dynamic";

/**
 * Edge Clinic (v4.6.0 W3, owner ruling T1) — the old /reports/edge,
 * /reports/discipline and /reports/scaling screens as one hub, one tab each.
 * The tab comes from `?tab=` (lib/domain/hubs.ts `resolveTab`); only the
 * active tab's body is rendered, so a tab costs nothing until it is opened.
 * Every tab is Pro. The Clinic tab itself lands in 4.7.0.
 */
const HUB = hubForHref("/reports/edge-clinic")!;

const BODIES: Record<string, () => React.ReactNode> = {
  setups: () => <SetupsTab />,
  discipline: () => <DisciplineTab />,
  scaling: () => <ScalingTab />,
};

export default async function EdgeClinicPage({
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
