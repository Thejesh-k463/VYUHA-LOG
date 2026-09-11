import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
// Both pure (invariant 2) — no DB in either, so a static import here cannot
// bind lib/db before openTempDb() sets VYUHA_DB_PATH.
import { DEFAULT_SHELF, parseShelf, type ShelfPostResult } from "@/lib/domain/strategy-shelf";
import { CATALOGUE, STRATEGY_IDS } from "@/lib/analytics/strategy-catalogue";

/**
 * The 403's sentence names how many shapes stay free, in words (G-2). It used
 * to say "the eight default strategies" — eight is `DEFAULT_SHELF`, which is
 * the shelf's starting tiles and NOT the paywall boundary. The boundary is
 * `legacyFree`, counted here from the catalogue so the sentence cannot drift
 * away from the code that enforces it. An unknown count fails loudly.
 */
const FREE_COUNT_WORD: Record<number, string> = { 16: "sixteen" };

/**
 * B3 — POST /api/strategies/shelf, against a real migrated temp database
 * (which also proves migration 0071 applies cleanly: openTempDb runs the whole
 * folder).
 *
 * Five things this file pins, because each one is a way the shelf could be
 * wrong while the screen looked fine:
 *
 *  1. A REFUSAL LEAVES THE STORE UNTOUCHED. Unknown id, duplicate, oversize,
 *     non-JSON and an unknown action are all 400s, and the column still holds
 *     exactly what it held before — a half-applied shelf is worse than a
 *     rejected one.
 *  2. AN ACCEPTED WRITE IS RE-READ, not echoed. The response is what the
 *     database now holds.
 *  3. `restore` writes the DEFAULTS AS AN EXPLICIT ENVELOPE (owner ruling), so
 *     the gesture survives a backup round-trip rather than reading as an
 *     install that never picked.
 *  4. EXACTLY ONE audit row per accepted write, and ZERO on a refusal.
 *  5. THE PRO GATE IS SERVER-SIDE. A free entitlement gets 403 and writes
 *     nothing, whatever the client rendered.
 */

// The route revalidates /strategies; outside a request there is no store to
// revalidate against (the shape tests/goals.test.ts uses).
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));

// The entitlement, stubbed. `vi.hoisted` because the factory is hoisted above
// this file's own `const`s, and the flag must be readable from inside it.
// Replacing the module outright also keeps lib/queries/license's own static
// `lib/db` import out of the graph.
const ent = vi.hoisted(() => ({ pro: true }));
vi.mock("@/lib/queries/license", () => ({
  getEntitlement: () => ({
    state: ent.pro ? "trial" : "unlicensed",
    pro: ent.pro,
    payload: null,
    trialDaysLeft: ent.pro ? 7 : 0,
  }),
}));

let t: TempDb;
let route: typeof import("@/app/api/strategies/shelf/route");

function post(body: unknown, opts: { raw?: string } = {}): Request {
  return new Request("http://local/api/strategies/shelf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: opts.raw ?? JSON.stringify(body),
  });
}

/** The stored column, verbatim. */
function storedJson(): string | null {
  return t.db.select({ j: t.schema.settings.strategyShelfJson }).from(t.schema.settings).get()?.j ?? null;
}

function auditCount(): number {
  return t.db.select({ id: t.schema.auditLog.id }).from(t.schema.auditLog).all().length;
}

async function send(body: unknown, opts: { raw?: string } = {}) {
  const res = await route.POST(post(body, opts));
  return { status: res.status, json: (await res.json()) as ShelfPostResult };
}

const A_SHELF = ["iron-condor", "long-put", "jade-lizard"];

beforeAll(async () => {
  t = await openTempDb("shelf-route", { seed: true });
  route = await import("@/app/api/strategies/shelf/route");
});

afterAll(() => t?.cleanup());

describe("an accepted write", () => {
  it("persists the selection, in order, and answers with the state RE-READ from the database", async () => {
    const before = auditCount();
    const { status, json } = await send({ action: "set", selected: A_SHELF });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    if (!json.ok) throw new Error("unreachable");
    // Order is a preference too — the shelf renders in the order it was built.
    expect(json.shelf.selected).toEqual(A_SHELF);
    expect(json.updatedAt).toBeTruthy();
    // …and the answer is the column, not the request body.
    expect(parseShelf(storedJson(), STRATEGY_IDS).selected).toEqual(A_SHELF);
    expect(json.updatedAt).toBe(
      t.db.select({ u: t.schema.settings.updatedAt }).from(t.schema.settings).get()?.u,
    );
    // Exactly one audit row for exactly one write.
    expect(auditCount()).toBe(before + 1);
  });

  it("stores a canonical envelope — B2's serialize/parse round-trip, not the raw body", async () => {
    await send({ action: "set", selected: A_SHELF });
    expect(JSON.parse(storedJson()!)).toEqual({ v: 1, selected: A_SHELF });
  });

  it("lets an EMPTY shelf round-trip — 'I want nothing on my shelf' is a real choice", async () => {
    const { status, json } = await send({ action: "set", selected: [] });
    expect(status).toBe(200);
    expect(json.ok && json.shelf.selected).toEqual([]);
    expect(JSON.parse(storedJson()!)).toEqual({ v: 1, selected: [] });
    // Restore the working shelf for the refusal tests below.
    await send({ action: "set", selected: A_SHELF });
  });

  it("accepts the WHOLE catalogue — the cap is the catalogue, not a smaller number", async () => {
    const { status, json } = await send({ action: "set", selected: [...STRATEGY_IDS] });
    expect(status).toBe(200);
    expect(json.ok && json.shelf.selected.length).toBe(40);
    await send({ action: "set", selected: A_SHELF });
  });
});

describe("restore", () => {
  it("returns the eight defaults and writes them as an EXPLICIT envelope, not null", async () => {
    const before = auditCount();
    const { status, json } = await send({ action: "restore" });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    if (!json.ok) throw new Error("unreachable");
    expect(json.shelf.selected).toEqual([...DEFAULT_SHELF]);
    expect(json.shelf.selected).toHaveLength(8);
    // The ruling: an explicit envelope, so the gesture survives a backup
    // round-trip. `null` would ALSO read back as the defaults, which is
    // exactly why asserting only the response would prove nothing.
    expect(storedJson()).not.toBeNull();
    expect(JSON.parse(storedJson()!)).toEqual({ v: 1, selected: [...DEFAULT_SHELF] });
    expect(auditCount()).toBe(before + 1);
    await send({ action: "set", selected: A_SHELF });
  });
});

describe("every refusal is a 400 with the store untouched and nothing audited", () => {
  const cases: Array<[string, unknown, string | undefined]> = [
    ["an id the catalogue does not know", { action: "set", selected: ["long-call", "moon-spread"] }, undefined],
    ["the same strategy twice", { action: "set", selected: ["long-call", "long-put", "long-call"] }, undefined],
    ["more entries than the catalogue holds", { action: "set", selected: [...STRATEGY_IDS, "long-call"] }, undefined],
    ["an action this route does not have", { action: "nuke" }, undefined],
    ["a `set` with no selection at all", { action: "set" }, undefined],
    ["a body that is not JSON", null, "not json at all"],
  ];

  for (const [name, body, raw] of cases) {
    it(name, async () => {
      const beforeJson = storedJson();
      const beforeAudit = auditCount();
      const { status, json } = await send(body, raw === undefined ? {} : { raw });
      expect(status).toBe(400);
      expect(json.ok).toBe(false);
      expect(json.ok === false && json.error.length).toBeGreaterThan(0);
      expect(storedJson()).toBe(beforeJson);
      expect(auditCount()).toBe(beforeAudit);
    });
  }

  it("names the reason it refused — the three `selected` refusals are distinguishable", async () => {
    const unknown = await send({ action: "set", selected: ["moon-spread"] });
    expect(unknown.json.ok === false && unknown.json.error).toContain("moon-spread");
    const dup = await send({ action: "set", selected: ["long-call", "long-call"] });
    expect(dup.json.ok === false && dup.json.error).toMatch(/twice/i);
    const big = await send({ action: "set", selected: [...STRATEGY_IDS, "long-call"] });
    expect(big.json.ok === false && big.json.error).toMatch(/at most 40/i);
  });
});

describe("the Pro gate is on the server", () => {
  it("refuses a free user's write with 403, writes nothing and audits nothing", async () => {
    const beforeJson = storedJson();
    const beforeAudit = auditCount();
    ent.pro = false;
    try {
      const { status, json } = await send({ action: "set", selected: ["long-call"] });
      expect(status).toBe(403);
      expect(json.ok).toBe(false);
      expect(json.ok === false && json.error).toMatch(/Pro/);
      // …and it states the free boundary correctly: the sixteen names this
      // screen printed before 4.3 (`legacyFree`), never the eight defaults.
      const free = CATALOGUE.filter((d) => d.legacyFree).length;
      const word = FREE_COUNT_WORD[free];
      expect(word, `${free} legacyFree rows — no spelled-out word is known for that count`).toBeDefined();
      expect(json.ok === false && json.error).toContain(word);
      expect(json.ok === false && json.error, "DEFAULT_SHELF is a different list").not.toMatch(/\beight\b/i);
      expect(storedJson()).toBe(beforeJson);
      expect(auditCount()).toBe(beforeAudit);
      // …and `restore` is not a back door into the same column.
      const restore = await send({ action: "restore" });
      expect(restore.status).toBe(403);
      expect(storedJson()).toBe(beforeJson);
    } finally {
      ent.pro = true;
    }
  });

  it("and the same body succeeds once the entitlement is Pro — the gate is the only difference", async () => {
    const { status } = await send({ action: "set", selected: ["long-call"] });
    expect(status).toBe(200);
    expect(parseShelf(storedJson(), STRATEGY_IDS).selected).toEqual(["long-call"]);
  });
});

/** The newest Audit Log row's summary, by id. */
function newestAuditSummary(): string | null {
  const rows = t.db
    .select({ id: t.schema.auditLog.id, summary: t.schema.auditLog.summary })
    .from(t.schema.auditLog)
    .all();
  return rows.reduce<(typeof rows)[number] | null>((a, r) => (a == null || r.id > a.id ? r : a), null)?.summary ?? null;
}

describe("the Audit Log row reads as English (R51)", () => {
  it("one strategy is 'strategy', never '1 strategies'", async () => {
    const { status } = await send({ action: "set", selected: ["long-call"] });
    expect(status).toBe(200);
    expect(newestAuditSummary()).toBe("strategy shelf → 1 strategy");
  });

  it("any other count keeps the plural — zero included", async () => {
    await send({ action: "set", selected: A_SHELF });
    expect(newestAuditSummary()).toBe("strategy shelf → 3 strategies");
    await send({ action: "set", selected: [] });
    expect(newestAuditSummary()).toBe("strategy shelf → 0 strategies");
    await send({ action: "set", selected: A_SHELF });
  });
});
