import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { dismissPanel, undismissPanels } from "@/lib/queries/dismissals";
import type { DismissiblePanel } from "@/lib/domain/dismissals";

export const runtime = "nodejs";

const PANELS = ["unmarked-holdings", "acquisition-basis", "cross-source-overlap", "mtf-confirmation"] as const;

const Body = z.union([
  z.object({ action: z.literal("dismiss"), panel: z.enum(PANELS), fingerprint: z.string().min(4).max(64) }),
  z.object({ action: z.literal("restore"), panel: z.enum(PANELS).optional() }),
]);

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });

  // The query module REFUSES the aggregate view (invariant 9: 0 is a view, not
  // a place — getWriteAccountId's lowest-id fallback used to file every
  // All-accounts dismissal against account #1). This route used to discard the
  // result and answer {ok:true} regardless. Nothing lied to the user, because
  // the only caller shows no toast — but a route that drops a refusal on the
  // floor is one UI change away from doing so. Same mapping as /api/bf-losses:
  // 403 for the aggregate-view write ban, 400 for anything else.
  const res =
    parsed.data.action === "dismiss"
      ? dismissPanel(parsed.data.panel as DismissiblePanel, parsed.data.fingerprint)
      : undismissPanels(parsed.data.panel as DismissiblePanel | undefined);

  if (!res.ok) return NextResponse.json(res, { status: res.forbidden ? 403 : 400 });
  for (const p of ["/trades", "/"]) revalidatePath(p);
  return NextResponse.json(res);
}
