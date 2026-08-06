import { PageHeader } from "@/components/layout/page-header";
import { HelpDesk } from "@/components/system/help-desk";
import { HELP_ENTRIES } from "@/lib/domain/help-content";
import { NAV_GROUPS, NAV_ITEMS } from "@/components/layout/nav-config";

export const dynamic = "force-dynamic";

export default function HelpPage() {
  // Grouped the same way the sidebar is, so the help desk reads as a map of
  // the app rather than a second information architecture.
  const groups = NAV_GROUPS.map((label) => ({
    label,
    hrefs: NAV_ITEMS.filter((i) => i.group === label).map((i) => i.href),
  }));
  return (
    <>
      <PageHeader title="Help Desk" description="What every part of Vyuha does, what it answers, and what it deliberately won't do." />
      <div className="p-6">
        <HelpDesk entries={HELP_ENTRIES} groups={groups} />
      </div>
    </>
  );
}
