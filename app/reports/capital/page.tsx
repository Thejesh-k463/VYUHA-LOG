import { PageHeader } from "@/components/layout/page-header";
import { HubTabs } from "@/components/reports/hub-tabs";
import { ProGate } from "@/components/system/pro-gate";
import { HUB_TAB_PARAM, hubForHref, resolveTab } from "@/lib/domain/hubs";
import { asWorkspace, hubStripTabs, type Workspace } from "@/lib/domain/workspace";
import { getSettings } from "@/lib/queries/settings";
import { RomTab } from "./_tabs/rom";
import { ExpiryTab } from "./_tabs/expiry";

export const dynamic = "force-dynamic";

/**
 * Capital & Expiry (v4.6.0 W3, owner ruling T1) — the old /reports/rom and
 * /reports/expiry screens as one hub. The hub itself is shared (visible in
 * every workspace, like /reports/rom always was); the Expiry TAB belongs to
 * the F&O book and leaves the strip in an equity-only workspace — unless it
 * is the tab being viewed, so a deep link still opens (lib/domain/workspace.ts
 * `hubStripTabs`). Only the active tab's body is rendered. Every tab is Pro.
 */
const HUB = hubForHref("/reports/capital")!;

const BODIES: Record<string, () => React.ReactNode> = {
  rom: () => <RomTab />,
  expiry: () => <ExpiryTab />,
};

export default async function CapitalPage({
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
