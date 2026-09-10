import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { recordAudit } from "@/lib/audit";
import { getEntitlement } from "@/lib/queries/license";
import { STRATEGY_IDS } from "@/lib/analytics/strategy-catalogue";
import {
  DEFAULT_SHELF,
  defaultShelf,
  parseShelf,
  serializeShelf,
  type ShelfPostResult,
} from "@/lib/domain/strategy-shelf";

export const runtime = "nodejs";

/**
 * THE OPTION-STRATEGY SHELF — the one door that writes
 * `settings.strategy_shelf_json` (migration 0071).
 *
 * WHY A ROUTE AND NOT A SERVER ACTION. AGENTS.md is explicit: a settings/editor
 * write is a route handler + client `fetch` + `router.refresh()`. An action
 * revalidates the current route and REMOUNTS its sibling client components — on
 * /strategies that is the picker itself, whose search box, open accordion and
 * (worse) its UNDO HISTORY would silently reset on every tick. The shelf is the
 * screen most likely to be edited many times in a row, so it is the screen an
 * action would damage most.
 *
 * NO ACCOUNT SCOPE, DELIBERATELY. `settings` is a SINGLE-ROW table with no
 * `account_id` column: the shelf is a fact about how this person likes their
 * workspace, not about one book, exactly as `theme` and `density` are. So there
 * is no `getSelectedAccountId()` read here and no `getWriteAccountId()` guard —
 * invariants 8 and 9 have nothing to bind to. (`tests/account-isolation.test.ts`
 * is what would catch the day that changes.)
 *
 * NO MONEY, NO DENOMINATOR — a list of string ids. Invariants 1 and 6 have
 * nothing to own here either.
 *
 * PRO, AND GATED SERVER-SIDE (owner ruling, v4.3). The catalogue's 40 shapes,
 * the shelf and the picker are the Pro capability inside an otherwise-free
 * screen; `lib/license.ts` lists /strategies as `partial: true`. A disabled
 * checkbox is not a gate, so the ENTITLEMENT IS CHECKED HERE, before the body
 * is even parsed — the free build can render the shelf it already has and can
 * never store a new one.
 *
 * WHAT `restore` WRITES: the SERIALISED DEFAULTS, not null. Migration 0071 is
 * right that null is the honest default for an install that has never picked
 * — and untouched installs keep it. But "put my shelf back" is a GESTURE, and
 * an explicit envelope is what makes it survive a backup round-trip as a
 * choice the user made rather than as an absence a later DEFAULT_SHELF change
 * would silently rewrite. (Owner ruling, v4.3 wave 2, weighed against 0071's
 * own note.)
 */

/**
 * The cap. 40 is the catalogue itself (`STRATEGY_IDS.length`) — derived, never
 * a literal, so adding a 41st shape does not turn into a refusal nobody
 * expected. The check runs on the RAW array, before any dedupe: a caller that
 * sends 41 entries is a broken caller, and silently shrinking its list to 40
 * would hide that.
 */
const SHELF_MAX = STRATEGY_IDS.length;

/** The catalogue as a lookup. Built once per module load, not per request. */
const VALID_IDS: ReadonlySet<string> = new Set<string>(STRATEGY_IDS);

/**
 * The wire contract. A discriminated union so an unknown `action` is a 400 with
 * the store untouched, rather than a "set" with no `selected` (which would read
 * as "empty my shelf") — the live-feed route's shape, for the same reason.
 *
 * All three `selected` refusals live in ONE `superRefine` with early returns, so
 * `issues[0]` is deterministic: too many ▸ unknown id ▸ duplicate. Zod 4 keeps
 * running sibling checks after a failure, and a caller reading the first issue
 * deserves the most specific sentence, not whichever check happened to be last.
 */
const ActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("set"),
    selected: z.array(z.string()).superRefine((ids, ctx) => {
      if (ids.length > SHELF_MAX) {
        ctx.addIssue({
          code: "custom",
          message: `A shelf holds at most ${SHELF_MAX} strategies — the whole catalogue.`,
        });
        return;
      }
      const unknown = ids.filter((id) => !VALID_IDS.has(id));
      if (unknown.length > 0) {
        // Named, because the only way this happens is a stale client or a
        // renamed id, and both are worth reading in the console.
        ctx.addIssue({
          code: "custom",
          message: `Not a strategy this build knows: ${unknown.slice(0, 3).join(", ")}.`,
        });
        return;
      }
      if (new Set(ids).size !== ids.length) {
        // `serializeShelf` would dedupe this happily. It is still refused: the
        // picker cannot produce a duplicate, so one on the wire means the
        // client and the server disagree about the shelf, and accepting a
        // quietly-shortened list is how that disagreement stays invisible.
        ctx.addIssue({ code: "custom", message: "The same strategy twice — the shelf is a set, in order." });
        return;
      }
    }),
  }),
  z.object({ action: z.literal("restore") }),
]);

const refuse = (error: string, status: number) =>
  NextResponse.json<ShelfPostResult>({ ok: false, error }, { status });

/** The single settings row — `settings` has exactly one, by construction. */
function settingsRow() {
  return db
    .select({ id: settings.id, strategyShelfJson: settings.strategyShelfJson, updatedAt: settings.updatedAt })
    .from(settings)
    .limit(1)
    .get();
}

export async function POST(req: Request) {
  // The gate first, before the body is read: a free build must not be able to
  // learn what this route would have accepted, and must never reach the write.
  if (!getEntitlement().pro) {
    return refuse(
      "The strategy shelf is part of Vyuha Pro. Your journal, your trades and the eight default strategies stay free.",
      403,
    );
  }

  const raw = await req.json().catch(() => null);
  const parsed = ActionSchema.safeParse(raw);
  if (!parsed.success) {
    return refuse(parsed.error.issues[0]?.message ?? "That is not a shelf this route can store.", 400);
  }

  const row = settingsRow();
  if (!row) return refuse("No settings row.", 400);

  // ONE canonical value for both actions, via B2's own round-trip: whatever is
  // stored is exactly what `parseShelf` will read back, so the panel and the
  // database can never hold different shelves. (`serializeShelf` dedupes and
  // `parseShelf` drops unknown ids — both already refused above, so here the
  // round-trip is a proof rather than a repair.)
  const wanted =
    parsed.data.action === "restore" ? defaultShelf() : { selected: parsed.data.selected };
  const strategyShelfJson = serializeShelf(parseShelf(serializeShelf(wanted), STRATEGY_IDS));

  db.update(settings)
    .set({ strategyShelfJson, updatedAt: new Date().toISOString() })
    .where(eq(settings.id, row.id))
    .run();

  // ONE audit row per accepted write, and none on a refusal. `settings` +
  // `update` + `ui` is the entity/action/source triple every other settings
  // write uses (app/api/live/feed/route.ts), so the Audit Log reads as one
  // stream. No before/after snapshots: `assertSymmetricSnapshots` wants both or
  // neither, and a shelf's before-image is a preference nobody restores from
  // the log.
  recordAudit({
    entity: "settings",
    action: "update",
    summary:
      parsed.data.action === "restore"
        ? `strategy shelf restored to the ${DEFAULT_SHELF.length} defaults`
        : `strategy shelf → ${parsed.data.selected.length} strategies`,
    source: "ui",
  });

  // RE-READ, never echoed. The response is what the database now holds, so a
  // write that silently did nothing shows up as a shelf that did not change
  // rather than as an optimistic UI that disagrees with the next page load.
  const after = settingsRow();
  const result: ShelfPostResult = {
    ok: true,
    shelf: parseShelf(after?.strategyShelfJson ?? null, STRATEGY_IDS),
    updatedAt: after?.updatedAt ?? "",
  };

  revalidatePath("/strategies");
  return NextResponse.json<ShelfPostResult>(result);
}
