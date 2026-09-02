import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * Second pass, item 2 — POST /api/sessions is the untested twin of a PATCH that
 * was already fixed for exactly this (v3.5.0, defect D7).
 *
 * PATCH takes the row's own accountId, validates it, and says so in its own
 * comment. POST resolved `getWriteAccountId(accountId ?? null)` — and
 * components/behavior/session-planner.tsx sends NO accountId at all. So
 * planning a session from the All-accounts view resolved the lowest account id
 * and filed the plan against account #1, behind "Plan saved."
 *
 * THE GUARD, and why it is one condition rather than two: in the aggregate view
 * the route accepts only an explicit id that SURVIVED validation
 * (`accountId !== requested` ⇒ refuse). That catches both a body with no id and
 * a body whose id named no real account — the resolver silently downgrades the
 * second to the same lowest-id guess as the first. A single-account view never
 * trips it, because the resolver has a real selection to return.
 *
 * The legitimate explicit-id case is preserved and pinned: a caller that DOES
 * name a real account (a picker, the session card) still writes from the
 * aggregate view. That is the same latitude /import and /trades already have.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let route: typeof import("@/app/api/sessions/route");

const PRIMARY = 1;
const SWING = 2;
const ARCHIVED = 3;
const ALL = 0;

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

/** The planner's body, minus whatever the test wants to vary. */
const plan = (over: Record<string, unknown> = {}) => ({
  sessionDate: "2026-08-25",
  market: "NSE",
  plannedSymbols: ["TCS", "INFY"],
  plannedPlaybookIds: [],
  maxTrades: 3,
  maxLoss: 5000,
  cutoffTime: null,
  thesis: "range day",
  status: "planned",
  ...over,
});

function post(body: unknown): Promise<Response> {
  return route.POST(new Request("http://local/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function patch(body: unknown): Promise<Response> {
  return route.PATCH(new Request("http://local/api/sessions", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

const rows = () => t.db.select().from(t.schema.tradingSessions).all();

beforeAll(async () => {
  t = await openTempDb("sessions-aggregate", { seed: true });
  route = await import("@/app/api/sessions/route");
  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing" }).run();
  t.db.insert(t.schema.accounts).values({ id: ARCHIVED, name: "Retired", archived: true }).run();
});

afterAll(() => t?.cleanup());

describe("POST: the All-accounts view may not plan a session without naming an account", () => {
  it("REFUSES the planner's own body — it sends no accountId", async () => {
    selectAccount(ALL);
    const res = await post(plan()); // exactly what session-planner.tsx sends

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.forbidden).toBe(true);
    expect(json.message).toMatch(/pick an account in the sidebar/i);

    // THE assertion. Reverting the guard files this plan on account #1.
    expect(rows()).toHaveLength(0);
  });

  it("REFUSES an accountId that names no real account — the resolver downgrades it to the same guess", async () => {
    selectAccount(ALL);
    const res = await post(plan({ accountId: 999, sessionDate: "2026-08-26" }));
    expect(res.status).toBe(403);
    expect(rows()).toHaveLength(0);
  });

  it("ACCEPTS an explicit, real accountId from the aggregate view — a picker must still work", async () => {
    selectAccount(ALL);
    const res = await post(plan({ accountId: SWING, sessionDate: "2026-08-27" }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    const all = rows();
    expect(all).toHaveLength(1);
    expect(all[0].accountId).toBe(SWING);
    expect(all.filter((r) => r.accountId === PRIMARY)).toHaveLength(0);
  });

  it("ACCEPTS an explicit ARCHIVED account — the resolver validates existence, not liveness", async () => {
    selectAccount(ALL);
    const res = await post(plan({ accountId: ARCHIVED, sessionDate: "2026-08-28" }));
    expect(res.status).toBe(200);
    expect(rows().some((r) => r.accountId === ARCHIVED)).toBe(true);
  });
});

describe("POST: a single-account view is untouched by the guard", () => {
  it("plans onto the selected account with no accountId in the body", async () => {
    selectAccount(SWING);
    const res = await post(plan({ sessionDate: "2026-09-01" }));
    expect(res.status).toBe(200);
    expect(rows().find((r) => r.sessionDate === "2026-09-01")!.accountId).toBe(SWING);
  });

  it("still plans onto account #1 when account #1 is the one actually selected", async () => {
    selectAccount(PRIMARY);
    const res = await post(plan({ sessionDate: "2026-09-02" }));
    expect(res.status).toBe(200);
    expect(rows().find((r) => r.sessionDate === "2026-09-02")!.accountId).toBe(PRIMARY);
  });

  it("re-posting the same date EDITS that account's row rather than duplicating it", async () => {
    selectAccount(SWING);
    expect((await post(plan({ sessionDate: "2026-09-01", thesis: "trend day" }))).status).toBe(200);
    const forSwing = rows().filter((r) => r.accountId === SWING && r.sessionDate === "2026-09-01");
    expect(forSwing).toHaveLength(1);
    expect(forSwing[0].thesis).toBe("trend day");
  });

  it("a malformed body still 400s, not 403", async () => {
    selectAccount(ALL);
    expect((await post({ sessionDate: "not-a-date" })).status).toBe(400);
    expect((await post(null)).status).toBe(400);
  });
});

describe("PATCH: the already-fixed twin, pinned", () => {
  it("reviews another account's session from the aggregate view (the v3.5.0 fix)", async () => {
    selectAccount(ALL);
    const row = rows().find((r) => r.accountId === SWING)!;
    const res = await patch({ id: row.id, accountId: SWING, status: "reviewed", reviewNotes: "stuck to plan" });
    expect(res.status).toBe(200);
    expect(rows().find((r) => r.id === row.id)!.status).toBe("reviewed");
  });

  it("404s an accountId that exists but does not own the row — never a cross-account write", async () => {
    selectAccount(ALL);
    const row = rows().find((r) => r.accountId === ARCHIVED)!;
    const res = await patch({ id: row.id, accountId: SWING, status: "reviewed", reviewNotes: "forged" });
    expect(res.status).toBe(404);
    expect(rows().find((r) => r.id === row.id)!.status).toBe("planned");
  });

  it("requires an accountId — the contract that prevents the fallback regression", async () => {
    selectAccount(ALL);
    const row = rows().find((r) => r.accountId === SWING)!;
    expect((await patch({ id: row.id, status: "planned" })).status).toBe(400);
  });

  it("a nonexistent accountId must not retarget the row the fallback lands on", async () => {
    // The hole this probes: getWriteAccountId(999) falls back to the LOWEST
    // account id, so a bogus id plus an id that happens to live on account #1
    // could review account #1's session on a client's behalf. Account #1 owns
    // the 2026-09-02 row, so this is exactly that shape.
    selectAccount(ALL);
    const row = rows().find((r) => r.accountId === PRIMARY)!;
    const before = row.status;
    const res = await patch({ id: row.id, accountId: 999, status: "reviewed", reviewNotes: "forged" });
    expect(res.status).toBe(404);
    expect(rows().find((r) => r.id === row.id)!.status).toBe(before);
  });
});
