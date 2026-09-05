import { PageHeader } from "@/components/layout/page-header";
import { ProGate } from "@/components/system/pro-gate";
import { AtlasPanel } from "@/components/atlas/atlas-panel";
import { AtlasPreview } from "@/components/atlas/atlas-preview";
import { getAtlasPageData } from "@/lib/queries/atlas";

/**
 * `/atlas` — the Market Atlas panel (v4.0 Live Desk, research answers Q42–Q59).
 *
 * PRO, AND LOCKED RATHER THAN HIDDEN (Q55/Q57): the read-only tracker is free;
 * Atlas is part of Pro. `<ProGate>` shows the screen exists and says what it
 * is, and `AtlasPreview` — no figures, no database read — is what a copy
 * without a licence or a trial gets in place of the panel. A locked door with
 * a label, never a missing room.
 *
 * `force-dynamic` because it reads the database (AGENTS.md), and the read
 * itself only recomputes when the bars' checksum has moved — opening this page
 * on an unchanged database costs one hash, not a full market recompute.
 *
 * Everything on the screen is computed from the user's OWN stored bhavcopy
 * bars. No proprietary widget is computed here (Q42b): the owner's formulas
 * would be readable the moment they shipped in a bundle, so they are a
 * separate signed feed and not this wave.
 */

export const dynamic = "force-dynamic";

export default function AtlasPage() {
  const data = getAtlasPageData();
  return (
    <ProGate>
      <PageHeader
        title="Market Atlas"
        description="Breadth, rotation and coverage — computed from the end-of-day bhavcopy bars on this machine."
      />
      <div className="p-6">
        {data.view ? <AtlasPanel view={data.view} /> : <AtlasPreview />}
      </div>
    </ProGate>
  );
}
