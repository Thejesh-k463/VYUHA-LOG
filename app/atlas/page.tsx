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
 * THE PREVIEW IS A SIBLING OF THE GATE, NOT ITS CHILD. `<ProGate>`'s "block"
 * branch renders the upsell panel INSTEAD of its children, and
 * LICENSE_ENFORCEMENT is "block" — so a preview nested inside it was
 * unreachable in every shipped state, which is the opposite of Q57. The loader
 * has already decided entitlement (`preview`), so the page renders the lock and
 * the preview beside each other: the gate draws the label and the buy surface,
 * and the preview says what the five tabs contain.
 *
 * `force-dynamic` because it reads the database (AGENTS.md), and the read
 * itself only recomputes when the bars' checksum has moved — opening this page
 * on an unchanged database costs one hash, not a full market recompute.
 *
 * Everything on the screen is computed from the user's OWN stored bhavcopy
 * bars. No proprietary widget is computed here (Q42b): the owner's formulas
 * would be readable the moment they shipped in a bundle, and no such feed
 * exists in v4.0 (build prompt Q-12).
 */

export const dynamic = "force-dynamic";

const HEADER = (
  <PageHeader
    title="Market Atlas"
    description="Breadth, rotation and coverage — computed from the end-of-day bhavcopy bars on this machine."
  />
);

export default function AtlasPage() {
  const data = getAtlasPageData();

  if (data.preview) {
    return (
      <>
        {HEADER}
        {/* The lock itself: the upsell panel under "block", the honest banner
            under "banner". It wraps nothing, because the body it would wrap is
            the preview below — which must render in BOTH states. */}
        <ProGate>{null}</ProGate>
        <div className="p-6">
          <AtlasPreview />
        </div>
      </>
    );
  }

  return (
    <ProGate>
      {HEADER}
      <div className="p-6">
        <AtlasPanel view={data.view!} />
      </div>
    </ProGate>
  );
}
