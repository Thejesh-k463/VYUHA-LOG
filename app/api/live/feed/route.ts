import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { brokerConnections, settings } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import { openAlgoGate, OPENALGO_DISCLOSURE_VERSION, isAckCurrent } from "@/lib/domain/openalgo-disclosure";
import {
  LIVE_FEED_DISCLOSURE_VERSIONS,
  isFeedAckCurrent,
  withFeedAck,
} from "@/lib/domain/live-feed-disclosure";
import { clampRefreshSeconds, type OpenAlgoHealth } from "@/lib/quotes/openalgo";
import { createProvider, getLiveFeedProvider, resolveLiveFeed, SHIPPED_PROVIDER_IDS } from "@/lib/quotes/registry";
import { openPositionKeys, persistDailyMarks } from "@/lib/quotes/persist-mark";
import { getSelectedAccountId } from "@/lib/queries/accounts";
import { ANGELONE_FEED_ENABLED, OPENALGO_FEED_ENABLED, UPSTOX_FEED_ENABLED } from "@/lib/quotes/types";

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

/**
 * What a user may pick. `mock` is an e2e/dev pin, never a choice, and
 * `openalgo` ships in v4.1 behind the ONE constant `OPENALGO_FEED_ENABLED`
 * (owner ruling). While it was false the id was not in the zod enum at all and
 * a hand-rolled POST asking for it was a 400; now that it is true such a POST
 * is parsed and meets the CONSENT GATE below instead — 403, and it still
 * stores nothing until both halves of the acknowledgement hold.
 *
 * `upstox` joins it in v4.2 behind `UPSTOX_FEED_ENABLED`, with its own pair of
 * halves and its own answer: 409, because the two things missing (a saved
 * connection, an accepted disclosure) are states the user can change on this
 * machine, not a forbidden request. `angelone` joins on exactly the same terms
 * behind `ANGELONE_FEED_ENABLED`, with its own connection, its own disclosure
 * and its own 409.
 */
const ALL_PICKABLE = ["manual", "eod", "openalgo", "upstox", "angelone"] as const;
type Pickable = (typeof ALL_PICKABLE)[number];
/**
 * The two unconditional ids, then whichever release flags are on.
 *
 * It used to be a nest of explicit tuples, because `z.enum()` needs a NON-EMPTY
 * tuple type and an array built from conditional spreads widens to `Pickable[]`
 * — which would let the enum accept whatever the array happened to hold instead
 * of being checked at compile time. Three flags make that nest eight branches,
 * so the SAME property is bought differently: every optional id is declared
 * against `Pickable` in the table below (a typo fails to compile there), and
 * the head of the tuple is spelled out so the type stays non-empty.
 */
const OPTIONAL_PICKABLE: readonly (readonly [Pickable, boolean])[] = [
  ["openalgo", OPENALGO_FEED_ENABLED],
  ["upstox", UPSTOX_FEED_ENABLED],
  ["angelone", ANGELONE_FEED_ENABLED],
];
const PICKABLE: readonly [Pickable, Pickable, ...Pickable[]] = [
  "manual",
  "eod",
  ...OPTIONAL_PICKABLE.filter(([, enabled]) => enabled).map(([id]) => id),
];

/**
 * WHICH DISCLOSURES MAY BE ACKNOWLEDGED (B-8).
 *
 * The `provider` action has always been flag-gated through `PICKABLE`; the
 * `ack` action was `z.enum(["upstox", "angelone"])` unconditionally. So on a
 * build that withholds one of them — the flag is the ONE line that decides — a
 * POST could still record an acknowledgement for the withheld broker, and the
 * card's "Review and accept" button would send exactly that POST whenever the
 * withheld id was sitting in `liveFeedProvider` (it travels in a backup
 * envelope; the acknowledgement is machine state and does not).
 *
 * Derived from `PICKABLE` rather than from a second list of flags, so the
 * picker and the consent write can never disagree about what this build ships.
 */
const ACK_PROVIDERS = ["upstox", "angelone"] as const;
type AckProvider = (typeof ACK_PROVIDERS)[number];
const ACKABLE: readonly AckProvider[] = ACK_PROVIDERS.filter((id) =>
  (PICKABLE as readonly string[]).includes(id),
);

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("provider"), provider: z.enum(PICKABLE) }),
  z.object({ action: z.literal("refresh-seconds"), seconds: z.number().int() }),
  z.object({ action: z.literal("mark") }),
  // The ack write. Its own action rather than a settings PUT because the
  // acknowledgement and the pick are one user gesture on one card: the sheet
  // is accepted and the provider is selected against the SAME route that
  // enforces the gate, so nothing can record consent the gate would not read.
  // v4.2 — one action, two providers. The acknowledgement is stored per
  // provider id (a JSON map), so widening the enum is the whole change: the
  // gate that reads it back is `isFeedAckCurrent(json, id)`.
  // …and it is narrowed again by the release flags (B-8): an id this build does
  // not offer is a 400 here, exactly as an unshipped `provider` id is, and
  // nothing is written.
  z.object({
    action: z.literal("ack"),
    provider: z.enum(ACK_PROVIDERS).refine((id) => ACKABLE.includes(id), {
      message: "That feed is not offered in this build.",
    }),
  }),
]);

function settingsRow() {
  return db.select().from(settings).limit(1).all()[0];
}

/**
 * Does the SELECTED account have an Upstox connection saved?
 *
 * EXISTENCE ONLY — the select list is the row id and nothing else. The token
 * columns (`api_key`, `access_token`, `auth_json`) are never read on this path
 * and never leave the database through this route; the card needs to know
 * whether to offer a radio, not what the credential is.
 *
 * Account-scoped through `getSelectedAccountId()` (invariant 8): a connection
 * saved on the swing account is not a connection on the long-term one. Id 0 is
 * the aggregate VIEW (invariant 9) — it can never receive a write, and there is
 * no write here, so it asks the honest question for a view: does any account
 * hold one?
 */
function upstoxConnected(): boolean {
  const accountId = getSelectedAccountId();
  const scoped = eq(brokerConnections.broker, "upstox");
  return (
    db
      .select({ id: brokerConnections.id })
      .from(brokerConnections)
      .where(accountId > 0 ? and(eq(brokerConnections.accountId, accountId), scoped) : scoped)
      .limit(1)
      .all().length > 0
  );
}

/** What the Settings card renders the Upstox radio from. No token, ever. */
function upstoxState(ackJson: string | null | undefined) {
  return {
    connected: upstoxConnected(),
    ackCurrent: isFeedAckCurrent(ackJson ?? null, "upstox"),
    disclosureVersion: LIVE_FEED_DISCLOSURE_VERSIONS.upstox,
  };
}

/**
 * Why the Upstox feed may not be selected yet. `null` means it may.
 *
 * BOTH halves, server-side, for the same reason the OpenAlgo gate is here: a
 * disabled radio is not a control. The connection is the user's own saved
 * token; the acknowledgement is compared with `===` against the version this
 * release ships, so bumping it re-asks every install.
 */
function upstoxRefusal(ackJson: string | null | undefined): string | null {
  if (!upstoxConnected()) {
    return "No Upstox connection is saved for this account. Add Upstox under Import → Connect broker first.";
  }
  if (!isFeedAckCurrent(ackJson ?? null, "upstox")) {
    return "Read what the Upstox feed does and accept it first — until then the desk stays on end-of-day prices.";
  }
  return null;
}

/**
 * Does the SELECTED account have an Angel One connection saved?
 *
 * THE EXISTENCE OF THE ROW AND NOTHING ELSE — the select list is the id, so the
 * client code, the PIN and the TOTP SECRET are never read on this path and can
 * never leave the database through this route. That matters more here than it
 * did for Upstox: an Analytics token is read-only, and a TOTP secret is the
 * seed that mints every future one-time password.
 *
 * Account-scoped through `getSelectedAccountId()` (invariant 8), and for id 0 —
 * the aggregate VIEW (invariant 9), which can never receive a write and does
 * not here — it asks the honest question for a view: does any account hold one?
 */
function angelOneConnected(): boolean {
  const accountId = getSelectedAccountId();
  const scoped = eq(brokerConnections.broker, "angelone");
  return (
    db
      .select({ id: brokerConnections.id })
      .from(brokerConnections)
      .where(accountId > 0 ? and(eq(brokerConnections.accountId, accountId), scoped) : scoped)
      .limit(1)
      .all().length > 0
  );
}

/**
 * What the Settings card renders the Angel One radio from. No credential, ever.
 *
 * `openCount` is the extra fact this provider needs and Upstox does not: its
 * refresh cadence is TIERED on the size of the book (ruling 4.2-4), so the card
 * cannot state the interval without knowing how many positions the poll would
 * cover. It comes from `openPositionKeys()` — the same account-scoped, 500-
 * capped set the stream route subscribes to — so the sentence on the card and
 * the requests on the wire are counting the same thing.
 */
async function angelOneState(ackJson: string | null | undefined) {
  return {
    connected: angelOneConnected(),
    ackCurrent: isFeedAckCurrent(ackJson ?? null, "angelone"),
    disclosureVersion: LIVE_FEED_DISCLOSURE_VERSIONS.angelone,
    openCount: (await openPositionKeys()).length,
  };
}

/**
 * Why the Angel One feed may not be selected yet. `null` means it may.
 *
 * The same two halves, server-side, in the same order and with messages
 * parallel to Upstox's — a disabled radio is not a control.
 */
function angelOneRefusal(ackJson: string | null | undefined): string | null {
  if (!angelOneConnected()) {
    return "No Angel One connection is saved for this account. Add Angel One under Import → Connect broker first.";
  }
  if (!isFeedAckCurrent(ackJson ?? null, "angelone")) {
    return "Read what the Angel One feed does and accept it first — until then the desk stays on end-of-day prices.";
  }
  return null;
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
    // The Upstox radio's two facts, always present so the card can render one
    // shape whatever the release flag says. `connected` is the existence of a
    // broker_connections row for the selected account — never the token.
    upstox: upstoxState(s?.liveFeedAckJson),
    // The Angel One radio's facts, always present for the same reason — plus
    // the open-position count its tiered cadence line is computed from.
    angelone: await angelOneState(s?.liveFeedAckJson),
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

  // The acknowledgement write. It records a VERSION against a provider id in
  // one JSON column, so a bumped version re-asks (`isFeedAckCurrent` compares
  // with `===`) and one provider's consent is never another's.
  if (body.action === "ack") {
    db.update(settings)
      .set({ liveFeedAckJson: withFeedAck(s.liveFeedAckJson, body.provider) })
      .where(eq(settings.id, s.id))
      .run();
    recordAudit({
      entity: "settings",
      action: "update",
      summary: `live feed disclosure accepted → ${body.provider} v${LIVE_FEED_DISCLOSURE_VERSIONS[body.provider]}`,
      source: "ui",
    });
    const after = settingsRow()?.liveFeedAckJson;
    // BOTH halves of the card's state, re-read from the database rather than
    // guessed optimistically — the card replaces whichever one it asked about.
    return NextResponse.json({
      ok: true,
      message: "Saved.",
      upstox: upstoxState(after),
      angelone: await angelOneState(after),
    });
  }

  if (body.action === "provider") {
    if (body.provider === "openalgo") {
      // The gate, server-side. Both halves: the integration is on AND the
      // acknowledgement covers the disclosure as it reads today.
      const gate = openAlgoGate({ enabled: s.openalgoEnabled, ackVersion: s.openalgoAckVersion });
      if (!gate.allowed) return NextResponse.json({ ok: false, message: gate.reason }, { status: 403 });
    }
    if (body.provider === "upstox") {
      // Same precedent, its own two halves — and it stores nothing until both
      // hold, whatever the card rendered.
      const refusal = upstoxRefusal(s.liveFeedAckJson);
      if (refusal) return NextResponse.json({ ok: false, message: refusal }, { status: 409 });
    }
    if (body.provider === "angelone") {
      // The same precedent again, its own two halves, its own 409 — and it
      // stores nothing until both hold, whatever the card rendered.
      const refusal = angelOneRefusal(s.liveFeedAckJson);
      if (refusal) return NextResponse.json({ ok: false, message: refusal }, { status: 409 });
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
