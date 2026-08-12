import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { listTrashSnapshots, restoreTrashSnapshot, purgeTrashSnapshot } from "@/lib/trash";

/**
 * Deleted-trade snapshots — list, restore, purge.
 *
 * A route handler rather than a server action, for the reason recorded in
 * AGENTS.md: a server action auto-refreshes the current route, which remounts
 * sibling client components and silently resets their state. The Deleted-items
 * panel sits next to the backup panel, which holds an in-progress file
 * selection and a typed password.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ snapshots: listTrashSnapshots() });
}

export async function POST(req: Request) {
  let body: { action?: string; id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Malformed request." }, { status: 400 });
  }

  const id = String(body.id ?? "");
  if (!id) return NextResponse.json({ ok: false, message: "No snapshot was named." }, { status: 400 });

  // `id` is validated against the snapshot-id shape inside lib/trash before it
  // is ever joined onto a path — it arrives from a form field, and a separator
  // or `..` in it would turn "purge this snapshot" into "remove that directory".
  if (body.action === "restore") {
    const res = restoreTrashSnapshot(id);
    if (res.ok) {
      for (const p of ["/trades", "/lenses", "/risk", "/equity", "/active", "/", "/backup"]) revalidatePath(p);
    }
    return NextResponse.json(res);
  }

  if (body.action === "purge") {
    const res = purgeTrashSnapshot(id);
    if (res.ok) revalidatePath("/backup");
    return NextResponse.json(res);
  }

  return NextResponse.json({ ok: false, message: "Unknown action." }, { status: 400 });
}
