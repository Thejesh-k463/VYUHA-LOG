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

  if (parsed.data.action === "dismiss") {
    dismissPanel(parsed.data.panel as DismissiblePanel, parsed.data.fingerprint);
  } else {
    undismissPanels(parsed.data.panel as DismissiblePanel | undefined);
  }
  for (const p of ["/trades", "/"]) revalidatePath(p);
  return NextResponse.json({ ok: true });
}
