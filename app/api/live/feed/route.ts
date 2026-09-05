import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import { openAlgoGate, OPENALGO_DISCLOSURE_VERSION, isAckCurrent } from "@/lib/domain/openalgo-disclosure";
import { clampRefreshSeconds, type OpenAlgoHealth } from "@/lib/quotes/openalgo";
import { createProvider, getLiveFeedProvider, resolveLiveFeed, SHIPPED_PROVIDER_IDS } from "@/lib/quotes/registry";
import { openPositionKeys, persistDailyMarks } from "@/lib/quotes/persist-mark";

/**
 * `/api/live/feed` — the Live Desk's feed settings and its health line.
 *
 * ROUTE HANDLER + CLIENT `fetch` + `router.refresh()`, never a server action
 * (AGENTS.md): a settings write through a server action auto-refreshes the
 * route, remounts every sibling client card in Settings and silently resets
 * the state they hold.
 *
 * THE CONSENT GATE LIVES HERE, not only in the card. Hiding a radio button is
 * never the only thing between an unread disclosure and a live pull — the
 * OpenAlgo import route set that precedent (`app/api/import/broker/route.ts`)
 * and this one keeps it: choosing OpenAlgo without a current acknowledgement
 * is a 403 and stores nothing.
 *
 * NOTHING HERE FETCHES A PRICE ON ITS OWN except the health probe (which goes
 * to the user's own bridge) and the explicit "save today's mark" action.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The desktop shell and the dev server; anything else must match the host. */
const LOCAL_ORIGINS = /^(?:tauri\.localhost|localhost|127\.0\.0\.1|\[::1\]|::1)$/i;

/**
 * Same-origin guard. There is still no shared helper in this repo (grep
 * `assertSameOrigin`), so this mirrors `app/api/live/stream/route.ts`
 * deliberately: a DENY of the known-cross-origin case rather than an allow of
 * a fixed origin, because a same-origin request may legitimately carry no
 * `Origin` header at all.
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

/** The three a user may pick. `mock` is an e2e/dev pin, never a choice. */
const PICKABLE = ["manual", "eod", "openalgo"] as const;

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("provider"), provider: z.enum(PICKABLE) }),
  z.object({ action: z.literal("refresh-seconds"), seconds: z.number().int() }),
  z.object({ action: z.literal("mark") }),
]);

function settingsRow() {
  return db.select().from(settings).limit(1).all()[0];
}

/** One health shape for every provider, so the card renders one component. */
async function healthLine() {
  const provider = await getLiveFeedProvider();
  const h = (await provider.health()) as OpenAlgoHealth;
  return {
    provider: provider.id,
    ok: h.ok,
    state: h.state ?? (h.ok ? "ok" : "disabled"),
    latencyMs: h.latencyMs ?? null,
    reason: h.reason ?? "",
    capabilities: provider.capabilities,
  };
}

export async function GET(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ ok: false, message: "This endpoint only answers the app itself." }, { status: 403 });
  }
  const s = settingsRow();
  const feed = await resolveLiveFeed();
  return NextResponse.json({
    ok: true,
    feed,
    // Every shipped id with its capability block, so the picker's labels and
    // the egress sentence come from the registry rather than from the JSX.
    providers: SHIPPED_PROVIDER_IDS.filter((id) => (PICKABLE as readonly string[]).includes(id)).map((id) => ({
      // `id` AFTER the spread, not before: `capabilities` carries its own `id`
      // and a leading one is silently overwritten (TS2783). Restating it last
      // pins the picker's id to the value the filter selected.
      ...createProvider(id).capabilities,
      id,
    })),
    openalgo: {
      enabled: s?.openalgoEnabled ?? false,
      ackCurrent: isAckCurrent(s?.openalgoAckVersion),
      disclosureVersion: OPENALGO_DISCLOSURE_VERSION,
    },
    lastLiveMarkDate: s?.lastLiveMarkDate ?? null,
    health: await healthLine(),
  });
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ ok: false, message: "This endpoint only answers the app itself." }, { status: 403 });
  }
  const raw = await req.json().catch(() => null);
  const parsed = ActionSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, message: parsed.error.issues[0]?.message ?? "Bad request" }, { status: 400 });
  }
  const body = parsed.data;
  const s = settingsRow();
  if (!s) return NextResponse.json({ ok: false, message: "No settings row." }, { status: 400 });

  if (body.action === "provider") {
    if (body.provider === "openalgo") {
      // The gate, server-side. Both halves: the integration is on AND the
      // acknowledgement covers the disclosure as it reads today.
      const gate = openAlgoGate({ enabled: s.openalgoEnabled, ackVersion: s.openalgoAckVersion });
      if (!gate.allowed) return NextResponse.json({ ok: false, message: gate.reason }, { status: 403 });
    }
    db.update(settings).set({ liveFeedProvider: body.provider }).where(eq(settings.id, s.id)).run();
    recordAudit({ entity: "settings", action: "update", summary: `live feed provider → ${body.provider}`, source: "ui" });
    return NextResponse.json({ ok: true, message: "Saved.", feed: await resolveLiveFeed() });
  }

  if (body.action === "refresh-seconds") {
    // Clamped, not rejected: 1–5 s is the owner's answer (Q25) and the slider
    // cannot produce anything else, so a number outside it is a bad caller
    // rather than a user mistake worth an error toast.
    const seconds = clampRefreshSeconds(body.seconds);
    db.update(settings).set({ liveFeedRefreshSeconds: seconds }).where(eq(settings.id, s.id)).run();
    return NextResponse.json({ ok: true, message: `Refreshing every ${seconds}s.`, seconds });
  }

  // "Save today's mark" — takes ONE snapshot and persists at most one mark per
  // position for the IST day. The prices come from the provider on the server;
  // a price the client sent could never be trusted into the journal.
  const provider = await getLiveFeedProvider();
  const keys = await openPositionKeys();
  if (keys.length === 0) {
    return NextResponse.json({ ok: false, message: "No open positions to mark." }, { status: 400 });
  }
  let quotes;
  try {
    quotes = [...(await provider.snapshot(keys)).values()];
  } catch (e) {
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : "The feed could not be read." },
      { status: 502 },
    );
  }
  const result = await persistDailyMarks(quotes, { ignoreClock: true });
  return NextResponse.json({ ok: result.written, message: result.reason, ...result });
}
