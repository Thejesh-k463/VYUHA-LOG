import { PageHeader } from "@/components/layout/page-header";
import { HubTabs } from "@/components/reports/hub-tabs";
import { HUB_TAB_PARAM, hubForHref, resolveTab } from "@/lib/domain/hubs";
import { asWorkspace, hubStripTabs, type Workspace } from "@/lib/domain/workspace";
import { clinicStateFor } from "@/lib/analytics/edge-clinic-contract";
import { getClinicState } from "@/lib/queries/edge-clinic";
import { getEntitlement } from "@/lib/queries/license";
import { getSettings } from "@/lib/queries/settings";
import { ClinicTab } from "./_tabs/clinic";
import { SetupsTab } from "./_tabs/setups";
import { DisciplineTab } from "./_tabs/discipline";
import { ScalingTab } from "./_tabs/scaling";

export const dynamic = "force-dynamic";

/**
 * Edge Clinic (v4.6.0 W3, owner ruling T1) — the old /reports/edge,
 * /reports/discipline and /reports/scaling screens as one hub, one tab each,
 * and since v4.7.0 C2 the Clinic tab itself, which is the default.
 * The tab comes from `?tab=` (lib/domain/hubs.ts `resolveTab`); only the
 * active tab's body is rendered, so a tab costs nothing until it is opened.
 *
 * Gating (v4.7.0 C2, design review change 5): the Clinic tab is PARTIAL — the
 * whole-book evidence grade is a free teaser — so this page carries no
 * whole-page Pro gate (tests/pro-gating.test.ts scans for the tag). Setups,
 * Discipline and Scaling each wrap their own body in one. The Clinic tab receives `clinicStateFor(state, pro)`: a free copy's
 * RSC payload never carries the full report, the weekly note or experiments.
 * Nothing here computes the report — the tab's client runner asks the compute
 * route when the cache is stale or missing.
 */
const HUB = hubForHref("/reports/edge-clinic")!;

const BODIES: Record<string, () => React.ReactNode> = {
  clinic: () => <ClinicTab state={clinicStateFor(getClinicState(), getEntitlement().pro)} now={Date.now()} />,
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
      <div className="space-y-5 p-6">{BODIES[tab.id]()}</div>
    </>
  );
}
