import { PageHeader } from "@/components/layout/page-header";
import { TrackerClient } from "@/components/live/tracker-client";
import { DESK_COPY } from "@/components/live/desk-copy";
import { loadLiveDesk } from "@/components/live/load-desk";
import { getEntitlement } from "@/lib/queries/license";

/**
 * `/live` — the Live Desk tracker (v4.0).
 *
 * FORCE-DYNAMIC because it reads the journal: every DB-backed page in this app
 * is, and a cached open-position table is a wrong number on screen.
 *
 * NOT WRAPPED IN A WHOLE-PAGE GATE, deliberately (invariant 7, owner ruling
 * Q55). The tracker's own record — positions, mark, P&L — is free; R, risk at stop,
 * heat, the chart overlay and alerts are the Pro capability, and they are
 * gated INSIDE the client by the `pro` flag read here. `PRO_FEATURES` carries
 * `/live` as a `partial: true` row, and `tests/pro-gating.test.ts` enforces
 * both halves of that: the partial entry must read `getEntitlement`, and it
 * must not carry a page gate.
 *
 * The loader lives in `components/live/load-desk.ts` — see its header for why
 * it is not (yet) in `lib/queries/`.
 */
export const dynamic = "force-dynamic";

export default async function LiveDeskPage() {
  const data = await loadLiveDesk();
  const pro = getEntitlement().pro;

  return (
    <>
      <PageHeader title={DESK_COPY.title} description={DESK_COPY.description} />
      <TrackerClient data={data} pro={pro} />
    </>
  );
}
