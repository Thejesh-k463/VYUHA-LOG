import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * F4 — "Mark reviewed" must target the session row's OWN account.
 *
 * The v3.5.0 PATCH resolved `getWriteAccountId(null)`: in the All-accounts
 * view (selected_account_id = 0, more than one live account) that falls back
 * to the lowest-id account, so reviewing any other account's session 404'd
 * with "No such session in this account". A review updates an EXISTING row,
 * so the client now sends the row's accountId and the route validates it via
 * `getWriteAccountId(accountId)` — an explicit id checked against the
 * accounts table (invariant 9: 0 is a view; the aggregate never receives a
 * write) — then scopes the update by (id, account) exactly as before.
 */

let t: TempDb;
let session1Id: number; // belongs to account 1 (lowest id)
let session2Id: number; // belongs to account 2 — the row the bug 404'd
let session3Id: number; // belongs to account 3 (archived)

async function patchSessions(body: Record<string, unknown>): Promise<Response | null> {
  const route = await import("@/app/api/sessions/route");
  const req = new Request("http://localhost/api/sessions", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // revalidatePath may throw outside a request scope — by then the DB write
  // (or the 404 return, which precedes it) has already happened, so failure
  // paths still hand back their Response and success is asserted on the DB.
  return route.PATCH(req).catch(() => null);
}

const readSession = (id: number) =>
  t.sqlite
    .prepare("SELECT status, review_notes AS reviewNotes FROM trading_sessions WHERE id = ?")
    .get(id) as { status: string; reviewNotes: string | null };

beforeAll(async () => {
  t = await openTempDb("session-review", { seed: true }); // seeds account 1 "Primary"
  t.db.insert(t.schema.accounts).values({ id: 2, name: "Second" }).run();
  t.db.insert(t.schema.accounts).values({ id: 3, name: "Retired", archived: true }).run();
  // The All-accounts view: selected 0 with >1 live account stays the aggregate.
  t.sqlite.prepare("UPDATE settings SET selected_account_id = 0").run();

  const insert = (accountId: number, sessionDate: string) =>
    t.db
      .insert(t.schema.tradingSessions)
      .values({ accountId, sessionDate } as typeof t.schema.tradingSessions.$inferInsert)
      .returning({ id: t.schema.tradingSessions.id })
      .get().id;
  session1Id = insert(1, "2026-08-25");
  session2Id = insert(2, "2026-08-26");
  session3Id = insert(3, "2026-08-27");
});

afterAll(() => t?.cleanup());

describe("PATCH /api/sessions scopes the review to the session's own account", () => {
  it("reviews an account-2 session from the All-accounts view while account 1 is lowest-id (the v3.5.0 404)", async () => {
    await patchSessions({ id: session2Id, accountId: 2, status: "reviewed", reviewNotes: "stuck to plan" });
    expect(readSession(session2Id)).toEqual({ status: "reviewed", reviewNotes: "stuck to plan" });
    // The neighbouring books were never touched.
    expect(readSession(session1Id).status).toBe("planned");
    expect(readSession(session3Id).status).toBe("planned");
  });

  it("still works for the lowest-id account itself", async () => {
    await patchSessions({ id: session1Id, accountId: 1, status: "reviewed", reviewNotes: null });
    expect(readSession(session1Id).status).toBe("reviewed");
  });

  it("404s a fabricated accountId that exists but does not own the session — never a cross-account write", async () => {
    const res = await patchSessions({ id: session3Id, accountId: 2, status: "reviewed", reviewNotes: "forged" });
    expect(res?.status).toBe(404);
    expect(readSession(session3Id)).toEqual({ status: "planned", reviewNotes: null });
  });

  it("404s a nonexistent accountId — getWriteAccountId falls back to a real account, which does not own the row", async () => {
    const res = await patchSessions({ id: session3Id, accountId: 999, status: "reviewed", reviewNotes: "forged" });
    expect(res?.status).toBe(404);
    expect(readSession(session3Id).status).toBe("planned");
  });

  it("reviews a session on an ARCHIVED account — getWriteAccountId validates existence, not liveness", async () => {
    await patchSessions({ id: session3Id, accountId: 3, status: "reviewed", reviewNotes: "closing the book" });
    expect(readSession(session3Id)).toEqual({ status: "reviewed", reviewNotes: "closing the book" });
  });

  it("rejects a review without an accountId — the contract that prevents the fallback regression", async () => {
    const res = await patchSessions({ id: session2Id, status: "planned" });
    expect(res?.status).toBe(400);
    expect(readSession(session2Id).status).toBe("reviewed"); // untouched by the refused call
  });
});
