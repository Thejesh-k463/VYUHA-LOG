import { PageHeader } from "@/components/layout/page-header";
import { HelpDesk } from "@/components/system/help-desk";
import { HELP_ENTRIES } from "@/lib/domain/help-content";
import { OPTIONS_HELP } from "@/lib/domain/options-help";
import { NAV_GROUPS, navGroupHrefs } from "@/components/layout/nav-config";

export const dynamic = "force-dynamic";

export default function HelpPage() {
  // Grouped the same way the sidebar is, so the help desk reads as a map of
  // the app rather than a second information architecture.
  const groups = NAV_GROUPS.map((label) => ({
    label,
    // navGroupHrefs, not a bare NAV_ITEMS filter: a hub's seven help entries
    // are keyed by their `?tab=` URL (v4.6.0 W3) and would otherwise vanish here.
    hrefs: navGroupHrefs(label),
  }));
  return (
    <>
      <PageHeader title="Help Desk" description="What every part of Vyuha does, what it answers, and what it deliberately won't do." />
      <div className="p-6">
        {/* v4.6.0 W4: the desk is task-first — a search hero, one accordion
            group per sidebar group (the groups above), and a topic dialog per
            screen opened by `#topic-…` (components/help/).
            The Options catalogue is a SECOND kind of entry — 40 structures, not
            screens, so they carry no href and never reach the NAV join above.
            They render as their own highlighted section below the topics. */}
        <HelpDesk entries={HELP_ENTRIES} groups={groups} options={OPTIONS_HELP} />
      </div>
    </>
  );
}
