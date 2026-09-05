import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { riskConfig } from "@/lib/db/schema";
import { recordAudit } from "@/lib/audit";
import { getSelectedAccountId } from "@/lib/queries/accounts";
import { LIVE_DESK_RANGES, STOP_METHODS } from "@/components/sizing/lab-config";

export const runtime = "nodejs";

/**
 * The Sizing Lab's write-back (owner Q36): the ONLY path that stores the
 * migration-0064 Live Desk columns on `risk_config`.
 *
 * It is a route handler with a client `fetch`, not a server action, for the
 * house reason: a server action refreshes the whole route, remounts the lab's
 * sibling client components and silently resets the setup the user just typed.
 * The dialog posts here and calls `router.refresh()` itself.
 *
 * The write is deliberately explicit and whole-row: the lab shows old → new
 * per field before it fires, and a slider drag never reaches this handler.
 *
 * SCOPE. `risk_config` carries no `account_id` column — its key is
 * (scope, key), and the Live Desk columns live on the `scope:'global'` row.
 * `getSelectedAccountId()` is read for the audit line only, so the log says
 * which account was on screen when the global rule was changed; it is not a
 * write target here, and no per-account row is created (invariant 9's
 * aggregate-view ban has nothing to bite on for a table with no account).
 *
 * VALIDATION. Every field is an INTEGER in the column's own unit (ppm,
 * per-thousand, sessions). Ranges come from `components/sizing/lab-config.ts`
 * so the slider's bounds and this 400 are one definition — a second copy here
 * would drift and the error would then contradict the control that produced
 * the value.
 */

/** The desktop shell and the dev server; anything else must match the host. */
const LOCAL_ORIGINS = /^(?:tauri\.localhost|localhost|127\.0\.0\.1|\[::1\]|::1)$/i;

/**
 * Same-origin guard, copied in shape from `app/api/live/stream/route.ts`
 * (there is still no shared helper — grep `assertSameOrigin`). It DENIES the
 * known-cross-origin case rather than allowing one fixed origin: a same-origin
 * `fetch` from the desktop webview sends no `Origin` header at all, so
 * requiring one would refuse the app itself.
 */
function isSameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const host = req.headers.get("host");
    if (host && url.host.toLowerCase() === host.toLowerCase()) return true;
    return LOCAL_ORIGINS.test(url.hostname);
  } catch {
    return false;
  }
}

class FieldError extends Error {}

/** An integer inside `[min,max]`, or a 400 that names the field and the range. */
function intInRange(v: unknown, field: string, range: { min: number; max: number }): number {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new FieldError(`${field} has to be a whole number in ppm — got ${JSON.stringify(v)}.`);
  }
  if (n < range.min || n > range.max) {
    throw new FieldError(`${field} has to be between ${range.min} and ${range.max} — got ${n}.`);
  }
  return n;
}

/** The same check, but `null`/absent stays null: the column means "unset". */
function optIntInRange(v: unknown, field: string, range: { min: number; max: number }): number | null {
  if (v == null || v === "") return null;
  return intInRange(v, field, range);
}

interface LiveDeskPatch {
  riskPctPpm: number;
  deployCapPpm: number;
  stopMethod: string | null;
  stopAtrLen: number | null;
  stopAtrMultPermille: number | null;
  stopDefaultPctPpm: number | null;
  heatCeilingPpm: number | null;
}

function parsePatch(body: Record<string, unknown>): LiveDeskPatch {
  const rawMethod = body.stopMethod == null || body.stopMethod === "" ? null : String(body.stopMethod);
  if (rawMethod != null && !(STOP_METHODS as readonly string[]).includes(rawMethod)) {
    throw new FieldError(`stopMethod has to be one of ${STOP_METHODS.join(", ")} — got ${JSON.stringify(rawMethod)}.`);
  }
  return {
    riskPctPpm: intInRange(body.riskPctPpm, "riskPctPpm", LIVE_DESK_RANGES.riskPctPpm),
    deployCapPpm: intInRange(body.deployCapPpm, "deployCapPpm", LIVE_DESK_RANGES.deployCapPpm),
    stopMethod: rawMethod,
    stopAtrLen: optIntInRange(body.stopAtrLen, "stopAtrLen", LIVE_DESK_RANGES.stopAtrLen),
    stopAtrMultPermille: optIntInRange(
      body.stopAtrMultPermille,
      "stopAtrMultPermille",
      LIVE_DESK_RANGES.stopAtrMultPermille,
    ),
    stopDefaultPctPpm: optIntInRange(body.stopDefaultPctPpm, "stopDefaultPctPpm", LIVE_DESK_RANGES.stopDefaultPctPpm),
    heatCeilingPpm: optIntInRange(body.heatCeilingPpm, "heatCeilingPpm", LIVE_DESK_RANGES.heatCeilingPpm),
  };
}

const LIVE_DESK_FIELDS = [
  "riskPctPpm",
  "stopMethod",
  "stopAtrLen",
  "stopAtrMultPermille",
  "stopDefaultPctPpm",
  "deployCapPpm",
  "heatCeilingPpm",
] as const;

type StoredShape = Record<(typeof LIVE_DESK_FIELDS)[number], unknown>;

function snapshot(row: Record<string, unknown> | undefined | null): StoredShape | null {
  if (!row) return null;
  return Object.fromEntries(LIVE_DESK_FIELDS.map((k) => [k, row[k] ?? null])) as StoredShape;
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json(
      { ok: false, message: "This endpoint only answers the app itself." },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });
  }

  let patch: LiveDeskPatch;
  try {
    patch = parsePatch(body);
  } catch (e) {
    if (e instanceof FieldError) return NextResponse.json({ ok: false, message: e.message }, { status: 400 });
    throw e;
  }

  const existing = db
    .select()
    .from(riskConfig)
    .where(and(eq(riskConfig.scope, "global"), eq(riskConfig.key, "")))
    .get();

  const before = snapshot(existing as unknown as Record<string, unknown> | undefined);
  const updatedAt = new Date().toISOString();

  if (existing) {
    db.update(riskConfig).set({ ...patch, updatedAt }).where(eq(riskConfig.id, existing.id)).run();
  } else {
    // A book whose global rule row was never seeded still gets a write rather
    // than a silent no-op that answers "saved".
    db.insert(riskConfig).values({ scope: "global", key: "", ...patch, updatedAt }).run();
  }

  const after = snapshot({ ...patch } as unknown as Record<string, unknown>);

  // `recordAudit` throws in dev/test when before and after carry different key
  // sets, so BOTH snapshots are built from the same `LIVE_DESK_FIELDS` list.
  // A book whose global row did not exist has a null before-image, which the
  // symmetry check treats as "nothing to compare" rather than an asymmetry.
  recordAudit({
    entity: "risk_config",
    entityId: existing ? existing.id : null,
    action: existing ? "update" : "create",
    summary: `Live Desk risk saved from the Sizing Lab (account ${getSelectedAccountId()})`,
    before: before as Record<string, unknown> | null,
    after: after as Record<string, unknown>,
  });

  for (const p of ["/", "/risk", "/settings", "/sizing-lab", "/targets/equity", "/targets/active"]) {
    revalidatePath(p);
  }

  return NextResponse.json({
    ok: true,
    message: "Live Desk risk saved.",
    before,
    after,
  });
}
