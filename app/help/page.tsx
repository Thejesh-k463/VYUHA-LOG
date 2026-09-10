import { PageHeader } from "@/components/layout/page-header";
import { HelpDesk } from "@/components/system/help-desk";
import { HELP_ENTRIES } from "@/lib/domain/help-content";
import { OPTIONS_HELP } from "@/lib/domain/options-help";
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
        {/* The Options catalogue is a SECOND kind of entry — 40 structures, not
            screens, so they carry no href and never reach the NAV join above.
            They render as their own highlighted section at the top of the desk. */}
        <HelpDesk entries={HELP_ENTRIES} groups={groups} options={OPTIONS_HELP} />
      </div>
    </>
  );
}
